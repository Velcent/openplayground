// WordCraft (word): the web build opens on File › Home; the "Blank document" tile (first, crates/ui-egui/src/backstage.rs
// home_page) opens a blank document and gives the page the keyboard; "Hello world", Enter, then "+-----+-----+" and Enter
// make a paragraph, a one-row table of two equal columns across the text (AutoFormat, engine cmd/text.rs
// apply_table_line) and the empty paragraph after it. The owner types at the start of the first paragraph (Ctrl+Home),
// the editor at the end of the last (Ctrl+End): two paragraphs, two index paths of the body. The owner's Ctrl+Z
// (edit.undo) takes back only the owner's letter.
// Presence: the owner selects the first word (Ctrl+Home, Ctrl+Shift+Right) and rests the pointer on the page: the editor
// is shown that selection (anchor and focus: story, paragraph path, byte offset) and pointer (page, x, y in points).
// drag() holds the table's middle column border dragged to the right (table_resize: no change until it is let go): the
// owner's presence then carries `border` (the line where it is). The harness's release (Escape, then mouse up) cancels
// it, so nothing changes. WordCraft keeps one document open (a new one replaces it), so there is no openTab().
import { until } from '../helpers.mjs'

const BLANK = { x: 315, y: 214 }
const blocks = (page) => page.evaluate(() => {
  try { return JSON.parse(new TextDecoder().decode(playgroundLiveAdapter.checkpoint())).body.length } catch { return 0 }
})
const type = async (page, where, letter) => {
  await page.keyboard.press(where)
  await page.keyboard.type(letter)
}
const presence = (page) => page.evaluate(() => playgroundLiveAdapter.presence())
// Screen points of the first page's points, from where two screen points land in the owner's presence.
async function pageToScreen(page) {
  const land = async (sx, sy) => {
    await page.mouse.move(sx, sy)
    await until(async () => (await presence(page))?.pointer?.[1] !== undefined, 5000, 'the pointer on the page')
    await page.waitForTimeout(120)
    return (await presence(page)).pointer
  }
  const [a, b] = [await land(500, 300), await land(800, 600)]
  const k = [(800 - 500) / (b[1] - a[1]), (600 - 300) / (b[2] - a[2])]
  return (x, y) => ({ x: 500 + (x - a[1]) * k[0], y: 300 + (y - a[2]) * k[1] })
}

export default {
  path: '/wordcraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await until(() => page.evaluate(() => !document.getElementById('wordcraft_loading')), 120000, 'WordCraft to start')
    await page.waitForTimeout(1000)
    await page.mouse.click(BLANK.x, BLANK.y)
    await page.waitForTimeout(500)
    await page.keyboard.type('Hello world')
    await page.keyboard.press('Enter')
    await page.keyboard.type('+--------------------+--------------------+')
    await page.keyboard.press('Enter')
    await until(async () => await blocks(page) === 3, 10000, 'a paragraph, a table and a paragraph')
  },
  point: async (page) => {
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Control+Shift+ArrowRight')
    await page.mouse.move(640, 500)
    await until(() => page.evaluate(() => {
      const p = playgroundLiveAdapter.presence()
      return !!p?.pointer && p.anchor.off !== p.focus.off
    }), 10000, 'the first word selected and the pointer on the page')
  },
  drag: async (page) => {
    // The border between the two columns: half way across the text (1 in margins, 6.5 in of text), somewhere in the row
    // under the first paragraph; the pointer turns into the column-resize arrow over it.
    const cursor = () => page.evaluate(() => document.querySelector('canvas')?.style.cursor)
    const screen = await pageToScreen(page)
    let at = null
    for (let y = 84; y <= 130 && !at; y += 3) {
      const p = screen(306, y)
      await page.mouse.move(p.x, p.y)
      await page.waitForTimeout(60)
      if (await cursor() === 'col-resize') at = p
    }
    if (!at) throw new Error('the table\'s column border was not found')
    await page.mouse.down()
    for (let i = 1; i <= 6; i++) { await page.mouse.move(at.x + 10 * i, at.y); await page.waitForTimeout(50) }
    await until(async () => !!(await presence(page))?.border, 10000, 'the column border held mid-drag')
  },
  editA: (page) => type(page, 'Control+Home', 'A'),
  editB: (page) => type(page, 'Control+End', 'B'),
  undo: (page) => page.keyboard.press('Control+z'),
}
