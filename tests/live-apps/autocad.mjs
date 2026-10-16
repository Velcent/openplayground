import { until } from '../helpers.mjs'

// CADCraft (autocad): Drawing1 in model space; typed text goes to the command line wherever focus is (ui-egui
// cmdline.rs). Every page draws the same two circles first (the joiner's copy is replaced by the owner's). The owner
// adds a third circle (a fresh handle, appended to model space), the editor moves the right one (a typed Window
// selection). The handle counter (handseed, merged by maximum) may stay raised after Undo.
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
  editA: (page) => type(page, 'circle', '6,1', '0.5'),
  editB: (page) => type(page, 'move', 'w', '7.5,3', '10.5,6', '', '0,0', '0,-1'),
  ignore: ['/handseed'],
  undo: async (page) => {
    await page.focus('#cadcraft_canvas')
    await page.keyboard.press('Control+z')
  },
}
