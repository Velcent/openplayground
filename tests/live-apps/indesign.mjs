import { until } from '../helpers.mjs'

// DesignCraft: the start screen's "Open sample magazine", then the Selection tool (the default) picks a frame on the
// cover and the Right arrow nudges it. The canvas fits the cover page on first show (crates/ui-egui/src/canvas.rs).
const SAMPLE = { x: 304, y: 232 }
const TITLE = { x: 400, y: 520 } // "The Quiet Art of Layout" (crates/engine/src/sample.rs: 42,420 – 570,698)
const KICKER = { x: 380, y: 214 } // "THE SPRING ISSUE · NO. 01" (42,60 – 570,120)
const doc = (page) => page.evaluate(() => { try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()).length } catch { return 0 } })
const nudge = async (page, at) => {
  await page.mouse.click(at.x, at.y)
  await page.keyboard.press('ArrowRight')
}

export default {
  path: '/designcraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await until(() => page.evaluate(() => !document.getElementById('designcraft_loading')), 60000, 'DesignCraft to start')
    await until(async () => {
      await page.mouse.click(SAMPLE.x, SAMPLE.y)
      await page.waitForTimeout(500)
      return await doc(page) > 1000
    }, 60000, 'the sample magazine to open')
  },
  editA: (page) => nudge(page, TITLE),
  editB: (page) => nudge(page, KICKER),
  undo: (page) => page.keyboard.press('Control+z'),
}
