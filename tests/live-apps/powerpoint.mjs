// DeckCraft (powerpoint): the sample deck's title slide. A click on the grey pasteboard right of the slide deselects
// and gives the canvas the keyboard; Tab selects the next shape (title, subtitle, band: crates/engine/src/keys.rs
// cycle_selection), a typed letter replaces its text (type_text) and Esc leaves the text. The owner retitles the
// title, the editor the subtitle; Ctrl+Z is the owner's Undo.
import { until } from '../helpers.mjs'

const PASTEBOARD = { x: 1250, y: 400 }
const checkpoint = (page) => page.evaluate(() => {
  try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch (e) { return `error: ${e}` }
})
const retype = async (page, tabs, letter) => {
  await page.mouse.click(PASTEBOARD.x, PASTEBOARD.y)
  for (let i = 0; i < tabs; i++) await page.keyboard.press('Tab')
  await page.keyboard.type(letter)
  await page.keyboard.press('Escape')
}

export default {
  path: '/deckcraft/',
  viewport: { width: 1280, height: 800 },
  ready: (page) => until(async () => (await checkpoint(page)).includes('Northern Lights'), 120000, 'the sample deck'),
  editA: (page) => retype(page, 1, 'A'),
  editB: (page) => retype(page, 2, 'B'),
  undo: (page) => page.keyboard.press('Control+z'),
}
