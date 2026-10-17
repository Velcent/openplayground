// SolidCraft (fusion-360): the shared document is the design's feature tree. Commands go through the S box (S at the
// pointer, type, Enter picks the top match, Enter applies its dialog: ui-egui toolbar.rs, shortcut_box.rs,
// dialogs.rs). Each page starts on a new design holding a Box, so the owner can point at it and select a face of it;
// then the owner adds another Box (features), the editor a New Component (components, occurrences).
const VIEWPORT = [700, 450]
// The top face of the Box a new design gets at its origin, in the default view.
const BOX_TOP = [830, 368]
const pause = (page) => page.waitForTimeout(400)

async function command(page, query) {
  await page.mouse.move(...VIEWPORT)
  await pause(page)
  // Nothing selected: a command would take a selected face as its place.
  await page.keyboard.press('Escape')
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
  // Home's New Design (ui-egui home.rs), once the first frames are drawn, and a Box in it.
  ready: async (page) => {
    await page.waitForTimeout(1500)
    await page.mouse.click(120, 176)
    await page.waitForTimeout(800)
    await command(page, 'Box')
  },
  // A face of the Box selected, the pointer resting on it.
  point: async (page) => {
    await page.mouse.click(...BOX_TOP)
    await page.waitForTimeout(800)
  },
  editA: (page) => command(page, 'Box'),
  editB: (page) => command(page, 'New Component'),
  undo: async (page) => {
    await page.mouse.move(...VIEWPORT)
    await page.keyboard.press('Control+z')
  },
}
