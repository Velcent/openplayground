import { cpSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { defineConfig } from 'vite'
import { parse } from 'yaml'

// What `make fetch` installed of a tool on a channel (its .release stamp), and where it's served.
const installed = (t, channel) => {
  const path = channel === 'head' ? `/head/${t.slug}/` : `/${t.slug}/`
  try {
    return { path, ...JSON.parse(readFileSync(`public${path}.release`, 'utf8')) }
  } catch {}
}

// GitHub's mark (Octicons mark-github), linking each card to its repo.
const GITHUB = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'

// A card links to the release, and carries the latest-commit build's link, label and commit date for the
// channel switch (index.html). A tool missing one channel uses the other for both.
const card = (t) => {
  const repo = t.repo.split('/')[1]
  const release = installed(t, 'release')
  const head = installed(t, 'head') ?? release
  const shown = release ?? head
  const ahead = head.ahead ? `${head.ahead.commits} commit${head.ahead.commits === 1 ? '' : 's'} ahead of ${head.ahead.of}` : ''
  return `
      <div class="tool" data-release-href="${shown.path}" data-head-href="${head.path}" style="--accent:${t.accent};--base:${t.base}">
        <img src="/${t.icon}" alt="" width="64" height="64">
        <span class="title">
          <a class="name open" href="${shown.path}">${t.name}</a>
          <span class="source"><a class="repo" href="https://github.com/${t.repo}" aria-label="${repo} on GitHub" title="${t.repo} on GitHub">${GITHUB}</a> <span class="version" data-release="${shown.label}" data-head="${head.label}" data-date="${head.date ?? ''}" data-ahead="${ahead}">${shown.label}</span></span>
        </span>
        ${t.alternative ? `<span class="alt">${existsSync(`icons/alternatives/${t.slug}.svg`) ? `<img src="/icons/alternatives/${t.slug}.svg" alt="" width="14" height="14">` : ''}Alternative to ${t.alternative}</span>` : ''}
        <span class="blurb">${t.blurb}</span>
      </div>`
}

const group = (g) => `
    <section>
      <h2>${g.name}</h2>
      <div class="tools">${g.tools.map(card).join('')}
      </div>
    </section>`

// Read per request, so tools.yaml edits and `make fetch` show up on refresh. Only installed tools are
// listed (one whose first build isn't ready yet has nothing to open).
const renderGroups = () =>
  parse(readFileSync('tools.yaml', 'utf8'))
    .groups.map((g) => ({ ...g, tools: g.tools.filter((t) => installed(t, 'release') || installed(t, 'head')) }))
    .filter((g) => g.tools.length)
    .map(group)
    .join('')

// /shell/apps.json: what the shell's app switcher and file explorer list, from tools.yaml and the installed
// builds (the same stamps the dashboard reads). An app's icon is its install's site-icon (fetch.mjs copies it).
const appsJson = () => ({
  groups: parse(readFileSync('tools.yaml', 'utf8'))
    .groups.map((g) => ({
      name: g.name,
      apps: g.tools.flatMap((t) => {
        const release = installed(t, 'release')
        const head = installed(t, 'head')
        if (!release && !head) return []
        const channel = (s) => s && { path: s.path, label: s.label, date: s.date ?? null }
        return [{
          slug: t.slug, name: t.name, alternative: t.alternative ?? null, blurb: t.blurb, accent: t.accent, opens: t.opens ?? [], imports: t.imports ?? [],
          icon: `${(release ?? head).path}site-icon${extname(t.icon)}`,
          release: channel(release) ?? null, head: channel(head) ?? null,
        }]
      }),
    }))
    .filter((g) => g.apps.length),
})

// Vite doesn't serve index.html for public/ folders: /slug -> /slug/ -> /slug/index.html, like a static host would.
const toolIndex = (req, res, next) => {
  const [path, query = ''] = req.url.split(/(?=\?)/)
  if (path === '/' || !existsSync(`public${path.replace(/\/?$/, '/index.html')}`)) return next()
  if (!path.endsWith('/')) return res.writeHead(301, { location: `${path}/${query}` }).end()
  req.url = `${path}index.html${query}`
  next()
}

const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' }
// The shell (top bar, file explorer, browser file storage: the shell/ folder) at /shell/, for the app pages
// and /files/. Served as-is, not through Vite's module pipeline, exactly as the built site serves it.
const shell = (req, res, next) => {
  const path = req.url.split('?')[0]
  if (!path.startsWith('/shell/')) return next()
  const name = path.slice('/shell/'.length)
  if (name === 'apps.json') {
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-cache' })
    return res.end(JSON.stringify(appsJson()))
  }
  const file = join('shell', name)
  if (name.includes('..') || !statSync(file, { throwIfNoEntry: false })?.isFile()) return next()
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
  res.end(readFileSync(file))
}

export default defineConfig({
  appType: 'mpa',
  // Worktrees and their app builds live in .claude/; changes there shouldn't reload the pages open here.
  server: { watch: { ignored: ['**/.claude/**'] } },
  build: { rollupOptions: { input: { main: 'index.html', files: 'files/index.html' } } },
  plugins: [
    {
      name: 'tools',
      transformIndexHtml: { order: 'pre', handler: (html) => html.replace('<!-- groups -->', renderGroups()) },
      configureServer: (server) => {
        server.middlewares.use(shell)
        server.middlewares.use(toolIndex)
      },
      configurePreviewServer: (server) => void server.middlewares.use(toolIndex),
    },
    {
      // The built site serves the shell as plain files, like the dev middleware above.
      name: 'shell',
      apply: 'build',
      closeBundle() {
        cpSync('shell', 'dist/shell', { recursive: true })
        writeFileSync('dist/shell/apps.json', JSON.stringify(appsJson()))
      },
    },
  ],
})
