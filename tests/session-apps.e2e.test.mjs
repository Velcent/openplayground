import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { sessionSite } from './session-helpers.mjs'
import { until } from './helpers.mjs'

// A session follows its people from app to app, through the real Share panel: GridCraft and Honeydew builds from
// LIVE_PUBLIC (tests/live-apps/README.md).
const publicDir = process.env.LIVE_PUBLIC
const ready = publicDir && existsSync(`${publicDir}/excel.ok`) && existsSync(`${publicDir}/honeydew.ok`)
let site
before(async () => { if (ready) site = await sessionSite({ publicDir }) })
after(async () => { await site?.close() })

const share = (page) => page.getByRole('button', { name: /^(Share files|Session: .*)$/ })
const members = (page) => page.locator('.pg-share-members').innerText().catch(() => '')

test('switching apps keeps the session: it resumes on the next app, and the others see where you are', { skip: !ready && 'no LIVE_PUBLIC builds' }, async () => {
  const owner = await site.page(), guest = await site.page()
  await owner.goto(`${site.url}/gridcraft/`)
  await share(owner).click({ timeout: 120000 })
  await owner.getByRole('button', { name: 'Create session' }).click()
  const link = await owner.getByLabel('Invitation link').inputValue({ timeout: 30000 })
  await guest.goto(link)
  await guest.getByRole('button', { name: 'Join session' }).click({ timeout: 120000 })
  await until(async () => (await members(guest)).includes('in GridCraft'), 30000, 'the guest to see the owner in GridCraft')
  await owner.goto(`${site.url}/honeydew/`)
  await until(async () => /Session: 2 people/.test(await share(owner).getAttribute('aria-label', { timeout: 1000 }).catch(() => '')), 120000, 'the owner\'s session to resume in Honeydew')
  await until(async () => (await members(guest)).includes('in Honeydew'), 30000, 'the guest to see the owner in Honeydew')
})
