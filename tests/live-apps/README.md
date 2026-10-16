# Live-editing acceptance specs

One `<slug>.mjs` per app with the generic adapter (`patches/live/playground_live.rs`), used by
`tests/live-apps.e2e.test.mjs`:

```js
export default {
  path: '/gridcraft/',                 // the app's URL path in Playground
  viewport: { width: 1280, height: 800 },
  ready: async (page) => {},           // optional: wait for or dismiss start-up UI
  editA: async (page) => {},           // the owner's edit
  editB: async (page) => {},           // the editor's edit, to a different object
  undo: async (page) => {},            // the owner's Undo (its usual shortcut or button)
}
```

Build the patched app, install it with `LIVE_PUBLIC=~/.cache/live-e2e-public node scripts/live-overlay.mjs <slug>
<dist> <path>`, then run `LIVE_PUBLIC=~/.cache/live-e2e-public LIVE_APPS=<slug> CHROMIUM=… node --test
--test-isolation=none tests/live-apps.e2e.test.mjs`.
