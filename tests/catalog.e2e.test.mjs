import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { launch, openPage, startSite } from './helpers.mjs'

let site, browser, apps
before(async () => {
  site = await startSite()
  browser = await launch()
  apps = (await (await fetch(`${site.url}/shell/apps.json`)).json()).groups.flatMap((g) => g.apps)
})
after(async () => {
  await browser?.close()
  await site?.close()
})

test('every installed app serves its own URL and redirects old links with their query and nested path', async () => {
  assert.ok(apps.length > 0)
  const query = '?alt=true&open=browser%3A%2FDocuments%2Fdemo.flp'
  for (const app of apps) {
    const own = app.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    for (const [prefix, build] of [['', app.release ?? app.head], ['/head', app.head ?? app.release]]) {
      assert.ok(build.path === `/${own}/` || build.path === `/head/${own}/`)
      const response = await fetch(`${site.url}${prefix}/${app.slug}${query}`, { redirect: 'manual' })
      assert.equal(response.status, 302, app.name)
      assert.equal(response.headers.get('location'), `${build.path}${query}`, app.name)
      const nested = await fetch(`${site.url}${prefix}/${app.slug}/index.html${query}`, { redirect: 'manual' })
      assert.equal(nested.headers.get('location'), `${build.path}index.html${query}`, app.name)
      assert.equal((await fetch(`${site.url}${build.path}`, { redirect: 'manual' })).status, 200, app.name)
    }
  }
})

test('Lemon uses the supplied icons and starts under its canonical URL with the Playground bar', async () => {
  const lemon = apps.find((a) => a.slug === 'fl-studio')
  assert.ok(lemon, 'Fetch the Lemon Studio web release before running the catalog check')
  assert.equal(lemon.release.path, '/lemon-studio/')
  assert.equal(lemon.head, null)
  assert.equal(lemon.icon, '/lemon-studio/site-icon.png')
  assert.equal(lemon.alternativeIcon, '/lemon-studio/alternative-icon.png')
  const page = await openPage(browser, `${site.url}/`)
  const card = page.locator('.tool', { hasText: 'Lemon Studio' })
  assert.equal(await card.locator('.name').innerText(), 'Lemon Studio')
  assert.equal(await card.locator('img:visible').first().getAttribute('src'), '/icons/lemon-studio.png')
  await page.getByRole('switch', { name: 'Alternative naming' }).click()
  assert.equal(await card.locator('.name').innerText(), 'FL Studio (experimental)')
  assert.equal(await card.locator('img:visible').first().getAttribute('src'), '/icons/alternatives/fl-studio.png')
  await page.goto(`${site.url}/fl-studio/?alt=true#editor`)
  await page.locator('html[data-lemon-ready=true]').waitFor({ timeout: 30000 })
  assert.equal(new URL(page.url()).pathname, '/lemon-studio/')
  assert.equal(new URL(page.url()).search, '?alt=true')
  assert.equal(new URL(page.url()).hash, '#editor')
  assert.equal(await page.evaluate(() => crossOriginIsolated), true)
  await page.locator('.pg-switch').waitFor()
  assert.equal(await page.title(), 'FL Studio')
  assert.equal(await page.locator('.pg-switch img').getAttribute('src'), lemon.alternativeIcon)
  const canvas = await page.locator('#lemon-canvas').boundingBox()
  assert.equal(canvas.y, 36)
  assert.equal(canvas.height, page.viewportSize().height - 36)
  await page.context().close()
})
