import { CHUNK_SIZE, MAX_FILE, MAX_MANIFEST, UUID, HASH, assetId, digest, pack, unpack, validateManifest } from './session-protocol.js'

const write = async (dir, name, bytes) => {
  const out = await (await dir.getFileHandle(name, { create: true })).createWritable()
  try { await out.write(bytes); await out.close() }
  catch (e) { await out.abort().catch(() => {}); throw e }
}
const readJSON = async (dir, name) => {
  try {
    const file = await (await dir.getFileHandle(name)).getFile()
    if (file.size > MAX_MANIFEST) throw new Error('Session metadata is too large')
    return JSON.parse(await file.text())
  } catch (e) { if (e.name === 'NotFoundError') return null; throw e }
}

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
  async manifest() {
    const entries = await validateManifest(await readJSON(await this.root(), 'manifest.json') ?? [])
    this.entries = new Map(entries.map((f) => [f.asset, f]))
    return entries
  }
  async saveManifest(files) {
    await validateManifest(files)
    return navigator.locks.request(`playground-session:${this.room}`, async () => {
      const merged = new Map((await this.manifest()).map((f) => [f.id, f]))
      for (const file of files) {
        const old = merged.get(file.id)
        if (old && (old.asset !== file.asset || old.name !== file.name)) throw new Error('Conflicting file version; the local copy was preserved')
        merged.set(file.id, file)
      }
      const entries = await validateManifest([...merged.values()])
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
  async verifiedChunks(file) {
    if (this.verified.has(file.asset)) return this.verified.get(file.asset)
    const verified = new Set(), dir = await this.directory(file.asset)
    for await (const [name, handle] of dir.entries()) {
      const i = Number(name)
      if (handle.kind !== 'file' || !/^(0|[1-9][0-9]*)$/.test(name) || i >= file.hashes.length) continue
      try {
        const chunk = await handle.getFile()
        if (chunk.size === Math.min(CHUNK_SIZE, file.size - i * CHUNK_SIZE) && await digest(await chunk.arrayBuffer()) === file.hashes[i]) verified.add(i)
      } catch (e) { if (e.name !== 'NotFoundError') throw e }
    }
    this.verified.set(file.asset, verified)
    return verified
  }
  async missing(asset) {
    const entry = await this.entry(asset), verified = await this.verifiedChunks(entry)
    return entry.hashes.map((_, i) => i).filter((i) => !verified.has(i))
  }
  async putChunk(asset, index, data) {
    const entry = await this.entry(asset)
    if (!Number.isInteger(index) || index < 0 || index >= entry.hashes.length || !(data instanceof Uint8Array) || data.length !== Math.min(CHUNK_SIZE, entry.size - index * CHUNK_SIZE) || await digest(data) !== entry.hashes[index]) throw new Error('Invalid or corrupted asset chunk')
    return navigator.locks.request(`playground-chunk:${this.room}:${asset}`, async () => {
      const verified = await this.verifiedChunks(entry), dir = await this.directory(asset)
      await write(dir, `${index}`, data)
      verified.add(index)
      if (verified.size === entry.hashes.length) await write(dir, 'complete.json', 'true')
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
    for (let i = 0; i < entry.hashes.length; i++) parts.push(await this.chunk(asset, i))
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
  // Local work a live document could not keep: a rejected or conflicting draft, or what a session replaced.
  // ponytail: drafts accumulate until the session is removed; prune or list them once there is a drafts UI.
  async draft(bytes) {
    const dir = await (await this.root()).getDirectoryHandle('drafts', { create: true })
    await write(dir, `${Date.now()}-${crypto.randomUUID()}.bin`, bytes)
  }
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
