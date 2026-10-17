// DeckCraft (powerpoint): the sample deck's title slide. A click on a text placeholder selects it (and gives the
// canvas the keyboard), a typed letter replaces or extends its text and Esc leaves the text. The owner edits the
// title, the editor the subtitle; Ctrl+Z is the owner's Undo. Clicks, not Tab: in v0.7.0 Tab could also move egui's
// focus to the ribbon (fixed later upstream, #78). The points are inside both shapes on both channels' layouts.
// Presence: the owner selects the subtitle (a click, no typing) and points at the title; the editor sees the subtitle
// outlined and the pointer with the owner's name, in the owner's color.
// drag() holds a move of the title slide's decorative band (the rect at 0,470 960×70 pt, engine sample.rs): the owner's
// presence then carries `drag` (its ghost). release() brings it back where it started with Ctrl down (no snapping) and
// lets go, so nothing changes. openTab() makes a new presentation (Ctrl+N): it joins the session's presentations
// (`documents`) and opens behind the editor's own.
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
// The page point of slide point (x, y), from where two page points land on the slide in the owner's presence.
async function slideToPage(page, x, y) {
  const land = async (px, py) => {
    await page.mouse.move(px, py)
    await until(async () => (await page.evaluate(() => playgroundLiveAdapter.presence()?.pointer))?.length === 2, 5000, 'the pointer on the slide')
    await page.waitForTimeout(120)
    return page.evaluate(() => playgroundLiveAdapter.presence().pointer)
  }
  const [a, b] = [await land(400, 300), await land(900, 600)]
  const k = [(900 - 400) / (b[0] - a[0]), (600 - 300) / (b[1] - a[1])]
  return { x: 400 + (x - a[0]) * k[0], y: 300 + (y - a[1]) * k[1] }
}
let held = null

export default {
  path: '/deckcraft/',
  viewport: { width: 1280, height: 800 },
  ready: (page) => until(async () => (await checkpoint(page)).includes('Northern Lights'), 120000, 'the sample deck'),
  editA: (page) => retype(page, TITLE, 'A'),
  editB: (page) => retype(page, SUBTITLE, 'B'),
  undo: (page) => page.keyboard.press('Control+z'),
  point: async (page) => {
    await page.mouse.click(SUBTITLE.x, SUBTITLE.y)
    await page.mouse.move(TITLE.x - 200, TITLE.y - 20)
    await until(() => page.evaluate(() => playgroundLiveAdapter.presence()?.selection?.length === 1 && !!playgroundLiveAdapter.presence().pointer), 10000, 'the selection and pointer')
  },
  drag: async (page) => {
    held = await slideToPage(page, 60, 505)
    await page.mouse.move(held.x, held.y)
    await page.mouse.down()
    for (let i = 1; i <= 6; i++) { await page.mouse.move(held.x + 12 * i, held.y - 9 * i); await page.waitForTimeout(50) }
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.drag), 10000, 'the band held mid-move')
  },
  release: async (page) => {
    await page.keyboard.down('Control')
    await page.mouse.move(held.x, held.y, { steps: 3 })
    await page.mouse.up()
    await page.keyboard.up('Control')
  },
  openTab: async (page) => {
    await page.keyboard.press('Control+n')
    // checkpoint() throws 'busy' while a key is down.
    await until(async () => { try { return JSON.parse(await checkpoint(page)).documents.length === 2 } catch { return false } }, 10000, 'a second presentation in the session')
  },
}
