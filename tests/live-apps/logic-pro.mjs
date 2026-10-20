// Pro Wave (logic-pro): every page opens its demo project (six tracks, a region on each). At 1400×900 the Tracks area's
// headers hold each track's M (mute) button at x 561, the rows 50 px apart from y 196 (Classic Electric Piano); the
// lanes start at x 788, bar 1. The owner mutes the first track; the editor mutes the Drummer (the fourth). Ctrl+Z (the
// session's Undo while connected) takes back only the owner's. point(): the owner rests the pointer on the lanes.
// drag(): the owner holds the Analog Pad region (third row) mid-move: the editor is shown it (presence `region`);
// release() brings it back before letting go, so nothing changes. importMedia(): the owner opens a WAV from Files in
// Pro Wave (an audio track); the file reaches the others as the session's media.
import { until } from '../helpers.mjs'

const checkpoint = (page) => page.evaluate(() => {
  try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch (e) { return `error: ${e}` }
})
const click = async (page, at, what) => {
  const before = await checkpoint(page)
  await page.mouse.click(...at)
  await until(async () => (await checkpoint(page)) !== before, 10000, what)
}
const PAD = [1000, 291]

export default {
  path: '/pro-wave/',
  viewport: { width: 1400, height: 900 },
  ready: async (page) => {
    await until(async () => !(await checkpoint(page)).startsWith('error'), 60000, 'the demo project')
  },
  editA: (page) => click(page, [561, 196], 'the first track to mute'),
  editB: (page) => click(page, [561, 347], 'the Drummer to mute'),
  undo: (page) => page.keyboard.press('Control+z'),
  point: async (page) => {
    await page.mouse.move(1100, 340, { steps: 4 })
    await until(() => page.evaluate(() => playgroundLiveAdapter.presence()?.at?.in === 'lanes'), 10000, 'the pointer on the lanes')
  },
  drag: async (page) => {
    await page.mouse.move(...PAD)
    await page.mouse.down()
    for (const x of [1040, 1090, 1150]) await page.mouse.move(x, PAD[1], { steps: 5 })
    await until(() => page.evaluate(() => playgroundLiveAdapter.presence()?.region?.length === 4), 10000, 'a region drag under way')
  },
  release: async (page) => {
    await page.mouse.move(...PAD, { steps: 5 })
    await page.mouse.up()
  },
  importMedia: async (page) => {
    const before = await checkpoint(page)
    await page.evaluate(async () => {
      // Half a second of a 440 Hz tone, as a 16-bit mono WAV.
      const rate = 44100, n = rate / 2, data = new DataView(new ArrayBuffer(44 + n * 2))
      const text = (at, s) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)))
      text(0, 'RIFF'); data.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt '); data.setUint32(16, 16, true)
      data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, rate, true); data.setUint32(28, rate * 2, true)
      data.setUint16(32, 2, true); data.setUint16(34, 16, true); text(36, 'data'); data.setUint32(40, n * 2, true)
      for (let i = 0; i < n; i++) data.setInt16(44 + i * 2, Math.sin(i / rate * 2 * Math.PI * 440) * 12000, true)
      playgroundFiles.write('browser:/Samples/tone.wav', new Uint8Array(data.buffer))
      await new Promise((r) => setTimeout(r, 500))
      await (await import('/shell/files.js')).openHere('/Samples/tone.wav')
    })
    await until(async () => (await checkpoint(page)) !== before, 15000, 'the audio track')
  },
}
