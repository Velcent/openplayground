// Uses the installed FigCraft release: E2E=1 node --test tests/figma.e2e.test.mjs
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { launch, openPage, startSite, until } from './helpers.mjs'

const E2E = process.env.E2E === '1'
let site, browser
before(async () => {
  if (!E2E) return
  site = await startSite()
  browser = await launch(['--enable-unsafe-swiftshader'])
})
after(async () => {
  await browser?.close()
  await site?.close()
})

// Read a blank part of the left panel. Black means the GPU has not painted yet.
async function panelShade(page) {
  const png = await page.screenshot({ clip: { x: 150, y: 400, width: 1, height: 1 } })
  return page.evaluate(async (url) => {
    const img = new Image()
    img.src = url
    await img.decode()
    const ctx = document.createElement('canvas').getContext('2d')
    ctx.drawImage(img, 0, 0)
    return ctx.getImageData(0, 0, 1, 1).data[0]
  }, `data:image/png;base64,${png.toString('base64')}`)
}

for (const colorScheme of ['dark', 'light']) {
  test(`FigCraft starts ${colorScheme} and keeps a manual theme change`, { skip: !E2E }, async () => {
    const page = await openPage(browser, `${site.url}/figma/?webgl`, { colorScheme })
    try {
      await page.locator('#figcraft_loading').waitFor({ state: 'detached', timeout: 45000 })
      const dark = colorScheme === 'dark'
      await until(async () => {
        const shade = await panelShade(page)
        return shade > 0 && (shade < 128) === dark
      }, 10000, `${colorScheme} FigCraft panel`)
      const canvas = await page.locator('#figcraft_canvas').boundingBox()
      await page.mouse.click(canvas.x + canvas.width - 24, canvas.y + 20)
      await until(async () => (await panelShade(page) < 128) !== dark, 10000, 'manual theme change')
      await page.waitForTimeout(500)
      assert.equal(await panelShade(page) < 128, !dark)
    } finally {
      await page.context().close()
    }
  })
}
