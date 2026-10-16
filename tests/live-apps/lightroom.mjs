// LightCraft (lightroom): a fresh profile opens the demo library on its first photo in Detail view. The owner rates
// that photo 1 star (key 1); the editor steps to the next photo (Right arrow) and rates it 2 stars; Ctrl+Z is the
// owner's Undo (crates/ui-egui/src/shortcuts.rs: 0-5 rate the active photo, the arrows step through the filmstrip).
// The owner then imports a photo: its original reaches the others as a session file.
// Each page has its own browser context, so LightCraft's one-tab-per-browser lock never trips.
import { until } from '../helpers.mjs'

const active = (page) => page.evaluate(async () => {
  try { return JSON.parse(await lightcraft.command('library.state', '{}')).selection.active } catch { return null }
})

export default {
  path: '/lightcraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await until(async () => await active(page) != null, 60000, 'the demo library')
    await page.focus('#lightcraft_canvas')
  },
  editA: (page) => page.keyboard.press('1'),
  editB: async (page) => {
    const first = await active(page)
    await page.keyboard.press('ArrowRight')
    await until(async () => await active(page) !== first, 10000, 'the next photo')
    await page.keyboard.press('2')
  },
  undo: (page) => page.keyboard.press('Control+z'),
  // The owner points at the middle of the photo open in the loupe: the others see that pointer, and the owner's
  // selection outlined in their filmstrip.
  point: async (page) => {
    await page.mouse.move(480, 345)
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.pointer), 10000, 'the pointer on the photo')
  },
  // File ▸ Import Photos… (file.addPhotos) opens the browser's file picker; the photo is a 16×16 PNG drawn here.
  importMedia: async (page) => {
    const png = await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(16, 16), g = canvas.getContext('2d')
      g.fillStyle = '#c63'
      g.fillRect(0, 0, 16, 16)
      return [...new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())]
    })
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.evaluate(() => lightcraft.command('file.addPhotos', '{}'))])
    await chooser.setFiles({ name: 'live-import.png', mimeType: 'image/png', buffer: Buffer.from(png) })
  },
}
