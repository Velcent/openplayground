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
  ignore: ['/next_id'],                // optional: allocator counters, which Undo leaves raised
  importMedia: async (page) => {},     // optional: the owner adds a photo/clip/sample kept outside the document; the
                                       // editor and the late viewer must end up with the same bytes (adapter assets())
  drag: async (page) => {},            // optional: the owner holds a gesture mid-way (no mouse up); the editor must be
                                       // shown its in-progress presence (ghost, stroke, rubber band…)
  release: async (page) => {},         // optional: ends drag() without an edit (default: Escape, then mouse up)
  openTab: async (page) => {},         // optional: the owner opens another document; it must reach the editor
  point: async (page) => {},           // optional: the owner points at or selects something; the editor's app must
                                       // be shown the owner's presence() (draw it; check once with a screenshot)
}
```

An app whose checkpoint is not JSON defines `globalThis.liveTestDocument()` in `ready`, returning the document as JSON
text (see photoshop.mjs).

Build the patched app, install it with `LIVE_PUBLIC=~/.cache/live-e2e-public node scripts/live-overlay.mjs <slug>
<dist> <path>`, then run `LIVE_PUBLIC=~/.cache/live-e2e-public LIVE_APPS=<slug> CHROMIUM=… node --test
--test-isolation=none tests/live-apps.e2e.test.mjs`.
