// MaterialCraft (substance-designer): run with LIVE_GPU=1 (its 3D view on software GL takes seconds a frame). `ready` opens the Brick wall example from the start screen in each page, so both
// show the same graph in the same view (the joiner then adopts the owner's package, keeping its view). Nodes are found
// through the view: presence() gives the pointer in graph coordinates at two places, and a node's card is its `pos`
// plus half a card. The owner moves Blend (node 4), the editor Levels (node 10): one node's `pos` each, no array
// shifts; Ctrl+Z is the owner's Undo. point(): the owner clicks Bricks (node 1): pointer and selection. drag(): the
// owner holds a move of Bricks (presence `moving`); release(): one move back by the same amount (Bricks sits at 0,0,
// so it lands exactly where it was), then the mouse comes up: no edit.
import { until } from '../helpers.mjs'

const checkpoint = (page) => page.evaluate(() => {
  try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch (e) { return `error: ${e}` }
})
const doc = async (page) => JSON.parse(await until(async () => { const t = await checkpoint(page); return !t.startsWith('error') && t }, 30000, 'a checkpoint'))
const presence = (page) => page.evaluate(() => playgroundLiveAdapter.presence())
// Two animation frames: the app has run a frame for the input before.
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
// Below the shell's 36 px top bar: the start screen's "Brick wall example" card, and two points over the graph between
// the example's nodes (its first two rows and columns, in the view the example opens with).
const EXAMPLE = { x: 768, y: 234 }, CANVAS = [{ x: 470, y: 300 }, { x: 640, y: 300 }]
// Where graph point (x, y) shows: the view from the pointer at two places over the graph.
async function view(page) {
  const pointer = () => presence(page).then((p) => p?.pointer)
  await page.mouse.move(CANVAS[0].x, CANVAS[0].y)
  await frames(page)
  const [x0, y0] = await until(pointer, 10000, 'the pointer over the graph')
  await page.mouse.move(CANVAS[1].x, CANVAS[1].y)
  const [x1] = await until(async () => { const p = await pointer(); return p?.[0] !== x0 && p }, 10000, 'the pointer to move')
  const scale = (CANVAS[1].x - CANVAS[0].x) / (x1 - x0)
  return (x, y) => ({ x: CANVAS[0].x + (x - x0) * scale, y: CANVAS[0].y + (y - y0) * scale })
}
// The middle of node `id`'s card on screen.
async function card(page, id) {
  const at = await view(page)
  const n = (await doc(page)).nodes.find((n) => n.id === id)
  return at(n.pos[0] + 46, n.pos[1] + 54)
}
// Drags node `id` by (dx, dy) screen points and lets go, until the shared document has the move.
async function move(page, id, dx, dy) {
  const before = await checkpoint(page)
  const p = await card(page, id)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + dx, p.y + dy, { steps: 6 })
  await page.mouse.up()
  await until(async () => { const t = await checkpoint(page); return !t.startsWith('error') && t !== before }, 10000, `node ${id} to move`)
}
let held = null

export default {
  // Only a head build exists (upstream releases are desktop-only): /materialcraft/ redirects here.
  path: '/head/materialcraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await until(async () => !(await checkpoint(page)).startsWith('error'), 120000, 'MaterialCraft to run')
    for (let tries = 0; (await doc(page)).nodes.length < 10; tries++) {
      if (tries === 4) throw new Error('no example after 4 tries')
      await page.mouse.click(EXAMPLE.x, EXAMPLE.y)
      await until(async () => (await doc(page)).nodes.length >= 10, 10000, 'the example').catch(() => {})
    }
    await frames(page)
  },
  editA: (page) => move(page, 4, 30, 45),
  editB: (page) => move(page, 10, -25, 40),
  undo: async (page) => {
    await page.keyboard.press('Control+z')
  },
  point: async (page) => {
    const p = await card(page, 1)
    await page.mouse.click(p.x, p.y)
    await until(async () => { const s = await presence(page); return s?.pointer && s.selection?.[0] === 1 }, 10000, 'the owner\'s pointer and selection')
  },
  drag: async (page) => {
    const p = await card(page, 1)
    held = { x: p.x + 60, y: p.y + 45 }
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.move(held.x, held.y)
    await until(async () => (await presence(page))?.moving, 10000, 'the node move under way')
  },
  release: async (page) => {
    await page.mouse.move(held.x - 60, held.y - 45)
    await frames(page)
    await page.mouse.up()
  },
}
