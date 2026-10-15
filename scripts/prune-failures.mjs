// Print redundant failure markers for build.yml to delete, even when builds keep failing.
import { CHANNELS, builtAssets, channelAssets, tools } from './releases.mjs'

export const staleFailures = (assets) => {
  let remaining = assets.filter((a) => a.name.endsWith('.failed'))
  // Match longer slugs first: lightroom-classic belongs to its own history, not lightroom's.
  return tools.toSorted((a, b) => b.slug.length - a.slug.length).flatMap((t) => {
    const ours = remaining.filter((a) => a.name.startsWith(`${t.slug}-`))
    remaining = remaining.filter((a) => !a.name.startsWith(`${t.slug}-`))
    // Keep the latest retry timestamp and the first failure for failed_today/failed_before.
    return CHANNELS.flatMap((channel) => channelAssets(ours, t, channel, '.failed').slice(1, -1))
  })
}

if (process.argv[1] === import.meta.filename) {
  for (const a of staleFailures(await builtAssets())) console.log(a.name)
}
