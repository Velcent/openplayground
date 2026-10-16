# Honeydew live document implementation plan

> **For agentic workers:** Use superpowers:executing-plans, inline, with one final independent review.

**Goal:** Two or more Honeydew browsers in one Playground session edit the same song live: edits sync without Save, conflicting edits keep the rejected local draft, Undo reverts only the person's own work, and a late joiner catches up.

**Architecture:** The room owner's browser coordinates: it runs `DocumentHistory`, persists its record in the session's OPFS directory and broadcasts accepted entries over a separate ordered `document` data channel. Every browser (the owner too) runs the same client: it keeps the last acknowledged document, sends at most one proposal at a time, and rebases its live song on each accepted entry inside the app. Honeydew gets a small web-only adapter; the shell owns transport, storage and policy.

**Tech stack:** Existing JS shell modules, Web Crypto, WebRTC data channels, node:test with Playwright, Rust/wasm-bindgen in the isolated Honeydew patch. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-peer-collaboration-design.md`, `docs/superpowers/specs/2026-10-15-honeydew-adapter-audit.md`. Builds on `docs/superpowers/plans/2026-10-15-honeydew-authored-history.md`.

## Global constraints

- Files, assets, document snapshots and edit history are never persisted on Playground's servers; document messages never pass through signaling.
- Native Honeydew builds keep their behavior: every new hook is `cfg(target_arch = "wasm32")` (logic also `cfg(test)`), and does nothing until the shell attaches.
- Identity and role come from the authenticated peer channel and roster, never from message fields.
- Undo during a session reverts only that person's operations; native snapshot Undo stays for non-session use.
- Divergence never resolves by replacing a project with the last file received; rejected local work is kept as a draft.
- Coordination exists only while the owner is online. Without it, live editing pauses and local work is preserved. No elections.
- Do not expose a partially working feature by default (`SESSIONS_ENABLED` stays false in production).
- Upstream diff stays small: an adapter module plus a few calls at existing seams (`run_web`, end of `frame`, `step`).

## Review focus

- A remote edit arriving mid-drag must not cancel or corrupt the drag; it applies once the gesture ends.
- A peer's proposal racing a remote entry must rebase or fail with its draft kept, never apply twice or drop the remote change.
- A viewer (or a forged message) cannot change anyone's document, including the coordinator's.
- A late joiner must reach exactly the coordinator's revision before showing ready, even while others keep editing.
- The coordinator going away must pause editing with local work intact, not leave a peer silently diverging.

### Task 1: Honeydew live adapter

**Files:** Create `src/collaboration/live.rs` in `/tmp/honeydew-collab-audit`; one-line module registration in `src/collaboration.rs`; calls from `src/lib.rs::run_web`, end of `HoneydewApp::frame` and start of `HoneydewApp::step` in `src/app.rs`; re-export the patch.

**Interfaces (JS, registered with `globalThis.playgroundLive?.attach(adapter)` after `runner.start`):**
- `adapter.format` — `"honeydew:1:<CARGO_PKG_VERSION>"`.
- `adapter.checkpoint()` → `Uint8Array`, canonical shared bytes of the live song.
- `adapter.apply(base, edited)` → `'applied' | 'busy'`, throws a conflict string. Merges `edited` relative to `base` into the live song (`collaboration::merge`), keeps local views, re-keys and rebuilds like `step` (`Handover::Undo`), and amends native history so the change is not personal Undo.
- `adapter.replace(bytes)` → same as `apply` but adopts `bytes` as the whole shared document (session entry, conflict recovery, viewers).
- `adapter.merge(base, current, edited)` → `Uint8Array` (pure, for the coordinator's journal).
- `adapter.connect({ changed, undo })` — the app calls `changed()` at the end of a quiescent frame whose shared projection differs from the last one reported or applied, and `undo(redo: boolean)` instead of native Undo/Redo while connected. `adapter.disconnect()` restores native behavior.
- Busy means a pointer is down, a gesture or param drag is open, or recording is on.

- [ ] Native tests via the app harness: applying a remote change to a different channel keeps the local edit, selection and zoom; applying while a drag is open returns busy and leaves the song untouched; a conflicting change errors and leaves the song untouched; the reported-change check ignores view-only changes. Run RED.
- [ ] Implement `live.rs` with a thread-local connection and the app methods. Run GREEN, `cargo test --lib collaboration::`, wasm check, native `cargo check`, export the patch, `git apply --check` upstream.
- [ ] Commit in the Honeydew clone and Playground (patch only).

### Task 2: Document channel

**Files:** Modify `shell/session.js`; test `tests/session.e2e.test.mjs` (extend) or a focused new browser test.

**Interfaces:** Peers open a second ordered channel labelled `document` (same initiator rule as `files`). `session.sendDocument(peer, value, bytes?)` sends a JSON header (≤32 KiB) followed by the bytes in 16 KiB binary frames; `session` dispatches `document` events `{ peer, value, bytes }` only for authenticated, current peers. Each message is bounded (header + 2 × 128 MiB + 64 KiB), document traffic has its own queue and backpressure, and file transfers never block it.

- [ ] Browser test: two peers exchange a 200 KiB document message while a file transfer is running; an oversized or unsolicited binary frame closes only that peer's document channel. Run RED, implement, GREEN, run the existing session suite, commit.

### Task 3: Coordinator, client and recovery

**Files:** Create `shell/live.js`; small additions to `shell/session-store.js` (`document(record?)`, `draft(bytes)`) and `shell/document-history.js` (export the stack derivation for the client); test `tests/live.test.mjs` with a fake adapter and an in-memory transport.

**Messages:** `propose {proposal}` client → owner; `entry {entry}` owner → everyone after commit; `reject {id, error}` owner → proposer; `snapshot {record}` owner → each peer whose document channel opens (record = `history.snapshot()`, bytes sent as binary). Author = sending peer's ID; the owner's own client calls its journal directly.

**Client rules:** keep `acked {revision, bytes}`, `entries` and at most one `inflight {id, base, sent}`. On `changed()`: if read-only, `replace(acked)`; else if idle and `checkpoint() != acked`, propose `delta(acked, checkpoint)` at `acked.revision`. On an entry for the next revision: apply its change to `acked`; if it is ours, clear `inflight`; otherwise call `apply(before, after)`, retrying `busy` on the next `changed()` or animation frame, queueing later entries behind it; on conflict save `checkpoint()` as a draft, then `replace(acked)`. On `reject` of our proposal: save the draft, `replace(acked)`. On Undo/Redo: wait for no inflight and no unsent change, then propose `undo`/`redo` targeting our derived stack top. A gap in revisions or a snapshot for an unknown document resets from the next snapshot. When the owner is disconnected, status is `paused`; local edits stay in the app and are proposed after resync, or kept as a draft if they conflict.

- [ ] Tests with two fake clients and the real journal: independent edits converge; same-field edits keep one result and the other as a draft; a busy apply is retried in order; personal Undo across a remote edit; a viewer's edit reverts locally and is rejected by the owner; a late joiner gets the snapshot then later entries; a reloaded owner restores its journal record and continues the revision sequence. Run RED, implement, GREEN, commit.

### Task 4: Shell wiring and real browsers

**Files:** `shell/share.js` (status text: `Live editing`, `Catching up`, `Paused: owner offline`), `shell/app.js` or `shell/files.js` (expose `globalThis.playgroundLive`), a local Honeydew web build with the patch for tests, `tests/live.e2e.test.mjs`.

- [ ] Build patched Honeydew with trunk (0.21.x) and wasm-bindgen matching `Cargo.lock` into a scratch `public` overlay for tests, never into the original checkout's `public`.
- [ ] Two real Honeydew browsers: different zoom/scroll; concurrent edits to different channels converge; same-object conflict keeps a draft; personal Undo keeps the other's edit; a third browser joins late and matches; viewer cannot edit; owner disconnect pauses then resumes. Run the session/share/topbar suites, commit.
- [ ] One final independent review of the slice, fix important findings with regressions, update the handoff.

## Out of scope for this plan

Remote cursors and selected-clip presence, the asset/sample bridge and missing-asset readiness, coordinator handoff, Word and other app adapters, real TURN verification (credentials still missing), production enablement.
