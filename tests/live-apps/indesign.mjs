import { until } from '../helpers.mjs'

// DesignCraft: the start screen's "Open sample magazine", then the Selection tool (the default) picks a frame on the
// cover and the Right arrow nudges it. The canvas fits the cover page on first show (crates/ui-egui/src/canvas.rs).
// In drag() the owner drags the title frame and holds the button: the editor is shown its ghost (`ghosts`); release()
// takes it back to where it started with snapping off (Ctrl), so letting go changes nothing (Escape does not cancel a
// move here). In openTab() the owner makes a new document (New Document…, Enter): it joins the session's documents, a
// tab for the editor.
const SAMPLE = { x: 304, y: 232 }
const TITLE = { x: 400, y: 520 } // "The Quiet Art of Layout" (crates/engine/src/sample.rs: 42,420 – 570,698)
const KICKER = { x: 380, y: 214 } // "THE SPRING ISSUE · NO. 01" (42,60 – 570,120)
const checkpoint = (page) => page.evaluate(() => { try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch { return '' } })
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
      return (await checkpoint(page)).length > 1000
    }, 60000, 'the sample magazine to open')
  },
  drag: async (page) => {
    await page.mouse.move(TITLE.x, TITLE.y)
    await page.mouse.down()
    for (const [x, y] of [[420, 510], [460, 490], [500, 470]]) await page.mouse.move(x, y, { steps: 3 })
  },
  release: async (page) => {
    await page.keyboard.down('Control')
    await page.mouse.move(TITLE.x, TITLE.y, { steps: 3 })
    await page.mouse.up()
    await page.keyboard.up('Control')
  },
  openTab: async (page) => {
    const documents = async () => { try { return JSON.parse(await checkpoint(page)).documents.length } catch { return 0 } }
    const before = await documents()
    await page.keyboard.press('Control+n')
    await page.waitForTimeout(500)
    await page.keyboard.press('Enter')
    await until(async () => (await documents()) > before, 10000, 'a second document')
  },
  // The owner selects the title frame (a click, no edit) and rests the pointer on the cover: the editor sees that
  // pointer with the owner's name, and the title outlined, in the owner's color.
  point: async (page) => {
    await page.mouse.click(TITLE.x, TITLE.y)
    await page.mouse.move(560, 330)
    await until(() => page.evaluate(() => { const p = playgroundLiveAdapter.presence(); return !!p?.pointer && p.selection.length > 0 }), 10000, 'the pointer and a selection on the cover')
    // editA clicks the same frame next: a second click this soon is a double-click, which starts typing in it.
    await page.waitForTimeout(800)
  },
  editA: (page) => nudge(page, TITLE),
  editB: (page) => nudge(page, KICKER),
  undo: (page) => page.keyboard.press('Control+z'),
}
