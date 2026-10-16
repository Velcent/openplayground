import test from 'node:test'
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
  constructor(values = [0, 0, 0], format = 'honeydew:1:test') { this.doc = Uint8Array.from(values); this.busy = null; this.gesture = false; this.format = format }
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

class Hub {
  constructor() { this.sessions = new Map(); this.gates = new Map(); this.sent = [] }
  // Holds messages from `from` to `to`, in order, until released.
  hold(from, to) {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    this.gates.set(`${from}>${to}`, gate)
    return () => { if (this.gates.get(`${from}>${to}`) === gate) this.gates.delete(`${from}>${to}`); release() }
  }
  async join(id, role, app = new App(), store = { saved: null, drafts: [] }, { linkFirst = false } = {}) {
    const session = Object.assign(new EventTarget(), { id, role, room: id, config: role === 'owner' ? { owner: 'token' } : {}, peers: new Map() })
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
    this.sessions.set(id, session)
    const others = () => [...this.sessions.values()].filter((other) => other !== session)
    if (linkFirst) { for (const other of others()) this.link(session, other); await sleep(50) }
    const live = session.live = await LiveDocument.start({ session, adapter: app, store })
    if (!linkFirst) for (const other of others()) this.link(session, other)
    return { session, app, live, store }
  }
  link(a, b) {
    for (const [from, to] of [[a, b], [b, a]]) {
      const peer = { id: to.id, role: to.role, document: { readyState: 'open' } }
      from.peers.set(to.id, peer)
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

test('the owner leaving pauses editing; local work syncs after the owner restores its journal', async () => {
  const hub = new Hub(), [o, e] = ids()
  const owner = await hub.join(o, 'owner'), editor = await hub.join(e, 'editor')
  await live(owner, editor)
  owner.app.edit(0, 1); await converge([editor], [1, 0, 0])
  hub.drop(o)
  assert.equal(editor.live.status, 'paused')
  editor.app.edit(2, 8)
  const back = await hub.join(o, 'owner', new App([0, 0, 0]), owner.store)
  await converge([back, editor], [1, 0, 8])
  assert.equal(editor.live.status, 'live')
  editor.app.hooks.undo(false)
  await converge([back, editor], [1, 0, 0])
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
  for (let i = 0; i < 80; i++) editor.session.sendDocument(peer, { type: 'propose', proposal: { version: 1, document: acked.document, format: 'honeydew:1:test', id: crypto.randomUUID(), base: acked.revision, kind: 'edit', edit } })
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
