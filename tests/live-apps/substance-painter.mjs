// SubCraft (substance-painter): WebGPU only, so run with LIVE_GPU=1 (helpers.mjs GPU flags). Each page starts on the sample crate with Body's empty paint "Layer 1" selected and the
// Brush tool; `ready` closes the welcome hub. The owner paints a stroke across the crate's front (Layer 1's tiles), the
// editor adds a fill layer above it (Ctrl+Shift+F: appended, so no array shifts); Ctrl+Z is the owner's Undo. point():
// the owner hovers over the crate, which the editor's 3D view shows as an arrow tagged "Alice · Layer 1".
//
// The checkpoint is binary (layer tree JSON, mesh, images, deflated tiles): `ready` defines liveTestDocument(), a JSON
// view of it (tiles by content hash) for the harness.
import { until } from '../helpers.mjs'

// Below the shell's 36 px top bar: the welcome hub's "Continue in workspace", and a stroke across the crate's front
// between its bands.
const CONTINUE = { x: 607, y: 455 }, STROKE = [{ x: 500, y: 370 }, { x: 630, y: 385 }], POINT = { x: 565, y: 378 }

// The view: { doc, mesh, resources: { id: ... }, rasters: { layer: { slot: { comps, size, fill, tiles: { i: hash } } } } }.
function view(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  const u8 = () => bytes[at++]
  const u32 = () => { const v = data.getUint32(at, true); at += 4; return v }
  const take = (n) => { const s = bytes.subarray(at, at + n); at += n; return s }
  const blob = () => take(u32())
  const text = (b) => new TextDecoder().decode(b)
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  const hash = (b) => { let h = 0x811c9dc5; for (const x of b) h = Math.imul(h ^ x, 0x01000193) >>> 0; return `${b.length}:${h.toString(16)}` }
  if (text(take(8)) !== 'SCLIVE01') throw new Error('not a SubCraft checkpoint')
  const doc = JSON.parse(text(blob())), mesh = hash(blob()), resources = {}, rasters = {}
  for (let n = u32(); n--;) { const id = hex(take(16)), kind = u8(); resources[id] = { kind, name: text(blob()), file: hash(blob()) } }
  while (u8() === 1) {
    const layer = hex(take(16)), images = []
    for (let n = u8(); n--;) {
      const tag = u8(), slot = tag === 0x80 ? `effect ${hex(take(16))}` : tag === 0x40 ? 'mask' : `channel ${tag}`
      images.push([slot, { comps: u8(), size: u32(), fill: [u32(), u32(), u32(), u32()], tiles: {} }])
    }
    for (let t; (t = u32()) !== 0xffffffff;) { const i = u8(); images[i][1].tiles[t] = hash(blob()) }
    rasters[layer] = Object.fromEntries(images)
  }
  return { doc, mesh, resources, rasters }
}

const shown = (page) => page.evaluate(() => {
  try { return JSON.parse(liveTestDocument()) } catch { return null }
})
const layers = async (page) => (await shown(page))?.doc.texture_sets[0].layers.length ?? 0
const tiles = async (page) => JSON.stringify((await shown(page))?.rasters ?? {}).split('"tiles"').length - 1

export default {
  // Only a head build exists: /subcraft/ redirects here.
  path: '/head/subcraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await page.evaluate((source) => {
      const view = new Function(`return ${source}`)()
      globalThis.liveTestDocument = () => JSON.stringify(view(playgroundLiveAdapter.checkpoint()))
    }, view.toString())
    await until(async () => (await layers(page)) > 0, 120000, 'SubCraft to run')
    // The welcome hub (centered) covers the crate: "Continue in workspace".
    await page.waitForTimeout(500)
    await page.mouse.click(CONTINUE.x, CONTINUE.y)
    await page.waitForTimeout(300)
  },
  editA: async (page) => {
    for (let tries = 0; await tiles(page) === 0; tries++) {
      if (tries === 4) throw new Error('no stroke after 4 tries')
      await page.mouse.move(STROKE[0].x, STROKE[0].y)
      await page.mouse.down()
      await page.mouse.move(STROKE[1].x, STROKE[1].y, { steps: 12 })
      await page.mouse.up()
      await until(async () => await tiles(page) > 0, 5000, 'the stroke').catch(() => {})
    }
  },
  editB: async (page) => {
    const before = await layers(page)
    for (let tries = 0; await layers(page) === before; tries++) {
      if (tries === 4) throw new Error('no fill layer after 4 tries')
      // The status bar takes the click (and gives the canvas the keyboard) without editing anything.
      await page.mouse.click(640, 790)
      await page.keyboard.press('Control+Shift+F')
      await until(async () => await layers(page) > before, 5000, 'the fill layer').catch(() => {})
    }
  },
  undo: (page) => page.keyboard.press('Control+z'),
  // The owner hovers over the crate's front: their presence gains the surface point under the pointer.
  point: async (page) => {
    await page.mouse.move(POINT.x, POINT.y, { steps: 4 })
    await until(() => page.evaluate(() => !!playgroundLiveAdapter.presence()?.pointer), 5000, 'the owner\'s pointer on the model')
  },
}

