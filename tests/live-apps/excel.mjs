import { until } from '../helpers.mjs'

// GridCraft (excel): a blank Book1. The grid takes the keyboard once the canvas has focus (crates/ui-egui/src/grid.rs
// `keyboard`): Ctrl+Home goes to A1, typing starts an edit and Enter commits it. The owner fills A1, the editor C3
// (two cells, two keys of the sheet's cell map); the owner's Ctrl+Z empties A1 again. Before that the owner selects
// B2:C4 from the keyboard and rests the pointer on the grid: the editor is shown that sheet, selection and pointer cell.
const pause = (page, ms = 250) => page.waitForTimeout(ms)
async function enter(page, moves, text) {
  await page.focus('#gridcraft_canvas')
  await page.keyboard.press('Control+Home')
  for (const key of moves) await page.keyboard.press(key)
  await pause(page)
  await page.keyboard.type(text, { delay: 30 })
  await page.keyboard.press('Enter')
  await pause(page)
}

export default {
  path: '/gridcraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await until(() => page.evaluate(() => !document.getElementById('gridcraft_loading')), 120000, 'GridCraft to start')
    await pause(page, 1000)
    // Focus the canvas on the grid (below the ribbon and formula bar).
    await page.mouse.click(640, 500)
    await pause(page)
  },
  point: async (page) => {
    await page.focus('#gridcraft_canvas')
    for (const key of ['Control+Home', 'ArrowDown', 'ArrowRight', 'Shift+ArrowDown', 'Shift+ArrowDown', 'Shift+ArrowRight']) await page.keyboard.press(key)
    await page.mouse.move(520, 430)
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.pointer), 10000, 'the pointer on the grid')
  },
  editA: (page) => enter(page, [], '1'),
  editB: (page) => enter(page, ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown'], '2'),
  undo: async (page) => {
    await page.focus('#gridcraft_canvas')
    await page.keyboard.press('Control+z')
  },
}
