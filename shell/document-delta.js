import { HASH, digest } from './session-protocol.js'

// Honeydew's web project limit. Media uses the separate streamed asset transport.
export const MAX_DOCUMENT = 128 * 1024 * 1024

function check(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('Invalid document bytes')
  if (bytes.length > MAX_DOCUMENT) throw new Error('Document exceeds the web file limit')
}

// This reconstructs a proposal for the model merge; it never applies directly to a live document.
export async function delta(before, after) {
  check(before); check(after)
  before = new Uint8Array(before); after = new Uint8Array(after)
  let at = 0, end = 0
  const common = Math.min(before.length, after.length)
  while (at < common && before[at] === after[at]) at++
  while (end < common - at && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  const [base, result] = await Promise.all([digest(before), digest(after)])
  return { version: 1, base, result, at, remove: before.slice(at, before.length - end), insert: after.slice(at, after.length - end) }
}

export async function applyDelta(bytes, edit, reverse = false) {
  check(bytes)
  if (!edit || edit.version !== 1 || typeof reverse !== 'boolean' || !Number.isSafeInteger(edit.at) || edit.at < 0
    || typeof edit.base !== 'string' || !HASH.test(edit.base) || typeof edit.result !== 'string' || !HASH.test(edit.result)) throw new Error('Invalid document delta')
  check(edit.remove); check(edit.insert)
  const { at } = edit
  const from = reverse ? edit.insert : edit.remove, to = reverse ? edit.remove : edit.insert
  if (at > bytes.length || from.length > bytes.length - at) throw new Error('Invalid document delta range')
  const size = bytes.length - from.length + to.length
  if (size > MAX_DOCUMENT) throw new Error('Document exceeds the web file limit')
  const base = reverse ? edit.result : edit.base, result = reverse ? edit.base : edit.result
  bytes = new Uint8Array(bytes)
  const remove = new Uint8Array(from), insert = new Uint8Array(to)
  if (await digest(bytes) !== base) throw new Error('Document delta has a stale or corrupted base')
  for (let i = 0; i < remove.length; i++) if (bytes[at + i] !== remove[i]) throw new Error('Document delta removed bytes do not match')
  const output = new Uint8Array(size)
  output.set(bytes.subarray(0, at))
  output.set(insert, at)
  output.set(bytes.subarray(at + remove.length), at + insert.length)
  if (await digest(output) !== result) throw new Error('Document delta result hash does not match')
  return output
}
