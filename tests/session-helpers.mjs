import { readFileSync } from 'node:fs'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { createServer } from 'vite'
import { launch } from './helpers.mjs'

export async function sessionSite() {
  if (process.env.SESSION_RELAY === '1' && (!process.env.TURN_KEY_ID || !process.env.TURN_API_TOKEN)) throw new Error('Forced relay requires TURN_KEY_ID and TURN_API_TOKEN')
  const worker = new Miniflare(convertV4MiniflareOptions({ name: 'sessions-e2e', modules: ['worker.js', 'session-room.js', 'shell/session-protocol.js'].map(path => ({ type: 'ESModule', path, contents: readFileSync(path, 'utf8') })), compatibilityDate: '2026-10-01',
    bindings: { SESSIONS_ENABLED: 'true', TURN_KEY_ID: process.env.TURN_KEY_ID ?? '', TURN_API_TOKEN: process.env.TURN_API_TOKEN ?? '' }, durableObjects: { ROOMS: { className: 'SessionRoom', useSQLite: true } },
    ratelimits: { SESSION_LIMITER: { namespace_id: '1001', simple: { limit: 1000, period: 60 } } },
    serviceBindings: { ASSETS: () => new Response('missing', { status: 404 }) },
  }))
  const server = await createServer({ logLevel: 'error', server: { port: 0, proxy: { '/api/session/': { target: (await worker.ready).origin, ws: true, changeOrigin: false } } } })
  await server.listen()
  const url = `http://localhost:${server.httpServer.address().port}`
  const browser = await launch()
  const pages = []
  return { url, browser, worker,
    async page() {
      const context = await browser.newContext()
      if (process.env.SESSION_RELAY === '1') await context.addInitScript(() => {
        const Native = RTCPeerConnection
        window.RTCPeerConnection = class extends Native {
          constructor(config) { super({ ...config, iceTransportPolicy: 'relay' }) }
          setConfiguration(config) { super.setConfiguration({ ...config, iceTransportPolicy: 'relay' }) }
        }
      })
      const page = await context.newPage()
      page.on('pageerror', (e) => console.error('session page error:', e.message))
      await page.goto(`${url}/shell/paths.js`)
      await page.evaluate(async () => { window.PeerSession = (await import('/shell/session.js').catch(() => ({}))).PeerSession })
      pages.push(page); return page
    },
    async close() { await browser.close(); await server.close(); await worker.dispose() },
  }
}
