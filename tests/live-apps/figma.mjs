// FigCraft (figma): each page starts on a new file's Page 1; `ready` draws two rectangles with the Rectangle tool (R,
// drag), which leaves the Move tool on. The owner selects the left one with a click and nudges it right (→), the
// editor the right one; Ctrl+Z is the owner's Undo. Nudges change one layer's transform: no array shifts.
// The tool key gets a frame of its own: in a frame that has both, the canvas takes the press before the shortcut
// switches the tool (a drag then selects instead of drawing, and a later click with the tool left on would draw a
// stray 100×100 rectangle). Before the edits the owner selects the left one with a click and leaves the pointer on it:
// the editor is shown that file, page, pointer (page coordinates) and selection.
// The shared document is the session's files ({ documents: [...] }). The editor, whose own file has drawings, gets the
// owner's as a new tab fitted to its view, so it finds the right rectangle on the page through its own pointer
// (presence() gives it in page coordinates). drag: the owner holds a move of the left rectangle (presence `ghosts`);
// release: Escape cancels it. openTab: the owner makes a new file (Ctrl+N), a background tab for the editor.
import { until } from '../helpers.mjs'

const LEFT = { x: 500, y: 330 }, RIGHT = { x: 760, y: 330 }
const checkpoint = (page) => page.evaluate(() => {
  try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch (e) { return `error: ${e}` }
})
// Two animation frames: the app has run a frame for the input before.
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
const rectangles = async (page) => (await checkpoint(page)).split('"type":"rectangle"').length - 1
// The shared files, once the app is not busy.
const files = async (page) => JSON.parse(await until(async () => { const t = await checkpoint(page); return !t.startsWith('error') && t }, 10000, 'a checkpoint')).documents
const draw = async (page, { x, y }) => {
  await page.keyboard.press('r')
  await frames(page)
  await page.mouse.move(x - 40, y - 40)
  await page.mouse.down()
  await page.mouse.move(x + 40, y + 40, { steps: 8 })
  await page.mouse.up()
}
// A click on its own (a second click within egui's double-click time would edit the rectangle's points).
const nudge = async (page, { x, y }) => {
  await page.waitForTimeout(400)
  await page.mouse.click(x, y)
  await frames(page)
  await page.keyboard.press('ArrowRight')
}
// Where page point (x, y) of the file in front shows: the view from the pointer at two places.
async function view(page) {
  const pointer = () => page.evaluate(() => playgroundLiveAdapter.presence()?.pointer)
  await page.mouse.move(600, 400)
  const [x0, y0] = await until(pointer, 10000, 'the pointer on the canvas')
  await page.mouse.move(700, 400)
  const [x1] = await until(async () => { const p = await pointer(); return p?.[0] !== x0 && p }, 10000, 'the pointer to move')
  const scale = 100 / (x1 - x0)
  return (x, y) => ({ x: 600 + (x - x0) * scale, y: 400 + (y - y0) * scale })
}
// The rectangles' centres in the session's first file (page coordinates), left to right.
const centres = async (page) => (await files(page))[0].changes
  .map((c) => c.create).filter((c) => c?.kind?.type === 'rectangle')
  .map((c) => { const p = Object.fromEntries(c.props); return [p.transform[4] + p.width / 2, p.transform[5] + p.height / 2] })
  .sort((a, b) => a[0] - b[0])

export default {
  path: '/figcraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await until(async () => !(await checkpoint(page)).startsWith('error'), 120000, 'FigCraft to run')
    // A first click gives the canvas the keyboard. A busy machine can drop the first keys: draw again until it shows
    // (each try first back on the Move tool, so its click draws nothing).
    for (const [at, count] of [[LEFT, 1], [RIGHT, 2]]) {
      for (let tries = 0; await rectangles(page) < count; tries++) {
        if (tries === 4) throw new Error(`no rectangle ${count} after ${tries} tries`)
        await page.keyboard.press('v')
        await frames(page)
        await page.mouse.click(640, 600)
        await draw(page, at)
        await until(async () => await rectangles(page) >= count, 5000, `rectangle ${count}`).catch(() => {})
      }
    }
  },
  drag: async (page) => {
    await page.mouse.move(LEFT.x, LEFT.y)
    await frames(page)
    await page.mouse.down()
    for (let i = 1; i <= 6; i++) await page.mouse.move(LEFT.x + 12 * i, LEFT.y + 6 * i, { steps: 2 })
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.ghosts), 10000, 'the move under way')
    await page.waitForTimeout(300)
  },
  // Escape in a frame of its own first: in one frame with the button coming up, the release would place the layers.
  release: async (page) => {
    await page.keyboard.press('Escape')
    await frames(page)
    await page.mouse.up()
    await frames(page)
  },
  point: async (page) => {
    await page.mouse.click(LEFT.x, LEFT.y)
    await frames(page)
    await until(() => page.evaluate(() => {
      const mine = playgroundLiveAdapter.presence()
      return !!mine?.pointer && mine.selection.length === 1
    }), 10000, 'the pointer and selection')
  },
  editA: (page) => nudge(page, LEFT),
  editB: async (page) => {
    const [, [x, y]] = await centres(page)
    await nudge(page, (await view(page))(x, y))
  },
  undo: (page) => page.keyboard.press('Control+z'),
  openTab: async (page) => {
    await page.keyboard.press('Control+n')
    await until(async () => (await files(page)).length === 2, 10000, 'a second file')
  },
}
