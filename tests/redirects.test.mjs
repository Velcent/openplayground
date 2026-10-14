import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appRedirects } from '../vite.config.js'

test('app-name URLs follow available release/head builds without replacing canonical URLs', () => {
  const redirects = appRedirects([
    { name: 'Honeydew', slug: 'fl-studio-mobile', release: { path: '/fl-studio-mobile/' }, head: { path: '/head/fl-studio-mobile/' } },
    { name: 'PhotoCraft', slug: 'photoshop', release: { path: '/photoshop/' } },
    { name: 'SubCraft', slug: 'substance-painter', head: { path: '/head/substance-painter/' } },
    { name: 'LightCraft Classic', slug: 'lightroom-classic', release: { path: '/lightroom-classic/' } },
    { name: 'Photoshop', slug: 'other-app', release: { path: '/other-app/' } },
    { name: 'Unavailable', slug: 'missing' },
  ])
  assert.equal(redirects['/honeydew'], '/fl-studio-mobile/')
  assert.equal(redirects['/honeydew/'], '/fl-studio-mobile/')
  assert.equal(redirects['/head/honeydew'], '/head/fl-studio-mobile/')
  assert.equal(redirects['/photocraft'], '/photoshop/')
  assert.equal(redirects['/head/photocraft/'], '/photoshop/')
  assert.equal(redirects['/subcraft'], '/head/substance-painter/')
  assert.equal(redirects['/lightcraft-classic/'], '/lightroom-classic/')
  assert.equal(redirects['/photoshop'], undefined)
  assert.equal(redirects['/unavailable'], undefined)
})
