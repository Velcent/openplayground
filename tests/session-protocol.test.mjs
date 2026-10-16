import assert from 'node:assert/strict'
import { test } from 'node:test'
const p = await import('../shell/session-protocol.js').catch(() => ({}))

test('signaling authenticates the key, destination, generation and ciphertext', async () => {
  assert.equal(typeof p.signalKey, 'function')
  const key = await p.signalKey(p.randomToken())
  const context = ['room', 1, 'alice', 'gen-a', 'bob', 'gen-b', 1]
  const packet = await p.seal(key, context, { type: 'offer', sdp: 'private SDP' })
  assert.deepEqual(await p.open(key, context, packet), { type: 'offer', sdp: 'private SDP' })
  assert.ok(!JSON.stringify(packet).includes('private SDP'))
  for (let i = 0; i < context.length; i++) {
    const changed = [...context]; changed[i] = `${changed[i]}wrong`
    await assert.rejects(() => p.open(key, changed, packet))
  }
  const wrong = await p.signalKey(p.randomToken())
  await assert.rejects(() => p.open(wrong, context, packet))
  await assert.rejects(() => p.open(key, context, { ...packet, data: packet.data.slice(0, -3) + 'AAA' }))
})

test('invite stays in the fragment and preserves the app URL', () => {
  assert.equal(typeof p.inviteURL, 'function')
  const invite = { room: 'b98ea707-95fd-486d-9749-542939cd7c5d', token: p.randomToken(), secret: p.randomToken(), app: '/honeydew/' }
  const url = p.inviteURL('https://example.test/honeydew/?mode=dark#page=2', invite)
  assert.equal(new URL(url).search, `?mode=dark&pg-session=${invite.room}`, 'only the room ID, never the secret, is in the query')
  assert.equal(new URLSearchParams(new URL(url).hash.slice(1)).get('page'), '2')
  assert.deepEqual(p.readInvite(url), invite)
  assert.equal(p.readInvite('https://example.test/honeydew/#page=2'), null)
  assert.throws(() => p.readInvite('https://example.test/honeydew/#pg-session=garbage'))
  assert.throws(() => p.inviteURL('https://example.test/honeydew/', { ...invite, token: 'short' }))
})

test('asset manifests reject traversal, impossible lengths and forged hashes', async () => {
  assert.equal(typeof p.validateManifest, 'function')
  assert.equal(await p.digest(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  const hash = await p.digest(new Uint8Array([1, 2, 3]))
  const file = { id: 'a', name: 'picture.png', size: 3, hashes: [hash], asset: await p.assetId(3, [hash]) }
  assert.deepEqual(await p.validateManifest([file]), [file])
  for (const change of [{ name: '../secret' }, { name: 'a\\b' }, { size: -1 }, { size: 8 * 1024 ** 3 + 1 }, { size: 4 }, { hashes: [] }, { asset: '0'.repeat(64) }, { id: '../a' }]) {
    await assert.rejects(() => p.validateManifest([{ ...file, ...change }]))
  }
  await assert.rejects(() => p.validateManifest([file, file]))
  const empty = { id: 'empty', name: 'empty.txt', size: 0, hashes: [], asset: await p.assetId(0, []) }
  assert.deepEqual(await p.validateManifest([empty]), [empty])
})
