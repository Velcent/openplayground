import assert from 'node:assert/strict'
import { test } from 'node:test'
import { staleFailures } from '../scripts/prune-failures.mjs'

const asset = (name, day) => ({ name, created_at: `2026-10-${String(day).padStart(2, '0')}T12:00:00Z` })

test('keeps the first and latest failure per app/channel, without deleting builds or unrelated assets', () => {
  const assets = [
    asset('word-head-old-a.failed', 1),
    asset('word-head-mid-a.failed', 2),
    asset('word-head-new-a.failed', 3),
    asset('word-v1-a.failed', 1),
    asset('word-v2-a.failed', 2),
    asset('word-v3-a.failed', 3),
    asset('excel-head-only-a.failed', 2),
    asset('word-head-good-a.zip', 4),
    asset('unknown-head-a.failed', 1),
    asset('artcraft-store-a.zip', 1),
  ].reverse()
  const before = structuredClone(assets)
  assert.deepEqual(staleFailures(assets).map((a) => a.name).sort(), ['word-head-mid-a.failed', 'word-v2-a.failed'])
  assert.deepEqual(assets, before)
})

test('zero, one or two failures have no redundant history', () => {
  const failures = [asset('word-head-a.failed', 1), asset('word-head-b.failed', 2)]
  for (let n = 0; n <= 2; n++) assert.deepEqual(staleFailures(failures.slice(0, n)), [])
})

test('slugs with a shared prefix have independent failure histories', () => {
  const assets = [
    asset('lightroom-v1-a.failed', 1), asset('lightroom-v2-a.failed', 2),
    asset('lightroom-classic-v1-a.failed', 1), asset('lightroom-classic-v2-a.failed', 2),
    asset('lightroom-classic-head-a.failed', 1), asset('lightroom-classic-head-b.failed', 2),
    asset('lightroom-classic-head-c.failed', 3),
  ]
  assert.deepEqual(staleFailures(assets).map((a) => a.name), ['lightroom-classic-head-b.failed'])
})
