// PdfCraft (acrobat): every page drops the same two-page PDF on the canvas (eframe's drop handler; the web build opens
// dropped files, crates/ui-egui/src/lib.rs open_dropped) and clicks the page so it has the keyboard. The palette
// (Ctrl+K, view.palette in crates/engine/src/commands.rs) runs "Rotate pages clockwise" (page.rotate) on the current
// page: the owner turns page 1; the editor goes to page 2 (ArrowRight, crates/ui-egui/src/canvas.rs shortcuts) and turns
// it. Two page objects, two paths of the shared document's /objects. The owner's Ctrl+Z (edit.undo) takes back only
// page 1's turn.
import { until } from '../helpers.mjs'

const PAGE = { x: 640, y: 430 }

// A two-page PDF with an exact cross-reference table, so it opens without repairs.
function twoPages() {
  const content = '0.2 0.4 0.8 rg 40 40 320 420 re f'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Contents 5 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets = objects.map((body, i) => {
    const at = out.length
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
    return at
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return [...Buffer.from(out, 'latin1')]
}

const shared = (page) => page.evaluate(() => {
  try { return JSON.parse(new TextDecoder().decode(playgroundLiveAdapter.checkpoint())) } catch { return {} }
})
const rotate = async (page) => {
  await page.keyboard.press('Control+k')
  await page.waitForTimeout(400)
  await page.keyboard.type('Rotate pages clockwise')
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  // The palette's text field holds the frame busy until it closes.
  await until(() => page.evaluate(() => { try { return !!playgroundLiveAdapter.checkpoint() } catch { return false } }), 10000, 'the palette to close')
}

export default {
  path: '/pdfcraft/',
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {
    await page.waitForTimeout(1500)
    await page.evaluate((bytes) => {
      const data = new DataTransfer()
      data.items.add(new File([new Uint8Array(bytes)], 'two-pages.pdf', { type: 'application/pdf' }))
      const canvas = document.getElementById('pdfcraft')
      for (const type of ['dragenter', 'dragover', 'drop']) canvas.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }))
    }, twoPages())
    await until(async () => !!(await shared(page)).pdf, 60000, 'the dropped PDF to open')
    await page.waitForTimeout(500)
    await page.mouse.click(PAGE.x, PAGE.y)
  },
  editA: (page) => rotate(page),
  editB: async (page) => {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(300)
    await rotate(page)
  },
  undo: (page) => page.keyboard.press('Control+z'),
}
