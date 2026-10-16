// EffectCraft (after-effects): the demo project, its comp open in the Timeline. Ctrl+Down is Layer > Select Next Layer
// (layer.selectNext: with nothing selected, layer 1); Alt+Shift+P / Alt+Shift+T add or remove a Position / Opacity
// keyframe at the current time on the selected layers (timeline.keyAt.*, ui-egui menus.rs). Selection is personal, so
// the editor steps twice to reach layer 2. Ctrl+Z is Undo.
const key = async (page, ...keys) => {
  await page.focus('#effectcraft_canvas')
  for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(300) }
}

export default {
  path: '/effectcraft/',
  viewport: { width: 1280, height: 800 },
  ready: (page) => page.waitForTimeout(1500),
  // A Position keyframe on layer 1.
  editA: (page) => key(page, 'Control+ArrowDown', 'Alt+Shift+P'),
  // An Opacity keyframe on layer 2.
  editB: (page) => key(page, 'Control+ArrowDown', 'Control+ArrowDown', 'Alt+Shift+T'),
  undo: (page) => key(page, 'Control+z'),
}
