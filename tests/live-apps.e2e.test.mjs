import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { sessionSite } from './session-helpers.mjs'
import { until } from './helpers.mjs'

// Live editing in real app builds that use patches/live/playground_live.rs (JSON documents). LIVE_PUBLIC is a public
// directory holding each patched build at its URL path with the shell injected (tests/live-apps/README.md). Each
// tests/live-apps/<slug>.mjs exports { path, viewport?, ready?(page), editA(page), editB(page), undo(page) }: two
// edits to different objects, then Undo of the owner's.
const publicDir = process.env.LIVE_PUBLIC
const only = process.env.LIVE_APPS?.split(',')
const specs = readdirSync(new URL('./live-apps/', import.meta.url)).filter((f) => f.endsWith('.mjs'))
  .map((f) => f.slice(0, -4)).filter((slug) => !only || only.includes(slug))
let site
before(async () => { if (publicDir) site = await sessionSite({ publicDir }) })
after(async () => { await site?.close() })

async function open(app) {
  const page = await site.page()
  await page.setViewportSize(app.viewport ?? { width: 1280, height: 800 })
  await page.goto(`${site.url}${app.path}`)
  await until(() => page.evaluate(() => !!globalThis.playgroundLiveAdapter), 120000, `${app.path} to start`)
  await page.evaluate(async () => { window.PeerSession = (await import('/shell/session.js')).PeerSession })
  await app.ready?.(page)
  return page
}
// Normalized, so a document's text compares equal to its own JSON.stringify(JSON.parse(...)) (e.g. 104.0 and 104).
const json = (page) => page.evaluate(() => JSON.stringify(JSON.parse(new TextDecoder().decode(playgroundLiveAdapter.checkpoint()))))
const status = (page) => page.evaluate(() => session.live?.status)
const follow = (page) => page.evaluate(async () => { await (await import('/shell/live.js')).follow(session) })
// Every page has the same document, different from `before` when given.
const same = (pages, what, before) => until(async () => {
  const docs = new Set(await Promise.all(pages.map(json)))
  return docs.size === 1 && !docs.has(before) && [...docs][0]
}, 30000, what)
// The JSON paths whose values differ between two documents.
function changes(a, b, path = '', out = new Map()) {
  if (JSON.stringify(a) === JSON.stringify(b)) return out
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) changes(a[key], b[key], `${path}/${key}`, out)
  } else out.set(path, b)
  return out
}
const at = (doc, path) => path.split('/').slice(1).reduce((v, k) => v?.[k], doc)

for (const slug of specs) {
  const exists = publicDir && existsSync(`${publicDir}/${slug}.ok`)
  test(`${slug}: two people edit live, views stay local, Undo reverts only its author, a late viewer catches up`, { skip: !exists && 'no LIVE_PUBLIC build' }, async () => {
    const app = (await import(`./live-apps/${slug}.mjs`)).default
    const a = await open(app), b = await open(app)
    const invite = await a.evaluate(async (path) => {
      window.session = await PeerSession.create({ app: path, name: 'Alice' })
      return { editor: session.invite('editor'), viewer: session.invite('viewer') }
    }, app.path)
    await follow(a)
    await b.evaluate(async (invite) => { window.session = await PeerSession.join(invite, { name: 'Bob' }) }, invite.editor)
    await follow(b)
    await until(async () => await status(a) === 'live' && await status(b) === 'live', 30000, 'live editing')
    const start = JSON.parse(await same([a, b], 'the joiner to adopt the owner\'s document'))

    await app.editA(a)
    const afterA = JSON.parse(await same([a, b], 'the owner\'s edit to reach the editor', JSON.stringify(start)))
    await app.editB(b)
    const afterB = JSON.parse(await same([a, b], 'the editor\'s edit to reach the owner', JSON.stringify(afterA)))
    await app.undo(a)
    const undone = JSON.parse(await same([a, b], 'the owner\'s Undo to reach the editor', JSON.stringify(afterB)))
    for (const [path] of changes(start, afterA)) assert.deepEqual(at(undone, path), at(start, path), `Undo reverts ${path}`)
    for (const [path, value] of changes(afterA, afterB)) assert.deepEqual(at(undone, path), value, `Undo keeps the editor's ${path}`)

    const c = await open(app)
    await c.evaluate(async (invite) => { window.session = await PeerSession.join(invite, { name: 'Carol' }) }, invite.viewer)
    await follow(c)
    await same([a, b, c], 'the late viewer to catch up')
    await until(async () => await status(c) === 'read-only', 10000, 'the viewer to be read-only')
    for (const page of [a, b, c]) await page.evaluate(() => session.leave())
  })
}
