// SelfPaint (mspaint): every page starts with a blank white 1920×1200 picture at 100%, the brush in black, size 8; the
// canvas fills the window under the ribbon, centred on the picture, so these points are on it. The owner paints a
// stroke over the left, the editor one over the right: different 64×64 tiles, so the harness can tell them apart (two
// strokes in one tile merge pixel by pixel: `cargo test live`). Ctrl+Z (the session's Undo while connected) takes back
// only the owner's. point(): the owner rests the pointer on the picture. drag(): the owner holds a right-button stroke
// (the second colour, white on the white picture, so letting go changes nothing): the editor is shown it (presence
// `stroke`). There is one picture, no tabs: no openTab(); no media outside it: no importMedia().
//
// The checkpoint is binary (src/app/live.rs: a header line, width and height, then each tile as u32 n + n bytes):
// `ready` defines liveTestDocument(), which gives the harness {"w", "h", "tiles": {index: hash of its bytes}}.
import { until } from '../helpers.mjs'

const checkpoint = (page) => page.evaluate(() => {
  try { return liveTestDocument() } catch (e) { return `error: ${e}` }
})
const stroke = async (page, x, y) => {
  const before = await checkpoint(page)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 60, y + 40, { steps: 8 })
  await page.mouse.up()
  await until(async () => await checkpoint(page) !== before, 10000, 'the stroke in the picture')
}

export default {
  path: '/selfpaint/',
  url: '/selfpaint/index.html',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    // The Early preview notice (tools.yaml notice) covers the app until it is dismissed.
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 10000 }).catch(() => {})
    await page.evaluate(() => {
      globalThis.liveTestDocument = () => {
        const bytes = playgroundLiveAdapter.checkpoint()
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        let at = 'selfpaint-live 1\n'.length
        const u32 = () => (at += 4, view.getUint32(at - 4, true))
        const w = u32(), h = u32(), tiles = {}
        for (let i = 0; at < bytes.length; i++) {
          const n = u32()
          let hash = 0x811c9dc5
          for (const b of bytes.subarray(at, at += n)) hash = Math.imul(hash ^ b, 0x01000193) >>> 0
          tiles[i] = `${n}:${hash.toString(16)}`
        }
        return JSON.stringify({ w, h, tiles })
      }
    })
    await until(async () => !(await checkpoint(page)).startsWith('error'), 60000, 'the picture')
  },
  point: async (page) => {
    await page.mouse.move(640, 600, { steps: 4 })
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.pointer), 10000, 'the pointer on the picture')
  },
  drag: async (page) => {
    await page.mouse.move(500, 250)
    await page.mouse.down({ button: 'right' })
    for (const [x, y] of [[560, 270], [620, 300], [660, 340]]) await page.mouse.move(x, y, { steps: 5 })
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.stroke), 10000, 'a stroke under way')
  },
  release: (page) => page.mouse.up({ button: 'right' }),
  editA: (page) => stroke(page, 300, 400),
  editB: (page) => stroke(page, 900, 500),
  undo: (page) => page.keyboard.press('Control+z'),
}
