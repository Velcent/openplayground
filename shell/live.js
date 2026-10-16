// Live editing of one shared document in a session. The owner's browser coordinates: it runs the authored journal
// (document-history.js), keeps its record in the session's browser storage and sends accepted entries to everyone.
// Every browser, the owner's too, runs the same client: it keeps the last acknowledged document, sends at most one
// proposal at a time and has the app merge each accepted change into its live document. Rejected or conflicting
// local work is kept as a draft, never overwritten silently. Without the owner, editing pauses.
//
// The app supplies an adapter (Honeydew: src/app/live.rs): format, checkpoint(), merge(base, current, edited),
// apply(base | null, edited) → Promise, connect({ changed, undo }) and disconnect().
import { DocumentHistory, stacks } from './document-history.js'
import { applyDelta, delta } from './document-delta.js'

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])
const RETAINED = 100

export class LiveDocument extends EventTarget {
  static async start({ session, adapter, store = session.store }) {
    const live = new LiveDocument(session, adapter, store)
    if (session.config.owner) await live.coordinate()
    adapter.connect({ changed: () => queueMicrotask(() => live.kick()), undo: (redo) => queueMicrotask(() => live.undo(redo)) })
    for (const [type, handler] of Object.entries(live.handlers)) session.addEventListener(type, handler)
    for (const peer of session.peers.values()) if (peer.document?.readyState === 'open') live.opened(peer)
    return live
  }
  constructor(session, adapter, store) {
    super()
    Object.assign(this, { session, adapter, store, acked: null, entries: [], inflight: null, wanted: [], error: null })
    this.work = this.coordinating = Promise.resolve()
    this.handlers = {
      document: (e) => this.receive(e.peer, e.value),
      'document-open': (e) => this.opened(e.peer),
      'document-close': (e) => this.closed(e.peer),
    }
  }
  get editable() { return this.session.role !== 'viewer' }
  get status() {
    if (!this.acked) return 'catching up'
    if (!this.history && !this.coordinator()) return 'paused'
    return this.editable ? 'live' : 'read-only'
  }
  changed() { this.dispatchEvent(new Event('change')) }
  report(error) { this.error = error?.message ?? String(error); this.changed() }
  stop() {
    for (const [type, handler] of Object.entries(this.handlers)) this.session.removeEventListener(type, handler)
    this.adapter.disconnect()
  }
  coordinator() {
    return [...this.session.peers.values()].find((p) => p.role === 'owner' && p.document?.readyState === 'open')
  }

  // Coordinator: the journal decides; one proposal is handled at a time so entries go out in revision order.
  async coordinate() {
    const options = {
      merge: (base, current, edited) => this.adapter.merge(base, current, edited),
      commit: (record) => this.store.document(record),
      allowed: (id) => id === this.session.id ? this.editable : ['owner', 'editor'].includes(this.session.peers.get(id)?.role),
    }
    const record = await this.store.document()
    if (record?.format === this.adapter.format) this.history = DocumentHistory.restore(record, options)
    else {
      if (record) await this.store.draft(record.bytes)
      this.history = await DocumentHistory.create({ document: crypto.randomUUID(), format: this.adapter.format, bytes: this.adapter.checkpoint(), ...options })
    }
    const snapshot = this.history.snapshot()
    this.broadcasted = snapshot.revision
    this.work = this.work.then(() => this.adopt(snapshot)).catch((e) => this.report(e))
  }
  coordinateProposal(author, proposal, reply) {
    this.coordinating = this.coordinating.then(async () => {
      let entry
      try { entry = await this.history.submit(author, proposal) }
      catch (e) { return reply({ type: 'reject', id: proposal?.id, error: e.message }) }
      // A replayed ID returns its original entry: only its sender can have missed it.
      if (entry.revision <= this.broadcasted) return reply({ type: 'entry', entry })
      this.broadcasted = entry.revision
      for (const peer of this.session.peers.values()) if (peer.document?.readyState === 'open') this.session.sendDocument(peer, { type: 'entry', entry }).catch(() => {})
      this.receive(null, { type: 'entry', entry })
    })
  }
  opened(peer) {
    if (this.history) this.session.sendDocument(peer, { type: 'snapshot', record: this.history.snapshot() }).catch(() => {})
    this.changed()
  }
  closed(peer) {
    if (peer.role === 'owner') this.changed()
  }

  // Client. `peer` is null for the coordinator in this browser.
  receive(peer, value) {
    if (this.history && peer) {
      if (value?.type === 'propose') this.coordinateProposal(peer.id, value.proposal, (reply) => this.session.sendDocument(peer, reply).catch(() => {}))
      else if (value?.type === 'resync') this.opened(peer)
      return
    }
    if (peer && peer.role !== 'owner') return
    this.work = this.work.then(() => this.process(value)).catch((e) => this.report(e))
  }
  async process(value) {
    if (value?.type === 'snapshot') return this.adopt(value.record)
    if (!this.acked) return
    if (value?.type === 'entry') await this.entry(value.entry)
    else if (value?.type === 'reject' && value.id === this.inflight?.proposal.id) {
      const { proposal } = this.inflight
      this.inflight = null
      if (proposal.kind === 'edit') await this.restore()
      this.report(new Error(`${proposal.kind === 'edit' ? 'Edit kept as a draft' : 'Cannot ' + proposal.kind}: ${value.error}`))
    }
    this.kick()
  }
  // A new document, or the first one: keeps differing local work as a draft. A reconnect replays missed entries.
  async adopt(record) {
    const known = this.acked?.document === record.document && record.revision >= this.acked.revision
      && record.revision - record.entries.length <= this.acked.revision
    if (known) {
      for (const entry of record.entries) await this.entry(entry)
      // Its ID makes a resent proposal apply at most once.
      if (this.inflight) this.send(this.inflight.proposal, this.inflight.inLive)
    } else {
      this.acked = { document: record.document, revision: record.revision, bytes: record.bytes }
      this.entries = record.entries.slice(-RETAINED); this.inflight = null
      await this.restore()
    }
    this.error = null; this.changed(); this.kick()
  }
  async entry(entry) {
    if (entry.revision <= this.acked.revision) return
    if (entry.revision !== this.acked.revision + 1) {
      // A gap: everything after it waits for a fresh snapshot.
      const owner = this.coordinator()
      if (owner) await this.session.sendDocument(owner, { type: 'resync' })
      return
    }
    const before = this.acked.bytes, after = await applyDelta(before, entry.change)
    this.acked = { ...this.acked, revision: entry.revision, bytes: after }
    this.entries = [...this.entries, entry].slice(-RETAINED)
    const own = entry.id === this.inflight?.proposal.id
    // An acknowledged edit is already in the live document, unless a conflict replaced it meanwhile.
    if (!own || !this.inflight.inLive) await this.merge(before, after)
    if (own) this.inflight = null
    this.changed()
  }
  async merge(before, after) {
    try { await this.adapter.apply(before, after) }
    catch (e) {
      this.report(new Error(`Local changes kept as a draft: ${e?.message ?? e}`))
      await this.restore()
    }
  }
  // The live document becomes the acknowledged one; its differing local work goes to a draft first.
  async restore() {
    const local = this.adapter.checkpoint()
    if (same(local, this.acked.bytes)) return
    await this.store.draft(local)
    if (this.inflight) this.inflight.inLive = false
    await this.adapter.apply(null, this.acked.bytes)
  }
  undo(redo) { this.wanted.push(redo); this.kick() }
  kick() { this.work = this.work.then(() => this.step()).catch((e) => this.report(e)) }
  // Sends unsent local work, else the next Undo or Redo, once nothing is in flight.
  async step() {
    if (!this.acked || this.inflight || this.status === 'paused') return
    const local = this.adapter.checkpoint()
    if (!same(local, this.acked.bytes)) {
      if (!this.editable) return this.adapter.apply(null, this.acked.bytes)
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
