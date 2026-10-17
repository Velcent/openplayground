import { CHUNK_SIZE, MAX_FILE, MAX_MANIFEST, UUID, HASH, assetId, digest, pack, unpack, validHashes, validateManifest } from './session-protocol.js'

// drafts/<time>-<uuid>[-<app path, URI-encoded>].bin
const DRAFT = /^([0-9]+)-[0-9a-f-]{36}(?:-((?:%2F|[a-z0-9-])+))?\.bin$/
export const NO_SPACE = 'Not enough storage in this browser. Free up space and try again; verified data is saved.'
const write = async (dir, name, bytes) => {
  try {
    const out = await (await dir.getFileHandle(name, { create: true })).createWritable()
    try { await out.write(bytes); await out.close() }
    catch (e) { await out.abort().catch(() => {}); throw e }
  } catch (e) { throw e.name === 'QuotaExceededError' ? new Error(NO_SPACE) : e }
}
const readJSON = async (dir, name) => {
  try {
    const file = await (await dir.getFileHandle(name)).getFile()
    if (file.size > MAX_MANIFEST) throw new Error('Session metadata is too large')
    return JSON.parse(await file.text())
  } catch (e) { if (e.name === 'NotFoundError') return null; throw e }
}

// The entry carries its chunk hashes until saveManifest keeps them beside the chunks; file lists hold only the root.
export async function describe(file, id = crypto.randomUUID()) {
  if (!Number.isSafeInteger(file.size) || file.size > MAX_FILE) throw new Error('File is too large to share')
  const hashes = []
  for (let at = 0; at < file.size; at += CHUNK_SIZE) hashes.push(await digest(await file.slice(at, at + CHUNK_SIZE).arrayBuffer()))
  const entry = { id, name: file.name, size: file.size, hashes, asset: await assetId(file.size, hashes) }
  await validateManifest([entry])
  return entry
}

export class SessionStore {
  // The sessions this browser keeps a copy of (to rejoin), newest first: whose they are, from which app, when, files.
  static async list() {
    const result = []
    let root
    try { root = await (await navigator.storage.getDirectory()).getDirectoryHandle('playground-sessions') }
    catch(e) { if (e.name === 'NotFoundError') return result; throw e }
    for await (const [id, dir] of root.entries()) {
      if (dir.kind !== 'directory' || !UUID.test(id)) continue
      const config = await readJSON(dir, 'connection.json')
      if (!config?.app) continue
      const files = await new SessionStore(id).manifest()
      const modified = await dir.getFileHandle('connection.json').then((h) => h.getFile()).then((f) => f.lastModified, () => 0)
      result.push({ id, app: config.app, owner: !!config.owner, files: files.length, modified })
    }
    return result.sort((a, b) => b.modified - a.modified)
  }
  constructor(room) {
    if (!UUID.test(room)) throw new Error('Invalid session ID')
    this.room = room
    this.verified = new Map()
  }
  async root() {
    const root = await navigator.storage.getDirectory()
    const sessions = await root.getDirectoryHandle('playground-sessions', { create: true })
    return sessions.getDirectoryHandle(this.room, { create: true })
  }
  async read() { return validateManifest(await readJSON(await this.root(), 'manifest.json') ?? []) }
  async manifest() {
    let entries = await this.read()
    // Earlier versions kept every file's chunk hashes in its list: move them beside the chunks, once.
    if (entries.some((f) => f.hashes)) entries = await this.saveManifest([])
    this.entries = new Map(entries.map((f) => [f.asset, f]))
    return entries
  }
  async saveManifest(files) {
    await validateManifest(files)
    return navigator.locks.request(`playground-session:${this.room}`, async () => {
      const merged = new Map((await this.read()).map((f) => [f.id, f]))
      for (const file of files) {
        const old = merged.get(file.id)
        if (old && (old.asset !== file.asset || old.name !== file.name)) throw new Error('Conflicting file version; the local copy was preserved')
        merged.set(file.id, file)
      }
      await validateManifest([...merged.values()])
      for (const f of merged.values()) if (f.hashes) await write(await this.directory(f.asset), 'hashes.json', JSON.stringify(f.hashes))
      const entries = [...merged.values()].map(({ hashes, ...f }) => f)
      await write(await this.root(), 'manifest.json', JSON.stringify(entries))
      this.entries = new Map(entries.map((f) => [f.asset, f]))
      for (const file of files) if (file.size === 0) await write(await this.directory(file.asset), 'complete.json', 'true')
      return entries
    })
  }
  async entry(asset) {
    if (!HASH.test(asset)) throw new Error('Invalid asset ID')
    if (!this.entries?.has(asset)) await this.manifest()
    const file = this.entries.get(asset)
    if (!file) throw new Error('Unknown session asset')
    return file
  }
  async directory(asset) {
    if (!HASH.test(asset)) throw new Error('Invalid asset ID')
    return (await this.root()).getDirectoryHandle(asset, { create: true })
  }
  // A file's chunk hashes, beside its chunks, checked against its asset ID when read. Null until fetched (session.js).
  // One list is kept in memory: downloads go file by file.
  async hashes(asset) {
    const entry = await this.entry(asset)
    if (this.list?.asset !== asset) {
      const hashes = await readJSON(await this.directory(asset), 'hashes.json').catch(() => null)
      if (!await validHashes(entry, hashes)) return null
      this.list = { asset, hashes }
    }
    return this.list.hashes
  }
  async putHashes(asset, hashes) {
    if (!await validHashes(await this.entry(asset), hashes)) throw new Error('Invalid chunk hashes')
    await write(await this.directory(asset), 'hashes.json', JSON.stringify(hashes))
    this.list = { asset, hashes }; this.verified.delete(asset)
  }
  async verifiedChunks(file) {
    if (this.verified.has(file.asset)) return this.verified.get(file.asset)
    const verified = new Set(), dir = await this.directory(file.asset), hashes = await this.hashes(file.asset)
    if (hashes) for await (const [name, handle] of dir.entries()) {
      const i = Number(name)
      if (handle.kind !== 'file' || !/^(0|[1-9][0-9]*)$/.test(name) || i >= hashes.length) continue
      try {
        const chunk = await handle.getFile()
        if (chunk.size === Math.min(CHUNK_SIZE, file.size - i * CHUNK_SIZE) && await digest(await chunk.arrayBuffer()) === hashes[i]) verified.add(i)
      } catch (e) { if (e.name !== 'NotFoundError') throw e }
    }
    this.verified.set(file.asset, verified)
    return verified
  }
  async missing(asset) {
    const entry = await this.entry(asset), verified = await this.verifiedChunks(entry)
    return Array.from({ length: Math.ceil(entry.size / CHUNK_SIZE) }, (_, i) => i).filter((i) => !verified.has(i))
  }
  async putChunk(asset, index, data) {
    const entry = await this.entry(asset), hashes = await this.hashes(asset)
    if (!hashes || !Number.isInteger(index) || index < 0 || index >= hashes.length || !(data instanceof Uint8Array) || data.length !== Math.min(CHUNK_SIZE, entry.size - index * CHUNK_SIZE) || await digest(data) !== hashes[index]) throw new Error('Invalid or corrupted asset chunk')
    return navigator.locks.request(`playground-chunk:${this.room}:${asset}`, async () => {
      const verified = await this.verifiedChunks(entry), dir = await this.directory(asset)
      await write(dir, `${index}`, data)
      verified.add(index)
      if (verified.size === hashes.length) await write(dir, 'complete.json', 'true')
    })
  }
  async chunk(asset, index) {
    const entry = await this.entry(asset), verified = await this.verifiedChunks(entry)
    if (!verified.has(index)) throw new Error('Asset chunk has not been verified')
    return (await (await this.directory(asset)).getFileHandle(`${index}`)).getFile()
  }
  async file(asset) {
    const entry = await this.entry(asset)
    if ((await this.missing(asset)).length || await readJSON(await this.directory(asset), 'complete.json') !== true) throw new Error('File is still syncing')
    const parts = []
    for (let i = 0; i * CHUNK_SIZE < entry.size; i++) parts.push(await this.chunk(asset, i))
    return new File(parts, entry.name)
  }
  async connection(value) {
    if (value !== undefined) await write(await this.root(), 'connection.json', JSON.stringify(value))
    return readJSON(await this.root(), 'connection.json')
  }
  // The media this browser brought into the live document: the only ones it shares (live.js).
  async media(ids, name = 'media') {
    if (ids !== undefined) await write(await this.root(), `${name}.json`, JSON.stringify(ids))
    return readJSON(await this.root(), `${name}.json`)
  }
  // A live document's recovery record (the coordinator's journal), one per app; written atomically on every commit.
  async document(record, name = 'document') {
    const dir = await this.root()
    if (record !== undefined) return write(dir, `${name}.bin`, pack(record))
    try { return unpack(new Uint8Array(await (await (await dir.getFileHandle(`${name}.bin`)).getFile()).arrayBuffer())) }
    catch (e) { if (e.name === 'NotFoundError') return null; throw e }
  }
  // Local work a live document could not keep: a rejected or conflicting draft, or what a session replaced. Named
  // for when and from which app (its path), kept until the person opens or removes it in the Share panel.
  async draft(bytes, app) {
    await write(await this.draftsDir(), `${Date.now()}-${crypto.randomUUID()}${app ? `-${encodeURIComponent(app)}` : ''}.bin`, bytes)
    this.kept = null
  }
  // Newest first: [{ name, app, time, size }]. Listed once until a draft is added or removed: the panel asks often.
  drafts() {
    return this.kept ??= (async () => {
      const list = []
      for await (const [name, handle] of (await this.draftsDir()).entries()) {
        const m = handle.kind === 'file' && name.match(DRAFT)
        if (m) list.push({ name, app: m[2] ? decodeURIComponent(m[2]) : null, time: Number(m[1]), size: (await handle.getFile()).size })
      }
      return list.sort((a, b) => b.time - a.time)
    })().catch((e) => { this.kept = null; throw e })
  }
  async readDraft(name) {
    if (!DRAFT.test(name)) throw new Error('Invalid draft')
    return new Uint8Array(await (await (await (await this.draftsDir()).getFileHandle(name)).getFile()).arrayBuffer())
  }
  async removeDraft(name) {
    if (!DRAFT.test(name)) throw new Error('Invalid draft')
    await (await this.draftsDir()).removeEntry(name)
    this.kept = null
  }
  async draftsDir() { return (await this.root()).getDirectoryHandle('drafts', { create: true }) }
  async finish(asset) {
    if ((await this.missing(asset)).length) throw new Error('File is still syncing')
    await write(await this.directory(asset), 'complete.json', 'true')
  }
  async remove() {
    const sessions = await (await navigator.storage.getDirectory()).getDirectoryHandle('playground-sessions')
    await sessions.removeEntry(this.room, { recursive: true })
    this.verified.clear()
  }
}
