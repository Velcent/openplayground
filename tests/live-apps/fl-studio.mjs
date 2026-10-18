// Lemon Studio: its own release with live editing built in (src/app/collab.rs). A new song: one Lemon Sampler channel,
// pattern 1, the playlist in front with the channel rack floating over its top left. The layout is measured at
// 1920 x 1080; the shell's bar puts the canvas 36 px down, so page points are the app's plus (0, 36).

// The app is between gestures: a checkpoint then reads the song (it throws `busy` mid-gesture).
const quiet = (page) => page.waitForFunction(() => {
  try { return !!globalThis.playgroundLiveAdapter.checkpoint() } catch { return false }
}, null, { timeout: 30000 })

// The editor under page point (x, y), as the app's presence names it ('playlist', 'piano' or null).
async function over(page, x, y) {
  await page.mouse.move(x, y - 1)
  await page.mouse.move(x, y)
  await page.waitForTimeout(250)
  return page.evaluate(() => playgroundLiveAdapter.presence()?.view ?? null)
}

// Brings `view` to the front under (x, y): F5 raises the playlist, F7 the piano roll (each hides its window when it
// is in front already, so it is pressed only while another one is).
async function front(page, view, x, y) {
  await page.focus('#lemon-canvas')
  for (let i = 0; i < 3 && await over(page, x, y) !== view; i++) await page.keyboard.press(view === 'piano' ? 'F7' : 'F5')
  if (await over(page, x, y) !== view) throw new Error(`the ${view} is not under ${x},${y}`)
}

async function click(page, x, y) {
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.up()
  await quiet(page)
}

export default {
  path: '/lemon-studio/',
  viewport: { width: 1920, height: 1080 },
  ready: async (page) => {
    // The Early preview notice (tools.yaml notice) covers the app until it is dismissed.
    await page.getByRole('button', { name: 'Continue' }).click({ timeout: 10000 }).catch(() => {})
    await quiet(page)
    await page.focus('#lemon-canvas')
  },
  // A note in pattern 1: a click in the piano roll's grid (Draw tool) at bar 1.
  editA: async (page) => {
    await front(page, 'piano', 900, 650)
    await click(page, 900, 650)
  },
  // A pattern clip in the playlist: a click in its grid (Draw tool), right of the channel rack.
  editB: async (page) => {
    await front(page, 'playlist', 1200, 600)
    await click(page, 1200, 600)
  },
  undo: async (page) => {
    await page.focus('#lemon-canvas')
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(300)
  },
  // The owner points into the playlist's grid.
  point: async (page) => {
    await front(page, 'playlist', 1000, 520)
  },
  // A selecting box held open in the playlist (Ctrl+drag): its corners reach the others as it grows.
  drag: async (page) => {
    await front(page, 'playlist', 1300, 500)
    await page.keyboard.down('Control')
    await page.mouse.down()
    await page.keyboard.up('Control')
    for (const [x, y] of [[1360, 540], [1440, 600], [1520, 660]]) {
      await page.mouse.move(x, y, { steps: 4 })
      await page.waitForTimeout(60)
    }
  },
  // The channel rack (F6 raises it) > right-click Lemon Sampler > Load sample... opens the browser's file picker: a
  // short 16-bit mono WAV becomes the channel's sample. F6 hides the rack when it is in front already: a menu that did
  // not open is closed and the rack shown again.
  importMedia: async (page) => {
    for (let tries = 3; ; tries--) {
      await page.focus('#lemon-canvas')
      await page.keyboard.press('F6')
      await page.waitForTimeout(300)
      await page.mouse.click(471, 292, { button: 'right' })
      await page.waitForTimeout(300)
      const chooser = page.waitForEvent('filechooser', { timeout: 3000 }).catch((e) => { if (tries === 1) throw e })
      await page.mouse.click(529, 432)
      const found = await chooser
      if (found) return found.setFiles({ name: 'Kick.wav', mimeType: 'audio/wav', buffer: wav() })
      await page.keyboard.press('Escape')
    }
  },
}

function wav(frames = 4410, rate = 44100) {
  const b = Buffer.alloc(44 + frames * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + frames * 2, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round(12000 * Math.sin(i / 6) * (1 - i / frames)), 44 + i * 2)
  return b
}
