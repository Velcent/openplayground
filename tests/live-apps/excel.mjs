import { until } from '../helpers.mjs'

// GridCraft (excel): a blank Book1. The grid takes the keyboard once the canvas has focus (crates/ui-egui/src/grid.rs
// `keyboard`): Ctrl+Home goes to A1, typing starts an edit and Enter commits it. The owner fills A1, the editor C3
// (two cells, two keys of the sheet's cell map); the owner's Ctrl+Z empties A1 again. Before that the owner selects
// B2:C4 from the keyboard and rests the pointer on the grid: the editor is shown that sheet, selection and pointer cell.
// drag() clicks a cell and holds its fill handle (crates/ui-egui/src/grid.rs `Drag::Fill`) three rows down: the owner's
// presence then carries `drag: {fill: <range>}`. The cell is empty, so releasing it changes nothing. openTab() makes a new
// workbook (Ctrl+N): it joins the session's workbooks (`documents`) and opens behind the editor's own; the owner stays on
// it (File › Home lists the session's workbooks).
const pause = (page, ms = 250) => page.waitForTimeout(ms)
// The cell under the owner's pointer at (x, y), as their presence gives it.
async function cellAt(page, x, y) {
  await page.mouse.move(x, y)
  await pause(page, 80)
  return page.evaluate(() => playgroundLiveAdapter.presence()?.pointer?.[0])
}
// The first pixel from `from` toward `to` (on one axis: `at` makes the point) that is in another cell than `from`.
async function edge(page, from, to, at) {
  const start = await cellAt(page, ...at(from))
  while (to - from > 1) {
    const mid = Math.floor((from + to) / 2)
    if (await cellAt(page, ...at(mid)) === start) from = mid
    else to = mid
  }
  return to
}
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
  drag: async (page) => {
    await page.mouse.click(520, 430)
    const x = await edge(page, 520, 1200, (x) => [x, 430]) - 0.5
    const y = await edge(page, 430, 740, (y) => [520, y]) - 0.5
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (const dy of [12, 24, 36, 48]) {
      await page.mouse.move(x, y + dy)
      await pause(page, 50)
    }
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.drag?.fill), 10000, 'the fill handle held')
  },
  openTab: async (page) => {
    await page.focus('#gridcraft_canvas')
    await page.keyboard.press('Control+n')
    // checkpoint() throws 'busy' while a key is down.
    const workbooks = () => page.evaluate(() => { try { return JSON.parse(new TextDecoder().decode(playgroundLiveAdapter.checkpoint())).documents.length } catch { return 0 } })
    await until(async () => await workbooks() === 2, 10000, 'a second workbook in the session')
  },
  editA: (page) => enter(page, [], '1'),
  editB: (page) => enter(page, ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown'], '2'),
  undo: async (page) => {
    await page.focus('#gridcraft_canvas')
    await page.keyboard.press('Control+z')
  },
}
