// WordCraft (word): the web build opens on File › Home; the "Blank document" tile (first, crates/ui-egui/src/backstage.rs
// home_page) opens a blank document and gives the page the keyboard, and Enter adds a second paragraph. The owner types
// at the start of the first paragraph (Ctrl+Home), the editor at the end of the last (Ctrl+End): two paragraphs, two
// index paths of the body. The owner's Ctrl+Z (edit.undo) takes back only the owner's letter.
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
    await page.keyboard.press('Enter')
    await until(async () => await paragraphs(page) === 2, 10000, 'a blank document with two paragraphs')
  },
  editA: (page) => type(page, 'Control+Home', 'A'),
  editB: (page) => type(page, 'Control+End', 'B'),
  undo: (page) => page.keyboard.press('Control+z'),
}
