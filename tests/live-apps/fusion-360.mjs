// SolidCraft (fusion-360): the shared document is the design's feature tree. Commands go through the S box (S at the
// pointer, type, Enter picks the top match, Enter applies its dialog: ui-egui toolbar.rs, shortcut_box.rs,
// dialogs.rs). The owner adds a Box (features), the editor a New Component (components, occurrences).
const VIEWPORT = [700, 450]
const pause = (page) => page.waitForTimeout(400)

async function command(page, query) {
  await page.mouse.move(...VIEWPORT)
  await pause(page)
  await page.keyboard.press('s')
  await pause(page)
  await page.keyboard.type(query)
  await pause(page)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  await page.keyboard.press('Enter')
  await pause(page)
}

export default {
  path: '/solidcraft/',
  viewport: { width: 1280, height: 800 },
  // Home's New Design (ui-egui home.rs), once the first frames are drawn.
  ready: async (page) => {
    await page.waitForTimeout(1500)
    await page.mouse.click(120, 176)
    await page.waitForTimeout(800)
  },
  editA: (page) => command(page, 'Box'),
  editB: (page) => command(page, 'New Component'),
  undo: async (page) => {
    await page.mouse.move(...VIEWPORT)
    await page.keyboard.press('Control+z')
  },
}
