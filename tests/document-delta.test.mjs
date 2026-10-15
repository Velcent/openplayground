import test from 'node:test'
import assert from 'node:assert/strict'
import { delta, applyDelta, MAX_DOCUMENT } from '../shell/document-delta.js'

const bytes = text => new TextEncoder().encode(text)

test('small edits carry only the changed bytes and reverse exactly', async () => {
  const before = new Uint8Array(1024 * 1024).fill(7), after = before.slice()
  after[500000] = 9
  const edit = await delta(before, after)
  assert.equal(edit.at, 500000)
  assert.equal(edit.remove.length, 1)
  assert.equal(edit.insert.length, 1)
  assert.deepEqual(await applyDelta(before, edit), after)
  assert.deepEqual(await applyDelta(after, edit, true), before)
})

test('insertions, deletions, empty documents and unchanged documents round trip', async () => {
  for (const [a, b] of [['abc', 'aXYZbc'], ['abc', 'ac'], ['', 'abc'], ['abc', ''], ['same', 'same'], ['', '']]) {
    const before = bytes(a), after = bytes(b), edit = await delta(before, after)
    assert.deepEqual(await applyDelta(before, edit), after)
    assert.deepEqual(await applyDelta(after, edit, true), before)
    if (a === b) assert.equal(edit.remove.length + edit.insert.length, 0)
  }
})

test('stale bases and tampered payloads cannot produce a checkpoint', async () => {
  const before = bytes('abcdef'), after = bytes('abcXef'), edit = await delta(before, after)
  await assert.rejects(applyDelta(bytes('zbcdef'), edit), /base/)
  await assert.rejects(applyDelta(after, edit), /base/)
  await assert.rejects(applyDelta(before, { ...edit, remove: bytes('z') }), /removed/)
  await assert.rejects(applyDelta(before, { ...edit, insert: bytes('z') }), /hash/)
  await assert.rejects(applyDelta(before, { ...edit, result: '0'.repeat(64) }), /hash/)
})

test('malformed offsets, formats and buffers are rejected', async () => {
  const before = bytes('abc'), edit = await delta(before, bytes('xyz'))
  for (const change of [{ version: 2 }, { at: -1 }, { at: .5 }, { at: 4 }, { at: Number.MAX_SAFE_INTEGER }, { base: 'bad' }, { result: 'bad' }, { remove: [] }, { insert: 'oops' }, { remove: new Uint8Array(4) }]) {
    await assert.rejects(applyDelta(before, { ...edit, ...change }), /Invalid/)
  }
  await assert.rejects(applyDelta(before, null), /Invalid/)
  await assert.rejects(delta([], before), /Invalid/)
  await assert.rejects(applyDelta(before, edit, 'false'), /Invalid/)
})

test('oversized output is rejected before hashing or allocating it', async () => {
  const before = new Uint8Array(MAX_DOCUMENT)
  await assert.rejects(applyDelta(before, { version: 1, base: '0'.repeat(64), result: '0'.repeat(64), at: 0, remove: new Uint8Array(), insert: bytes('x') }), /limit/)
  await assert.rejects(delta(new Uint8Array(MAX_DOCUMENT + 1), bytes('x')), /limit/)
})

test('async hashing takes an immutable copy of caller buffers', async () => {
  const before = bytes('abc'), after = bytes('aXc'), pending = delta(before, after)
  before.fill(0); after.fill(0)
  const edit = await pending
  const source = bytes('abc'), applying = applyDelta(source, edit)
  source.fill(0); edit.insert.fill(0); edit.remove.fill(0)
  assert.deepEqual(await applying, bytes('aXc'))
})

test('byte views and a range of replacement spans round trip', async () => {
  for (let n = 0; n < 40; n++) {
    const before = Uint8Array.from({ length: n }, (_, i) => (i * 91 + n) % 256)
    const at = n % 7, after = Uint8Array.from([...before.slice(0, at), 0, 255, ...before.slice(at + n % 5)])
    const wrapper = new Uint8Array(before.length + 6); wrapper.set(before, 3)
    const view = wrapper.subarray(3, 3 + before.length), edit = await delta(view, after)
    assert.deepEqual(await applyDelta(view, edit), after)
    assert.deepEqual(await applyDelta(after, edit, true), before)
  }
})

test('Buffer subclasses are copied rather than retaining aliased slices', async () => {
  const before = Buffer.from('abc'), after = Buffer.from('aXc'), pending = delta(before, after)
  before.fill(0); after.fill(0)
  const edit = await pending
  const source = Buffer.from('abc'), incoming = { ...edit, remove: Buffer.from(edit.remove), insert: Buffer.from(edit.insert) }
  const applying = applyDelta(source, incoming)
  source.fill(0); incoming.remove.fill(0); incoming.insert.fill(0)
  assert.deepEqual(await applying, bytes('aXc'))
})
