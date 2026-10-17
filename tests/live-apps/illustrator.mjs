// VectorCraft (illustrator): the owner draws a rectangle (Rectangle tool, M), the editor sets the document's units in
// the Properties panel (its Document section, shown with nothing selected); Ctrl+Z is the owner's Undo. Before that
// the owner rests the pointer on the artboard: the editor is shown that pointer (document points) and artboard.
import { until } from '../helpers.mjs'

const checkpoint = (page) => page.evaluate(() => {
  try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch (e) { return `error: ${e}` }
})

export default {
  path: '/vectorcraft/',
  viewport: { width: 1280, height: 800 },
  // The Home screen's "Web 1920×1080" card makes a new document.
  ready: async (page) => {
    await until(async () => !(await checkpoint(page)).startsWith('error'), 120000, 'VectorCraft to run')
    await page.mouse.click(480, 400)
    await until(async () => (await checkpoint(page)).includes('"artboards"'), 30000, 'a new document')
  },
  point: async (page) => {
    await page.mouse.move(560, 420)
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.pointer), 10000, 'the pointer on the canvas')
  },
  editA: async (page) => {
    await page.keyboard.press('m')
    await page.mouse.move(300, 350)
    await page.mouse.down()
    await page.mouse.move(420, 450, { steps: 8 })
    await page.mouse.up()
  },
  // Units: Pixels → Inches.
  editB: async (page) => {
    await page.mouse.click(1096, 199)
    await page.waitForTimeout(500)
    await page.mouse.click(1060, 289)
  },
  undo: (page) => page.keyboard.press('Control+z'),
}
