import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, test } from 'node:test'
import { sessionSite } from './session-helpers.mjs'
import { until } from './helpers.mjs'

// Real Honeydew browsers. LIVE_PUBLIC is a public directory whose honeydew/ holds a web build with
// patches/fl-studio-mobile/live.diff and the shell injected (fetch.mjs does this for installed builds).
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
// The editor's MiniSynth clip on its track (row 1, under the master's), and the bottom editors' close X.
const SYNTH_CLIP = at(80, 144), EDITOR_CLOSE = at(1082, 24)

// A 50 ms 440 Hz sine, 16-bit mono PCM WAV at 44.1 kHz.
function wav() {
  const frames = 2205, out = Buffer.alloc(44 + frames * 2)
  out.write('RIFF', 0); out.writeUInt32LE(36 + frames * 2, 4); out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(44100, 24)
  out.writeUInt32LE(88200, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) out.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 44100)), 44 + i * 2)
  return out
}
const SAMPLE = { name: 'Beep.wav', mimeType: 'audio/wav', buffer: wav() }
// The owner's import, through Honeydew's own sample picker: a new Audio Clip track (with the editor's MiniSynth there
// are two above it), a tap on its row opens the picker, then My Files, My Samples, Import (the file dialog) and the
// file, which becomes the track's clip; Escape closes the picker. The picker takes its first tap after it opens, and
// after the file dialog, as a drag from where the last press was: a tap level with that press (the root's folder row,
// My Samples' empty space) clears it.
const PLUS = at(585, 232), AUDIO_CLIP = at(490, 206), AUDIO_ROW = at(600, 207), LEVEL_ROW = at(300, 207), BACK = at(20, 30)
const MY_FILES = at(125, 84), MY_SAMPLES = at(125, 124), IMPORT = at(32, 160), LEVEL_IMPORT = at(300, 160), FIRST_FILE = at(125, 84)
async function importSample(page) {
  // Listening early, so the dialog is intercepted by the time Import opens it.
  const chooser = page.waitForEvent('filechooser')
  await click(page, PLUS, AUDIO_CLIP)
  await page.waitForTimeout(800)
  await click(page, AUDIO_ROW, LEVEL_ROW, BACK, MY_FILES, MY_SAMPLES, IMPORT)
  await (await chooser).setFiles(SAMPLE)
  await page.waitForTimeout(1000)
  await click(page, LEVEL_IMPORT, FIRST_FILE)
  await page.waitForTimeout(1000)
  await page.keyboard.press('Escape')
}
// The samples a page has, as sorted `id sha256` lines, once it has every one the song plays.
const media = (page) => page.evaluate(async () => {
  const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await new Blob([bytes]).arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('')
  try {
    const list = await playgroundLiveAdapter.assets()
    if (!list.length || !list.every((a) => a.have)) return null
    return (await Promise.all(list.map(async (a) => `${a.id} ${await hex(await playgroundLiveAdapter.readAsset(a.id))}`))).sort().join('\n')
  } catch (e) { if (e === 'busy') return null; throw e }
})
const sameMedia = (pages, what) => until(async () => {
  const all = new Set(await Promise.all(pages.map(media)))
  return all.size === 1 && [...all][0]
}, 60000, what)
// Every page shows the same song, and it differs from `before` when given.
async function same(pages, what, before) {
  return until(async () => {
    const songs = new Set(await Promise.all(pages.map(song)))
    return songs.size === 1 && !songs.has(before) && [...songs][0]
  }, 20000, what)
}

test('Honeydew browsers edit one song live, keep views local, show each other where they point, undo personally, share samples and catch up late', { skip: !publicDir && 'set LIVE_PUBLIC' }, async () => {
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

  // Presence: the editor back on the playlist; the owner selects the editor's new clip and points at it. The editor's
  // app is shown exactly the owner's presence(), and draws it there (PRESENCE_SCREENSHOT: a picture of that).
  await b.evaluate(() => {
    const show = playgroundLiveAdapter.showPresence
    playgroundLiveAdapter.showPresence = (others) => { window.shownPresence = others; return show(others) }
  })
  await click(b, EDITOR_CLOSE)
  await click(a, SYNTH_CLIP)
  await a.mouse.move(SYNTH_CLIP[0] + 40, SYNTH_CLIP[1] + 10)
  await a.waitForTimeout(500)
  const [owner, mine] = await a.evaluate(() => [session.id, playgroundLiveAdapter.presence()])
  assert.equal(mine.view, 'playlist')
  assert.equal(mine.clips?.length, 1, 'the owner selected the clip')
  assert.ok(mine.pointer?.track, 'the owner points at a track')
  await until(() => b.evaluate(([id, mine]) => JSON.stringify(window.shownPresence?.find((p) => p.id === id)?.state) === JSON.stringify(mine), [owner, mine]), 10000, 'the owner\'s presence to reach the editor')
  if (process.env.PRESENCE_SCREENSHOT) { await b.waitForTimeout(300); await b.screenshot({ path: process.env.PRESENCE_SCREENSHOT }) }
  await a.keyboard.press('Escape')
  await a.mouse.move(0, 0)

  await a.keyboard.press('Control+z')
  const undone = await same([a, b], 'the owner\'s Undo to reach the editor', both)
  assert.equal(undone.length - both.length, start.length - faster.length, 'Undo reverted the tempo, not the editor\'s channel')
  assert.deepEqual(await a.evaluate(() => session.live.entries.map((e) => e.kind)), ['edit', 'edit', 'undo'])

  await importSample(a)
  const imported = await same([a, b], 'the owner\'s sample clip to reach the editor', undone)
  const sample = `My Samples/Beep.wav ${createHash('sha256').update(SAMPLE.buffer).digest('hex')}`
  assert.equal(await sameMedia([a, b], 'the sample to reach the editor'), sample)

  const c = await open()
  await c.evaluate(async (invite) => { window.session = await PeerSession.join(invite, { name: 'Carol' }) }, invite.viewer)
  await follow(c)
  assert.equal(await same([a, b, c], 'the late viewer to catch up'), imported)
  assert.equal(await sameMedia([a, c], 'the sample to reach the late viewer'), sample)
  await until(async () => await status(c) === 'read-only', 10000, 'the viewer to be read-only')
  await tempoUp(c)
  await c.waitForTimeout(1500)
  assert.equal(await same([a, b, c], 'the viewer\'s edit to revert'), imported)

  const room = await a.evaluate(() => { session.live.stop(); session.leave(); return session.room })
  await until(async () => await status(b) === 'paused', 20000, 'the editor to pause')
  await tempoUp(b)
  const paused = await song(b)
  assert.notEqual(paused, imported)
  assert.equal(await song(c), imported, 'nothing is shared without the owner')

  await open(a)
  await a.evaluate(async (room) => { window.session = await PeerSession.restore(room); await session.connect() }, room)
  await follow(a)
  await until(async () => await status(b) === 'live', 20000, 'the editor to resume')
  assert.equal(await same([a, b, c], 'the paused edit to sync after the owner returns'), paused)
  assert.equal(await sameMedia([a, b, c], 'the owner\'s reloaded page to get the sample back'), sample)
  for (const page of [a, b, c]) await page.evaluate(() => session.leave())
})
