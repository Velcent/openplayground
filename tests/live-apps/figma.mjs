// FigCraft (figma): each page starts on a new file's Page 1; `ready` draws two rectangles with the Rectangle tool (R,
// drag), which leaves the Move tool on. The owner selects the left one with a click and nudges it right (→), the
// editor the right one; Ctrl+Z is the owner's Undo. Nudges change one layer's transform: no array shifts.
import { until } from '../helpers.mjs'

const LEFT = { x: 500, y: 330 }, RIGHT = { x: 760, y: 330 }
const checkpoint = (page) => page.evaluate(() => {
  try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch (e) { return `error: ${e}` }
})
const rectangles = async (page) => (await checkpoint(page)).split('"type":"rectangle"').length - 1
const draw = async (page, { x, y }) => {
  await page.keyboard.press('r')
  await page.mouse.move(x - 40, y - 40)
  await page.mouse.down()
  await page.mouse.move(x + 40, y + 40, { steps: 8 })
  await page.mouse.up()
}
const nudge = async (page, { x, y }) => {
  await page.mouse.click(x, y)
  await page.keyboard.press('ArrowRight')
}

export default {
  path: '/figcraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await until(async () => !(await checkpoint(page)).startsWith('error'), 120000, 'FigCraft to run')
    // A first click gives the canvas the keyboard. A busy machine can drop the first keys: draw again until it shows.
    for (const [at, count] of [[LEFT, 1], [RIGHT, 2]]) {
      for (let tries = 0; await rectangles(page) < count; tries++) {
        if (tries === 4) throw new Error(`no rectangle ${count} after ${tries} tries`)
        await page.mouse.click(640, 600)
        await draw(page, at)
        await until(async () => await rectangles(page) >= count, 5000, `rectangle ${count}`).catch(() => {})
      }
    }
  },
  editA: (page) => nudge(page, LEFT),
  editB: (page) => nudge(page, RIGHT),
  undo: (page) => page.keyboard.press('Control+z'),
}
