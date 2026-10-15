import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { sessionSite } from './session-helpers.mjs'
import { until } from './helpers.mjs'
let site
before(async () => { site = await sessionSite() })
after(async () => { await site?.close() })

test('three browsers receive only chosen files, verify bytes and enforce viewer access', async () => {
  const a = await site.page(), b = await site.page(), c = await site.page()
  assert.equal(await a.evaluate(() => typeof PeerSession), 'function')
  const invite = await a.evaluate(async () => {
    const personal = await import('/shell/store.js')
    await personal.write('/private.txt', new Blob(['do not share']))
    const file = new File([Uint8Array.from({ length: 140003 }, (_, i) => i % 251)], 'song.wav')
    window.session = await PeerSession.create({ app: '/honeydew/', name: 'Alice', files: [file, new File([], 'empty.txt')] })
    return session.invite('viewer')
  })
  for (const [page, name] of [[b, 'Bob'], [c, 'Carol']]) {
    await page.evaluate(async ({ invite, name }) => { window.session = await PeerSession.join(invite, { name }) }, { invite, name })
    await until(() => page.evaluate(() => session.files.length === 2), 15000, 'manifest')
    assert.equal(await page.evaluate(() => session.status), 'awaiting acceptance')
    assert.equal(await page.evaluate(async () => { try { await session.store.file(session.files[0].asset); return true } catch { return false } }), false)
    await page.evaluate(() => session.receive())
  }
  await until(() => c.evaluate(() => session.status === 'ready'), 10000, 'verified transfer')
  for (const page of [a, b, c]) {
    await until(() => page.evaluate(() => session.peers.size === 2 && [...session.peers.values()].every((p) => p.channel?.readyState === 'open')), 15000, 'peer mesh')
    const result = await page.evaluate(async () => {
      const f = session.files.find(f => f.name === 'song.wav')
      const bytes = new Uint8Array(await (await session.store.file(f.asset)).arrayBuffer())
      const personal = await import('/shell/store.js')
      return { matches: bytes.length === 140003 && bytes.every((v, i) => v === i % 251), received: session.progress.received, total: session.progress.total, personal: (await personal.list('/')).map(x => x.name) }
    })
    assert.equal(result.matches, true)
    assert.equal(result.received, result.total)
    assert.deepEqual(result.personal, page === a ? ['private.txt'] : [])
  }
  assert.match(await b.evaluate(async () => { try { await session.share([new File(['bad'], 'bad.txt')]); return 'accepted' } catch (e) { return e.message } }), /viewer/i)
  const removed = await b.evaluate(() => session.id)
  await a.evaluate((id) => session.admin({ remove: id }), removed)
  await until(() => b.evaluate(() => session.status === 'removed'), 12000, 'revocation')
  assert.equal(await c.evaluate(async () => (await session.store.file(session.files.find(f => f.name === 'song.wav').asset)).size), 140003)
  for (const page of [a, b, c]) await page.evaluate(() => session.leave())
})

test('interrupted downloads resume verified chunks, including files added during transfer', async () => {
  const a = await site.page(), b = await site.page()
  const invite = await a.evaluate(async () => {
    window.session = await PeerSession.create({ app: '/honeydew/', files: [new File([new Uint8Array(65536 * 5 + 9).fill(37)], 'audio.wav')] })
    return session.invite()
  })
  await b.evaluate(async invite => { window.session = await PeerSession.join(invite) }, invite)
  await until(() => b.evaluate(() => session.files.length === 1))
  // Cut the connection after one chunk is durably written, before acknowledging it.
  await b.evaluate(async () => {
    const write = session.store.putChunk.bind(session.store)
    session.store.putChunk = async (...args) => { await write(...args); session.leave(); throw new Error('Disconnected during transfer') }
    await session.receive()
  })
  await until(() => b.evaluate(() => session.stopped))
  assert.equal(await b.evaluate(async () => (await session.store.missing(session.files[0].asset)).length), 5)
  await a.evaluate(() => session.share([new File(['second'], 'notes.txt')]))
  await b.reload()
  await b.evaluate(async invite => {
    window.PeerSession = (await import('/shell/session.js')).PeerSession
    window.session = await PeerSession.join(invite)
    window.chunkIndexes = []
    const write = session.store.putChunk.bind(session.store)
    session.store.putChunk = (...args) => { chunkIndexes.push(args[1]); return write(...args) }
  }, invite)
  await until(() => b.evaluate(() => session.status === 'ready' && session.files.length === 2), 15000, 'resumed transfer')
  assert.equal(await b.evaluate(async () => (await session.store.file(session.files[0].asset)).size), 65536 * 5 + 9)
  assert.deepEqual(await b.evaluate(() => chunkIndexes), [1, 2, 3, 4, 5, 0])
  for (const page of [a, b]) await page.evaluate(() => session.leave())
  assert.equal(await b.evaluate(async () => (await session.store.file(session.files[1].asset)).text()), 'second')
})

test('wrong secrets, mismatched apps and forged viewer manifests cannot change shared files', async () => {
  const a = await site.page(), b = await site.page(), c = await site.page()
  const invite = await a.evaluate(async () => {
    window.session = await PeerSession.create({ app: '/honeydew/', files: [new File(['safe'], 'score.txt')] })
    return session.invite('viewer')
  })
  const wrongApp = await c.evaluate(async invite => {
    const {readInvite} = await import('/shell/session-protocol.js')
    try { await PeerSession.join({...readInvite(invite), app:'/wordcraft/'}); return 'accepted' } catch(e) { return e.message }
  }, invite)
  assert.match(wrongApp, /another app/)
  await c.evaluate(async invite => {
    const {readInvite,randomToken} = await import('/shell/session-protocol.js')
    window.session = await PeerSession.join({...readInvite(invite),secret:randomToken()})
  }, invite)
  await until(() => c.evaluate(() => session.status === 'failed'), 10000, 'authentication rejection')
  assert.equal(await c.evaluate(() => session.files.length), 0)
  await c.evaluate(() => session.leave())
  await b.evaluate(async invite => { window.session = await PeerSession.join(invite) }, invite)
  await until(() => b.evaluate(() => session.files.length === 1))
  await b.evaluate(async () => {
    const peer = [...session.peers.values()].find(p=>p.role==='owner')
    await session.send(peer, { type:'manifest', length:2 })
  })
  await until(() => a.evaluate(() => [...session.peers.values()].some(p=>/Unauthorized/.test(p.error))), 10000, 'viewer rejection')
  assert.equal(await a.evaluate(async () => (await session.store.file(session.files[0].asset)).text()), 'safe')
  for (const page of [a, b]) await page.evaluate(() => session.leave())
})
