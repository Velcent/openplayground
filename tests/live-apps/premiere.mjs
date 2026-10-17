// FilmCraft (premiere): the demo project, its Main Edit sequence in the Timeline, which has keyboard focus (ui-egui
// state.rs). Ctrl+Down is Select Next Clip (engine keyboard.rs: with nothing selected, the clips at the playhead on the
// targeted tracks), Shift+E is Clip > Enable, a toggle (commands.rs). Selection is personal, so the editor steps twice
// to reach the next clips. Ctrl+Z is Undo. Media: files dropped on the page are imported (filmcraft-web import.rs).
// Presence: the owner clicks V1's third clip (selected, with its linked audio) and the pointer stays on it; the
// owner's edit starts with Ctrl+Shift+A (Deselect All) so it still picks the first clips. drag() holds a move of that
// clip (presence `ghosts`); Escape before the release cancels the move (timeline.rs `cancelled`), so it edits nothing.
const key = async (page, ...keys) => {
  await page.focus('#filmcraft_canvas')
  for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(300) }
}
// The page point of V1's clip `index` (window.filmcraft's control API gives its place on the canvas).
const clipAt = (page, index) => page.evaluate(async (index) => {
  const { sequence } = playgroundLiveAdapter.presence()
  const doc = JSON.parse(new TextDecoder().decode(playgroundLiveAdapter.checkpoint()))
  const { x, y } = await filmcraft.request('ui.timeline.locate', { clip: doc.items[sequence].kind.Sequence.video_tracks[0].items[index].id })
  const canvas = document.querySelector('#filmcraft_canvas').getBoundingClientRect()
  return { x: canvas.left + x, y: canvas.top + y }
}, index)

export default {
  path: '/filmcraft/',
  viewport: { width: 1280, height: 800 },
  ready: (page) => page.waitForTimeout(1500),
  // Selects V1's third clip.
  point: async (page) => {
    const at = await clipAt(page, 2)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.waitForTimeout(100)
    await page.mouse.up()
    await page.waitForTimeout(500)
  },
  // Drags V1's third clip about 90 px to the right and holds it there (no release).
  drag: async (page) => {
    const at = await clipAt(page, 2)
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    for (let i = 1; i <= 6; i++) { await page.mouse.move(at.x + 15 * i, at.y); await page.waitForTimeout(50) }
    await page.waitForTimeout(300)
  },
  // Disables the first clips (V1 and its linked audio).
  editA: (page) => key(page, 'Control+Shift+A', 'Control+ArrowDown', 'Shift+E'),
  // Disables the second clips.
  editB: (page) => key(page, 'Control+ArrowDown', 'Control+ArrowDown', 'Shift+E'),
  undo: (page) => key(page, 'Control+z'),
  // Drops a half-second WAV tone on the page: the app imports it as /files/tone.wav.
  importMedia: (page) => page.evaluate(() => {
    const rate = 8000, n = 4000, v = new DataView(new ArrayBuffer(44 + n * 2))
    const text = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)))
    text(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt '); v.setUint32(16, 16, true)
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true)
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, n * 2, true)
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(8000 * Math.sin(i / 4)), true)
    const data = new DataTransfer()
    data.items.add(new File([v.buffer], 'tone.wav', { type: 'audio/wav' }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, cancelable: true }))
  }),
}
