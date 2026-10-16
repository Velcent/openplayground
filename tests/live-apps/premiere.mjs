// FilmCraft (premiere): the demo project, its Main Edit sequence in the Timeline, which has keyboard focus (ui-egui
// state.rs). Ctrl+Down is Select Next Clip (engine keyboard.rs: with nothing selected, the clips at the playhead on the
// targeted tracks), Shift+E is Clip > Enable, a toggle (commands.rs). Selection is personal, so the editor steps twice
// to reach the next clips. Ctrl+Z is Undo.
const key = async (page, ...keys) => {
  await page.focus('#filmcraft_canvas')
  for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(300) }
}

export default {
  path: '/filmcraft/',
  viewport: { width: 1280, height: 800 },
  ready: (page) => page.waitForTimeout(1500),
  // Disables the first clips (V1 and its linked audio).
  editA: (page) => key(page, 'Control+ArrowDown', 'Shift+E'),
  // Disables the second clips.
  editB: (page) => key(page, 'Control+ArrowDown', 'Control+ArrowDown', 'Shift+E'),
  undo: (page) => key(page, 'Control+z'),
}
