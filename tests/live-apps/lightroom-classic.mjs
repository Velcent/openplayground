// LightCraft Classic (lightroom-classic): a fresh profile opens the demo library on its first photo in Library's Loupe.
// The owner rates that photo 1 star (key 1); the editor steps to the next photo (Right arrow) and rates it 2 stars;
// Ctrl+Z is the owner's Undo (crates/ui-egui/src/shortcuts.rs: 0-5 rate the active photo, the arrows step through the
// filmstrip). Each page has its own browser context, so the app's one-tab-per-browser lock never trips.
import { until } from '../helpers.mjs'

const active = (page) => page.evaluate(async () => {
  try { return JSON.parse(await app.command('library.state', '{}')).selection.active } catch { return null }
})

export default {
  path: '/lightcraft-classic/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await until(async () => await active(page) != null, 60000, 'the demo library')
    await page.focus('#app_canvas')
  },
  editA: (page) => page.keyboard.press('1'),
  editB: async (page) => {
    const first = await active(page)
    await page.keyboard.press('ArrowRight')
    await until(async () => await active(page) !== first, 10000, 'the next photo')
    await page.keyboard.press('2')
  },
  undo: (page) => page.keyboard.press('Control+z'),
}
