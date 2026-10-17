import { until } from '../helpers.mjs'

// CADCraft (autocad): Drawing1 in model space; typed text goes to the command line wherever focus is (ui-egui
// cmdline.rs). Every page draws the same two circles first (the joiner's copy is replaced by the owner's). The owner
// adds a third circle (a fresh handle, appended to model space), the editor moves the right one (a typed Window
// selection). The handle counter (handseed, merged by maximum) may stay raised after Undo. Before that the owner
// clicks the left circle's edge (no command: it is selected) and rests the pointer there: the editor is shown that
// space, selection and pointer.
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
    // The drawing's transform from two pointer positions (presence() gives the pointer in drawing units).
    const at = async (x, y, before) => {
      await page.mouse.move(x, y)
      const pointer = () => page.evaluate(() => playgroundLiveAdapter.presence()?.pointer)
      return until(async () => { const p = await pointer(); return p?.[0] !== before && p }, 10000, 'the pointer on the canvas')
    }
    const [x0, y0] = await at(600, 400)
    const [x1] = await at(700, 400, x0)
    const scale = 100 / (x1 - x0)
    const x = 600 + (2 - x0) * scale, y = 400 - (4.5 - y0) * scale
    await page.mouse.click(x, y)
    await until(() => page.evaluate(() => playgroundLiveAdapter.presence()?.selection?.length === 1), 10000, 'the circle selected')
  },
  editA: (page) => type(page, 'circle', '6,1', '0.5'),
  editB: (page) => type(page, 'move', 'w', '7.5,3', '10.5,6', '', '0,0', '0,-1'),
  ignore: ['/handseed'],
  undo: async (page) => {
    await page.focus('#cadcraft_canvas')
    await page.keyboard.press('Control+z')
  },
}
