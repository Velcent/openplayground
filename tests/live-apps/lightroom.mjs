// LightCraft (lightroom): a fresh profile opens the demo library on its first photo in Detail view. The owner rates
// that photo 1 star (key 1); the editor steps to the next photo (Right arrow) and rates it 2 stars; Ctrl+Z is the
// owner's Undo (crates/ui-egui/src/shortcuts.rs: 0-5 rate the active photo, the arrows step through the filmstrip).
// The owner then imports a photo: its original reaches the others as a session file; before that, both change one
// photo at once (together()). drag() holds the Exposure slider (presence `adjust`) and lets go with nothing changed.
// Each page has its own browser context, so LightCraft's one-tab-per-browser lock never trips.
import assert from 'node:assert/strict'
import { until } from '../helpers.mjs'

const active = (page) => page.evaluate(async () => {
  try { return JSON.parse(await lightcraft.command('library.state', '{}')).selection.active } catch { return null }
})
// The pages in the order the harness opens them (the owner's first): together() needs the owner's and the editor's.
const pages = []

// Two develop edits of one photo at once (LightCraft and LightCraft Classic, whose app is `globalThis[app]`): the owner
// (a) holds a crop drag while the editor (b) brushes a stroke on the same photo; once the stroke is in the shared
// document, the owner lets go. Both land on both pages: the crop box and the new mask; nothing is kept as a draft.
export async function together(a, b, app) {
  const command = (page, id, params = {}) => page.evaluate(([app, id, params]) => globalThis[app].command(id, JSON.stringify(params)), [app, id, params])
  const presence = (page) => page.evaluate(() => playgroundLiveAdapter.presence())
  const text = (page) => page.evaluate(() => new TextDecoder().decode(playgroundLiveAdapter.checkpoint()))
  const photo = (await presence(a)).page
  const look = async (page) => {
    const d = JSON.parse(await text(page)).photos[photo].develop
    return { crop: JSON.stringify(d.crop.geometry.rect), masks: d.masks.length }
  }
  // Where normalized point n of the photo open in the loupe is on screen (two probes of the pointer).
  const screenOf = async (page, n) => {
    const probe = async (x, y) => { await page.mouse.move(x, y); await page.waitForTimeout(250); return (await presence(page)).pointer }
    const p = await probe(420, 250), q = await probe(560, 480)
    return [420 + (n[0] - p[0]) * 140 / (q[0] - p[0]), 250 + (n[1] - p[1]) * 230 / (q[1] - p[1])]
  }
  await command(b, 'library.select', { ids: [photo], active: photo })
  await until(async () => (await presence(b)).page === photo, 10000, 'the editor on the owner\'s photo')
  const start = await look(a)
  await command(a, 'panel.crop')
  await a.waitForTimeout(800)
  const corner = await screenOf(a, [0, 0])
  await a.mouse.move(corner[0] + 2, corner[1] + 2)
  await a.mouse.down()
  for (let i = 1; i <= 15; i++) { await a.mouse.move(corner[0] + 2 + 4 * i, corner[1] + 2 + 5 * i); await a.waitForTimeout(40) }
  await until(async () => !!(await presence(a)).crop, 10000, 'the owner\'s crop under way')
  await command(b, 'tool.brush', { new: true })
  await b.waitForTimeout(800)
  const from = await screenOf(b, [0.3, 0.45]), to = await screenOf(b, [0.6, 0.5])
  await b.mouse.move(...from)
  await b.mouse.down()
  for (let i = 1; i <= 10; i++) { await b.mouse.move(from[0] + (to[0] - from[0]) * i / 10, from[1] + (to[1] - from[1]) * i / 10); await b.waitForTimeout(30) }
  await b.mouse.up()
  // the stroke is in the shared document (the editor's acknowledged one) while the owner still holds the crop
  await until(() => b.evaluate(() => session.live.acked && !session.live.inflight
    && new TextDecoder().decode(session.live.acked.bytes) === new TextDecoder().decode(playgroundLiveAdapter.checkpoint())), 10000, 'the editor\'s stroke shared')
  assert.equal((await look(b)).masks, start.masks + 1, 'the editor\'s stroke is a new mask')
  await a.mouse.up()
  await until(async () => {
    const [x, y] = await Promise.all([text(a), text(b)])
    return x === y && (await look(a)).crop !== start.crop && (await look(a)).masks === start.masks + 1
  }, 30000, 'the owner\'s crop and the editor\'s stroke on both pages')
  for (const page of [a, b]) assert.equal(await page.evaluate(async () => (await session.store.drafts()).length), 0, 'no draft kept')
  for (const page of [a, b]) await command(page, 'panel.edit').catch(() => {})
}

export default {
  path: '/lightcraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    pages.push(page)
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
  // Holds a drag of the Edit panel's Exposure slider by its thumb (a fresh profile shows it there at 1280×800). Shift
  // makes it a fine drag, which moves the value by the pointer's sideways travel only (widgets.rs `slider`): straight
  // down, the value stays where it is. Presence `adjust` names the slider while it is held; let go, the interaction
  // ends with nothing changed (Escape would be Back, which leaves the loupe mid-drag).
  drag: async (page) => {
    await page.mouse.move(1100, 450)
    await page.keyboard.down('Shift')
    await page.mouse.down()
    for (let i = 1; i <= 6; i++) { await page.mouse.move(1100, 450 + 4 * i); await page.waitForTimeout(50) }
    await page.waitForTimeout(300)
  },
  release: async (page) => {
    await page.mouse.up()
    await page.keyboard.up('Shift')
  },
  // File ▸ Import Photos… (file.addPhotos) opens the browser's file picker; the photo is a 16×16 PNG drawn here.
  importMedia: async (page) => {
    await together(page, pages.find((p) => p !== page), 'lightcraft')
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
