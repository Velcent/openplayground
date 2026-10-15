import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { launch, startSite } from './helpers.mjs'
import { card } from '../vite.config.js'
import { tools } from '../scripts/releases.mjs'

let site, browser
before(async () => {
  site = await startSite()
  browser = await launch()
})
after(async () => {
  await browser?.close()
  await site?.close()
})

test('/shell/apps.json lists the installed apps with their channels and file types', async () => {
  const data = await (await fetch(`${site.url}/shell/apps.json`)).json()
  const apps = data.groups.flatMap((g) => g.apps)
  assert.ok(apps.length >= 3, 'run `make fetch` first: the tests use the installed apps')
  const word = apps.find((a) => a.slug === 'word')
  assert.equal(word.name, 'WordCraft')
  assert.equal(word.alternative, 'Word')
  assert.match(word.icon, /^\/(head\/)?wordcraft\/site-icon\.svg$/)
  assert.ok(word.opens.includes('docx'))
  assert.ok(word.imports.includes('png'), 'Word inserts pictures')
  const build = word.release ?? word.head
  assert.match(build.path, /^\/(head\/)?wordcraft\/$/)
  assert.equal(typeof build.label, 'string')
  for (const g of data.groups) assert.ok(g.apps.length > 0, `group ${g.name} is empty`)
})

test('the dashboard and the Files page use the ArtCraft icon as their favicon', async () => {
  const icon = await fetch(`${site.url}/shell/artcraft-icon.svg`)
  assert.equal(icon.status, 200)
  assert.match(icon.headers.get('content-type'), /image\/svg\+xml/)
  for (const path of ['/', '/files/']) {
    const html = await (await fetch(`${site.url}${path}`)).text()
    assert.match(html, /<link rel="icon"[^>]*href="\/shell\/artcraft-icon\.svg"/, path)
  }
})

test('alternative naming keeps an app icon when no commercial icon is supplied', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(site.url)
    const fixture = card({ ...tools.find((t) => t.slug === 'word'), slug: 'missing-commercial-icon' })
    await page.locator('.tool').first().evaluate((element, html) => element.outerHTML = html, fixture)
    const cards = page.locator('.tool').filter({ hasNot: page.locator(':scope > img.as-alt') })
    assert.ok(await cards.count() > 0)
    await page.evaluate(() => document.documentElement.dataset.naming = 'alternative')
    for (const card of await cards.all()) {
      assert.equal(await card.locator(':scope > img:visible').count(), 1, await card.locator('.name').innerText())
    }
  } finally { await page.close() }
})
