import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { pruneRetiredBuilds } from '../vite.config.js'

test('retired app builds are removed from both channels without touching other public files', () => {
  const root = mkdtempSync(join(tmpdir(), 'retired-builds-'))
  try {
    for (const dir of ['markupcraft', 'head/markupcraft', 'bluebeam', 'head/bluebeam', 'honeydew', 'head/honeydew', 'shared']) {
      mkdirSync(join(root, dir), { recursive: true })
      if (dir !== 'shared') writeFileSync(join(root, dir, '.release'), '{}')
    }
    pruneRetiredBuilds(root)
    for (const dir of ['markupcraft', 'head/markupcraft', 'bluebeam', 'head/bluebeam']) assert.equal(existsSync(join(root, dir)), false)
    for (const dir of ['honeydew', 'head/honeydew', 'shared']) assert.equal(existsSync(join(root, dir)), true)
  } finally { rmSync(root, {recursive:true,force:true}) }
})
