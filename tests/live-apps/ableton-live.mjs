// Suhina (ableton-live): every page opens its demo project in the Session view; at 1400×1000 the Keys track's "Chords 2"
// clip (scene 3) is at (650, 158), and a click there opens it in the clip editor at the bottom right, its four notes
// C3, D#3, F3 and G3 a key row (12 px) apart. The owner moves C3 later; the editor turns the Drums track's volume down
// with its fader. Ctrl+Z (the session's Undo while connected) takes back only the owner's. (Two people's edits to
// different notes of one clip both stay too, see crates/session `live` tests; not here: the demo's clips share their
// notes with the arrangement's, so a clip's first note edit copies them, and undoing that copy would take the other
// person's later edit of it along, a conflict.) point(): the owner rests the pointer on the clip grid. drag(): the
// owner holds G3 mid-move: the editor is shown it (presence `notes`); release() brings it back before letting go, so
// nothing changes. importMedia(): the owner opens a sample from Files in Suhina (a clip on a new track); the sample
// reaches the others as the session's media.
import { until } from '../helpers.mjs'

const checkpoint = (page) => page.evaluate(() => {
  try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch (e) { return `error: ${e}` }
})
const drag = async (page, from, to) => {
  const before = await checkpoint(page)
  await page.mouse.move(...from)
  await page.mouse.down()
  await page.mouse.move(...to, { steps: 8 })
  await page.mouse.up()
  await until(async () => (await checkpoint(page)) !== before, 10000, 'the note to move')
}
const G3 = [1015, 840]

export default {
  path: '/suhina/',
  viewport: { width: 1400, height: 1000 },
  ready: async (page) => {
    // The Early preview notice (tools.yaml notice) covers the app until it is dismissed.
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 10000 }).catch(() => {})
    await until(async () => !(await checkpoint(page)).startsWith('error'), 60000, 'the demo project')
    await page.mouse.click(650, 158)
    await page.waitForTimeout(500)
  },
  point: async (page) => {
    await page.mouse.move(360, 300, { steps: 4 })
    await until(() => page.evaluate(() => playgroundLiveAdapter.presence()?.at?.in === 'slots'), 10000, 'the pointer on the clip grid')
  },
  drag: async (page) => {
    await page.mouse.move(...G3)
    await page.mouse.down()
    for (const [x, y] of [[1040, 836], [1070, 828], [1100, 816]]) await page.mouse.move(x, y, { steps: 5 })
    await until(() => page.evaluate(() => playgroundLiveAdapter.presence()?.notes?.length > 0), 10000, 'a note drag under way')
  },
  release: async (page) => {
    await page.mouse.move(...G3, { steps: 5 })
    await page.mouse.up()
  },
  editA: (page) => drag(page, [880, 924], [950, 924]),
  editB: async (page) => {
    const before = await checkpoint(page)
    await page.mouse.move(321, 705)
    await page.mouse.down()
    await page.mouse.move(321, 730, { steps: 6 })
    await page.mouse.up()
    await until(async () => (await checkpoint(page)) !== before, 10000, 'the volume to change')
  },
  undo: (page) => page.keyboard.press('Control+z'),
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
    await until(async () => (await checkpoint(page)) !== before, 15000, 'the sample\'s clip')
  },
  ignore: ['/next_id'],
}
