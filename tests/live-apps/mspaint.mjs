// PaintCraft (mspaint): every page starts with a blank white 1000×486 picture (one Background layer), fitted under
// Playground's bar and the Classic ribbon, the brush in black, size 4. At 1280×800 the picture fills x 156-1124,
// y 259-730 (96.8%), so these points are on it. The owner paints a stroke over its top left (tile 0,0 of the layer's
// 256×256 tiles), the editor one over its bottom right (tile 3,1): different tiles, so the harness can tell them apart
// (two strokes in one tile merge pixel by pixel: `cargo test -p paintcraft-web live::`). Ctrl+Z (the session's Undo
// while connected) takes back only the owner's. point(): the owner rests the pointer on the picture. drag(): the owner
// holds a right-button stroke (the second colour, white on the white picture, so even letting go changes nothing): the
// editor is shown it (presence `stroke`); Escape drops it. There is one picture, no tabs: no openTab(); no media
// outside it: no importMedia(). The checkpoint is JSON: { canvas, layers: [{ id, …, tiles: { "tx,ty": … } }] }.
import { until } from '../helpers.mjs'

const checkpoint = (page) => page.evaluate(() => {
  try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch (e) { return `error: ${e}` }
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
  path: '/paintcraft/',
  url: '/paintcraft/index.html',
  viewport: { width: 1280, height: 800 },
  ready: (page) => until(async () => !(await checkpoint(page)).startsWith('error'), 60000, 'the picture'),
  point: async (page) => {
    await page.mouse.move(640, 600, { steps: 4 })
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.pointer), 10000, 'the pointer on the picture')
  },
  drag: async (page) => {
    await page.mouse.move(500, 300)
    await page.mouse.down({ button: 'right' })
    for (const [x, y] of [[560, 320], [620, 350], [660, 390]]) await page.mouse.move(x, y, { steps: 5 })
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.stroke), 10000, 'a stroke under way')
  },
  release: async (page) => {
    await page.keyboard.press('Escape')
    await page.mouse.up({ button: 'right' })
  },
  editA: (page) => stroke(page, 220, 300),
  editB: (page) => stroke(page, 960, 580),
  undo: (page) => page.keyboard.press('Control+z'),
}
