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
const tick = () => new Promise((resolve) => setImmediate(resolve))
async function settle() { for (let i = 0; i < 50; i++) await tick() }

class App {
  constructor(values = [0, 0, 0]) { this.doc = Uint8Array.from(values); this.busy = null; this.format = 'honeydew:1:test' }
  checkpoint() { return this.doc.slice() }
  merge(base, current, edited) { return merge(base, current, edited) }
  async apply(base, edited) {
    while (this.busy) await this.busy
    this.doc = base ? merge(base, this.doc, edited) : edited.slice()
  }
  connect(hooks) { this.hooks = hooks }
  disconnect() { this.hooks = null }
  edit(i, value) { this.doc[i] = value; this.hooks?.changed() }
  hold() { let release; this.busy = new Promise((resolve) => { release = resolve }); return () => { this.busy = null; release() } }
}

class Hub {
  constructor() { this.sessions = new Map() }
  async join(id, role, app = new App(), store = { saved: null, drafts: [] }) {
    const session = Object.assign(new EventTarget(), { id, role, room: id, config: role === 'owner' ? { owner: 'token' } : {}, peers: new Map() })
    store.document ??= async (record) => record === undefined ? store.saved && copy(store.saved) : void (store.saved = await copy(record))
    store.draft ??= async (bytes) => { store.drafts.push(bytes.slice()) }
    session.sendDocument = async (peer, value) => {
      const target = this.sessions.get(peer.id)
      const message = await copy(value)
      const from = target?.peers.get(id)
      if (from?.document.readyState === 'open') target.dispatchEvent(Object.assign(new Event('document'), { peer: from, value: message }))
    }
    this.sessions.set(id, session)
    const live = session.live = await LiveDocument.start({ session, adapter: app, store })
    for (const other of this.sessions.values()) if (other !== session) this.link(session, other)
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
const ids = () => [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort()
const values = (...members) => members.map((m) => [...m.app.doc])

test('independent edits converge, a late viewer catches up and cannot edit', async () => {
  const hub = new Hub(), [o, e, v] = ids()
  const owner = await hub.join(o, 'owner', new App([1, 0, 0])), editor = await hub.join(e, 'editor')
  await settle()
  assert.deepEqual(values(owner, editor), [[1, 0, 0], [1, 0, 0]])
  owner.app.edit(1, 5); editor.app.edit(2, 7)
  await settle()
  assert.deepEqual(values(owner, editor), [[1, 5, 7], [1, 5, 7]])
  const viewer = await hub.join(v, 'viewer')
  await settle()
  viewer.app.edit(0, 9)
  editor.app.edit(0, 3)
  await settle()
  assert.deepEqual(values(owner, editor, viewer), [[3, 5, 7], [3, 5, 7], [3, 5, 7]])
  assert.equal(owner.live.status, 'live'); assert.equal(viewer.live.status, 'read-only')
})

test('a conflicting edit keeps one result everywhere and the rejected work as a draft', async () => {
  const hub = new Hub(), [o, e] = ids()
  const owner = await hub.join(o, 'owner'), editor = await hub.join(e, 'editor')
  await settle()
  editor.app.edit(0, 2); owner.app.edit(0, 1)
  await settle()
  const [a, b] = values(owner, editor)
  assert.deepEqual(a, b)
  const drafts = [...owner.store.drafts, ...editor.store.drafts].map((d) => [...d])
  assert.equal(drafts.length, 1)
  assert.notEqual(drafts[0][0], a[0], 'the losing value survives only in the draft')
})

test('remote changes wait for a busy app, in order', async () => {
  const hub = new Hub(), [o, e] = ids()
  const owner = await hub.join(o, 'owner'), editor = await hub.join(e, 'editor')
  await settle()
  const release = editor.app.hold()
  owner.app.edit(0, 1); await settle(); owner.app.edit(1, 2); await settle()
  assert.deepEqual(values(editor), [[0, 0, 0]])
  release(); await settle()
  assert.deepEqual(values(owner, editor), [[1, 2, 0], [1, 2, 0]])
})

test('Undo reverts only this person, around and after a remote edit', async () => {
  const hub = new Hub(), [o, e] = ids()
  const owner = await hub.join(o, 'owner'), editor = await hub.join(e, 'editor')
  await settle()
  editor.app.edit(0, 4); await settle()
  owner.app.edit(1, 6); await settle()
  editor.app.hooks.undo(false); await settle()
  assert.deepEqual(values(owner, editor), [[0, 6, 0], [0, 6, 0]])
  editor.app.hooks.undo(true); await settle()
  assert.deepEqual(values(owner, editor), [[4, 6, 0], [4, 6, 0]])
  owner.app.hooks.undo(false); await settle()
  assert.deepEqual(values(owner, editor), [[4, 0, 0], [4, 0, 0]])
})

test('the owner leaving pauses editing; local work syncs after the owner restores its journal', async () => {
  const hub = new Hub(), [o, e] = ids()
  const owner = await hub.join(o, 'owner'), editor = await hub.join(e, 'editor')
  await settle()
  owner.app.edit(0, 1); await settle()
  hub.drop(o); await settle()
  assert.equal(editor.live.status, 'paused')
  editor.app.edit(2, 8); await settle()
  const back = await hub.join(o, 'owner', new App([0, 0, 0]), owner.store)
  await settle()
  assert.equal(editor.live.status, 'live')
  assert.deepEqual(values(back, editor), [[1, 0, 8], [1, 0, 8]])
  editor.app.hooks.undo(false); await settle()
  assert.deepEqual(values(back, editor), [[1, 0, 0], [1, 0, 0]])
})
