import { CHUNK_SIZE, FRAME_SIZE, HASH, MAX_FILES, MAX_MANIFEST, MAX_SIGNAL, pack, unpack, randomToken, tokenHash, signalKey, seal, open, readInvite, inviteURL, validateManifest } from './session-protocol.js'
import { NO_SPACE, SessionStore, describe } from './session-store.js'
import { MAX_DOCUMENT } from './document-delta.js'

const cleanName = (name) => String(name || 'Guest').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 40)
// The app this page runs (its Playground path): a session spans apps, and each person says which one they are in.
const APP_PATH = /^\/(?:head\/)?[a-z0-9-]+\/$/
let page = null
export const setPage = (path) => { page = APP_PATH.test(path) ? path : null }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Document messages by sender: the owner's snapshots (a document and its retained history, see document-history.js),
// an editor's proposal to the owner (a delta's two spans), anything else small (a resync).
const MAX_SNAPSHOT = 3 * MAX_DOCUMENT + 8 * 1024 ** 2, MAX_CONTROL = 64 * 1024
// Hashes (or asset IDs) per files-channel message: 67 characters each in JSON, under its 32 KiB limit.
const PART = 400
async function request(room, action, data, token) {
  const response = await fetch(`/api/session/${room}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data), cache: 'no-store' })
  const result = await response.json()
  if (!response.ok) throw Object.assign(new Error(result.error || 'Session request failed'), { status: response.status })
  return result
}

export class PeerSession extends EventTarget {
  // This person's own choice to connect through the relay only (the owner can also require it for everyone).
  static preferRelay = false
  get relayOnly() { return this.relayRequired === true || PeerSession.preferRelay }
  static async restore(room) {
    const config = await new SessionStore(room).connection()
    if (!config || config.room !== room) throw new Error('Local session unavailable')
    const session = new PeerSession(config)
    session.files = await session.store.manifest()
    session.stopped = true; session.status = 'left'
    for (const f of new Map(session.files.map(f=>[f.asset,f])).values()) {
      const missing = await session.store.missing(f.asset)
      session.progress.total += f.size
      session.progress.received += f.size - missing.reduce((n,i)=>n+Math.min(CHUNK_SIZE,f.size-i*CHUNK_SIZE),0)
      if (!missing.length) { await session.store.finish(f.asset); session.available.add(f.asset) }
    }
    return session
  }
  static async create({ app, name, files = [] }) {
    const config = { room: crypto.randomUUID(), app, secret: randomToken(), owner: randomToken(), editor: randomToken(), viewer: randomToken(), name: cleanName(name), accepted: true }
    const member = await request(config.room, 'create', { app, owner: await tokenHash(config.owner), editor: await tokenHash(config.editor), viewer: await tokenHash(config.viewer) })
    const session = new PeerSession({ ...config, ...member })
    await session.share(files)
    try { await session.connect() } catch(e) { session.leave(); throw e }
    return session
  }
  static async join(invite, { name } = {}) {
    const info = typeof invite === 'string' ? readInvite(invite) : invite
    if (!info) throw new Error('Invalid invitation')
    const store = new SessionStore(info.room)
    const previous = await store.connection()
    const member = previous?.secret === info.secret ? previous : await request(info.room, 'join', { token: info.token })
    if (member.app !== info.app) throw new Error('This invitation is for another app')
    const session = new PeerSession({ ...member, room: info.room, secret: info.secret, name: cleanName(name || member.name) })
    session.files = await session.store.manifest()
    try { await session.connect() } catch(e) { session.leave(); throw e }
    return session
  }
  constructor(config) {
    super()
    this.config = config
    this.id = config.id; this.room = config.room; this.role = config.role; this.name = config.name; this.page = page
    this.store = new SessionStore(config.room)
    this.peers = new Map(); this.members = []; this.files = []; this.fileQueue = Promise.resolve(); this.status = 'connecting'; this.progress = { received: 0, total: 0 }
    this.accepted = !!config.accepted
    this.seq = 0; this.epoch = 0; this.generation = null; this.signalQueue = Promise.resolve(); this.downloads = []
    this.stopped = false; this.requested = null; this.ice = null; this.error = null; this.available = new Set(); this.wanted = new Set()
  }
  changed() { this.dispatchEvent(new Event('change')) }
  fail(error) { if (this.stopped) return; this.error = error.message || 'Peer authentication failed'; this.status = 'failed'; this.changed() }
  async remember() { await this.store.connection({ ...this.config, role: this.role, name: this.name, accepted: this.accepted }) }
  invite(role = 'editor') {
    if (!this.config.owner || !['editor', 'viewer'].includes(role)) throw new Error('Only the owner can create invitations')
    // The link opens the app the inviter is in now; the room keeps the app it was started in as its identity.
    return inviteURL(new URL(this.page ?? this.config.app, location.origin), { room: this.room, app: this.config.app, secret: this.config.secret, token: this.config[role] })
  }
  async admin(action) {
    if (!this.config.owner) throw new Error('Only the owner can manage this session')
    const data = { ...action }
    let editor, viewer
    if (action.remove) {
      editor = randomToken(); viewer = randomToken()
      data.editor = await tokenHash(editor); data.viewer = await tokenHash(viewer)
    }
    await request(this.room, 'admin', data, this.config.owner)
    if (editor) { this.config.editor = editor; this.config.viewer = viewer; await this.remember() }
  }
  async relay() {
    if (this.ice && this.ice.expires > Date.now() + 90000) return this.ice.iceServers
    try {
      this.ice = await request(this.room, 'turn', { id: this.id }, this.config.token)
      this.relayWarning = null
    } catch (e) {
      if (e.status === 403) throw e
      this.relayWarning = `${e.message}. Direct connections only.`
      // A public address from STUN still lets browsers behind most home routers meet directly; local addresses alone
      // often can't (Chrome hides them behind .local names that other machines, or Linux without mDNS, can't resolve).
      this.ice = { iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }], expires: Date.now() + 60000 }
    }
    this.changed()
    return this.ice.iceServers
  }
  async connect() {
    this.stopped = false; this.error = null; clearTimeout(this.reconnectTimer)
    this.key ??= await signalKey(this.config.secret)
    await this.remember()
    return new Promise((resolve, reject) => {
      let settled = false
      const url = new URL(`/api/session/${this.room}/socket`, location.origin); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = this.ws = new WebSocket(url)
      const timer = setTimeout(() => { if (!settled) { settled = true; ws.close(); reject(new Error('Session connection timed out')) } }, 15000)
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', id: this.id, token: this.config.token, page: this.page }))
      let incoming = Promise.resolve()
      ws.onmessage = (event) => {
        if (event.data === 'pong') return
        incoming = incoming.then(async () => {
          if (ws !== this.ws || typeof event.data !== 'string' || event.data.length > MAX_SIGNAL) return
          const message = JSON.parse(event.data)
          if (message.type === 'roster') {
            const me = message.peers.find((p) => p.id === this.id)
            if (!me || message.app !== this.config.app) throw new Error('Session identity or app mismatch')
            this.epoch = message.epoch; this.generation = me.generation; this.role = me.role; this.locked = message.locked; this.since = me.since
            this.relayRequired = message.relay === true
            this.members = message.members ?? []
            if (this.config.names) for (const id of Object.keys(this.config.names)) if (!this.members.some(m => m.id === id)) delete this.config.names[id]
            if (!settled) {
              this.seq = 0
              this.status = this.accepted ? 'syncing' : 'awaiting acceptance'
              await this.relay()
              clearTimeout(timer); settled = true; resolve(this)
              clearInterval(this.heartbeat)
              this.heartbeat = setInterval(() => {
                if (ws.readyState !== WebSocket.OPEN) return
                ws.send('ping')
                if (this.ice?.expires < Date.now() + 90000) this.refreshRelay().catch((e) => this.fail(e))
              }, 30000)
            }
            for (const [id, peer] of this.peers) if (!message.peers.some((p) => p.id === id && p.generation === peer.generation && p.role === peer.role)) this.drop(id)
            for (const p of message.peers) if (p.id !== this.id && !this.peers.has(p.id)) await this.addPeer(p)
            await this.remember()
            if (this.accepted) await this.prepareDownloads()
            this.changed()
          } else if (message.type === 'signal') await this.signal(message)
        }).catch((e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e) }; this.fail(e) })
      }
      ws.onclose = (event) => {
        if (ws !== this.ws) return
        clearTimeout(timer); clearInterval(this.heartbeat)
        for (const id of [...this.peers.keys()]) this.drop(id)
        if (this.stopped) return
        const end = { 4003: ['removed', 'Access was removed or expired.'], 4004: ['displaced', 'This session opened in another tab.'], 4005: ['ended', 'This session has ended: nobody had it open for 30 days.'] }[event.code]
        if (end) {
          this.status = end[0]; this.error = `${end[1]} Your local copies are still available.`
          this.stopped = true
          if (!settled) reject(new Error(this.error))
        } else {
          this.status = 'reconnecting'
          this.reconnectTimer = setTimeout(() => this.connect().catch((e) => this.fail(e)), 1500)
          if (!settled) { settled = true; reject(new Error('Connection interrupted')) }
        }
        this.changed()
      }
      ws.onerror = () => { this.error = 'Cannot reach the session service'; this.changed() }
    })
  }
  async refreshRelay() {
    if (this.refreshing) return
    this.refreshing = true
    try {
      const iceServers = await this.relay()
      for (const [id, peer] of this.peers) {
        peer.pc.setConfiguration({ iceServers, iceTransportPolicy: this.relayOnly ? 'relay' : 'all' })
        if (this.id < id) peer.pc.restartIce()
      }
    } finally { this.refreshing = false }
  }
  drop(id) {
    const peer = this.peers.get(id)
    if (!peer) return
    this.peers.delete(id); peer.pc.close()
    if (this.requested?.peer === id) this.requested = null
    this.changed()
  }
  async addPeer(info) {
    const pc = new RTCPeerConnection({ iceServers: this.ice?.iceServers ?? [], iceTransportPolicy: this.relayOnly ? 'relay' : 'all' })
    const peer = { ...info, pc, name: 'Connecting…', inventory: new Set(), seq: 0, candidates: [], sends: Promise.resolve(), incoming: Promise.resolve(), progress: null, pending: 0 }
    this.peers.set(info.id, peer)
    await this.sendSignal(peer, { hello: true })
    pc.onicecandidate = (event) => { if (event.candidate) this.sendSignal(peer, { candidate: event.candidate.toJSON() }) }
    pc.onnegotiationneeded = async () => {
      if (this.id > peer.id || pc.signalingState !== 'stable') return
      try {
        await pc.setLocalDescription(await pc.createOffer())
        await this.sendSignal(peer, { description: pc.localDescription.toJSON() })
      } catch (e) { if (this.peers.get(peer.id) === peer) this.fail(e) }
    }
    // Still not connected after a while: say why it may be, rather than show "Connecting…" for good.
    const stuck = `Can't reach the other browser yet.${this.relayWarning ? this.relayOnly ? ' Connections go through the relay only, and the relay is unavailable.' : ' The encrypted relay is off, and this network may not allow a direct connection.' : ''}`
    setTimeout(() => {
      if (this.peers.get(peer.id) !== peer || ['connected', 'closed'].includes(pc.connectionState)) return
      this.error = stuck; this.changed()
    }, 20000)
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected' && this.error === stuck) this.error = null
      if (pc.connectionState === 'failed' && this.peers.get(peer.id) === peer) {
        this.error = `Connection to ${peer.name} failed${this.relayWarning ? ': relay unavailable' : ''}`
        if (this.requested?.peer === peer.id) this.requested = null
        this.pump().catch((e) => this.fail(e))
      }
      this.changed()
    }
    pc.ondatachannel = (e) => e.channel.label === 'document' ? this.documentChannel(peer, e.channel) : this.channel(peer, e.channel)
    if (this.id < peer.id) {
      this.channel(peer, pc.createDataChannel('files', { ordered: true }))
      this.documentChannel(peer, pc.createDataChannel('document', { ordered: true }))
    }
  }
  sendSignal(peer, value) {
    this.signalQueue = this.signalQueue.then(async () => {
      if (this.peers.get(peer.id) !== peer || this.ws.readyState !== WebSocket.OPEN) return
      const seq = ++this.seq, ws = this.ws, epoch = this.epoch, generation = this.generation
      const envelope = await seal(this.key, [this.room, epoch, this.id, generation, peer.id, peer.generation, seq], value)
      if (ws === this.ws && epoch === this.epoch && generation === this.generation && ws.readyState === WebSocket.OPEN && this.peers.get(peer.id) === peer) ws.send(JSON.stringify({ type: 'signal', to: peer.id, generation: peer.generation, seq, envelope }))
    }).catch((e) => this.fail(e))
    return this.signalQueue
  }
  async signal(message) {
    const peer = this.peers.get(message.from)
    if (!peer || peer.generation !== message.generation || message.epoch !== this.epoch || !Number.isSafeInteger(message.seq) || message.seq <= peer.seq) return
    let value
    try { value = await open(this.key, [this.room, this.epoch, peer.id, peer.generation, this.id, this.generation, message.seq], message.envelope) }
    catch {
      peer.error = 'Peer authentication failed. Check the invitation link.'; peer.pc.close()
      this.error = peer.error
      if (!this.accepted) this.status = 'failed'
      this.changed(); return
    }
    peer.seq = message.seq
    if (value.hello === true) return
    if (value.description) {
      if (!['offer', 'answer'].includes(value.description.type)) throw new Error('Invalid peer description')
      await peer.pc.setRemoteDescription(value.description)
      for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate)
      if (value.description.type === 'offer') {
        await peer.pc.setLocalDescription(await peer.pc.createAnswer())
        await this.sendSignal(peer, { description: peer.pc.localDescription.toJSON() })
      }
    } else if (value.candidate) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(value.candidate)
      else if (peer.candidates.length < 64) peer.candidates.push(value.candidate)
      else throw new Error('Too many ICE candidates')
    }
  }
  channel(peer, channel) {
    if (peer.channel || channel.label !== 'files') { channel.close(); return }
    peer.channel = channel; channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = 65536
    channel.onopen = () => {
      this.send(peer, { type: 'hello', name: this.name, page: this.page }).then(() => this.announce(peer)).catch((e) => this.fail(e))
      this.changed()
    }
    channel.onmessage = (event) => {
      const size = typeof event.data === 'string' ? event.data.length : event.data.byteLength
      if (size > 32768 || ++peer.pending > 64) { peer.error = 'Peer exceeded the transfer buffer'; channel.close(); return }
      peer.incoming = peer.incoming.then(() => this.message(peer, event.data)).catch((e) => {
        peer.error = e.message; channel.close(); this.error = e.message
        if (this.requested?.peer === peer.id) this.requested = null
        this.changed(); this.pump().catch((e) => this.fail(e))
      }).finally(() => { peer.pending-- })
    }
    channel.onclose = () => { if (this.requested?.peer === peer.id) this.requested = null; this.changed(); this.pump().catch((e) => this.fail(e)) }
  }
  async raw(peer, data, channel = peer.channel) {
    if (channel?.readyState !== 'open') throw new Error('Peer disconnected')
    // Stalled: no byte has left for a minute. Time counts from the last progress, not from the start: a relayed link
    // drains a large message in bursts, with pauses of half a minute between them.
    let deadline = Date.now() + 60000, left = channel.bufferedAmount
    while (channel.bufferedAmount > 262144) {
      if (channel.bufferedAmount < left) { left = channel.bufferedAmount; deadline = Date.now() + 60000 }
      if (channel.readyState !== 'open' || Date.now() > deadline) throw new Error('Transfer stalled; reconnect to resume')
      await sleep(10)
    }
    channel.send(data)
  }
  // Live document traffic has its own ordered channel, so bulk file transfers never hold it up. Each message is a
  // short {size} string, then its packed bytes (session-protocol.js) as binary frames.
  documentChannel(peer, channel) {
    if (peer.document) { channel.close(); return }
    peer.document = channel; peer.documentSends = Promise.resolve(); peer.documentIn = null; channel.binaryType = 'arraybuffer'
    const event = (type, detail) => this.dispatchEvent(Object.assign(new Event(type), detail))
    channel.onopen = () => event('document-open', { peer })
    channel.onclose = () => event('document-close', { peer })
    channel.onmessage = ({ data }) => {
      if (this.peers.get(peer.id) !== peer) return
      try {
        const message = this.documentFrame(peer, data)
        if (message) event('document', { peer, ...message })
      } catch (e) { peer.error = e.message; channel.close() }
    }
  }
  documentFrame(peer, data) {
    const incoming = peer.documentIn
    if (typeof data === 'string') {
      const size = data.length < 64 && JSON.parse(data).size
      // Owners and editors may host an app's document (snapshots, records); viewers only ever send small messages.
      const limit = peer.role === 'viewer' ? MAX_CONTROL : MAX_SNAPSHOT
      if (incoming || !Number.isSafeInteger(size) || size < 4 || size > limit) throw new Error('Invalid document message')
      peer.documentIn = { size, frames: [], used: 0 }
      return
    }
    if (!incoming || data.byteLength > FRAME_SIZE || incoming.used + data.byteLength > incoming.size) throw new Error('Unsolicited document data')
    incoming.frames.push(new Uint8Array(data)); incoming.used += data.byteLength
    if (incoming.used < incoming.size) return
    peer.documentIn = null
    const bytes = new Uint8Array(incoming.size)
    incoming.frames.reduce((at, frame) => (bytes.set(frame, at), at + frame.length), 0)
    return { value: unpack(bytes) }
  }
  sendDocument(peer, value) {
    const bytes = pack(value)
    if (bytes.length > MAX_SNAPSHOT) return Promise.reject(new Error('Document message too large'))
    const channel = peer.document
    if (!channel) return Promise.reject(new Error('Peer disconnected'))
    peer.documentSends = peer.documentSends.catch(() => {}).then(async () => {
      try {
        await this.raw(peer, JSON.stringify({ size: bytes.length }), channel)
        for (let i = 0; i < bytes.length; i += FRAME_SIZE) await this.raw(peer, bytes.subarray(i, i + FRAME_SIZE), channel)
      } catch (e) { channel.close(); throw e } // A half-sent message would desynchronize the receiver.
    })
    return peer.documentSends
  }
  send(peer, value) {
    const data = JSON.stringify(value)
    if (data.length > 32768) return Promise.reject(new Error('Control message too large'))
    peer.sends = peer.sends.then(() => this.raw(peer, data))
    return peer.sends
  }
  announce(peer) {
    peer.announcing = (peer.announcing ?? Promise.resolve()).then(async () => {
      // The whole list once, then only files added since: the other side merges what it gets.
      const files = this.role === 'viewer' ? [] : this.files.filter((f) => !peer.announced?.has(f.id))
      if (this.role !== 'viewer' && (files.length || !peer.announced)) {
        const value = JSON.stringify(files)
        await this.send(peer, { type: 'manifest', length: value.length })
        for (let i = 0; i < value.length; i += 8000) await this.send(peer, { type: 'manifest-part', text: value.slice(i, i + 8000) })
        await this.send(peer, { type: 'manifest-end' })
        peer.announced = new Set([...peer.announced ?? [], ...files.map((f) => f.id)])
      }
      await this.report(peer)
    })
    return peer.announcing
  }
  mergeFiles(files, persist = this.accepted || this.wanted.size > 0) {
    const merged = this.fileQueue.then(async () => {
      const entries = new Map(this.files.map(f => [f.id, f]))
      for (const f of await validateManifest(files)) {
        const old = entries.get(f.id)
        if (old && (old.asset !== f.asset || old.name !== f.name)) {
          // Live media go to whoever shares them first; a second version is ignored, not a broken file list.
          if (f.id.startsWith('live-')) continue
          throw new Error('Conflicting file version')
        }
        entries.set(f.id, f)
      }
      const next = await validateManifest([...entries.values()])
      this.files = persist ? await this.store.saveManifest(next) : next
      if ((this.accepted || this.wanted.size) && !this.stopped) { this.scanDownloads = true; this.status = 'syncing' }
    })
    this.fileQueue = merged.catch(() => {})
    return merged
  }
  async message(peer, data) {
    if (this.peers.get(peer.id) !== peer) return
    if (data instanceof ArrayBuffer) {
      const chunk = peer.chunk
      if (!chunk || data.byteLength > FRAME_SIZE || chunk.used + data.byteLength > chunk.bytes.length || this.requested?.peer !== peer.id) throw new Error('Unsolicited asset data')
      chunk.bytes.set(new Uint8Array(data), chunk.used); chunk.used += data.byteLength
      if (chunk.used === chunk.bytes.length) {
        await this.store.putChunk(chunk.asset, chunk.index, chunk.bytes)
        const job = this.downloads.find((d) => d.asset === chunk.asset)
        job.at++; this.progress.received += chunk.bytes.length; peer.chunk = null; this.requested = null
        clearTimeout(this.chunkTimer)
        if (job.at === job.indices.length) this.available.add(chunk.asset)
        await this.send(peer, { type: 'ack', asset: chunk.asset, index: chunk.index })
        this.changed(); await this.pump()
      }
      return
    }
    if (typeof data !== 'string' || data.length > 32768) throw new Error('Invalid control message')
    const value = JSON.parse(data)
    if (value.type === 'hello') {
      peer.name = cleanName(value.name)
      peer.page = APP_PATH.test(value.page) ? value.page : null
      if (this.config.owner) { (this.config.names ??= {})[peer.id] = peer.name; await this.remember() }
      this.changed()
    }
    else if (value.type === 'manifest') {
      if (peer.role === 'viewer' || !Number.isSafeInteger(value.length) || value.length < 2 || value.length > MAX_MANIFEST || peer.manifest !== undefined) throw new Error('Unauthorized file list')
      peer.manifest = ''; peer.manifestSize = value.length
    } else if (value.type === 'manifest-part') {
      if (peer.manifest === undefined || typeof value.text !== 'string' || peer.manifest.length + value.text.length > peer.manifestSize) throw new Error('Invalid file list fragment')
      peer.manifest += value.text
    } else if (value.type === 'manifest-end') {
      if (peer.role === 'viewer' || peer.manifest?.length !== peer.manifestSize) throw new Error('Incomplete file list')
      const incoming = JSON.parse(peer.manifest); delete peer.manifest
      await this.mergeFiles(incoming)
      if (this.accepted) await this.prepareDownloads()
      this.changed()
    } else if (value.type === 'inventory') {
      // A whole inventory in parts (`more` until the last), or later additions to it (`add`).
      if (!Array.isArray(value.assets) || value.assets.length > PART || !value.assets.every((a) => typeof a === 'string' && HASH.test(a)) || (value.add && !peer.inventoryKnown)) throw new Error('Invalid inventory')
      const into = value.add ? peer.inventory : (peer.inventoryIn ??= new Set())
      for (const a of value.assets) into.add(a)
      if (into.size > MAX_FILES) throw new Error('Invalid inventory')
      if (value.more) return
      if (!value.add) { peer.inventory = into; peer.inventoryIn = null; peer.inventoryKnown = true }
      await this.pump()
    } else if (value.type === 'want-hashes') {
      const hashes = await this.store.hashes(value.asset)
      if (!hashes || !Number.isSafeInteger(value.at) || value.at < 0 || value.at >= hashes.length) throw new Error('Invalid hash request')
      await this.send(peer, { type: 'hashes', asset: value.asset, at: value.at, hashes: hashes.slice(value.at, value.at + PART) })
    } else if (value.type === 'hashes') {
      const expected = this.requested, entry = this.files.find((f) => f.asset === value.asset)
      if (!expected?.list || expected.peer !== peer.id || expected.asset !== value.asset || expected.list.length !== value.at || !Array.isArray(value.hashes) || !value.hashes.length || value.hashes.length > PART || !value.hashes.every((h) => typeof h === 'string' && HASH.test(h))) throw new Error('Unexpected chunk hashes')
      expected.list.push(...value.hashes)
      if (expected.list.length < Math.ceil(entry.size / CHUNK_SIZE)) return this.ask(peer, expected, { type: 'want-hashes', asset: value.asset, at: expected.list.length })
      await this.store.putHashes(value.asset, expected.list) // A list that does not hash to the asset ID throws.
      clearTimeout(this.chunkTimer); this.requested = null
      await this.pump()
    } else if (value.type === 'want') {
      if (peer.sending || !Number.isInteger(value.index)) throw new Error('Invalid asset request')
      const data = await this.store.chunk(value.asset, value.index)
      if (data.size > CHUNK_SIZE) throw new Error('Asset chunk too large')
      peer.sending = { asset: value.asset, index: value.index }
      await this.send(peer, { type: 'chunk', ...peer.sending, size: data.size })
      for (let i = 0; i < data.size; i += FRAME_SIZE) {
        const bytes = await data.slice(i, i + FRAME_SIZE).arrayBuffer()
        peer.sends = peer.sends.then(() => this.raw(peer, bytes)); await peer.sends
      }
    } else if (value.type === 'chunk') {
      const expected = this.requested, entry = this.files.find((f) => f.asset === value.asset)
      if (peer.chunk || !expected || expected.peer !== peer.id || expected.asset !== value.asset || expected.index !== value.index || !entry || value.size !== Math.min(CHUNK_SIZE, entry.size - value.index * CHUNK_SIZE)) throw new Error('Unexpected asset chunk')
      peer.chunk = { asset: value.asset, index: value.index, bytes: new Uint8Array(value.size), used: 0 }
    } else if (value.type === 'ack') {
      if (!peer.sending || peer.sending.asset !== value.asset || peer.sending.index !== value.index) throw new Error('Invalid transfer acknowledgement')
      peer.sending = null
    } else if (value.type === 'progress') {
      if (!Number.isSafeInteger(value.received) || !Number.isSafeInteger(value.total) || value.received < 0 || value.received > value.total) throw new Error('Invalid progress')
      peer.progress = { received: value.received, total: value.total, status: String(value.status).slice(0, 40) }; this.changed()
    } else throw new Error('Unknown session message')
  }
  async share(files, ids = []) {
    if (this.role === 'viewer') throw new Error('Viewers cannot share or replace files')
    for (const [i, file] of files.entries()) {
      const entry = await describe(file, ids[i])
      await this.mergeFiles([entry], true)
      for (let i = 0; i < entry.hashes.length; i++) await this.store.putChunk(entry.asset, i, new Uint8Array(await file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).arrayBuffer()))
    }
    this.accepted = true
    await this.prepareDownloads()
    for (const peer of this.peers.values()) if (peer.channel?.readyState === 'open') await this.announce(peer)
    await this.remember()
  }
  async receive() {
    await this.mergeFiles([], true)
    this.accepted = true; this.config.accepted = true
    await this.remember(); await this.prepareDownloads()
  }
  // Downloads just these files (a live document's media) without accepting the session's other files.
  async receiveFiles(ids) {
    const before = this.wanted.size
    for (const id of ids) this.wanted.add(id)
    // The store verifies chunks against the saved file list, which a session not accepted yet does not keep.
    if (this.wanted.size > before) { await this.mergeFiles([], true); await this.prepareDownloads() }
  }
  async prepareDownloads() {
    this.scanDownloads = true
    await this.pump()
  }
  async report(peer) {
    // The whole inventory the first time (or when an asset went missing), then only what was added. Its parts are queued
    // together, so another report's never land between them.
    const now = new Set(this.available), told = peer.reportedAssets
    const full = !told || [...told].some((a) => !now.has(a)), assets = [...now].filter((a) => full || !told.has(a))
    if (full || assets.length) {
      peer.reportedAssets = now
      const parts = []
      for (let i = 0; i === 0 || i < assets.length; i += PART) parts.push(this.send(peer, { type: 'inventory', assets: assets.slice(i, i + PART), ...(full ? { more: i + PART < assets.length } : { add: true }) }))
      await Promise.all(parts)
    }
    const progress = JSON.stringify({ type: 'progress', ...this.progress, status: this.status })
    if (progress !== peer.reportedProgress && (this.status !== 'syncing' || Date.now() - (peer.reportedAt || 0) > 200)) {
      await this.send(peer, JSON.parse(progress))
      peer.reportedProgress = progress; peer.reportedAt = Date.now()
    }
  }
  async pump() {
    if (!(this.accepted || this.wanted.size) || this.stopped || this.requested || this.pumping || this.ws?.readyState !== WebSocket.OPEN) return
    this.pumping = true
    try {
      if (this.scanDownloads) {
        this.scanDownloads = false
        this.downloads = []; this.available.clear(); this.progress = { received: 0, total: 0 }
        for (const f of new Map(this.files.filter((f) => this.accepted || this.wanted.has(f.id)).map((f) => [f.asset, f])).values()) {
          const missing = await this.store.missing(f.asset)
          this.progress.total += f.size
          this.progress.received += f.size - missing.reduce((n, i) => n + Math.min(CHUNK_SIZE, f.size - i * CHUNK_SIZE), 0)
          if (missing.length) this.downloads.push({ asset: f.asset, indices: missing, at: 0 })
          else { await this.store.finish(f.asset); this.available.add(f.asset) }
        }
      }
      // A file no connected participant has must not hold up the ones queued after it.
      const holder = (asset) => [...this.peers.values()].find(p => p.channel?.readyState === 'open' && p.inventory.has(asset))
      const unfinished = this.downloads.filter((d) => d.at < d.indices.length)
      const job = unfinished.find((d) => holder(d.asset)) ?? unfinished[0]
      const source = job && holder(job.asset)
      const pending = [...this.peers.values()].some(p => !['closed','failed'].includes(p.pc.connectionState) && p.channel?.readyState !== 'closed' && !p.inventoryKnown)
      this.status = job || this.scanDownloads ? 'syncing' : this.accepted ? 'ready' : 'awaiting acceptance'
      const disconnected = this.peers.size && [...this.peers.values()].every(p => ['closed', 'failed'].includes(p.pc.connectionState) || p.channel?.readyState === 'closed')
      if (disconnected || (job && !source && !pending)) {
        this.status = 'failed'
        if (this.error !== NO_SPACE) this.error = 'No connected participant can send these files. Reconnect to retry; verified data is saved.'
      }
      for (const peer of this.peers.values()) if (peer.channel?.readyState === 'open') await this.report(peer)
      // A file's chunk hashes come first, in parts, from the participant that will send its chunks.
      if (job && source) {
        if (await this.store.hashes(job.asset)) await this.ask(source, { asset: job.asset, index: job.indices[job.at] }, { type: 'want', asset: job.asset, index: job.indices[job.at] })
        else await this.ask(source, { asset: job.asset, list: [] }, { type: 'want-hashes', asset: job.asset, at: 0 })
      }
      this.changed()
    } finally { this.pumping = false }
    if (this.scanDownloads && !this.requested) await this.pump()
  }
  // One request in flight, to one participant; when it goes unanswered, that channel closes so another can take over.
  ask(peer, request, message) {
    this.requested = { ...request, peer: peer.id }
    clearTimeout(this.chunkTimer)
    this.chunkTimer = setTimeout(() => {
      if (this.requested?.peer !== peer.id) return
      this.error = `Transfer from ${peer.name} stalled. Verified data is saved for retry.`
      peer.channel.close()
    }, 15000)
    return this.send(peer, message)
  }
  leave() {
    this.stopped = true; clearInterval(this.heartbeat); clearTimeout(this.reconnectTimer); clearTimeout(this.chunkTimer)
    this.ws?.close(1000, 'Left session')
    for (const id of [...this.peers.keys()]) this.drop(id)
    this.status = 'left'; this.changed()
  }
}
