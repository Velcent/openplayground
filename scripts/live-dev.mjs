// Try live sessions on this computer: `npm run live` (with the relay: `node --env-file=.dev.vars scripts/live-dev.mjs`).
// Serves the patched app builds in $LIVE_PUBLIC (default ~/.cache/live-e2e-public, where scripts/live-overlay.mjs
// installs them) with sessions on. Open an app in two browser profiles (a normal and a private window): each keeps
// its own session storage.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sessionServer } from './session-server.mjs'

const publicDir = process.env.LIVE_PUBLIC ?? join(homedir(), '.cache', 'live-e2e-public')
if (!existsSync(publicDir)) throw new Error(`No app builds in ${publicDir}: install some with scripts/live-overlay.mjs`)
const { url } = await sessionServer({ publicDir, port: Number(process.env.PORT ?? 5180) })
console.log(`Live sessions on at ${url}${process.env.TURN_KEY_ID ? ' (relay on)' : ''}. Apps:`)
for (const f of readdirSync(publicDir).filter((f) => f.endsWith('.ok')).sort()) console.log(`  ${f.slice(0, -3).padEnd(18)} ${url}${readFileSync(join(publicDir, f), 'utf8').trim()}`)
