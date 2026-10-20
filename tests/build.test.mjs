import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { webDir } from '../scripts/build.mjs'

test('the dedicated web crate wins over the root workspace; root-only apps still build', () => {
  const src = mkdtempSync(join(tmpdir(), 'web-dir-'))
  try {
    writeFileSync(join(src, 'Cargo.toml'), '[workspace]')
    assert.equal(webDir(src), src)
    const web = join(src, 'apps', 'example-web')
    mkdirSync(web, { recursive: true })
    writeFileSync(join(web, 'Cargo.toml'), '[package]')
    assert.equal(webDir(src), web)
  } finally { rmSync(src, { recursive: true, force: true }) }
})

test("a tool's builds and failures leave out a longer slug's that start with its own (lightroom, lightroom-classic)", async () => {
  const { channelAssets, tools } = await import('../scripts/releases.mjs')
  const lightroom = tools.find((t) => t.slug === 'lightroom')
  const assets = ['lightroom-v0.8.0-aaaa.zip', 'lightroom-classic-v0.9.1-bbbb.zip', 'lightroom-head-1234567-cccc.zip', 'lightroom-classic-head-7654321-dddd.zip']
    .map((name, i) => ({ name, created_at: `2026-10-1${i}T00:00:00Z` }))
  assert.deepEqual(channelAssets(assets, lightroom, 'release').map((a) => a.name), ['lightroom-v0.8.0-aaaa.zip'])
  assert.deepEqual(channelAssets(assets, lightroom, 'head').map((a) => a.name), ['lightroom-head-1234567-cccc.zip'])
})

test('a build is stamped with the Playground commit it was made from, which fetch.mjs installs with it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'))
  try {
    mkdirSync(join(dir, 'word-v1.0.0-abcd1234'))
    writeFileSync(join(dir, 'word-v1.0.0-abcd1234', 'index.html'), '')
    const zip = join(dir, 'word-v1.0.0-abcd1234.zip')
    execFileSync('zip', ['-qr', zip, 'word-v1.0.0-abcd1234'], { cwd: dir })
    execFileSync('node', ['scripts/stamp-commit.mjs', zip])
    const stamped = execFileSync('unzip', ['-p', zip, 'word-v1.0.0-abcd1234/.playground-commit'], { encoding: 'utf8' })
    assert.equal(stamped.trim(), execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
