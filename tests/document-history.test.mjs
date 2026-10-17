import test from 'node:test'
import assert from 'node:assert/strict'
import { delta } from '../shell/document-delta.js'
import { DocumentHistory } from '../shell/document-history.js'

const document = crypto.randomUUID(), format = 'honeydew:1:test-build'
const alice = crypto.randomUUID(), bob = crypto.randomUUID(), viewer = crypto.randomUUID()
const bytes = (...values) => Uint8Array.from(values)
// A three-field document exercises journal ordering independently of Honeydew's separately tested model.
function merge(base, current, edited) {
  assert.equal(base.length, 3); assert.equal(current.length, 3); assert.equal(edited.length, 3)
  return edited.map((value, i) => {
    if (value === base[i]) return current[i]
    if (current[i] !== base[i]) throw new Error('Conflicting field')
    return value
  })
}
async function setup(overrides = {}) {
  return DocumentHistory.create({ document, format, bytes: bytes(0, 0, 0), merge,
    commit: async () => {}, allowed: id => id === alice || id === bob, ...overrides })
}
const command = (base, kind, target) => ({ version: 1, document, format, id: crypto.randomUUID(), base, kind, target })
async function edit(base, before, after) {
  return { ...command(base, 'edit'), edit: await delta(bytes(...before), bytes(...after)) }
}
const state = journal => [...journal.snapshot().bytes]

test('concurrent independent proposals are ordered and preserve both changes', async () => {
  const j = await setup()
  const a = await edit(0, [0, 0, 0], [1, 0, 0]), b = await edit(0, [0, 0, 0], [0, 2, 0])
  const [one, two] = await Promise.all([j.submit(alice, a), j.submit(bob, b)])
  assert.equal(one.revision, 1); assert.equal(two.revision, 2)
  assert.equal(one.author, alice); assert.equal(two.author, bob)
  assert.deepEqual(state(j), [1, 2, 0])
  await assert.rejects(j.submit(bob, await edit(0, [0, 0, 0], [1, 0, 0])), /Conflict/)
  assert.deepEqual(state(j), [1, 2, 0])
})

test('changing a value and changing it back still fences stale proposals', async () => {
  const j = await setup()
  await j.submit(bob, await edit(0, [0, 0, 0], [1, 0, 0]))
  await j.submit(bob, await edit(1, [1, 0, 0], [0, 0, 0]))
  await assert.rejects(j.submit(alice, await edit(0, [0, 0, 0], [2, 0, 0])), /Conflict/)
  assert.deepEqual(state(j), [0, 0, 0])
})

test('Undo and Redo target only that author and keep remote changes', async () => {
  const j = await setup()
  await j.submit(alice, await edit(0, [0, 0, 0], [1, 0, 0]))
  await j.submit(bob, await edit(1, [1, 0, 0], [1, 2, 0]))
  await assert.rejects(j.submit(bob, command(2, 'undo', 1)), /target/)
  await j.submit(alice, command(2, 'undo', 1))
  assert.deepEqual(state(j), [0, 2, 0])
  await j.submit(bob, await edit(3, [0, 2, 0], [0, 3, 0]))
  await j.submit(alice, command(4, 'redo', 3))
  assert.deepEqual(state(j), [1, 3, 0])
})

test('several own Undo steps ignore canceled own edits around other authors work', async () => {
  const j = await setup()
  await j.submit(alice, await edit(0, [0, 0, 0], [1, 0, 0]))
  await j.submit(alice, await edit(1, [1, 0, 0], [2, 0, 0]))
  await j.submit(bob, await edit(2, [2, 0, 0], [2, 5, 0]))
  await j.submit(alice, command(3, 'undo', 2))
  await j.submit(alice, command(4, 'undo', 1))
  assert.deepEqual(state(j), [0, 5, 0])
  await j.submit(alice, command(5, 'redo', 5))
  await j.submit(alice, command(6, 'redo', 4))
  assert.deepEqual(state(j), [2, 5, 0])
})

test('Undo refuses another authors intervening edit even after that edit is undone', async () => {
  const j = await setup()
  await j.submit(alice, await edit(0, [0, 0, 0], [1, 0, 0]))
  await j.submit(bob, await edit(1, [1, 0, 0], [2, 0, 0]))
  await j.submit(bob, command(2, 'undo', 2))
  await assert.rejects(j.submit(alice, command(3, 'undo', 1)), /Conflict/)
  assert.deepEqual(state(j), [1, 0, 0])
})

test('new own edits clear Redo, remote edits do not', async () => {
  const j = await setup()
  await j.submit(alice, await edit(0, [0, 0, 0], [1, 0, 0]))
  await j.submit(alice, command(1, 'undo', 1))
  await j.submit(alice, await edit(2, [0, 0, 0], [0, 0, 3]))
  await assert.rejects(j.submit(alice, command(3, 'redo', 2)), /target/)
})

test('replay returns the original receipt and rejects modified content or identity', async () => {
  let writes = 0
  const j = await setup({ commit: async () => { writes++ } }), request = await edit(0, [0, 0, 0], [1, 0, 0])
  const receipt = await j.submit(alice, request)
  assert.deepEqual(await j.submit(alice, request), receipt)
  assert.equal(writes, 2)
  await assert.rejects(j.submit(bob, request), /operation ID/)
  const changed = { ...request, edit: { ...request.edit, insert: bytes(7) } }
  await assert.rejects(j.submit(alice, changed), /operation ID/)
  assert.deepEqual(state(j), [1, 0, 0])
})

test('rejected persistence never acknowledges or mutates the last committed state', async () => {
  let fail = false, durable
  const j = await setup({ commit: async record => {
    if (fail) throw new Error('Quota exceeded')
    durable = record
  } })
  const request = await edit(0, [0, 0, 0], [1, 0, 0])
  fail = true
  await assert.rejects(j.submit(alice, request), /Quota/)
  assert.equal(j.snapshot().revision, 0); assert.equal(durable.revision, 0)
  assert.deepEqual(state(j), [0, 0, 0])
  fail = false
  await j.submit(alice, request)
  assert.equal(durable.revision, 1)
})

test('untrusted identities, formats, revisions and read-only senders cannot submit', async () => {
  const j = await setup(), valid = await edit(0, [0, 0, 0], [1, 0, 0])
  for (const change of [{ document: crypto.randomUUID() }, { format: 'different-build' }, { version: 2 },
    { base: -1 }, { base: 1 }, { base: .5 }, { id: 'bad' }, { kind: 'replace' }, { edit: null }]) {
    await assert.rejects(j.submit(alice, { ...valid, ...change }))
  }
  await assert.rejects(j.submit(viewer, { ...valid, author: alice, role: 'owner' }), /permission/)
  await assert.rejects(j.submit('invalid-author', valid))
  assert.deepEqual(state(j), [0, 0, 0])
})

test('queued work checks current permission after waiting, and a pending check fails closed', async () => {
  let release, blocked = false, allow = true
  const j = await setup({ allowed: () => allow, commit: async () => {
    if (blocked) await new Promise(resolve => { release = resolve })
  } })
  blocked = true
  const a = await edit(0, [0, 0, 0], [1, 0, 0]), b = await edit(0, [0, 0, 0], [0, 2, 0])
  const first = j.submit(alice, a)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  const second = j.submit(bob, b)
  allow = false; blocked = false; release()
  await first
  await assert.rejects(second, /permission/)
  assert.deepEqual(state(j), [1, 0, 0])
  const pending = await setup({ allowed: async () => false })
  await assert.rejects(pending.submit(alice, await edit(0, [0, 0, 0], [1, 0, 0])), /permission/)
})

test('caller mutations cannot change queued proposals, receipts or stored history', async () => {
  const source = bytes(0, 0, 0), creating = setup({ bytes: source, commit: async record => { record.bytes.fill(9) } })
  source.fill(7)
  const j = await creating, request = await edit(0, [0, 0, 0], [1, 0, 0])
  const pending = j.submit(alice, request)
  request.edit.insert.fill(9); request.base = 100
  const receipt = await pending
  receipt.change.insert.fill(8)
  const snapshot = j.snapshot(); snapshot.bytes.fill(7); snapshot.entries[0].change.insert.fill(7)
  await j.submit(alice, command(1, 'undo', 1))
  assert.deepEqual(state(j), [0, 0, 0])
})

test('pruned history expires stale proposals and old Undo without losing recent operations', async () => {
  const j = await setup()
  await j.submit(alice, await edit(0, [0, 0, 0], [0, 1, 0]))
  for (let i = 1; i < 102; i++) await j.submit(bob, await edit(i, [i - 1, 1, 0], [i, 1, 0]))
  await assert.rejects(j.submit(alice, command(102, 'undo', 1)), /target|expired/)
  await assert.rejects(j.submit(alice, await edit(0, [0, 0, 0], [0, 0, 1])), /expired/)
  await j.submit(bob, command(102, 'undo', 102))
  assert.deepEqual(state(j), [100, 1, 0])
  assert.equal(j.snapshot().entries.length, 100)
})

test('a proposal is rebased entry by entry, exactly as its author rebases it, so both reach the same bytes', async () => {
  // An ordered-list merge that is path-dependent: items the edited side added go after the current side's.
  const append = (base, current, edited) => {
    const added = [...edited].filter((v) => !base.includes(v))
    if ([...base].some((v) => !current.includes(v) || !edited.includes(v))) throw new Error('Conflicting removal')
    return Uint8Array.from([...current, ...added])
  }
  const j = await setup({ bytes: bytes(1), merge: append })
  await j.submit(bob, await edit(0, [1], [1, 2]))
  await j.submit(bob, await edit(1, [1, 2], [1, 2, 3]))
  const proposal = bytes(1, 9)
  await j.submit(alice, await edit(0, [1], [...proposal]))
  // Alice's browser merged each accepted entry into her work in turn: merge(a(k-1), local, a(k)).
  const local = append(bytes(1, 2), append(bytes(1), proposal, bytes(1, 2)), bytes(1, 2, 3))
  assert.deepEqual(state(j), [...local])
})

test('an edit that changes nothing is refused, so a browser stuck on one cannot record entries forever', async () => {
  const j = await setup()
  await assert.rejects(j.submit(alice, await edit(0, [0, 0, 0], [0, 0, 0])), /No change/)
  await j.submit(bob, await edit(0, [0, 0, 0], [1, 0, 0]))
  await assert.rejects(j.submit(alice, await edit(1, [1, 0, 0], [1, 0, 0])), /No change/)
  assert.equal(j.snapshot().revision, 1)
})
