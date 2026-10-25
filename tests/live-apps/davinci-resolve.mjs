// Picasso Suite (davinci-resolve): every page imports the same two-second tone from Files and places it at the start of
// the timeline (Cut page, double-click in the media pool), so the joiner already has its file. At 1400×850 the Cut
// page's detail timeline has the tone's clip on A1 at y 732, from x 828 (the fixed playhead) to the right. The owner
// selects it (Ctrl+A: a click on the Cut page's timeline clears the selection) and disables it (D); the editor moves the playhead 25 frames on and cuts the clip there (Ctrl+B);
// Ctrl+Z (the session's Undo while connected) takes back only the owner's. point(): the owner rests the pointer on the
// clip. drag(): on the Edit page (Shift+4), the owner holds the clip mid-move (presence `ghosts`); release() brings it
// back before letting go, so nothing changes, and returns to the Cut page. importMedia(): the owner opens a PNG from
// Files in Picasso Suite; the file reaches the others as the session's media.
import { until } from '../helpers.mjs'

const checkpoint = (page) => page.evaluate(() => {
  try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch (e) { return `error: ${e}` }
})
const doc = async (page) => JSON.parse(await checkpoint(page))
const changed = async (page, act, what) => {
  const before = await checkpoint(page)
  await act()
  await until(async () => (await checkpoint(page)) !== before, 10000, what)
}
// The clip on the Edit page's timeline (A1, zoomed to fit), grabbed away from its edges.
const GRAB = [560, 560]

export default {
  path: '/picasso-suite/',
  url: '/picasso-suite/index.html',
  viewport: { width: 1400, height: 850 },
  ready: async (page) => {
    await until(async () => !(await checkpoint(page)).startsWith('error'), 120000, 'Picasso Suite')
    await page.evaluate(async () => {
      // Two seconds of a 440 Hz tone, as a 16-bit mono WAV.
      const rate = 48000, n = rate * 2, data = new DataView(new ArrayBuffer(44 + n * 2))
      const text = (at, s) => [...s].forEach((c, i) => data.setUint8(at + i, c.charCodeAt(0)))
      text(0, 'RIFF'); data.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt '); data.setUint32(16, 16, true)
      data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, rate, true); data.setUint32(28, rate * 2, true)
      data.setUint16(32, 2, true); data.setUint16(34, 16, true); text(36, 'data'); data.setUint32(40, n * 2, true)
      for (let i = 0; i < n; i++) data.setInt16(44 + i * 2, Math.sin(i / rate * 2 * Math.PI * 440) * 12000, true)
      playgroundFiles.write('browser:/Audio/tone.wav', new Uint8Array(data.buffer))
      // Opened once Files has stored it (writes are queued).
      for (let i = 0; i < 50 && !(await playgroundFiles.read('browser:/Audio/tone.wav').catch(() => null)); i++) await new Promise((r) => setTimeout(r, 100))
      await (await import('/shell/files.js')).openHere('/Audio/tone.wav')
    })
    await until(async () => (await doc(page)).media.length === 1, 20000, 'the tone imported')
    // Until it lands: a double-click before the pool has drawn the new item misses it.
    await until(async () => {
      if ((await doc(page)).timeline.tracks[1].clips.length === 1) return true
      await page.mouse.dblclick(73, 215)
      await page.waitForTimeout(700)
    }, 20000, 'the tone on the timeline')
  },
  editA: (page) => changed(page, async () => {
    await page.keyboard.press('Control+a')
    await page.keyboard.press('d')
  }, 'the clip disabled'),
  editB: (page) => changed(page, async () => {
    await page.mouse.click(886, 300)
    for (let i = 0; i < 25; i++) await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Control+b')
  }, 'the clip cut'),
  undo: (page) => page.keyboard.press('Control+z'),
  point: async (page) => {
    await page.mouse.move(1100, 732, { steps: 4 })
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.pointer?.track), 10000, 'the pointer on the clip')
  },
  drag: async (page) => {
    await page.keyboard.press('Shift+Digit4')
    await page.waitForTimeout(1000)
    await page.mouse.move(...GRAB)
    await page.mouse.down()
    for (const x of [580, 610, 640]) await page.mouse.move(x, GRAB[1], { steps: 5 })
    await until(() => page.evaluate(() => playgroundLiveAdapter.presence()?.ghosts?.length === 1), 10000, 'a clip drag under way')
  },
  release: async (page) => {
    await page.mouse.move(...GRAB, { steps: 5 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    await page.keyboard.press('Shift+Digit3')
    await page.waitForTimeout(500)
  },
  importMedia: async (page) => {
    await changed(page, () => page.evaluate(async () => {
      const canvas = new OffscreenCanvas(64, 36), ctx = canvas.getContext('2d')
      ctx.fillStyle = '#e8452c'; ctx.fillRect(0, 0, 64, 36); ctx.fillStyle = '#fff'; ctx.fillRect(8, 8, 20, 20)
      playgroundFiles.write('browser:/Images/still.png', new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer()))
      for (let i = 0; i < 50 && !(await playgroundFiles.read('browser:/Images/still.png').catch(() => null)); i++) await new Promise((r) => setTimeout(r, 100))
      await (await import('/shell/files.js')).openHere('/Images/still.png')
    }), 'the picture imported')
  },
}
