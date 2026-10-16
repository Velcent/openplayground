import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { sessionSite } from './session-helpers.mjs'
import { until } from './helpers.mjs'

// Real Honeydew browsers. LIVE_PUBLIC is a public directory whose honeydew/ holds a web build with
// patches/fl-studio-mobile/peer-document.diff and the shell injected (fetch.mjs does this for installed builds).
const publicDir = process.env.LIVE_PUBLIC
let site
before(async () => { if (publicDir) site = await sessionSite({ publicDir }) })
after(async () => { await site?.close() })

// Canvas coordinates of the native test rig (1170 × 540), below the 36 px top bar.
const at = (x, y) => [x, y + 36]
const BPM = at(641, 408), PLUS_ONE = at(693, 258), CLOSE_TEMPO = at(1146, 270), ADD_CHANNEL = at(585, 246), MINISYNTH = at(632, 126)

async function open(page = null) {
  page ??= await site.page()
  await page.setViewportSize({ width: 1170, height: 576 })
  await page.goto(`${site.url}/honeydew/`)
  await until(() => page.evaluate(() => !!globalThis.playgroundLiveAdapter), 60000, 'Honeydew to start')
  await page.evaluate(async () => { window.PeerSession = (await import('/shell/session.js')).PeerSession })
  await page.waitForTimeout(500)
  return page
}
const song = (page) => page.evaluate(() => Array.from(playgroundLiveAdapter.checkpoint()).join())
const status = (page) => page.evaluate(() => session.live?.status)
const follow = (page) => page.evaluate(async () => { await (await import('/shell/live.js')).follow(session) })
async function click(page, ...points) {
  for (const point of points) { await page.mouse.click(...point); await page.waitForTimeout(400) }
}
const tempoUp = (page) => click(page, BPM, PLUS_ONE, CLOSE_TEMPO)
// Every page shows the same song, and it differs from `before` when given.
async function same(pages, what, before) {
  return until(async () => {
    const songs = new Set(await Promise.all(pages.map(song)))
    return songs.size === 1 && !songs.has(before) && [...songs][0]
  }, 20000, what)
}

test('Honeydew browsers edit one song live, keep views local, undo personally and catch up late', { skip: !publicDir && 'set LIVE_PUBLIC' }, async () => {
  const a = await open(), b = await open()
  const invite = await a.evaluate(async () => {
    window.session = await PeerSession.create({ app: '/honeydew/', name: 'Alice' })
    return { editor: session.invite('editor'), viewer: session.invite('viewer') }
  })
  await follow(a)
  await b.evaluate(async (invite) => { window.session = await PeerSession.join(invite, { name: 'Bob' }) }, invite.editor)
  await follow(b)
  await until(async () => await status(a) === 'live' && await status(b) === 'live', 20000, 'live editing')
  const start = await same([a, b], 'the joiner to adopt the owner\'s song')

  await b.keyboard.press('Control+Equal')
  await b.waitForTimeout(1000)
  assert.equal(await song(a), start, 'zoom is a personal view')

  await tempoUp(a)
  const faster = await same([a, b], 'a tempo change to reach the editor', start)

  await click(b, ADD_CHANNEL, MINISYNTH)
  const both = await same([a, b], 'a new channel to reach the owner', faster)
  assert.ok(both.length > faster.length, 'the channel was added')

  await a.keyboard.press('Control+z')
  const undone = await same([a, b], 'the owner\'s Undo to reach the editor', both)
  assert.equal(undone.length - both.length, start.length - faster.length, 'Undo reverted the tempo, not the editor\'s channel')
  assert.deepEqual(await a.evaluate(() => session.live.entries.map((e) => e.kind)), ['edit', 'edit', 'undo'])

  const c = await open()
  await c.evaluate(async (invite) => { window.session = await PeerSession.join(invite, { name: 'Carol' }) }, invite.viewer)
  await follow(c)
  assert.equal(await same([a, b, c], 'the late viewer to catch up'), undone)
  await until(async () => await status(c) === 'read-only', 10000, 'the viewer to be read-only')
  await tempoUp(c)
  await c.waitForTimeout(1500)
  assert.equal(await same([a, b, c], 'the viewer\'s edit to revert'), undone)

  const room = await a.evaluate(() => { session.live.stop(); session.leave(); return session.room })
  await until(async () => await status(b) === 'paused', 20000, 'the editor to pause')
  await tempoUp(b)
  const paused = await song(b)
  assert.notEqual(paused, undone)
  assert.equal(await song(c), undone, 'nothing is shared without the owner')

  await open(a)
  await a.evaluate(async (room) => { window.session = await PeerSession.restore(room); await session.connect() }, room)
  await follow(a)
  await until(async () => await status(b) === 'live', 20000, 'the editor to resume')
  assert.equal(await same([a, b, c], 'the paused edit to sync after the owner returns'), paused)
  for (const page of [a, b, c]) await page.evaluate(() => session.leave())
})
