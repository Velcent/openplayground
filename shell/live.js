// Live editing of one shared document in a session. The owner's browser coordinates: it runs the authored journal
// (document-history.js), keeps its record in the session's browser storage and sends accepted entries to everyone.
// Every browser, the owner's too, runs the same client: it keeps the last acknowledged document, sends at most one
// proposal at a time and has the app merge each accepted change into its live document. Rejected or conflicting
// local work is kept as a draft, never overwritten silently. Without the owner, editing pauses.
//
// The app supplies an adapter (Honeydew: src/app/live.rs; others: patches/live/playground_live.rs): format;
// checkpoint(), which throws 'busy' while a gesture is under way; merge(base, current, edited); apply(base, edited) and
// apply(null, document), promises settled at the next quiet frame, the second resolving to the document it replaced;
// connect({ changed, undo }) and disconnect(). Apps that keep media outside the document (photos, audio) also offer
// assets() → [{ id, name, have }] for the live document, assetsOf(document) → the same IDs for a document, readAsset(id)
// → bytes or Blob, and writeAsset(id, name, bytes), any of which may throw 'busy'; those media travel as session files.
// For presence, presence() → a small JSON value (where this person points, what they selected) and showPresence(others)
// with [{ id, name, color, state }]; both may throw 'busy'. Presence goes peer to peer and never into the document.
import { DocumentHistory, stacks } from './document-history.js'
import { applyDelta, delta } from './document-delta.js'

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
const busy = (e) => e === 'busy' || e?.message === 'busy'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const RETAINED = 100, MAX_WANTED = 8, PRESENCE_MS = 100, MAX_PRESENCE = 4096, MAX_DEPTH = 16
// The largest media file installed: the browser holds it about twice while the app takes it.
const MAX_ASSET = 1024 ** 3
const depth = (v, d = 0) => d > MAX_DEPTH || !v || typeof v !== 'object' ? d : Math.max(d, ...Object.values(v).map((x) => depth(x, d + 1)))
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0fa5b5', '#f032e6', '#9a6324']
const color = (id) => COLORS[parseInt(id.replaceAll('-', '').slice(-8), 16) % COLORS.length]
const fileIds = new Map()
// The session file that carries an app's asset: one per asset ID, whoever shares it first.
async function fileId(asset) {
  if (!fileIds.has(asset)) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(asset)))
    fileIds.set(asset, 'live-' + btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  }
  return fileIds.get(asset)
}
const fileName = (name) => String(name).replace(/[\/\\\x00-\x1f\x7f]/g, '_').slice(0, 255) || 'asset'

// The app's adapter: set before the shell loads (globalThis.playgroundLiveAdapter) or offered through attach.
let adapter = globalThis.playgroundLiveAdapter ?? null
const waiting = new Set(), followed = new WeakMap()
globalThis.playgroundLive = { attach(next) { adapter = next; for (const resolve of waiting) resolve(next); waiting.clear() } }
export const liveAdapter = () => adapter
// Live editing for a session once this page's app offers an adapter; apps without one only share files.
export function follow(session) {
  if (!followed.has(session)) followed.set(session, (adapter ? Promise.resolve(adapter) : new Promise((resolve) => waiting.add(resolve)))
    .then(async (found) => {
      if (session.unfollowed) return null
      const live = await LiveDocument.start({ session, adapter: found })
      if (session.unfollowed) { live.stop(); return null }
      return session.live = live
    }))
  return followed.get(session)
}
export function unfollow(session) {
  session.unfollowed = true
  session.live?.stop()
}

export class LiveDocument extends EventTarget {
  static async start({ session, adapter, store = session.store }) {
    const live = new LiveDocument(session, adapter, store)
    // Connected first: the owner's coordinate() may need the app to apply a stored document.
    adapter.connect({ changed: () => queueMicrotask(() => live.kick()), undo: (redo) => queueMicrotask(() => live.undo(redo)) })
    live.mine = new Set(await store.media?.().catch(() => null) ?? [])
    if (session.config.owner) await live.coordinate()
    for (const [type, handler] of Object.entries(live.handlers)) session.addEventListener(type, handler)
    for (const peer of session.peers.values()) if (peer.document?.readyState === 'open') live.opened(peer)
    // A snapshot the owner sent before this document listened is gone: ask again.
    live.resync()
    // The first presence asks the others for theirs: a page whose app attached late missed them.
    live.presenceHello = true
    if (adapter.presence || adapter.showPresence) live.presenceTimer = setInterval(() => live.presenceTick(), PRESENCE_MS)
    return live
  }
  constructor(session, adapter, store) {
    super()
    // `mine`: the media this browser may share, those its own document or edits brought in. Someone else referring to
    // a file this browser happens to have never makes it share that file.
    Object.assign(this, { session, adapter, store, acked: null, entries: [], inflight: null, wanted: [], error: null, unsaved: [], mine: new Set(), others: new Map() })
    this.work = this.coordinating = this.assetWork = Promise.resolve()
    this.handlers = {
      document: (e) => this.receive(e.peer, e.value),
      'document-open': (e) => this.opened(e.peer),
      'document-close': (e) => this.closed(e.peer),
      change: () => this.syncAssets(),
    }
  }
  get editable() { return this.session.role !== 'viewer' }
  get status() {
    if (this.incompatible) return 'incompatible'
    if (!this.acked) return 'catching up'
    if (this.session.stopped || (!this.history && !this.coordinator())) return 'paused'
    return this.editable ? 'live' : 'read-only'
  }
  changed() { this.dispatchEvent(new Event('change')); this.syncAssets() }
  report(error) { this.error = error?.message ?? String(error); this.changed() }
  stop() {
    this.stopped = true
    clearInterval(this.presenceTimer)
    try { this.adapter.showPresence?.([]) } catch {}
    for (const [type, handler] of Object.entries(this.handlers)) this.session.removeEventListener(type, handler)
    this.adapter.disconnect()
  }
  coordinator() {
    return [...this.session.peers.values()].find((p) => p.role === 'owner' && p.document?.readyState === 'open')
  }

  // Coordinator. Proposals go to the journal as they arrive (its own bounds apply); their replies and broadcasts
  // follow in submission order, which is revision order.
  async coordinate() {
    const options = {
      merge: (base, current, edited) => this.adapter.merge(base, current, edited),
      commit: (record) => this.store.document(record),
      allowed: (id) => id === this.session.id ? this.editable : ['owner', 'editor'].includes(this.session.peers.get(id)?.role),
    }
    const record = await this.store.document().catch(() => null)
    try {
      if (record?.format !== this.adapter.format) throw new Error('another build')
      this.history = DocumentHistory.restore(record, options)
    } catch {
      // Another build's or an unreadable journal: its document carries over when this build can open it.
      if (record?.bytes) await this.adapter.apply(null, record.bytes).catch(() => this.store.draft(record.bytes))
      const bytes = await this.shareable()
      this.history = await DocumentHistory.create({ document: crypto.randomUUID(), format: this.adapter.format, bytes, ...options })
      await this.introduced(null, bytes)
    }
    const snapshot = this.history.snapshot()
    this.broadcasted = snapshot.revision
    this.work = this.work.then(() => this.adopt(snapshot)).catch((e) => this.report(e))
  }
  // A document every peer can install (the app's own merge validates it), or nothing is shared yet: a journal that
  // starts from no document would fail every joiner.
  async shareable() {
    for (;;) {
      const bytes = await this.quietCheckpoint()
      try { this.adapter.merge(bytes, bytes, bytes); this.error = null; return bytes }
      catch { this.report(new Error('Open a document to share it live.')) }
      await sleep(500)
    }
  }
  async quietCheckpoint() {
    for (;;) {
      try { return this.adapter.checkpoint() } catch (e) { if (!busy(e)) throw e }
      await sleep(50)
    }
  }
  coordinateProposal(author, proposal, reply) {
    const result = this.history.submit(author, proposal).then((entry) => ({ entry }), (error) => ({ error }))
    this.coordinating = this.coordinating.then(async () => {
      const { entry, error } = await result
      if (error) return reply({ type: 'reject', id: proposal?.id, error: error.message })
      // A replayed ID returns its original entry: only its sender can have missed it.
      if (entry.revision <= this.broadcasted) return reply({ type: 'entry', entry })
      this.broadcasted = entry.revision
      for (const peer of this.session.peers.values()) if (peer.document?.readyState === 'open') this.session.sendDocument(peer, { type: 'entry', entry }).catch(() => {})
      this.receive(null, { type: 'entry', entry })
    })
  }
  // At most one snapshot per peer in flight, and a second one at least a second later: a peer cannot make the owner
  // copy the whole document at will.
  snapshot(peer) {
    if (peer.snapshotting) { peer.snapshotAgain = true; return }
    peer.snapshotting = true
    this.session.sendDocument(peer, { type: 'snapshot', record: this.history.snapshot() }).catch(() => {}).then(() => sleep(1000)).then(() => {
      peer.snapshotting = false
      if (peer.snapshotAgain && this.session.peers.get(peer.id) === peer && !this.stopped) { peer.snapshotAgain = false; this.snapshot(peer) }
    })
  }
  opened(peer) {
    this.presenceSent = null
    if (this.history) this.snapshot(peer)
    else if (peer.role === 'owner') this.resyncing = false
    this.changed()
  }
  closed(peer) {
    // A late close from a peer that has reconnected since leaves the new one's presence alone.
    if (this.session.peers.get(peer.id) === peer && this.others.delete(peer.id)) this.presenceDirty = true
    if (peer.role === 'owner') this.changed()
  }
  resync() {
    const owner = !this.history && !this.resyncing && this.coordinator()
    if (!owner) return
    this.resyncing = true
    this.session.sendDocument(owner, { type: 'resync' }).catch(() => { this.resyncing = false })
  }

  // Client. `peer` is null for the coordinator in this browser.
  receive(peer, value) {
    if (this.stopped) return
    if (peer && value?.type === 'presence') return this.presence(peer, value.state, value.hello === true)
    if (this.history && peer) {
      if (value?.type === 'propose') this.coordinateProposal(peer.id, value.proposal, (reply) => this.session.sendDocument(peer, reply).catch(() => {}))
      else if (value?.type === 'resync') this.snapshot(peer)
      return
    }
    if (peer && peer.role !== 'owner') return
    this.work = this.work.then(() => this.process(value)).catch((e) => this.report(e))
  }
  async process(value) {
    if (value?.type === 'snapshot') return this.adopt(value.record)
    if (!this.acked || this.incompatible) return
    if (value?.type === 'entry') {
      // An entry that does not apply to our acknowledged document means we diverged: start again from a snapshot.
      try { await this.entry(value.entry) } catch (e) { this.resync(); throw e }
    } else if (value?.type === 'reject' && value.id === this.inflight?.proposal.id) {
      const { proposal, inLive } = this.inflight
      this.inflight = null
      // Only an edit still in the live document is undone here; a conflict already kept it as a draft.
      if (proposal.kind === 'edit' && inLive) await this.restore(this.acked.bytes)
      // An edit the merge reduced to nothing needs no message: the shared document is what it wanted.
      if (value.error !== 'No change') this.report(new Error(`${proposal.kind === 'edit' ? 'Edit kept as a draft' : 'Cannot ' + proposal.kind}: ${value.error}`))
    }
    this.kick()
  }
  // A new document, or the first one: differing local work becomes a draft. A reconnect replays missed entries.
  async adopt(record) {
    this.resyncing = false
    if (record.format !== this.adapter.format) {
      this.incompatible = true
      return this.report(new Error(`This session's document is from ${record.format}; this page runs ${this.adapter.format}. Your work here is unchanged.`))
    }
    this.incompatible = false
    const known = this.acked?.document === record.document && record.revision >= this.acked.revision
      && record.revision - record.entries.length <= this.acked.revision
      && (record.revision > this.acked.revision || same(record.bytes, this.acked.bytes))
    let replayed = false
    if (known) {
      try {
        for (const entry of record.entries) await this.entry(entry)
        replayed = true
      } catch {}
    }
    if (replayed) {
      // Its ID makes a resent proposal apply at most once.
      if (this.inflight) this.send(this.inflight.proposal, this.inflight.inLive)
    } else {
      this.inflight = null
      await this.restore(record.bytes)
      this.acked = { document: record.document, revision: record.revision, bytes: record.bytes }
      this.entries = record.entries.slice(-RETAINED)
    }
    this.error = null; this.changed(); this.kick()
  }
  // The live document takes the entry before the acknowledged one does: a failure leaves both as they were.
  async entry(entry) {
    if (entry.revision <= this.acked.revision) return
    if (entry.revision !== this.acked.revision + 1) return this.resync()
    const before = this.acked.bytes, after = await applyDelta(before, entry.change)
    const own = entry.id === this.inflight?.proposal.id
    // An acknowledged edit is already in the live document, unless a conflict replaced it meanwhile.
    if (!own || !this.inflight.inLive) await this.merge(before, after)
    this.acked = { ...this.acked, revision: entry.revision, bytes: after }
    this.entries = [...this.entries, entry].slice(-RETAINED)
    if (own) this.inflight = null
    if (entry.author === this.session.id && entry.kind === 'edit') await this.introduced(before, after)
    this.changed()
  }
  async introduced(before, after) {
    if (!this.adapter.assetsOf) return
    // Most apps keep no media: one look at the live document spares parsing both documents.
    if (before) {
      const list = await Promise.resolve().then(() => this.adapter.assets?.()).catch(() => null)
      if (Array.isArray(list) && !list.length) return
    }
    try {
      const old = new Set(before ? await this.adapter.assetsOf(before) : []), size = this.mine.size
      for (const id of await this.adapter.assetsOf(after)) if (!old.has(id)) this.mine.add(id)
      // Kept with the session, so a reload before they are shared still shares them.
      if (this.mine.size > size) await this.store.media?.([...this.mine])
    } catch (e) { this.report(e) }
  }
  async merge(before, after) {
    try { await this.adapter.apply(before, after) }
    catch (e) {
      this.report(new Error(`Local changes kept as a draft: ${e?.message ?? e}`))
      await this.restore(after)
    }
  }
  // The live document becomes `document`; what it replaced is kept as a draft when it differs.
  async restore(document) {
    const replaced = await this.adapter.apply(null, document)
    if (this.inflight) this.inflight.inLive = false
    if (!(replaced instanceof Uint8Array) || same(replaced, document)) return
    try { await this.store.draft(replaced) }
    catch (e) {
      // ponytail: held in memory only; offer it for download once there is a drafts UI.
      this.unsaved.push(replaced)
      this.report(new Error(`Your replaced work could not be saved as a draft (${e?.message ?? e}). Keep this page open.`))
    }
  }
  // Shares the media the shared document refers to that nobody shared yet, and installs what this browser lacks once
  // it has arrived. Coalesced: one pass at a time, at most one more queued.
  syncAssets() {
    if (!this.adapter.assets || this.stopped || this.assetsQueued) return
    if (Date.now() < this.assetsRetry) return
    this.assetsQueued = true
    this.assetWork = this.assetWork.then(() => { this.assetsQueued = false; return this.exchangeAssets() }).catch((e) => {
      if (busy(e)) return void setTimeout(() => this.syncAssets(), 100)
      // Not through report(): its change would start the next pass at once. A failing pass waits a few seconds.
      this.error = `Shared media: ${e?.message ?? e}`; this.dispatchEvent(new Event('change'))
      this.assetsRetry = Date.now() + 5000; setTimeout(() => this.syncAssets(), 5000)
    })
  }
  async exchangeAssets() {
    if (this.status !== 'live' && this.status !== 'read-only') return
    const files = new Map(this.session.files.map((f) => [f.id, f]))
    for (const { id, name, have } of await this.adapter.assets()) {
      const file = files.get(await fileId(id))
      // One at a time, so a large catalog is never in memory at once.
      if (have && !file && this.editable && this.mine.has(id)) await this.session.share([new File([await this.adapter.readAsset(id)], fileName(name))], [await fileId(id)])
      else if (!have && file && file.size <= MAX_ASSET) {
        // Only this file: the session's other files still wait for the person to accept them.
        if (!this.session.accepted) await this.session.receiveFiles([file.id])
        if (this.session.available.has(file.asset)) await this.adapter.writeAsset(id, file.name, new Uint8Array(await (await this.session.store.file(file.asset)).arrayBuffer()))
      }
    }
  }
  // Presence, ten times a second at most: this person's, when it changed (to everyone again when someone arrives), and
  // the others' as the app shows them.
  presence(peer, state, hello) {
    if (hello) this.presenceSent = null
    if (JSON.stringify(state ?? null).length > MAX_PRESENCE || depth(state) > MAX_DEPTH) return
    this.others.set(peer.id, state ?? null); this.presenceDirty = true
  }
  presenceTick() {
    if (this.stopped || !this.acked || this.incompatible) return
    try {
      const text = JSON.stringify(this.adapter.presence?.() ?? null)
      if (text !== this.presenceSent && text.length <= MAX_PRESENCE) {
        this.presenceSent = text
        const hello = this.presenceHello === true
        this.presenceHello = false
        for (const peer of this.session.peers.values()) {
          if (peer.document?.readyState === 'open') this.session.sendDocument(peer, { type: 'presence', state: JSON.parse(text), hello }).catch(() => {})
        }
      }
      // Someone whose connection dropped without a close event goes too.
      for (const id of this.others.keys()) if (this.session.peers.get(id)?.document?.readyState !== 'open') { this.others.delete(id); this.presenceDirty = true }
      if (this.presenceDirty) {
        this.adapter.showPresence?.([...this.others].map(([id, state]) => ({ id, name: this.session.peers.get(id)?.name ?? '', color: color(id), state })))
        this.presenceDirty = false
      }
    } catch (e) { if (!busy(e)) this.report(e) }
  }
  undo(redo) {
    if (this.status === 'live' && this.wanted.length < MAX_WANTED) this.wanted.push(redo)
    this.kick()
  }
  kick() { if (!this.stopped) this.work = this.work.then(() => this.step()).catch((e) => this.report(e)) }
  // Sends unsent local work, else the next Undo or Redo, once nothing is in flight. A busy app reports again when
  // its gesture ends.
  async step() {
    if (this.status !== 'live' && this.status !== 'read-only') return
    if (this.inflight) return
    let local
    try { local = this.adapter.checkpoint() } catch (e) { if (busy(e)) return; throw e }
    if (!same(local, this.acked.bytes)) {
      if (!this.editable) return this.restore(this.acked.bytes)
      return this.send({ ...this.request('edit'), edit: await delta(this.acked.bytes, local) }, true)
    }
    if (!this.wanted.length) return
    const redo = this.wanted.shift(), own = stacks(this.entries, this.session.id)
    const target = (redo ? own.redo : own.undo).at(-1)
    if (target !== undefined) this.send({ ...this.request(redo ? 'redo' : 'undo'), target }, false)
    else this.kick()
  }
  request(kind) {
    return { version: 1, document: this.acked.document, format: this.adapter.format, id: crypto.randomUUID(), base: this.acked.revision, kind }
  }
  send(proposal, inLive) {
    this.inflight = { proposal, inLive }
    if (this.history) return this.coordinateProposal(this.session.id, proposal, (reply) => this.receive(null, reply))
    const owner = this.coordinator()
    if (owner) this.session.sendDocument(owner, { type: 'propose', proposal }).catch(() => {})
  }
}
