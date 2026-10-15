import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { randomToken, tokenHash, seal, signalKey } from '../shell/session-protocol.js'

let mf
const origin = 'http://localhost'
const owner = randomToken(), editor = randomToken(), viewer = randomToken()
const room = crypto.randomUUID()
let host, guest
const call = (action, body, { authorization, headers = {}, target = room } = {}) => mf.dispatchFetch(`${origin}/api/session/${target}/${action}`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', ...(authorization ? { authorization: `Bearer ${authorization}` } : {}), ...headers }, body: JSON.stringify(body),
})
before(async () => {
  mf = new Miniflare({ ...convertV4MiniflareOptions({ name: 'rooms-test', modules: ['worker.js', 'session-room.js', 'shell/session-protocol.js'].filter(existsSync).map(path => ({ type: 'ESModule', path, contents: readFileSync(path, 'utf8') })), compatibilityDate: '2026-10-01',
    bindings: { SESSIONS_ENABLED: 'true' },
    durableObjects: existsSync('session-room.js') ? { ROOMS: { className: 'SessionRoom', useSQLite: true } } : {},
    ratelimits: { SESSION_LIMITER: { namespace_id: '1001', simple: { limit: 1000, period: 60 } } },
    serviceBindings: { ASSETS: () => new Response('asset', { status: 404 }) },
  }), unsafeInspectDurableObjects: true })
})
after(async () => { await mf?.dispose() })

test('room authenticates members and enforces capacity, origins and owner privileges', async () => {
  const r = await call('create', { app: '/honeydew/', owner: await tokenHash(owner), editor: await tokenHash(editor), viewer: await tokenHash(viewer) })
  assert.equal(r.status, 201)
  host = await r.json()
  assert.equal(host.role, 'owner')
  assert.equal((await call('join', { token: 'wrong' })).status, 403)
  assert.equal((await call('join', { token: editor }, { headers: { origin: 'https://evil.test' } })).status, 403)
  guest = await (await call('join', { token: viewer })).json()
  assert.equal(guest.role, 'viewer')
  assert.equal((await call('admin', { lock: true }, { authorization: guest.token })).status, 403)
  for (let i = 0; i < 6; i++) assert.equal((await call('join', { token: editor })).status, 201)
  assert.equal((await call('join', { token: editor })).status, 409)
  assert.equal((await call('create', {}, { target: 'not-a-uuid' })).status, 404)
  assert.equal((await call('join', { token: editor, padding: 'x'.repeat(20000) })).status, 413)
})

async function socket(member) {
  const result = await mf.dispatchFetch(`${origin}/api/session/${room}/socket`, { headers: { Upgrade: 'websocket', origin } })
  assert.equal(result.status, 101)
  const ws = result.webSocket
  ws.accept()
  const queue = [], waiting = []
  ws.addEventListener('message', (e) => { const v = JSON.parse(e.data); waiting.length ? waiting.shift()(v) : queue.push(v) })
  const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket message timed out')), 3000)
    waiting.push((value) => { clearTimeout(timer); resolve(value) })
  })
  ws.send(JSON.stringify({ type: 'auth', id: member.id, token: member.token }))
  return { ws, next }
}

test('sockets authenticate, server stamps encrypted signaling, removal revokes access', async () => {
  assert.ok(host && guest)
  const a = await socket(host)
  const roster = await a.next()
  assert.equal(roster.type, 'roster')
  const b = await socket(guest)
  await b.next()
  const updated = await a.next()
  assert.equal(updated.peers.length, 2)
  const ag = updated.peers.find((p) => p.id === host.id).generation
  const bg = updated.peers.find((p) => p.id === guest.id).generation
  const envelope = await seal(await signalKey(randomToken()), [room, updated.epoch, host.id, ag, guest.id, bg, 1], { sdp: 'secret' })
  await mf.unsafeEvictDurableObject('rooms-test', 'SessionRoom', { name: room, webSockets: 'hibernate' })
  a.ws.send(JSON.stringify({ type: 'signal', to: guest.id, generation: bg, seq: 1, envelope }))
  const signal = await b.next()
  assert.equal(signal.from, host.id)
  assert.equal(signal.generation, ag)
  assert.deepEqual(signal.envelope, envelope)
  assert.equal((await call('turn', { id: guest.id }, { authorization: guest.token })).status, 503)
  const nextEditor = randomToken(), nextViewer = randomToken()
  const removed = await call('admin', { remove: guest.id, editor: await tokenHash(nextEditor), viewer: await tokenHash(nextViewer) }, { authorization: owner })
  assert.equal(removed.status, 200)
  assert.equal((await call('join', { token: viewer })).status, 403)
  assert.equal((await call('turn', { id: guest.id }, { authorization: guest.token })).status, 403)
  assert.equal((await call('admin', { lock: true }, { authorization: owner })).status, 200)
  assert.equal((await call('join', { token: nextEditor })).status, 403)
  a.ws.close(); b.ws.close()
})

test('room metadata survives eviction without persisting bearer credentials or project content', async () => {
  const db = await mf.unsafeGetDurableObjectStorage('rooms-test', 'SessionRoom', { name: room })
  const data = await db.exec('SELECT value FROM room')
  const stored = JSON.stringify(data)
  for (const secret of [owner, editor, viewer, host.token, guest.token, 'private SDP', 'secret']) assert.ok(!stored.includes(secret))
  await mf.unsafeEvictDurableObject('rooms-test', 'SessionRoom', { name: room })
  assert.equal((await call('admin', { lock: false }, { authorization: owner })).status, 200)
  assert.equal((await call('admin', { lock: false }, { authorization: guest.token })).status, 403)
})

test('unauthenticated and oversized socket frames are closed before they can signal', async () => {
  for (const [payload, code] of [[JSON.stringify({ type: 'signal', to: host.id }), 4003], ['x'.repeat(196609), 1009]]) {
    const r = await mf.dispatchFetch(`${origin}/api/session/${room}/socket`, { headers: { Upgrade: 'websocket', origin } })
    const ws = r.webSocket; ws.accept()
    const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code), { once: true }))
    ws.send(payload)
    assert.equal(await closed, code)
  }
})
