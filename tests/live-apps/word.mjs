// WordCraft (word): the web build opens on File › Home; the "Blank document" tile (first, crates/ui-egui/src/backstage.rs
// home_page) opens a blank document and gives the page the keyboard; "Hello world" and Enter make two paragraphs. The
// owner types at the start of the first paragraph (Ctrl+Home), the editor at the end of the last (Ctrl+End): two
// paragraphs, two index paths of the body. The owner's Ctrl+Z (edit.undo) takes back only the owner's letter.
// Presence: the owner selects the first word (Ctrl+Home, Ctrl+Shift+Right) and rests the pointer on the page: the editor
// is shown that selection (anchor and focus: story, paragraph path, byte offset) and pointer (page, x, y in points).
import { until } from '../helpers.mjs'

const BLANK = { x: 315, y: 214 }
const paragraphs = (page) => page.evaluate(() => {
  try { return JSON.parse(new TextDecoder().decode(playgroundLiveAdapter.checkpoint())).body.length } catch { return 0 }
})
const type = async (page, where, letter) => {
  await page.keyboard.press(where)
  await page.keyboard.type(letter)
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
    await until(async () => await paragraphs(page) === 2, 10000, 'a document with two paragraphs')
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
  editA: (page) => type(page, 'Control+Home', 'A'),
  editB: (page) => type(page, 'Control+End', 'B'),
  undo: (page) => page.keyboard.press('Control+z'),
}
