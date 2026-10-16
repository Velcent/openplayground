// Installs a locally built app for tests/live-apps.e2e.test.mjs: copies its web dist into $LIVE_PUBLIC at the app's
// URL path, adds the shell (as fetch.mjs does for installed builds, without the prelude), keeps a gzip copy of each
// .wasm for loaders that fetch <name>.wasm.gz, and marks it ready.
//   LIVE_PUBLIC=~/.cache/live-e2e-public node scripts/live-overlay.mjs <slug> <dist> <url-path>
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const [slug, dist, path] = process.argv.slice(2)
const root = process.env.LIVE_PUBLIC
if (!root || !slug || !dist || !path?.startsWith('/')) throw new Error('usage: LIVE_PUBLIC=<dir> node scripts/live-overlay.mjs <slug> <dist> <url-path>')
const dir = join(root, path)
rmSync(dir, { recursive: true, force: true })
cpSync(dist, dir, { recursive: true, dereference: false })
const page = join(dir, 'index.html')
writeFileSync(page, readFileSync(page, 'utf8').replace(/<meta charset[^>]*>/i, (m) => `${m}\n  <link rel="stylesheet" href="/shell/shell.css">\n  <script type="module" src="/shell/app.js"></script>`))
for (const f of readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.wasm') && !existsSync(join(dir, `${f}.gz`)))) {
  writeFileSync(join(dir, `${f}.gz`), gzipSync(readFileSync(join(dir, f)), { level: 6 }))
}
writeFileSync(join(root, `${slug}.ok`), path)
console.log(`installed ${slug} at ${dir}`)
