import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { pack, unpack } from '../shell/session-protocol.js'
import { LiveDocument } from '../shell/live.js'

// A three-field document stands in for a song; the fake app merges like Honeydew: strictly, field by field.
function merge(base, current, edited) {
  return edited.map((value, i) => {
    if (value === base[i]) return current[i]
    if (current[i] !== base[i]) throw `field ${i}`
    return value
  })
}
const copy = async (value) => unpack(new Uint8Array(await pack(value).arrayBuffer()))
// Retries `check` until it stops throwing: hashing and messages are asynchronous, and slow under a loaded machine.
async function eventually(check, ms = 10000) {
  for (const end = Date.now() + ms; ; await new Promise((resolve) => setTimeout(resolve, 5))) {
    try { return await check() } catch (e) { if (Date.now() > end) throw e }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class App {
  constructor(values = [0, 0, 0], format = 'honeydew:1:test') { this.doc = Uint8Array.from(values); this.busy = null; this.gesture = false; this.format = format; this.media = new Map() }
  // Media the document refers to but keeps outside it, as a photo or audio app does: field i set refers to photo-i.
  assetsOf(doc) { return [...doc].flatMap((v, i) => v ? [`photo-${i}`] : []) }
  assets() { return this.assetsOf(this.doc).map((id) => ({ id, name: `${id}.bin`, have: this.media.has(id) })) }
  async readAsset(id) { return this.media.get(id) }
  // Where this person points and what they selected, and what the app shows of the others.
  presence() { return this.here ?? null }
  showPresence(others) { this.shown = others }
  async writeAsset(id, name, bytes) { this.media.set(id, new Blob([bytes])) }
  checkpoint() { if (this.gesture) throw 'busy'; return this.doc.slice() }
  // 9 in the first field stands for "no document": the app's own merge refuses it, as a real app's validation would.
  merge(base, current, edited) { if ([base, current, edited].some((d) => d[0] === 9)) throw 'not a document'; return merge(base, current, edited) }
  async apply(base, edited) {
    while (this.busy || this.gesture) await (this.busy ?? sleep(5))
    const replaced = this.doc.slice()
    this.doc = base ? merge(base, this.doc, edited) : edited.slice()
    return base ? undefined : replaced
  }
  connect(hooks) { this.hooks = hooks }
  disconnect() { this.hooks = null }
  edit(i, value) { this.doc[i] = value; this.hooks?.changed() }
  // A drag under way changes the document without a quiet frame; letting go reports it.
  drag(i, value) { this.gesture = true; this.doc[i] = value }
  drop() { this.gesture = false; this.hooks?.changed() }
  hold() { let release; this.busy = new Promise((resolve) => { release = resolve }); return () => { this.busy = null; release() } }
}

// Every live document a test started stops at the end, presence timers with them.
const hubs = []
after(() => { for (const hub of hubs) for (const s of hub.sessions.values()) s.live?.stop() })
class Hub {
  constructor() { hubs.push(this); this.clock = 0; this.sessions = new Map(); this.gates = new Map(); this.sent = []; this.pool = new Map() }
  // Holds messages from `from` to `to`, in order, until released.
  hold(from, to) {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    this.gates.set(`${from}>${to}`, gate)
    return () => { if (this.gates.get(`${from}>${to}`) === gate) this.gates.delete(`${from}>${to}`); release() }
  }
  async join(id, role, app = new App(), store = { saved: null, drafts: [] }, { linkFirst = false, page = '/honeydew/' } = {}) {
    const session = Object.assign(new EventTarget(), { id, role, room: id, page, config: role === 'owner' ? { owner: 'token' } : {}, peers: new Map() })
    store.document ??= async (record) => record === undefined ? store.saved && copy(store.saved) : void (store.saved = await copy(record))
    store.draft ??= async (bytes) => { store.drafts.push(bytes.slice()) }
    let chain = Promise.resolve()
    session.sendDocument = (peer, value) => {
      this.sent.push({ from: id, to: peer.id, type: value.type })
      const message = copy(value)
      return chain = chain.then(async () => {
        await this.gates.get(`${id}>${peer.id}`)
        const target = this.sessions.get(peer.id), from = target?.peers.get(id)
        if (from?.document.readyState === 'open') target.dispatchEvent(Object.assign(new Event('document'), { peer: from, value: await message }))
      })
    }
    // The session's file transfer, as one pool every member sees (PeerSession's verified transfer in the shell).
    Object.assign(session, { files: [], accepted: false, available: new Set(), store: { file: async (asset) => this.pool.get(asset) } })
    session.share = async (files, ids) => {
      for (const [i, file] of files.entries()) {
        const asset = `${ids[i]}:${file.size}`
        this.pool.set(asset, file)
        for (const s of this.sessions.values()) s.files = [...s.files.filter((f) => f.id !== ids[i]), { id: ids[i], name: file.name, size: file.size, asset }]
      }
      session.accepted = true
      for (const s of this.sessions.values()) { if (s.accepted) for (const f of s.files) s.available.add(f.asset); s.dispatchEvent(new Event('change')) }
    }
    session.receive = async () => { session.accepted = true; for (const f of session.files) session.available.add(f.asset); session.dispatchEvent(new Event('change')) }
    session.receiveFiles = async (wanted) => { for (const f of session.files) if (wanted.includes(f.id)) session.available.add(f.asset); session.dispatchEvent(new Event('change')) }
    this.sessions.set(id, session)
    const others = () => [...this.sessions.values()].filter((other) => other !== session)
    // As a real session: the roster (who is here, in which app, since when) arrives first, the channels open after.
    session.since = ++this.clock
    for (const other of others()) this.list(session, other)
    if (linkFirst) { for (const other of others()) this.link(session, other); await sleep(250) }
    const live = session.live = await LiveDocument.start({ session, adapter: app, store })
    if (!linkFirst) for (const other of others()) this.link(session, other)
    return { session, app, live, store }
  }
  list(a, b) {
    for (const [from, to] of [[a, b], [b, a]]) {
      from.peers.set(to.id, { id: to.id, role: to.role, page: to.page, since: to.since, document: { readyState: 'connecting' } })
      from.dispatchEvent(new Event('change'))
    }
  }
  link(a, b) {
    for (const [from, to] of [[a, b], [b, a]]) {
      const peer = from.peers.get(to.id)
      if (peer.document.readyState === 'open') continue
      peer.document.readyState = 'open'
      from.dispatchEvent(Object.assign(new Event('document-open'), { peer }))
    }
  }
  drop(id) {
    const gone = this.sessions.get(id)
    this.sessions.delete(id)
    gone.live.stop()
    for (const other of this.sessions.values()) {
      const peer = other.peers.get(id)
      if (!peer) continue
      peer.document.readyState = 'closed'; other.peers.delete(id)
      other.dispatchEvent(Object.assign(new Event('document-close'), { peer }))
    }
  }
}
const sent = (hub, from, to, type) => eventually(() => assert.ok(hub.sent.some((m) => m.from === from && m.to === to && m.type === type)))
const ids = () => [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort()
const values = (...members) => members.map((m) => [...m.app.doc])

const live = (...members) => eventually(() => assert.ok(members.every((m) => m.live.status === 'live')))
const converge = (members, expected) => eventually(() => assert.deepEqual(values(...members), members.map(() => expected)))

test('independent edits converge, a late viewer catches up and cannot edit', async () => {
  const hub = new Hub(), [o, e, v] = ids()
  const owner = await hub.join(o, 'owner', new App([1, 0, 0])), editor = await hub.join(e, 'editor')
  await converge([owner, editor], [1, 0, 0])
  owner.app.edit(1, 5); editor.app.edit(2, 7)
  await converge([owner, editor], [1, 5, 7])
  const viewer = await hub.join(v, 'viewer')
  await converge([viewer], [1, 5, 7])
  viewer.app.edit(0, 9)
  editor.app.edit(0, 3)
  await converge([owner, editor, viewer], [3, 5, 7])
  assert.equal(owner.live.status, 'live'); assert.equal(viewer.live.status, 'read-only')
})

test('a conflicting edit keeps one result everywhere and the rejected work as a draft', async () => {
  const hub = new Hub(), [o, e] = ids()
  const owner = await hub.join(o, 'owner'), editor = await hub.join(e, 'editor')
  await live(owner, editor)
  editor.app.edit(0, 2); owner.app.edit(0, 1)
  const drafts = () => [...owner.store.drafts, ...editor.store.drafts].map((d) => [...d])
  await eventually(() => { assert.equal(new Set(values(owner, editor).map(String)).size, 1); assert.equal(drafts().length, 1) })
  assert.notEqual(drafts()[0][0], owner.app.doc[0], 'the losing value survives only in the draft')
})

test('a kept draft opens as this person\'s version, proposed through the journal like any edit', async () => {
  const hub = new Hub(), [o, e] = ids()
  const owner = await hub.join(o, 'owner'), editor = await hub.join(e, 'editor')
  await live(owner, editor)
  editor.app.edit(0, 2); owner.app.edit(0, 1)
  await eventually(() => { assert.equal(new Set(values(owner, editor).map(String)).size, 1); assert.equal(owner.store.drafts.length + editor.store.drafts.length, 1) })
  const loser = owner.store.drafts.length ? owner : editor, [draft] = loser.store.drafts, shared = [...owner.app.doc]
  await loser.live.restoreDraft(draft)
  await converge([owner, editor], [...draft])
  assert.equal(loser.store.drafts.length, 1, 'the shared document it replaced needs no draft')
  // Undo takes it back out: it is this person's own entry in the journal.
  loser.app.hooks.undo(false)
  await converge([owner, editor], shared)
})

test('remote changes wait for a busy app, in order', async () => {
  const hub = new Hub(), [o, e] = ids()
  const owner = await hub.join(o, 'owner'), editor = await hub.join(e, 'editor')
  await live(owner, editor)
  const release = editor.app.hold()
  owner.app.edit(0, 1); await eventually(() => assert.equal(owner.live.acked.revision, 1))
  owner.app.edit(1, 2); await eventually(() => assert.equal(owner.live.acked.revision, 2))
  await sent(hub, o, e, 'entry'); await sleep(50)
  assert.deepEqual(values(editor), [[0, 0, 0]])
  assert.equal(editor.live.acked.revision, 0, 'acknowledged only once the app has it')
  release()
  await converge([owner, editor], [1, 2, 0])
})

test('Undo reverts only this person, around and after a remote edit', async () => {
  const hub = new Hub(), [o, e] = ids()
  const owner = await hub.join(o, 'owner'), editor = await hub.join(e, 'editor')
  await live(owner, editor)
  editor.app.edit(0, 4); await converge([owner, editor], [4, 0, 0])
  owner.app.edit(1, 6); await converge([owner, editor], [4, 6, 0])
  editor.app.hooks.undo(false); await converge([owner, editor], [0, 6, 0])
  editor.app.hooks.undo(true); await converge([owner, editor], [4, 6, 0])
  owner.app.hooks.undo(false); await converge([owner, editor], [4, 0, 0])
})

test('when the owner leaves an app its earliest editor hosts on, keeping every edit and Undo, and the owner takes it back', async () => {
  const hub = new Hub(), [o, e, f] = ids()
  const owner = await hub.join(o, 'owner'), first = await hub.join(e, 'editor'), second = await hub.join(f, 'editor')
  await live(owner, first, second)
  first.app.edit(0, 4); await converge([owner, first, second], [4, 0, 0])
  owner.app.edit(1, 5); await converge([owner, first, second], [4, 5, 0])
  hub.drop(o)
  second.app.edit(2, 6); await converge([first, second], [4, 5, 6])
  assert.ok(first.live.history && !second.live.history, 'the editor here longest hosts')
  first.app.hooks.undo(false); await converge([first, second], [0, 5, 6])
  // Back with its older journal: the owner hosts again and carries on the line the others went on with.
  const back = await hub.join(o, 'owner', new App([0, 0, 0]), owner.store)
  await converge([back, first, second], [0, 5, 6])
  await eventually(() => assert.ok(back.live.history && !first.live.history))
  first.app.hooks.undo(true); await converge([back, first, second], [4, 5, 6])
})

test('a reject that arrives after a conflict kept the edit as a draft leaves newer local work alone', async () => {
  const hub = new Hub(), [o, e] = ids()
  const owner = await hub.join(o, 'owner'), editor = await hub.join(e, 'editor')
  await live(owner, editor)
  const release = hub.hold(o, e)
  owner.app.edit(0, 1); await eventually(() => assert.equal(owner.live.acked.revision, 1))
  editor.app.edit(0, 2)
  await sent(hub, o, e, 'reject')
  const rejectLater = hub.hold(o, e); release()
  await converge([editor], [1, 0, 0])
  editor.app.edit(2, 9)
  await sleep(50); rejectLater()
  await converge([owner, editor], [1, 0, 9])
  assert.deepEqual(editor.store.drafts.map((d) => [...d]), [[2, 0, 0]])
})

test('a draft that cannot be stored never lets another person\'s change be proposed back', async () => {
  const hub = new Hub(), [o, e] = ids()
  const owner = await hub.join(o, 'owner'), editor = await hub.join(e, 'editor')
  await live(owner, editor)
  editor.store.draft = async () => { throw new Error('QuotaExceededError') }
  const release = hub.hold(o, e)
  owner.app.doc[0] = 1; owner.app.doc[1] = 5; owner.app.hooks.changed()
  await eventually(() => assert.equal(owner.live.acked.revision, 1))
  editor.app.edit(0, 2)
  await sent(hub, o, e, 'reject')
  release()
  await converge([editor], [1, 5, 0])
  editor.app.edit(2, 9)
  await converge([owner, editor], [1, 5, 9])
  assert.deepEqual(editor.live.unsaved.map((d) => [...d]), [[2, 0, 0]])
})

test('a document that starts after the owner\'s snapshot went out asks for another', async () => {
  const hub = new Hub(), [o, e] = ids()
  await hub.join(o, 'owner', new App([1, 2, 3]))
  const editor = await hub.join(e, 'editor', new App(), undefined, { linkFirst: true })
  await converge([editor], [1, 2, 3])
  assert.equal(editor.live.status, 'live')
})

test('another build keeps its work and says why instead of joining', async () => {
  const hub = new Hub(), [o, e] = ids()
  await hub.join(o, 'owner', new App([1, 0, 0]))
  const editor = await hub.join(e, 'editor', new App([5, 5, 5], 'honeydew:1:other'))
  await eventually(() => assert.equal(editor.live.status, 'incompatible'))
  editor.app.edit(2, 9); await sleep(50)
  assert.deepEqual([...editor.app.doc], [5, 5, 9])
  assert.match(editor.live.error, /honeydew:1:test/)
})

test('repeated resync requests cost the owner one snapshot', async () => {
  const hub = new Hub(), [o, v] = ids()
  await hub.join(o, 'owner')
  const viewer = await hub.join(v, 'viewer')
  await eventually(() => assert.equal(viewer.live.status, 'read-only'))
  const before = hub.sent.filter((m) => m.type === 'snapshot').length
  for (let i = 0; i < 50; i++) viewer.session.sendDocument(viewer.session.peers.get(o), { type: 'resync' })
  await sleep(500)
  assert.ok(hub.sent.filter((m) => m.type === 'snapshot').length - before <= 1)
})

test('nothing of a gesture under way is proposed, even when an acknowledgement arrives', async () => {
  const hub = new Hub(), [o, e] = ids()
  const owner = await hub.join(o, 'owner'), editor = await hub.join(e, 'editor')
  await live(owner, editor)
  const release = hub.hold(o, e)
  editor.app.edit(0, 1)
  await sent(hub, o, e, 'entry')
  editor.app.drag(1, 3)
  release(); await sleep(100)
  assert.deepEqual([...owner.app.doc], [1, 0, 0])
  editor.app.drop()
  await converge([owner, editor], [1, 3, 0])
})

test('proposals reach the journal as they arrive, so its pending bound rejects a flood', async () => {
  const { delta } = await import('../shell/document-delta.js')
  const hub = new Hub(), [o, e] = ids(), ownerStore = { saved: null, drafts: [] }
  const owner = await hub.join(o, 'owner', new App(), ownerStore), editor = await hub.join(e, 'editor')
  await live(owner, editor)
  const save = ownerStore.document
  ownerStore.document = async (record) => { if (record !== undefined) await sleep(500); return save(record) }
  const { acked } = editor.live, edit = await delta(acked.bytes, Uint8Array.from([1, 0, 0])), peer = editor.session.peers.get(o)
  for (let i = 0; i < 80; i++) editor.session.sendDocument(peer, { type: 'propose', app: '/honeydew/', proposal: { version: 1, document: acked.document, format: 'honeydew:1:test', id: crypto.randomUUID(), base: acked.revision, kind: 'edit', edit } })
  const rejects = []
  owner.session.addEventListener('document', () => {})
  await eventually(() => {
    rejects.splice(0, rejects.length, ...hub.sent.filter((m) => m.from === o && m.type === 'reject'))
    assert.ok(rejects.length >= 80 - 64 - 1)
  })
})

test('the owner shares nothing until it has a document every peer can install', async () => {
  const hub = new Hub(), [o, e] = ids(), app = new App([9, 0, 0])
  const starting = hub.join(o, 'owner', app)
  await sleep(100)
  app.doc = Uint8Array.from([1, 2, 3])
  const owner = await starting, editor = await hub.join(e, 'editor')
  await converge([owner, editor], [1, 2, 3])
})

test('media reach the people who lack them, shared only by whoever added them to the document', async () => {
  const hub = new Hub(), [o, e] = ids(), ownerApp = new App([0, 1, 0]), editorApp = new App()
  const bytes = async (app, id) => [...new Uint8Array(await app.media.get(id)?.arrayBuffer() ?? new ArrayBuffer(0))]
  ownerApp.media.set('photo-1', new Blob([Uint8Array.of(1, 2, 3)]))
  // A file the owner has from elsewhere: someone else referring to it must not make the owner share it.
  ownerApp.media.set('photo-0', new Blob([Uint8Array.of(7)]))
  const owner = await hub.join(o, 'owner', ownerApp), editor = await hub.join(e, 'editor', editorApp)
  await live(owner, editor)
  await eventually(async () => assert.deepEqual(await bytes(editorApp, 'photo-1'), [1, 2, 3]))
  assert.equal(editor.session.accepted, false, 'the session\'s other files still wait for the editor to accept them')
  editorApp.edit(0, 1)
  editorApp.media.set('photo-2', new Blob([Uint8Array.of(9)]))
  editorApp.edit(2, 1)
  await eventually(async () => assert.deepEqual(await bytes(ownerApp, 'photo-2'), [9]))
  assert.equal(owner.session.files.length, 2)
  assert.equal(editorApp.media.has('photo-0'), false)
})

test('presence reaches the others, stays out of the document, and goes when they leave', async () => {
  const hub = new Hub(), [o, e] = ids(), ownerApp = new App(), editorApp = new App()
  ownerApp.here = { cursor: [1, 2] }
  const owner = await hub.join(o, 'owner', ownerApp), editor = await hub.join(e, 'editor', editorApp)
  await eventually(() => assert.deepEqual(editorApp.shown?.map((p) => [p.id, p.state]), [[o, { cursor: [1, 2] }]]))
  editorApp.here = { selection: [7] }
  await eventually(() => assert.deepEqual(ownerApp.shown?.map((p) => p.state), [{ selection: [7] }]))
  assert.match(ownerApp.shown[0].color, /^#[0-9a-f]{6}$/)
  assert.deepEqual(values(owner, editor), [[0, 0, 0], [0, 0, 0]])
  hub.drop(e)
  await eventually(() => assert.deepEqual(ownerApp.shown, []))
  // A page whose app attached late still gets the others' presence (its first one asks for theirs).
  const late = await hub.join(crypto.randomUUID(), 'viewer', Object.assign(new App(), { here: null }), undefined, { linkFirst: true })
  await eventually(() => assert.deepEqual(late.app.shown?.map((p) => p.state), [{ cursor: [1, 2] }]))
  owner.live.stop()
})

test('a session spans apps: each app edits its own document with its own host', async () => {
  const hub = new Hub(), [o, e, x] = ids()
  const owner = await hub.join(o, 'owner', new App([1, 0, 0])), editor = await hub.join(e, 'editor')
  await converge([owner, editor], [1, 0, 0])
  // Someone in another app hosts that app's document: the owner's is not theirs.
  const other = await hub.join(x, 'editor', new App([7, 7, 7], 'gridcraft:1:test'), undefined, { page: '/gridcraft/' })
  await eventually(() => assert.equal(other.live.status, 'live'))
  other.app.edit(0, 8)
  owner.app.edit(1, 5)
  await converge([owner, editor], [1, 5, 0])
  await eventually(() => assert.deepEqual([...other.app.doc], [8, 7, 7]))
  assert.ok(!hub.sent.some((m) => (m.from === o && m.to === x || m.from === x && m.to !== x) && ['snapshot', 'entry'].includes(m.type)), 'one app\'s document goes only to people in that app')
})

test('media an app turns down is not handed to it again on every change', async () => {
  const hub = new Hub(), [o, e] = ids(), ownerApp = new App([0, 1, 0]), editorApp = new App()
  ownerApp.media.set('photo-1', new Blob([Uint8Array.of(1)]))
  let offered = 0
  editorApp.writeAsset = async () => { offered++ }
  const owner = await hub.join(o, 'owner', ownerApp), editor = await hub.join(e, 'editor', editorApp)
  await live(owner, editor)
  await eventually(() => assert.equal(offered, 1))
  for (let i = 0; i < 5; i++) { editor.session.dispatchEvent(new Event('change')); await sleep(20) }
  assert.equal(offered, 1)
})
