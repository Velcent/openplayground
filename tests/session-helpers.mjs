import { sessionServer } from '../scripts/session-server.mjs'
import { GPU, launch } from './helpers.mjs'

export async function sessionSite({ publicDir, gpu = false } = {}) {
  if (process.env.SESSION_RELAY === '1' && (!process.env.TURN_KEY_ID || !process.env.TURN_API_TOKEN)) throw new Error('Forced relay requires TURN_KEY_ID and TURN_API_TOKEN')
  const { url, worker, server } = await sessionServer({ publicDir })
  const browser = await launch(gpu ? GPU : [])
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
