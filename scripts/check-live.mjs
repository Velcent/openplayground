// Checks that each live-editing tool's diffs (and patch rules) still apply to what build.mjs would build now, on
// both channels: the same refs as `build.mjs facts`, the live template copied in first, then applyDiffs and the rules.
// No compile. Sources are cached under $LIVE_CHECK_DIR (default ~/.cache/live-check).
//   node scripts/check-live.mjs [slug...]
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, globSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { applyDiffs } from './diffs.mjs'
import { CHANNELS, resolveVersion, tools } from './releases.mjs'

const root = process.env.LIVE_CHECK_DIR ?? join(homedir(), '.cache', 'live-check')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const wanted = process.argv.slice(2)
let failed = 0
for (const t of tools.filter((t) => (t.live || t.slug === 'fl-studio-mobile') && (!wanted.length || wanted.includes(t.slug)))) {
  for (const channel of CHANNELS) {
    const version = await resolveVersion(t, channel)
    if (!version) { console.log(`${t.slug} ${channel}: no version`); continue }
    const ref = version.release.ref ?? version.release.tag_name
    const src = join(root, `${t.slug}-${channel}`)
    rmSync(src, { recursive: true, force: true })
    mkdirSync(src, { recursive: true })
    git(src, 'init', '--quiet')
    git(src, 'fetch', '--quiet', '--depth', '1', `https://github.com/${t.repo}.git`, version.release.ref ?? `refs/tags/${ref}`)
    git(src, 'checkout', '--quiet', 'FETCH_HEAD')
    try {
      if (t.live) cpSync(new URL('../patches/live/playground_live.rs', import.meta.url), join(src, t.live, 'playground_live.rs'))
      const merged = applyDiffs(src, t, channel)
      let bad = 0
      for (const rule of (t.patches && existsSync(t.patches) && parse(readFileSync(t.patches, 'utf8'))) || []) {
        const re = new RegExp(rule.find, 'm')
        if (!globSync(rule.file, { cwd: src }).some((f) => re.test(readFileSync(join(src, f), 'utf8')))) bad++
      }
      if (bad) throw new Error(`${bad} patch rule(s) no longer match`)
      console.log(`${t.slug} ${channel} (${ref}): ok${merged.length ? ` (upstream has ${merged.length})` : ''}`)
    } catch (e) {
      failed++
      console.log(`${t.slug} ${channel} (${ref}): FAILS — ${e.message.split('\n')[0]}`)
    }
  }
}
process.exitCode = failed ? 1 : 0
