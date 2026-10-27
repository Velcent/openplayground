// A .wasm still over the host's file limit gzipped is split into parts (scripts/fetch.mjs); scripts/page-prelude.js
// fetches the parts, joins them and unzips them into the one application/wasm response the app asked for.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { launch, openPage, startSite } from './helpers.mjs'

test('a .wasm split into gzipped parts loads as one application/wasm response', async (t) => {
  const dir = 'public/wasm-parts-test'
  const bytes = Buffer.from(Array.from({ length: 300000 }, (_, i) => (i * 7919) % 251))
  const gz = gzipSync(bytes)
  const size = Math.ceil(gz.length / 3)
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < 3; i++) writeFileSync(`${dir}/app.wasm.gz.${i}`, gz.subarray(i * size, (i + 1) * size))
  const site = await startSite()
  const browser = await launch()
  t.after(async () => {
    await browser.close()
    await site.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const page = await openPage(browser, `${site.url}/`)
  const tool = { name: 'Test', accent: '#000000', tag: 'v0', wasm: { 'app.wasm': bytes.length }, parts: { 'app.wasm': 3 } }
  await page.addScriptTag({ content: `{\nconst tool = ${JSON.stringify(tool)}\n${readFileSync('scripts/page-prelude.js', 'utf8')}}` })
  const got = await page.evaluate(async () => {
    const res = await fetch('/wasm-parts-test/app.wasm')
    const hash = await crypto.subtle.digest('SHA-256', await res.arrayBuffer())
    return { type: res.headers.get('content-type'), sha256: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('') }
  })
  assert.deepEqual(got, { type: 'application/wasm', sha256: createHash('sha256').update(bytes).digest('hex') })
})
