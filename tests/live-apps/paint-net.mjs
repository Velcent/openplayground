// Paint.RS (paint-net): its live editing is in its own source (paint.rs's crates/paintrs/src/live.rs), as Honeydew's is.
// Every page starts with a blank white 800×600 image and the Paintbrush in black, behind a Welcome dialog that Escape
// closes; the canvas fills the window between the docked windows, centred on the image, so these points are on it. The
// owner paints a stroke over the left, the editor one over the right: different 64×64 tiles, so the harness can tell
// them apart (two strokes in one tile merge pixel by pixel: `cargo test -p paintrs live`). Ctrl+Z (the session's Undo
// while connected) takes back only the owner's. point(): the owner rests the pointer on the image. drag(): the owner
// holds a right-button stroke (the secondary colour, white on the white image, so letting go changes nothing): the
// editor is shown it (presence `stroke`). openTab(): the owner makes a new image (Ctrl+N, Enter): it joins the
// session's set and reaches the editor as a tab.
//
// The checkpoint is binary (a header line, then JSON pieces each followed by a layer's tiles: u32 count, then u32 n +
// n bytes per tile): `ready` defines liveTestDocument(), which gives the harness the JSON with each layer's tiles as
// hashes of their bytes.
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
  await until(async () => await checkpoint(page) !== before, 10000, 'the stroke in the image')
}

export default {
  path: '/paint-rs/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await page.evaluate(() => {
      globalThis.liveTestDocument = () => {
        const bytes = playgroundLiveAdapter.checkpoint()
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        let at = 'paintrs-live 1\n'.length
        const u32 = () => (at += 4, view.getUint32(at - 4, true))
        const pieces = [], tiles = []
        for (;;) {
          const n = u32()
          pieces.push(bytes.subarray(at, at += n))
          const count = u32()
          if (count === 0xffffffff) break
          const layer = []
          for (let i = 0; i < count; i++) {
            const n = u32()
            let hash = 0x811c9dc5
            for (const b of bytes.subarray(at, at += n)) hash = Math.imul(hash ^ b, 0x01000193) >>> 0
            layer.push(`${n}:${hash.toString(16)}`)
          }
          tiles.push(layer)
        }
        const json = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0))
        pieces.reduce((n, p) => (json.set(p, n), n + p.length), 0)
        return JSON.stringify({ doc: JSON.parse(new TextDecoder().decode(json)), tiles })
      }
    })
    // The Welcome dialog holds the session (a dialog is a gesture under way) until it closes.
    await until(async () => {
      await page.mouse.move(640, 400)
      await page.keyboard.press('Escape')
      return !(await checkpoint(page)).startsWith('error')
    }, 60000, 'the image')
  },
  point: async (page) => {
    await page.mouse.move(640, 420, { steps: 4 })
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.pointer), 10000, 'the pointer on the image')
  },
  drag: async (page) => {
    await page.mouse.move(560, 300)
    await page.mouse.down({ button: 'right' })
    for (const [x, y] of [[600, 320], [640, 350], [680, 380]]) await page.mouse.move(x, y, { steps: 5 })
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.stroke), 10000, 'a stroke under way')
  },
  release: (page) => page.mouse.up({ button: 'right' }),
  openTab: async (page) => {
    await page.keyboard.press('Control+n')
    await page.waitForTimeout(500)
    await page.keyboard.press('Enter')
  },
  editA: (page) => stroke(page, 460, 330),
  editB: (page) => stroke(page, 760, 450),
  undo: (page) => page.keyboard.press('Control+z'),
}
