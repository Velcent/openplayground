import { until } from '../helpers.mjs'

// CADCraft (autocad): Drawing1 in model space; typed text goes to the command line wherever focus is (ui-egui
// cmdline.rs). Every page draws the same two circles first (the joiner's copy is replaced by the owner's). The owner
// moves the left one (a typed Window selection), the editor the right one (Last selection). Neither adds an object: the
// handle counter (handseed, merged by maximum) stays where both left it, so it would not go back with an Undo.
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
  editA: (page) => type(page, 'move', 'w', '1.5,3', '4.5,6', '', '0,0', '0,1'),
  editB: (page) => type(page, 'move', 'l', '', '0,0', '0,-1'),
  undo: async (page) => {
    await page.focus('#cadcraft_canvas')
    await page.keyboard.press('Control+z')
  },
}
