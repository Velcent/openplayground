// NoteCraft (onenote): the web build starts with the sample notebooks and the Project X page open (the tree expanded
// down to it), in every fresh browser; the joiner then adopts the owner's notebooks (same paths). Rows of the tree are
// 24 points apart under the shell's bar; a click on a block of the page puts the caret in it. The owner types a letter
// at the start of Project X's first paragraph, the editor opens Ideas › Format ideas and types one into its first
// paragraph: two page files, two paths of the shared document. Ctrl+Z (the session's Undo while connected) takes back
// only the owner's letter. point(): the owner clicks into the paragraph and rests the pointer on the page (presence:
// page, pointer, caret). drag(): the owner selects across the paragraph (presence `selection`); the harness's release
// (Escape, then mouse up) leaves the block, so nothing changes. importMedia(): the owner drops a picture on the page
// and inserts it: the editor and the late viewer get its bytes. Every page is in the document, so opening one is
// presence (the tree's dots), not a new document: there is no openTab().
import { until } from '../helpers.mjs'

const checkpoint = (page) => page.evaluate(() => {
  try { return new TextDecoder().decode(playgroundLiveAdapter.checkpoint()) } catch (e) { return `error: ${e}` }
})
const presence = (page) => page.evaluate(() => playgroundLiveAdapter.presence())
// The first paragraph of the page shown (Project X's and Format ideas' both start under the title), and tree rows.
const PARAGRAPH = { x: 404, y: 321 }, IDEAS = { x: 80, y: 374 }, FORMAT_IDEAS = { x: 130, y: 401 }
// The first choice of the dialog a dropped file opens (centred in the window).
const INSERT_PICTURE = { x: 503, y: 397 }
// A letter typed where `at` is, until the shared document has it.
async function type(page, at, letter) {
  const before = await checkpoint(page)
  await page.mouse.click(at.x, at.y)
  await page.waitForTimeout(300)
  await page.keyboard.type(letter)
  await until(async () => { const t = await checkpoint(page); return !t.startsWith('error') && t !== before }, 10000, `${letter} to be typed`)
}

export default {
  path: '/head/notecraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await until(async () => JSON.parse((await checkpoint(page)).replace(/^error.*/, '{}')).files?.['my-notebook']?.work?.projects?.['project-x']?.['index.html'], 120000, 'the sample notebooks')
    await page.waitForTimeout(500)
  },
  point: async (page) => {
    await page.mouse.click(PARAGRAPH.x + 60, PARAGRAPH.y)
    await page.mouse.move(640, 480)
    await until(async () => { const p = await presence(page); return p?.pointer && p.caret }, 10000, 'the owner\'s pointer and caret')
  },
  drag: async (page) => {
    // The page's text boxes select with Shift+click (a press-drag places the caret): the selection under way.
    await page.mouse.click(PARAGRAPH.x + 30, PARAGRAPH.y)
    await page.waitForTimeout(300)
    await page.keyboard.down('Shift')
    await page.mouse.click(PARAGRAPH.x + 230, PARAGRAPH.y)
    await page.keyboard.up('Shift')
    await until(async () => !!(await presence(page))?.selection, 10000, 'a selection being made')
  },
  editA: (page) => type(page, PARAGRAPH, 'A'),
  editB: async (page) => {
    await page.mouse.click(IDEAS.x, IDEAS.y)
    await page.waitForTimeout(300)
    await page.mouse.click(FORMAT_IDEAS.x, FORMAT_IDEAS.y)
    await until(async () => (await presence(page))?.page === 'my-notebook/ideas/format-ideas', 10000, 'Format ideas to open')
    await type(page, PARAGRAPH, 'B')
  },
  undo: (page) => page.keyboard.press('Control+z'),
  importMedia: async (page) => {
    // A picture dropped on the page (as Playground's Files hands files to apps), then "Insert the picture" in the dialog
    // that asks what to do with it: a copy in the page's assets folder, and an <img> in the page.
    await page.evaluate(async () => {
      const c = document.createElement('canvas')
      Object.assign(c, { width: 64, height: 48 })
      const g = c.getContext('2d')
      g.fillStyle = '#ca64ea'
      g.fillRect(0, 0, 64, 48)
      const data = new DataTransfer()
      data.items.add(new File([await new Promise((r) => c.toBlob(r, 'image/png'))], 'swatch.png', { type: 'image/png' }))
      const canvas = document.querySelector('canvas'), r = canvas.getBoundingClientRect()
      const at = { clientX: r.left + 700, clientY: r.top + 400, bubbles: true, cancelable: true, dataTransfer: data }
      for (const type of ['dragenter', 'dragover', 'drop']) canvas.dispatchEvent(new DragEvent(type, at))
    })
    await page.waitForTimeout(800)
    await page.mouse.click(INSERT_PICTURE.x, INSERT_PICTURE.y)
    await until(async () => Object.keys(JSON.parse(await checkpoint(page)).media ?? {}).length, 10000, 'the picture in the page')
  },
}
