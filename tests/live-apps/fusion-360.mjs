import { until } from '../helpers.mjs'

// SolidCraft (fusion-360): each shared design is its feature tree. Commands go through the S box (S at the
// pointer, type, Enter picks the top match, Enter applies its dialog: ui-egui toolbar.rs, shortcut_box.rs,
// dialogs.rs). Each page starts on a new design holding a Box, so the owner can point at it and select a face of it;
// then the owner adds another Box (features), the editor a New Component (components, occurrences). The shared
// document is the session's designs ({ documents: [...] }), the owner's first.
// drag: the owner opens Extrude on the Box's top face and holds its distance arrow mid-drag (the editor is shown the
// dialog's value at the arrow, `value`, the owner's pointer on it, and the extruded prism's edges, `solid`); Escape
// cancels it. openTab: the owner
// starts a new design (Ctrl+N) and adds a Box to it, so the session shares it: the editor gets it as a tab behind.
const VIEWPORT = [700, 450]
// The top face of the Box a new design gets at its origin, in the default view.
const BOX_TOP = [830, 368]
// Extrude's distance arrow on that face, in the default view (canvas.rs drag_arrow publishes it as "arrow").
const ARROW = [830, 330]
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
  drag: async (page) => {
    await page.mouse.move(...VIEWPORT)
    await page.keyboard.press('Escape')
    await pause(page)
    await page.mouse.click(...BOX_TOP)
    await pause(page)
    await page.keyboard.press('s')
    await pause(page)
    await page.keyboard.type('Extrude')
    await pause(page)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
    await page.mouse.move(...ARROW)
    await pause(page)
    await page.mouse.down()
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(ARROW[0], ARROW[1] - 8 * i)
      await page.waitForTimeout(50)
    }
    await until(() => page.evaluate(() => {
      const p = playgroundLiveAdapter.presence()
      return !!p?.solid && JSON.stringify(p.pointer) === JSON.stringify(p.value?.at)
    }), 10000, 'the extrude under way, its prism shown and the pointer on its arrow')
    await pause(page)
  },
  openTab: async (page) => {
    await page.mouse.move(...VIEWPORT)
    await page.keyboard.press('Control+n')
    await page.waitForTimeout(800)
    await command(page, 'Box')
  },
  editA: (page) => command(page, 'Box'),
  editB: (page) => command(page, 'New Component'),
  undo: async (page) => {
    await page.mouse.move(...VIEWPORT)
    await page.keyboard.press('Control+z')
  },
}
