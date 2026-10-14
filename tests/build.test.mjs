import assert from 'node:assert/strict'
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
