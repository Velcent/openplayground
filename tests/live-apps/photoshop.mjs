// PhotoCraft (photoshop): each page makes a new 1920×1080 white document from the Home screen ("New document…",
// then Enter). The owner paints a brush stroke (B, drag) over the left of the Background, the editor one over its
// right: different 256×256 tiles of the same layer, which merge tile by tile. Ctrl+Z is the owner's Undo.
// point(): the owner drags a marquee around where editA paints (M; the stroke stays inside it) and rests the pointer on
// the canvas: the editor is shown their pointer, active layer and selection bounds.
//
// PhotoCraft's checkpoint is binary (canonical JSON, then the tiles): `ready` defines liveTestDocument(), which gives
// the harness that JSON with each surface's tiles as {"tx,ty": hash}.
import { until } from '../helpers.mjs'

const checkpoint = (page) => page.evaluate(() => {
  try { return liveTestDocument() } catch (e) { return `error: ${e}` }
})
const stroke = async (page, x, y) => {
  await page.keyboard.press('b')
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 50, y + 30, { steps: 10 })
  await page.mouse.up()
}

export default {
  path: '/photocraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await page.evaluate(() => {
      const real = globalThis.playgroundLiveAdapter
      const json = (bytes) => {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        let at = 'photocraft-live 1\n'.length
        const u32 = () => (at += 4, view.getUint32(at - 4, true))
        const size = u32()
        const doc = JSON.parse(new TextDecoder().decode(bytes.subarray(at, at += size)))
        const walk = (v) => {
          if (Array.isArray(v)) return v.forEach(walk)
          if (!v || typeof v !== 'object') return
          const keys = Object.keys(v).sort()
          if (keys.join() !== 'default,format,tiles') return keys.forEach((k) => walk(v[k]))
          v.tiles = {}
          for (let n = u32(); n > 0; n--) {
            const tile = `${view.getInt32(at, true)},${view.getInt32(at + 4, true)}`
            v.tiles[tile] = [...bytes.subarray(at + 8, at + 40)].map((b) => b.toString(16).padStart(2, '0')).join('')
            at += 40
            const size = u32()
            at += size
          }
        }
        walk(doc)
        return JSON.stringify(doc)
      }
      globalThis.liveTestDocument = () => json(real.checkpoint())
    })
    // The Home screen's primary button, then Create. A busy machine can drop the first click: retry.
    for (let tries = 0; (await checkpoint(page)).startsWith('error'); tries++) {
      if (tries === 4) throw new Error(`no document after ${tries} tries: ${await checkpoint(page)}`)
      await page.mouse.click(397, 391)
      await page.waitForTimeout(500)
      await page.keyboard.press('Enter')
      await until(async () => !(await checkpoint(page)).startsWith('error'), 10000, 'a new document').catch(() => {})
    }
  },
  point: async (page) => {
    await page.keyboard.press('m')
    await page.mouse.move(150, 250)
    await page.mouse.down()
    await page.mouse.move(420, 420, { steps: 8 })
    await page.mouse.up()
    await page.mouse.move(600, 400, { steps: 4 })
    await until(() => page.evaluate(() => {
      const p = playgroundLiveAdapter.presence()
      return !!(p?.pointer && p.selection)
    }), 10000, 'the pointer and a selection on the canvas')
  },
  editA: (page) => stroke(page, 220, 300),
  editB: (page) => stroke(page, 850, 520),
  undo: (page) => page.keyboard.press('Control+z'),
}
