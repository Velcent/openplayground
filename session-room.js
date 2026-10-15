import { DurableObject } from 'cloudflare:workers'
import { HASH, UUID, TOKEN, MAX_MEMBERS, MAX_SIGNAL, randomToken, tokenHash } from './shell/session-protocol.js'

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const error = (message, status) => json({ error: message }, status)
const bearer = (request) => request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
async function body(request) {
  const reader = request.body?.getReader()
  if (!reader) return {}
  let size = 0, chunks = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.length
    if (size > 16384) { await reader.cancel(); throw new RangeError('Request too large') }
    chunks.push(value)
  }
  return JSON.parse(await new Blob(chunks).text())
}

export async function sessionRequest(request, env) {
  if (env.SESSIONS_ENABLED !== 'true') return error('File sharing is not enabled yet', 503)
  const url = new URL(request.url)
  if (request.headers.get('origin') !== url.origin) return error('Origin not allowed', 403)
  const match = url.pathname.match(/^\/api\/session\/([^/]+)\/(create|join|socket|turn|admin)$/)
  if (!match || !UUID.test(match[1])) return error('Unknown session endpoint', 404)
  const allowed = await env.SESSION_LIMITER.limit({ key: request.headers.get('cf-connecting-ip') ?? 'local' })
  if (!allowed.success) return error('Too many session requests; try again shortly', 429)
  return env.ROOMS.getByName(match[1]).fetch(request)
}

export class SessionRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)')
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }
  load() { return JSON.parse(this.ctx.storage.sql.exec('SELECT value FROM room WHERE id=1').toArray()[0]?.value ?? 'null') }
  save(room) { this.ctx.storage.sql.exec('INSERT OR REPLACE INTO room(id, value) VALUES(1, ?)', JSON.stringify(room)) }
  sockets() { return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1) }
  roster() {
    const room = this.load()
    if (!room) return
    const peers = this.sockets().flatMap((ws) => {
      const a = ws.deserializeAttachment()
      const member = a.id && room.members[a.id]
      return member && a.epoch === room.epoch ? [{ id: a.id, role: member.role, generation: a.generation }] : []
    })
    const data = JSON.stringify({ type: 'roster', app: room.app, epoch: room.epoch, locked: room.locked, peers })
    for (const ws of this.sockets()) if (ws.deserializeAttachment().id) ws.send(data)
  }
  async fetch(request) {
    const action = new URL(request.url).pathname.split('/').pop()
    if (action === 'socket') {
      if (request.method !== 'GET' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return error('WebSocket required', 426)
      if (!this.load()) return error('Session unavailable', 404)
      if (this.sockets().length >= MAX_MEMBERS * 3) return error('Too many connections', 429)
      const { 0: client, 1: server } = new WebSocketPair()
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment({ deadline: Date.now() + 10000 })
      const alarm = await this.ctx.storage.getAlarm()
      if (!alarm) await this.ctx.storage.setAlarm(Date.now() + 10000)
      return new Response(null, { status: 101, webSocket: client })
    }
    if (request.method !== 'POST') return error('POST required', 405)
    try {
      const input = await body(request)
      if (!input || typeof input !== 'object' || Array.isArray(input)) return error('Invalid request', 400)
      const credential = action === 'join' ? input.token : bearer(request)
      const hash = TOKEN.test(credential) ? await tokenHash(credential) : null
      // Hash before reading room state: no awaits between checking capacity and writing a new member.
      const token = randomToken(), memberHash = await tokenHash(token)
      const room = this.load()
      if (action === 'create') {
        if (room) return error('Session already exists', 409)
        if (!/^\/(?:head\/)?[a-z0-9-]+\/$/.test(input.app) || /(?:outlook|mailcraft)/.test(input.app) || ![input.owner, input.editor, input.viewer].every((v) => typeof v === 'string' && HASH.test(v)) || new Set([input.owner, input.editor, input.viewer]).size !== 3) return error('Invalid room', 400)
        const id = crypto.randomUUID()
        this.save({ app: input.app, owner: input.owner, editor: input.editor, viewer: input.viewer, epoch: 1, locked: false, members: { [id]: { hash: memberHash, role: 'owner' } } })
        return json({ id, token, role: 'owner', app: input.app }, 201)
      }
      if (!room) return error('Session unavailable; someone with a local copy must reopen it', 404)
      if (action === 'join') {
        const role = hash && !room.locked && (hash === room.editor ? 'editor' : hash === room.viewer ? 'viewer' : null)
        if (!role) return error('Invitation is invalid or locked', 403)
        if (Object.keys(room.members).length >= MAX_MEMBERS) return error('This session is full', 409)
        const id = crypto.randomUUID()
        room.members[id] = { hash: memberHash, role }
        this.save(room)
        return json({ id, token, role, app: room.app }, 201)
      }
      if (action === 'admin') {
        if (!hash || hash !== room.owner) return error('Only the owner can manage this session', 403)
        if (typeof input.lock === 'boolean') room.locked = input.lock
        if (input.remove) {
          if (!room.members[input.remove] || room.members[input.remove].role === 'owner' || !HASH.test(input.editor) || !HASH.test(input.viewer) || input.editor === room.editor || input.viewer === room.viewer || new Set([input.editor, input.viewer, room.owner]).size !== 3) return error('Invalid removal or invitation rotation', 400)
          delete room.members[input.remove]
          room.editor = input.editor; room.viewer = input.viewer
        }
        if (input.member) {
          if (!room.members[input.member] || room.members[input.member].role === 'owner' || !['editor', 'viewer'].includes(input.role)) return error('Invalid role change', 400)
          room.members[input.member].role = input.role
        }
        room.epoch++
        this.save(room)
        for (const ws of this.sockets()) ws.close(4001, 'Membership changed; reconnect')
        return json({ epoch: room.epoch })
      }
      if (action === 'turn') {
        const member = room.members[input.id]
        if (!hash || !member || member.hash !== hash) return error('Member authentication required', 403)
        if (!this.sockets().some((ws) => ws.deserializeAttachment().id === input.id)) return error('Connect to the session first', 403)
        if (!this.env.TURN_KEY_ID || !this.env.TURN_API_TOKEN) return error('Encrypted relay has not been configured', 503)
        if (member.turnAt && Date.now() - member.turnAt < 60000) return error('Relay credentials requested too often', 429)
        member.turnAt = Date.now(); this.save(room)
        const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
          method: 'POST', headers: { authorization: `Bearer ${this.env.TURN_API_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 600 }), signal: AbortSignal.timeout(10000),
        })
        if (!response.ok) return error('Encrypted relay is temporarily unavailable', 502)
        const result = await response.json()
        if (!Array.isArray(result.iceServers)) return error('Invalid relay response', 502)
        return json({ iceServers: result.iceServers, expires: Date.now() + 600000 })
      }
      return error('Unknown action', 404)
    } catch (e) {
      if (e instanceof RangeError) return error('Request too large', 413)
      if (e instanceof SyntaxError) return error('Invalid JSON', 400)
      return error('Session request failed; local files are unchanged', 500)
    }
  }
  async webSocketMessage(ws, value) {
    try {
      if (typeof value !== 'string' || value.length > MAX_SIGNAL) return ws.close(1009, 'Message too large')
      const message = JSON.parse(value)
      let a = ws.deserializeAttachment()
      if (!a.id) {
        if (a.deadline < Date.now() || message.type !== 'auth' || !UUID.test(message.id) || !TOKEN.test(message.token)) return ws.close(4003, 'Authentication required')
        const hash = await tokenHash(message.token)
        const room = this.load(), member = room?.members[message.id]
        if (!member || member.hash !== hash) return ws.close(4003, 'Invalid membership')
        for (const old of this.sockets()) if (old !== ws && old.deserializeAttachment().id === message.id) old.close(4001, 'Reconnected elsewhere')
        a = { id: message.id, generation: crypto.randomUUID(), epoch: room.epoch, count: 0, window: Date.now(), seq: 0 }
        ws.serializeAttachment(a)
        this.roster()
        return
      }
      const room = this.load()
      if (!room?.members[a.id] || a.epoch !== room.epoch) return ws.close(4003, 'Membership expired')
      if (Date.now() - a.window > 10000) { a.window = Date.now(); a.count = 0 }
      if (++a.count > 120) return ws.close(4008, 'Too many signaling messages')
      if (message.type !== 'signal' || !UUID.test(message.to) || !UUID.test(message.generation) || !Number.isSafeInteger(message.seq) || message.seq <= a.seq || !message.envelope || typeof message.envelope.iv !== 'string' || message.envelope.iv.length !== 16 || typeof message.envelope.data !== 'string' || message.envelope.data.length > MAX_SIGNAL - 1024) return ws.close(4002, 'Invalid signal')
      a.seq = message.seq; ws.serializeAttachment(a)
      const destination = this.sockets().find((peer) => {
        const b = peer.deserializeAttachment()
        return b.id === message.to && b.generation === message.generation && b.epoch === room.epoch
      })
      destination?.send(JSON.stringify({ type: 'signal', from: a.id, generation: a.generation, epoch: room.epoch, seq: message.seq, envelope: { iv: message.envelope.iv, data: message.envelope.data } }))
    } catch { ws.close(4002, 'Invalid session message') }
  }
  webSocketClose(ws, code, reason) { ws.close(code, reason); this.roster() }
  webSocketError(ws) { ws.close(1011, 'Connection interrupted'); this.roster() }
  async alarm() {
    let next = Infinity
    for (const ws of this.sockets()) {
      const a = ws.deserializeAttachment()
      if (a.id) continue
      if (a.deadline <= Date.now()) ws.close(4003, 'Authentication timed out')
      else next = Math.min(next, a.deadline)
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next)
  }
}
