import { UUID, digest } from './session-protocol.js'
import { MAX_DOCUMENT, applyDelta, delta } from './document-delta.js'

const MAX_ENTRIES = 100, MAX_HISTORY = 256 * 1024 * 1024, MAX_PENDING = 64
const KINDS = ['edit', 'undo', 'redo']
const text = new TextEncoder()
const invalid = () => new Error('Invalid document operation')
const copyEntry = entry => ({ ...entry, change: { ...entry.change, remove: new Uint8Array(entry.change.remove), insert: new Uint8Array(entry.change.insert) } })
const size = change => change.remove.length + change.insert.length

// Copies everything used later before the first await, so callers may reuse their buffers.
function read(proposal) {
  if (!proposal || typeof proposal !== 'object') throw invalid()
  const { version, document, format, id, base, kind, target, edit } = proposal
  if (version !== 1 || typeof id !== 'string' || !UUID.test(id) || !Number.isSafeInteger(base) || base < 0 || !KINDS.includes(kind)) throw invalid()
  if (kind !== 'edit') {
    if (!Number.isSafeInteger(target) || target < 1) throw invalid()
    return { document, format, id, base, kind, target }
  }
  const bytes = value => {
    if (!(value instanceof Uint8Array) || value.length > MAX_DOCUMENT) throw invalid()
    return new Uint8Array(value)
  }
  if (!edit || typeof edit !== 'object') throw invalid()
  return { document, format, id, base, kind, edit: { version: edit.version, base: edit.base, result: edit.result, at: edit.at, remove: bytes(edit.remove), insert: bytes(edit.insert) } }
}

// Identifies a request's content so a replayed ID can be told apart from a reused one.
async function fingerprint({ base, kind, target, edit }) {
  const head = text.encode(JSON.stringify([base, kind, target ?? null, edit && [edit.version, edit.base, edit.result, edit.at, edit.remove.length]]))
  return digest(await new Blob(edit ? [head, edit.remove, edit.insert] : [head]).arrayBuffer())
}

// An author's Undo and Redo stacks follow from the retained entries; expired targets simply drop out.
export function stacks(entries, author) {
  const undo = [], redo = []
  for (const entry of entries) {
    if (entry.author !== author) continue
    if (entry.kind === 'edit') { undo.push(entry.revision); redo.length = 0 }
    else if (entry.kind === 'undo') { undo.pop(); redo.push(entry.revision) }
    else { redo.pop(); undo.push(entry.revision) }
  }
  return { undo, redo }
}

// ponytail: each submit copies and commits the whole record and runs up to one merge per retained revision; fine for
// typical songs, a ceiling near the 128 MiB document and 256 MiB history limits. Commit deltas incrementally if that shows.
// Orders authored changes for one shared document. A proposal is rebased over every retained revision after its base,
// one at a time, so changing a value and changing it back still fences stale work. Undo and Redo revert the
// author's own latest operation and are checked against other authors' later changes only.
export class DocumentHistory {
  #document; #format; #merge; #commit; #allowed
  #revision = 0; #bytes; #entries = []
  #tail = Promise.resolve(); #pending = 0; #queued = 0

  constructor({ document, format, bytes, merge, commit, allowed }) {
    if (typeof document !== 'string' || !UUID.test(document) || typeof format !== 'string' || !format || !(bytes instanceof Uint8Array)
      || bytes.length > MAX_DOCUMENT || typeof merge !== 'function' || typeof commit !== 'function' || typeof allowed !== 'function') throw new Error('Invalid document history')
    this.#document = document; this.#format = format; this.#bytes = new Uint8Array(bytes)
    this.#merge = merge; this.#commit = commit; this.#allowed = allowed
  }

  // The initial record is durable before any operation can be acknowledged.
  static async create(options) {
    const history = new DocumentHistory(options)
    await history.#commit(history.snapshot())
    return history
  }

  // Continues from this browser's own last committed record.
  static restore(record, options) {
    const history = new DocumentHistory({ ...options, document: record?.document, format: record?.format, bytes: record?.bytes })
    const { revision, entries } = record
    if (record.version !== 1 || !Array.isArray(entries) || entries.length > MAX_ENTRIES || !Number.isSafeInteger(revision) || revision < entries.length
      || !entries.every((e, i) => e?.revision === revision - entries.length + 1 + i && e.change?.remove instanceof Uint8Array && e.change.insert instanceof Uint8Array)) throw new Error('Invalid document history record')
    history.#revision = revision; history.#entries = entries.map(copyEntry)
    return history
  }

  snapshot() {
    return this.#record(this.#revision, this.#bytes, this.#entries)
  }

  async submit(author, proposal) {
    const request = read(proposal), bytes = request.edit ? size(request.edit) : 0
    if (request.document !== this.#document || request.format !== this.#format) throw new Error('Operation is for a different document or build')
    if (this.#pending >= MAX_PENDING || this.#queued + bytes > MAX_HISTORY) throw new Error('Too many pending document operations')
    this.#pending++; this.#queued += bytes
    const run = this.#tail.then(() => this.#apply(author, request))
    this.#tail = run.catch(() => {})
    try { return await run } finally { this.#pending--; this.#queued -= bytes }
  }

  #record(revision, bytes, entries) {
    return { version: 1, document: this.#document, format: this.#format, revision, bytes: new Uint8Array(bytes), entries: entries.map(copyEntry) }
  }

  get #oldest() { return this.#revision - this.#entries.length }

  async #check(base, current, edited) {
    try {
      return new Uint8Array(await this.#merge(base, current, edited))
    } catch (error) {
      throw new Error(`Conflict: ${error?.message ?? error}`)
    }
  }

  async #at(revision) {
    let bytes = this.#bytes
    for (let i = this.#entries.length - 1; i >= revision - this.#oldest; i--) bytes = await applyDelta(bytes, this.#entries[i].change, true)
    return bytes
  }

  async #apply(author, p) {
    // Identity and role come from the authenticated caller at processing time, never from the proposal.
    if (typeof author !== 'string' || !UUID.test(author) || await this.#allowed(author) !== true) throw new Error('Sender lacks editing permission')
    const request = await fingerprint(p)
    const old = this.#entries.find(entry => entry.id === p.id)
    if (old) {
      if (old.author !== author || old.request !== request) throw new Error('Reused operation ID')
      return copyEntry(old)
    }
    if (p.base > this.#revision) throw invalid()
    let next
    if (p.kind === 'edit') {
      if (p.base < this.#oldest) throw new Error('Base revision expired')
      // Rebased over each later entry in turn, with the arguments its author's browser uses for the same entries
      // (merge(before, local, after)): both reach the same bytes, and a change made and reverted in between still
      // conflicts at its own step.
      const base = await this.#at(p.base), edited = await applyDelta(base, p.edit)
      let state = base
      next = await this.#check(base, base, edited)
      for (const entry of this.#entries.slice(p.base - this.#oldest)) {
        const before = state
        state = await applyDelta(state, entry.change)
        next = await this.#check(before, next, state)
      }
      // An edit the merge reduces to nothing would be an empty entry its author's browser, still differing, proposes
      // again and again; refused, that browser takes the shared document back (keeping its own as a draft).
      if (next.length === this.#bytes.length && next.every((v, i) => v === this.#bytes[i])) throw new Error('No change')
    } else {
      if (p.target <= this.#oldest) throw new Error('Undo or Redo target expired')
      const { undo, redo } = stacks(this.#entries, author)
      if ((p.kind === 'undo' ? undo : redo).at(-1) !== p.target) throw new Error('Invalid Undo or Redo target')
      const before = await this.#at(p.target - 1)
      const after = await applyDelta(before, this.#entries[p.target - this.#oldest - 1].change)
      // The author's own later operations cancel out under stack order; replay only everyone else's.
      let state = after, others = after
      for (const entry of this.#entries.slice(p.target - this.#oldest)) {
        const previous = state
        state = await applyDelta(state, entry.change)
        if (entry.author === author) continue
        others = await this.#check(previous, others, state)
        await this.#check(after, others, before)
      }
      next = await this.#check(after, state, before)
    }
    const entry = { id: p.id, author, revision: this.#revision + 1, base: p.base, kind: p.kind, target: p.target, request, change: await delta(this.#bytes, next) }
    const entries = [...this.#entries, entry]
    let total = entries.reduce((sum, e) => sum + size(e.change), 0)
    while (entries.length > MAX_ENTRIES || total > MAX_HISTORY) total -= size(entries.shift().change)
    await this.#commit(this.#record(entry.revision, next, entries))
    this.#revision = entry.revision; this.#bytes = next; this.#entries = entries
    return copyEntry(entry)
  }
}
