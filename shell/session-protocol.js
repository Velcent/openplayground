// Shared wire limits and browser cryptography. Project bytes never belong in the signaling API.
export const VERSION = 1
export const CHUNK_SIZE = 65536
export const FRAME_SIZE = 16384
export const MAX_MEMBERS = 8
export const MAX_SIGNAL = 196608
export const MAX_MANIFEST = 16 * 1024 ** 2
export const MAX_FILE = 8 * 1024 ** 3
export const MAX_TOTAL = 32 * 1024 ** 3
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const HASH = /^[0-9a-f]{64}$/
export const TOKEN = /^[A-Za-z0-9_-]{43}$/
const text = new TextEncoder()
const string = new TextDecoder('utf-8', { fatal: true })
export const encode = (bytes) => btoa(Array.from(new Uint8Array(bytes), (b) => String.fromCharCode(b)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
export function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid encoding')
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
  if (encode(bytes) !== value) throw new Error('Invalid encoding')
  return bytes
}
export const randomToken = () => encode(crypto.getRandomValues(new Uint8Array(32)))
export const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) => v.toString(16).padStart(2, '0')).join('')
export const tokenHash = (value) => digest(text.encode(value))
export function signalKey(secret) {
  if (!TOKEN.test(secret)) throw new Error('Invalid invitation secret')
  return crypto.subtle.importKey('raw', decode(secret), 'AES-GCM', false, ['encrypt', 'decrypt'])
}
export async function seal(key, context, value) {
  const bytes = text.encode(JSON.stringify(value))
  if (bytes.length > 128 * 1024) throw new Error('Signaling message too large')
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: text.encode(JSON.stringify([VERSION, ...context])) }, key, bytes)
  return { iv: encode(iv), data: encode(data) }
}
export async function open(key, context, envelope) {
  if (!envelope || typeof envelope.data !== 'string' || envelope.data.length > MAX_SIGNAL || typeof envelope.iv !== 'string' || envelope.iv.length !== 16) throw new Error('Invalid signaling envelope')
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(envelope.iv), additionalData: text.encode(JSON.stringify([VERSION, ...context])) }, key, decode(envelope.data))
  return JSON.parse(string.decode(bytes))
}
function validInvite(value) {
  if (!value || !UUID.test(value.room) || !TOKEN.test(value.token) || !TOKEN.test(value.secret) || !/^\/(?:head\/)?[a-z0-9-]+\/$/.test(value.app)) throw new Error('Invalid invitation')
  decode(value.token); decode(value.secret)
  return { room: value.room, token: value.token, secret: value.secret, app: value.app }
}
export function inviteURL(url, invite) {
  const out = new URL(url)
  const fragment = new URLSearchParams(out.hash.slice(1))
  fragment.set('pg-session', encode(text.encode(JSON.stringify(validInvite(invite)))))
  out.hash = fragment.toString()
  return out.href
}
export function readInvite(url) {
  const value = new URLSearchParams(new URL(url).hash.slice(1)).get('pg-session')
  if (value === null) return null
  if (value.length > 2048) throw new Error('Invalid invitation')
  return validInvite(JSON.parse(string.decode(decode(value))))
}
export const assetId = (size, hashes) => digest(text.encode(JSON.stringify([VERSION, CHUNK_SIZE, size, hashes])))
export async function validateManifest(files) {
  if (!Array.isArray(files) || files.length > 256 || JSON.stringify(files).length > MAX_MANIFEST) throw new Error('File list is too large')
  const ids = new Set()
  let total = 0
  for (const f of files) {
    if (!f || typeof f.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(f.id) || ids.has(f.id)) throw new Error('Invalid file ID')
    ids.add(f.id)
    if (typeof f.name !== 'string' || !f.name.trim() || f.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(f.name) || ['.', '..'].includes(f.name)) throw new Error('Invalid file name')
    if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > MAX_FILE || (total += f.size) > MAX_TOTAL) throw new Error('File size exceeds session limits')
    if (!Array.isArray(f.hashes) || f.hashes.length !== Math.ceil(f.size / CHUNK_SIZE) || !f.hashes.every((h) => typeof h === 'string' && HASH.test(h))) throw new Error('Invalid chunk hashes')
    if (typeof f.asset !== 'string' || !HASH.test(f.asset) || f.asset !== await assetId(f.size, f.hashes)) throw new Error('Invalid asset hash')
  }
  return files
}
