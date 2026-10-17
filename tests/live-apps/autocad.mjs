import { until } from '../helpers.mjs'

// CADCraft (autocad): Drawing1 in model space; typed text goes to the command line wherever focus is (ui-egui
// cmdline.rs). Every page draws the same two circles first (the joiner's copy is replaced by the owner's). The owner
// adds a third circle (a fresh handle, appended to model space), the editor moves the right one (a typed Window
// selection). The handle counter (handseed, merged by maximum) may stay raised after Undo. Before that the owner
// clicks the left circle's edge (no command: it is selected) and rests the pointer there: the editor is shown that
// space, selection and pointer. The shared document is the session's drawings ({ documents: [...] }), Drawing1 first.
// drag: the owner MOVEs the left circle from its centre with the mouse held down (the editor is shown the move under
// way: `drag`, the circle's ghost, and `band`, the line from the base point). openTab: the owner opens the sample
// drawing (a new tab, which the owner then shows; the editor gets it as a tab behind Drawing1).
const pause = (page, ms = 250) => page.waitForTimeout(ms)
// Each input followed by Enter ('' is Enter alone).
async function type(page, ...inputs) {
  await page.focus('#cadcraft_canvas')
  for (const text of inputs) {
    if (text) await page.keyboard.type(text, { delay: 20 })
    await page.keyboard.press('Enter')
    await pause(page)
  }
}

// Where drawing point (x, y) is on the page: the canvas's transform from two pointer positions (presence() gives the
// pointer in drawing units).
async function view(page) {
  const pointer = () => page.evaluate(() => playgroundLiveAdapter.presence()?.pointer)
  await page.mouse.move(600, 400)
  await pause(page, 300)
  const [x0, y0] = await until(pointer, 10000, 'the pointer on the canvas')
  await page.mouse.move(700, 400)
  const [x1] = await until(async () => { const p = await pointer(); return p?.[0] !== x0 && p }, 10000, 'the pointer to move')
  const scale = 100 / (x1 - x0)
  return (x, y) => [600 + (x - x0) * scale, 400 - (y - y0) * scale]
}

export default {
  path: '/cadcraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await until(() => page.evaluate(() => !document.getElementById('cadcraft_loading')), 120000, 'CADCraft to start')
    await pause(page, 1000)
    await type(page, 'circle', '3,4.5', '1')
    await type(page, 'circle', '9,4.5', '1')
  },
  point: async (page) => {
    const [x, y] = (await view(page))(2, 4.5)
    await page.mouse.click(x, y)
    await until(() => page.evaluate(() => playgroundLiveAdapter.presence()?.selection?.length === 1), 10000, 'the circle selected')
  },
  editA: (page) => type(page, 'circle', '6,1', '0.5'),
  editB: (page) => type(page, 'move', 'w', '7.5,3', '10.5,6', '', '0,0', '0,-1'),
  drag: async (page) => {
    const to = await view(page)
    await type(page, 'move', 'w', '1.5,3', '4.5,6', '', '3,4.5')
    const [x, y] = to(3, 4.5)
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(x + 25 * i, y - 10 * i)
      await pause(page, 50)
    }
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.drag), 10000, 'the move under way')
    await pause(page, 300)
  },
  // Escape ends MOVE first (in one frame with the button coming up, the release would place the point); a second one
  // clears the selection MOVE leaves.
  release: async (page) => {
    await page.keyboard.press('Escape')
    await pause(page, 300)
    await page.mouse.up()
    await page.keyboard.press('Escape')
    await pause(page, 300)
  },
  openTab: (page) => type(page, 'ui.sample'),
  ignore: ['/documents/0/handseed'],
  undo: async (page) => {
    await page.focus('#cadcraft_canvas')
    await page.keyboard.press('Control+z')
  },
}
