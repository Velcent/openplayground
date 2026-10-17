// EffectCraft (after-effects): the demo project, its comp open in the Timeline. Ctrl+Down is Layer > Select Next Layer
// (layer.selectNext: with nothing selected, layer 1); Alt+Shift+P / Alt+Shift+T add or remove a Position / Opacity
// keyframe at the current time on the selected layers (timeline.keyAt.*, ui-egui menus.rs). Selection is personal, so
// the editor steps twice to reach layer 2. Ctrl+Z is Undo. Ctrl+I is File > Import > File (file.import), whose browser
// file picker stores the picked file in the page's file table under /<name> and imports it as footage.
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const key = async (page, ...keys) => {
  await page.focus('#effectcraft_canvas')
  for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(300) }
}

export default {
  path: '/effectcraft/',
  viewport: { width: 1280, height: 800 },
  ready: (page) => page.waitForTimeout(1500),
  // Presence: layer 1 selected (selection is personal) and the pointer over the comp viewer.
  point: async (page) => {
    await key(page, 'Control+ArrowDown')
    await page.mouse.move(600, 300)
    await page.waitForTimeout(300)
  },
  // A gesture held down (the harness releases it): the owner scrubs the current time along the Timeline's ruler, which
  // their presence shows as `time` while the button is down. The current time is personal: the document stays as it is.
  drag: async (page) => {
    await page.mouse.move(720, 560)
    await page.mouse.down()
    for (const x of [760, 800, 840]) {
      await page.mouse.move(x, 560, { steps: 4 })
      await page.waitForTimeout(100)
    }
  },
  // A Position keyframe on layer 1 (F2 is Deselect All, after point()'s selection).
  editA: (page) => key(page, 'F2', 'Control+ArrowDown', 'Alt+Shift+P'),
  // An Opacity keyframe on layer 2.
  editB: (page) => key(page, 'Control+ArrowDown', 'Control+ArrowDown', 'Alt+Shift+T'),
  undo: (page) => key(page, 'Control+z'),
  importMedia: async (page) => {
    // A cold page once missed the key: press again until the picker opens.
    let chooser
    for (let i = 0; !chooser && i < 5; i++) {
      const opened = page.waitForEvent('filechooser', { timeout: 6000 }).catch(() => null)
      await key(page, 'Control+i')
      chooser = await opened
    }
    await chooser.setFiles({ name: 'live-photo.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') })
  },
}
