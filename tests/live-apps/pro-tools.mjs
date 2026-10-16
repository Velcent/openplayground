// SoundCraft: the demo session, Edit window, Commands Keyboard Focus, the first track ("Kick") selected.
const key = async (page, ...keys) => {
  await page.focus('#soundcraft_canvas')
  for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(300) }
}

export default {
  path: '/soundcraft/',
  viewport: { width: 1280, height: 800 },
  ready: (page) => page.waitForTimeout(1000),
  // Shift+M mutes the selected track (Kick).
  editA: (page) => key(page, 'Shift+M'),
  // ; moves the selection down to Snare (a personal view), then Shift+M mutes it.
  editB: (page) => key(page, 'Semicolon', 'Shift+M'),
  undo: (page) => key(page, 'Control+z'),
}
