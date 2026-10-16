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
  // File > Import > Audio (Ctrl+Shift+I) opens the browser's file picker (web.rs take_path_prompt, rfd's file input,
  // which a picker nobody answers cancels): a 10 ms mono 16-bit WAV goes onto a new track.
  importMedia: async (page) => {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), key(page, 'Control+Shift+I')])
    await chooser.setFiles({ name: 'Click.wav', mimeType: 'audio/wav', buffer: wav() })
  },
}

function wav(frames = 480, rate = 48000) {
  const b = Buffer.alloc(44 + frames * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + frames * 2, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), 44 + i * 2)
  return b
}
