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
    if (process.env.SESSION_RELAY === '1') assert.equal(await page.evaluate(async () => {
      for (const peer of session.peers.values()) {
        const stats = await peer.pc.getStats()
        const transport = [...stats.values()].find(s=>s.type==='transport' && s.selectedCandidatePairId)
        const pair = stats.get(transport?.selectedCandidatePairId)
        if (stats.get(pair?.localCandidateId)?.candidateType !== 'relay') return false
      }
      return true
    }), true, 'every selected connection must actually use TURN')
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


test('new files announced mid-transfer are queued once, identical assets reuse verified bytes', async () => {
  const a = await site.page(), b = await site.page()
  const invite = await a.evaluate(async () => {
    window.session = await PeerSession.create({ app:'/honeydew/',files:[new File([new Uint8Array(65536 * 12).fill(7)],'first.wav')] })
    return session.invite()
  })
  await b.evaluate(async invite => { window.session=await PeerSession.join(invite) },invite)
  await until(()=>b.evaluate(()=>session.files.length===1))
  await b.evaluate(async () => {
    const put=session.store.putChunk.bind(session.store)
    session.store.putChunk=async(...args)=>{await new Promise(r=>setTimeout(r,40));return put(...args)}
    await session.receive()
  })
  await until(()=>b.evaluate(()=>session.progress.received>0))
  await Promise.all([
    a.evaluate(()=>session.share([new File(['new'],'same.txt'),new File(['new'],'same.txt')])),
    b.evaluate(()=>session.share([new File(['peer'],'peer.txt')])),
  ])
  for(const page of [a,b]) {
    await until(()=>page.evaluate(()=>session.files.length===4&&session.status==='ready'),10000,'concurrent additions during transfer')
    assert.deepEqual(await page.evaluate(async()=>({total:session.progress.total,files:(await Promise.all(session.files.filter(f=>f.name!=='first.wav').map(async f=>(await session.store.file(f.asset)).text()))).sort()})),{total:65536*12+7,files:['new','new','peer']})
  }
  await b.evaluate(()=>{window.framesAfterReady=0;for(const p of session.peers.values())p.channel.addEventListener('message',()=>framesAfterReady++)})
  await new Promise(r=>setTimeout(r,300))
  assert.ok(await b.evaluate(()=>framesAfterReady<5),'ready peers must not echo inventory forever')
  for(const page of [a,b])await page.evaluate(()=>session.leave())
})

test('simultaneous manifests preserve both additions before and after acceptance', async () => {
  const page = await site.page()
  for (const accepted of [false, true]) {
    const result = await page.evaluate(async accepted => {
      const { describe } = await import('/shell/session-store.js')
      const session = new PeerSession({room:crypto.randomUUID(),role:'editor',accepted})
      const peers = await Promise.all(['a.txt','b.txt'].map(async name => {
        const manifest=JSON.stringify([await describe(new File([name],name))])
        return {id:crypto.randomUUID(),role:'editor',manifest,manifestSize:manifest.length}
      }))
      for (const peer of peers) session.peers.set(peer.id,peer)
      await Promise.all(peers.map(p=>session.message(p,JSON.stringify({type:'manifest-end'}))))
      return {files:session.files.map(f=>f.name).sort(),stored:(await session.store.manifest()).map(f=>f.name).sort()}
    }, accepted)
    assert.deepEqual(result.files,['a.txt','b.txt'])
    assert.deepEqual(result.stored,accepted?['a.txt','b.txt']:[])
  }
})

test('opening the same session in another tab displaces the old tab without a reconnect loop', async () => {
  const owner = await site.page(), first = await site.page()
  const invite = await owner.evaluate(async () => {
    window.session=await PeerSession.create({app:'/honeydew/',files:[new File(['safe'],'safe.txt')]})
    return session.invite()
  })
  await first.evaluate(async invite=>{window.session=await PeerSession.join(invite)},invite)
  const second=await first.context().newPage()
  await second.goto(`${site.url}/shell/paths.js`)
  await second.evaluate(async invite=>{
    window.session=await (await import('/shell/session.js')).PeerSession.join(invite)
  },invite)
  await until(()=>first.evaluate(()=>session.stopped&&session.status==='displaced'),5000,'old tab stopped')
  await until(()=>second.evaluate(()=>[...session.peers.values()].some(p=>p.channel?.readyState==='open')))
  const generation=await second.evaluate(()=>session.generation)
  await new Promise(r=>setTimeout(r,2000))
  assert.equal(await second.evaluate(()=>session.generation),generation)
  for (const page of [owner,first,second]) await page.evaluate(()=>session.leave())
})

test('a closed transfer channel offers retry and resumes verified data', async () => {
  const a=await site.page(), b=await site.page()
  const invite=await a.evaluate(async()=>{
    window.session=await PeerSession.create({app:'/honeydew/',files:[new File([new Uint8Array(200000).fill(19)],'track.wav')]})
    return session.invite()
  })
  await b.evaluate(async invite=>{window.session=await PeerSession.join(invite)},invite)
  await until(()=>b.evaluate(()=>session.files.length===1))
  await b.evaluate(async()=>{
    const put=session.store.putChunk.bind(session.store)
    session.store.putChunk=async(...args)=>{
      await put(...args)
      session.store.putChunk=put
      for(const p of session.peers.values())p.channel.close()
    }
    await session.receive()
  })
  await until(()=>b.evaluate(()=>session.status==='failed'),5000,'retry state')
  assert.equal(await b.evaluate(async()=> (await session.store.missing(session.files[0].asset)).length),3)
  await b.evaluate(async()=>{session.leave();await session.connect()})
  await until(()=>b.evaluate(()=>session.status==='ready'),10000,'resumed channel')
  assert.equal(await b.evaluate(async()=>new Uint8Array(await(await session.store.file(session.files[0].asset)).arrayBuffer()).every(v=>v===19)),true)
  for(const page of [a,b])await page.evaluate(()=>session.leave())
})

test('document messages carry nested bytes beside a file transfer, and a stray frame closes only that channel', async () => {
  const a = await site.page(), b = await site.page()
  const invite = await a.evaluate(async () => {
    window.session = await PeerSession.create({ app: '/honeydew/', files: [new File([new Uint8Array(3000000).fill(5)], 'big.wav')] })
    return session.invite()
  })
  await b.evaluate(async (invite) => {
    window.session = await PeerSession.join(invite); window.got = []
    session.addEventListener('document', (e) => got.push(e.value))
    await session.receive()
  }, invite)
  await until(() => a.evaluate(() => [...session.peers.values()].some((p) => p.document?.readyState === 'open')), 15000, 'document channel')
  await a.evaluate(() => {
    const bytes = Uint8Array.from({ length: 200000 }, (_, i) => i % 253)
    return session.sendDocument([...session.peers.values()][0], { type: 'snapshot', record: { bytes, entries: [{ change: { remove: new Uint8Array(0), insert: bytes.subarray(5, 9) } }] } })
  })
  await until(() => b.evaluate(() => got.length === 1), 10000, 'document message')
  assert.equal(await b.evaluate(() => {
    const { record } = got[0]
    return record.bytes.every((v, i) => v === i % 253) && record.bytes.length + record.entries[0].change.remove.length === 200000 && record.entries[0].change.insert.join()
  }), '5,6,7,8')
  await a.evaluate(() => [...session.peers.values()][0].document.send(new ArrayBuffer(10)))
  await until(() => b.evaluate(() => [...session.peers.values()][0].document.readyState === 'closed'), 10000, 'stray frame closes the document channel')
  await until(() => b.evaluate(() => session.status === 'ready'), 20000, 'file transfer unaffected')
  for (const page of [a, b]) await page.evaluate(() => session.leave())
})
