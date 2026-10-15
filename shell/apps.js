// The site's apps, from /shell/apps.json (vite.config.js builds it from tools.yaml and the installed builds).

// The dashboard's switches (index.html) keep their choices in localStorage: `channel` and `naming`.
const stored = (key) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

// "Alternative naming": the dashboard's switch, or ?alt=true|false on any page (kept, like the switch).
const alternativeNaming = () => {
  const alt = new URLSearchParams(location.search).get('alt')
  if (alt) {
    try {
      localStorage.setItem('naming', /^(1|true)$/.test(alt) ? 'alternative' : 'own')
    } catch {}
    return /^(1|true)$/.test(alt)
  }
  return stored('naming') === 'alternative'
}

// With it on, an app goes by the name and icon of the app it's an alternative to (`own` keeps its project's),
// and a group by its alternative heading.
const named = (a) => (a.alternative ? { ...a, name: a.alternative, icon: a.alternativeIcon ?? a.icon, own: { name: a.name, icon: a.icon } } : a)

let data
/** { groups: [{ name, alternative, apps: [{ slug, name, alternative, blurb, accent, icon, alternativeIcon, own?, opens, release, head }] }] } */
export const loadApps = () =>
  (data ??= fetch('/shell/apps.json')
    .then((r) => (r.ok ? r.json() : { groups: [] }))
    .then((d) => (alternativeNaming() ? { groups: d.groups.map((g) => ({ ...g, name: g.alternative ?? g.name, apps: g.apps.map(named) })) } : d))
    .catch(() => ({ groups: [] })))

export const flatApps = ({ groups }) => groups.flatMap((g) => g.apps)

/** The app page this is ('/wordcraft/' or '/head/wordcraft/'): { path, channel }, or null on other pages. */
export const currentApp = (pathname = location.pathname) => {
  const m = pathname.match(/^\/(?:(head)\/)?([^/]+)\//)
  return m && !['files', 'shell'].includes(m[2]) ? { path: m[0], channel: m[1] ? 'head' : 'release' } : null
}

/** An app's page in the channel chosen with "Use latest commits", else the one it has. */
export const appHref = (app) => ((stored('channel') === 'head' && app.head) || app.release || app.head).path
