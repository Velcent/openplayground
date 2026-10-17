// Playground with live sessions on, locally: the session Worker (Miniflare, SESSIONS_ENABLED) behind a Vite dev
// server whose public folder holds the app builds. TURN_KEY_ID/TURN_API_TOKEN in the environment turn the relay on.
// Used by the browser tests (tests/session-helpers.mjs) and by `npm run live` (scripts/live-dev.mjs).
import { readFileSync } from 'node:fs'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { createServer } from 'vite'

export async function sessionServer({ publicDir, port = 0 } = {}) {
  const worker = new Miniflare(convertV4MiniflareOptions({ name: 'sessions-e2e', modules: ['worker.js', 'session-room.js', 'shell/session-protocol.js'].map(path => ({ type: 'ESModule', path, contents: readFileSync(path, 'utf8') })), compatibilityDate: '2026-10-01',
    bindings: { SESSIONS_ENABLED: 'true', TURN_KEY_ID: process.env.TURN_KEY_ID ?? '', TURN_API_TOKEN: process.env.TURN_API_TOKEN ?? '' }, durableObjects: { ROOMS: { className: 'SessionRoom', useSQLite: true } },
    ratelimits: { SESSION_LIMITER: { namespace_id: '1001', simple: { limit: 1000, period: 60 } } },
    serviceBindings: { ASSETS: () => new Response('missing', { status: 404 }) },
  }))
  const server = await createServer({ logLevel: 'error', ...(publicDir && { publicDir }), server: { port, strictPort: port !== 0, proxy: { '/api/session/': { target: (await worker.ready).origin, ws: true, changeOrigin: false } } } })
  await server.listen()
  const url = `http://localhost:${server.httpServer.address().port}`
  return { url, worker, server, async close() { await server.close(); await worker.dispose() } }
}
