// transit: every page opens the demo session ("Midnight Groove") in the studio's arrangement. At 1400×900 the track
// headers hold each track's M (mute) button at x 153, the rows 46 px apart from y 147 (Kick); the timeline starts at
// x 237, bar 1, with bar 5 at x 462. The owner mutes Kick; the editor mutes Snare. Ctrl+Z (the session's Undo while
// connected) takes back only the owner's. point(): the owner rests the pointer on the Lead row. drag(): the owner holds
// the first Bass clip (fourth row) mid-move: the editor is shown where it would land (presence `ghosts`); release()
// brings it back before letting go, so nothing changes. importMedia(): the owner opens a WAV from Files in transit (an
// audio track at the cursor); the file reaches the others as the session's media.
import { until } from '../helpers.mjs'

const checkpoint = (page) => page.evaluate(() => {
  try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch (e) { return `error: ${e}` }
})
const click = async (page, at, what) => {
  const before = await checkpoint(page)
  await page.mouse.click(...at)
  await until(async () => (await checkpoint(page)) !== before, 10000, what)
}
const BASS = [570, 305]

export default {
  path: '/transit/',
  // The dev server serves an app folder's index.html only for builds in its own public/. `?webgl` (the page's switch to
  // WebGL2): headless Chromium answers the first pages' WebGPU adapter request with none, but a third page's (the late
  // viewer's) never, which leaves it starting forever; live editing is the same either way.
  url: '/transit/index.html?webgl',
  viewport: { width: 1400, height: 900 },
  ready: async (page) => {
    await until(async () => !(await checkpoint(page)).startsWith('error'), 60000, 'the demo session')
  },
  editA: (page) => click(page, [153, 147], 'Kick to mute'),
  editB: (page) => click(page, [153, 193], 'Snare to mute'),
  undo: (page) => page.keyboard.press('Control+z'),
  point: async (page) => {
    await page.mouse.move(1000, 440, { steps: 4 })
    await until(() => page.evaluate(() => playgroundLiveAdapter.presence()?.pointer?.track !== undefined), 10000, 'the pointer on the arrangement')
  },
  drag: async (page) => {
    await page.mouse.move(...BASS)
    await page.mouse.down()
    for (const x of [600, 640, 690]) await page.mouse.move(x, BASS[1], { steps: 5 })
    await until(() => page.evaluate(() => playgroundLiveAdapter.presence()?.ghosts?.length === 1), 10000, 'a clip drag under way')
  },
  release: async (page) => {
    await page.mouse.move(...BASS, { steps: 5 })
    await page.mouse.up()
  },
  importMedia: async (page) => {
    const before = await checkpoint(page)
    await page.evaluate(async () => {
      // Half a second of a 440 Hz tone, as a 16-bit mono WAV.
      const rate = 48000, n = rate / 2, data = new DataView(new ArrayBuffer(44 + n * 2))
      const text = (at, s) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)))
      text(0, 'RIFF'); data.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt '); data.setUint32(16, 16, true)
      data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, rate, true); data.setUint32(28, rate * 2, true)
      data.setUint16(32, 2, true); data.setUint16(34, 16, true); text(36, 'data'); data.setUint32(40, n * 2, true)
      for (let i = 0; i < n; i++) data.setInt16(44 + i * 2, Math.sin(i / rate * 2 * Math.PI * 440) * 12000, true)
      playgroundFiles.write('browser:/Samples/tone.wav', new Uint8Array(data.buffer))
      // The store writes in the background: open the file once it holds it all.
      for (let i = 0; i < 100; i++) {
        if ((await playgroundFiles.read('browser:/Samples/tone.wav').catch(() => []))?.length === data.byteLength) break
        await new Promise((r) => setTimeout(r, 100))
      }
      await (await import('/shell/files.js')).openHere('/Samples/tone.wav')
    })
    await until(async () => (await checkpoint(page)) !== before, 15000, 'the audio track')
  },
}
