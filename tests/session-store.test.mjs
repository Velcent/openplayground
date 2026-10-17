import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { launch, openPage, startSite } from './helpers.mjs'
let site, browser
before(async () => { site = await startSite(); browser = await launch() })
after(async () => { await browser?.close(); await site?.close() })
const run = async (fn) => {
  const page = await openPage(browser, `${site.url}/shell/paths.js`)
  try { return await page.evaluate(async (source) => {
    const m = await import('/shell/session-store.js').catch(() => null)
    if (!m) return { missing: true }
    return new Function('m', `return (${source})(m)`)(m)
  }, fn.toString()) } finally { await page.context().close() }
}

test('verified chunks resume out of order and never touch personal files', async () => {
  const result = await run(async ({ SessionStore, describe }) => {
    const room = crypto.randomUUID(), store = new SessionStore(room)
    const bytes = Uint8Array.from({ length: 65536 * 2 + 3 }, (_, i) => i % 251)
    const file = new File([bytes], 'song.wav')
    const entry = await describe(file, 'song')
    await store.saveManifest([entry])
    await store.putChunk(entry.asset, 2, bytes.slice(131072))
    let hidden = false
    try { await store.file(entry.asset) } catch { hidden = true }
    const again = new SessionStore(room)
    const missing = await again.missing(entry.asset)
    await again.putChunk(entry.asset, 0, bytes.slice(0, 65536))
    await again.putChunk(entry.asset, 0, bytes.slice(0, 65536))
    let corrupt = false
    try { await again.putChunk(entry.asset, 1, new Uint8Array(65536)) } catch { corrupt = true }
    await again.putChunk(entry.asset, 1, bytes.slice(65536, 131072))
    const restored = new Uint8Array(await (await again.file(entry.asset)).arrayBuffer())
    const personal = await import('/shell/store.js')
    await personal.write('/mine.txt', new Blob(['mine']))
    await personal.flattenOnce()
    let forged = false
    try { await again.putHashes(entry.asset, [entry.hashes[0], entry.hashes[0], entry.hashes[2]]) } catch { forged = true }
    // A copy kept by an earlier version (every chunk hash in the file list) opens as before.
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('playground-sessions')).getDirectoryHandle(room)
    await (await dir.getDirectoryHandle(entry.asset)).removeEntry('hashes.json')
    const out = await (await dir.getFileHandle('manifest.json')).createWritable(); await out.write(JSON.stringify([entry])); await out.close()
    const old = new Uint8Array(await (await new SessionStore(room).file(entry.asset)).arrayBuffer())
    const kept = JSON.parse(await (await (await dir.getFileHandle('manifest.json')).getFile()).text())
    return { missing, hidden, corrupt, forged, matched: restored.every((v, i) => v === bytes[i]) && old.every((v, i) => v === bytes[i]), moved: !kept[0].hashes, personal: await (await personal.file('/mine.txt')).text(), complete: await again.missing(entry.asset) }
  })
  assert.deepEqual(result, { missing: [0, 1], hidden: true, corrupt: true, forged: true, matched: true, moved: true, personal: 'mine', complete: [] })
})

test('empty assets and identical names keep independent verified versions', async () => {
  const result = await run(async ({ SessionStore, describe }) => {
    const store = new SessionStore(crypto.randomUUID())
    const a = await describe(new File([], 'same.txt'), 'a')
    const b = await describe(new File(['x'], 'same.txt'), 'b')
    await store.saveManifest([a, b])
    await store.putChunk(b.asset, 0, new TextEncoder().encode('x'))
    return { files: (await store.manifest()).length, a: (await store.file(a.asset)).size, b: await (await store.file(b.asset)).text() }
  })
  assert.deepEqual(result, { files: 2, a: 0, b: 'x' })
})

test('a failed completion write never reports a partially stored asset as complete', async () => {
  const result = await run(async ({ SessionStore, describe }) => {
    const store = new SessionStore(crypto.randomUUID())
    const entry = await describe(new File(['safe'], 'test.txt'), 'x')
    await store.saveManifest([entry])
    const original = FileSystemFileHandle.prototype.createWritable
    FileSystemFileHandle.prototype.createWritable = function (...args) {
      if (this.name === 'complete.json') return Promise.reject(new DOMException('full', 'QuotaExceededError'))
      return original.apply(this, args)
    }
    let failed = false, hidden = false
    try { await store.putChunk(entry.asset, 0, new TextEncoder().encode('safe')) } catch { failed = true }
    try { await store.file(entry.asset) } catch { hidden = true }
    FileSystemFileHandle.prototype.createWritable = original
    await store.putChunk(entry.asset, 0, new TextEncoder().encode('safe'))
    return { failed, hidden, recovered: await (await store.file(entry.asset)).text() }
  })
  assert.deepEqual(result, { failed: true, hidden: true, recovered: 'safe' })
})
