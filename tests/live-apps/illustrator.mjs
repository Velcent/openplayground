// VectorCraft (illustrator): the owner draws a rectangle (Rectangle tool, M), the editor sets the document's units in
// the Properties panel (its Document section, shown with nothing selected); Ctrl+Z is the owner's Undo. Before that
// the owner rests the pointer on the artboard: the editor is shown that pointer (document points) and artboard. In
// drag() the owner drags out a rectangle and holds the button: the editor is shown its rubber band (`bands`). In
// openTab() the owner makes a second document (New…, Enter): it joins the session's documents, a tab for the editor.
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
  drag: async (page) => {
    await page.keyboard.press('m')
    await page.mouse.move(620, 280)
    await page.mouse.down()
    for (const [x, y] of [[650, 300], [690, 330], [730, 360]]) await page.mouse.move(x, y, { steps: 3 })
  },
  openTab: async (page) => {
    const documents = async () => (await checkpoint(page)).split('"artboards"').length - 1
    const before = await documents()
    await page.keyboard.press('Control+n')
    await page.waitForTimeout(500)
    await page.keyboard.press('Enter')
    await until(async () => (await documents()) > before, 10000, 'a second document')
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
