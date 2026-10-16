// DeckCraft (powerpoint): the sample deck's title slide. A click on a text placeholder selects it (and gives the
// canvas the keyboard), a typed letter replaces or extends its text and Esc leaves the text. The owner edits the
// title, the editor the subtitle; Ctrl+Z is the owner's Undo. Clicks, not Tab: in v0.7.0 Tab could also move egui's
// focus to the ribbon (fixed later upstream, #78). The points are inside both shapes on both channels' layouts.
import { until } from '../helpers.mjs'

const TITLE = { x: 758, y: 370 }
const SUBTITLE = { x: 758, y: 490 }
const checkpoint = (page) => page.evaluate(() => {
  try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch (e) { return `error: ${e}` }
})
const retype = async (page, at, letter) => {
  await page.mouse.click(at.x, at.y)
  await page.keyboard.type(letter)
  await page.keyboard.press('Escape')
}

export default {
  path: '/deckcraft/',
  viewport: { width: 1280, height: 800 },
  ready: (page) => until(async () => (await checkpoint(page)).includes('Northern Lights'), 120000, 'the sample deck'),
  editA: (page) => retype(page, TITLE, 'A'),
  editB: (page) => retype(page, SUBTITLE, 'B'),
  undo: (page) => page.keyboard.press('Control+z'),
}
