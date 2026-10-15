import { CHUNK_SIZE, MAX_FILE, MAX_MANIFEST, UUID, HASH, assetId, digest, validateManifest } from './session-protocol.js'

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
  async remove() {
    const sessions = await (await navigator.storage.getDirectory()).getDirectoryHandle('playground-sessions')
    await sessions.removeEntry(this.room, { recursive: true })
    this.verified.clear()
  }
}
