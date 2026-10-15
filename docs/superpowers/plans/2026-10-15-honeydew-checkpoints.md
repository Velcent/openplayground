# Honeydew checkpoint and edit transport implementation plan

> **For agentic workers:** Use superpowers:executing-plans. Autonomous execution is already authorized.

**Goal:** Give the Honeydew browser adapter a checked, bounded checkpoint format and compact reversible edit payloads.

**Architecture:** Reuse Honeydew's FLM codec and musical projection. Normalize a checkpoint once at session entry, then require canonical bytes from peers. Transport a changed byte span with before/after hashes; the model merge still decides whether the proposed musical edit is valid. A byte patch never directly replaces a live app document.

**Tech stack:** Existing Rust FLM codec, wasm-bindgen, JavaScript typed arrays and Web Crypto. No dependency changes.

**Spec:** `docs/superpowers/specs/2026-10-15-peer-collaboration-design.md`, `2026-10-15-honeydew-adapter-audit.md`.

## Constraints and review focus

- The web's existing 128 MiB file limit bounds a checkpoint. Media stays in immutable asset transfers.
- Reject repaired/noncanonical peer input, unknown format versions, malformed lengths and wrong base hashes before application.
- Small edits must not carry unchanged project prefixes and suffixes. Bulk/multi-object edits remain bounded.
- Reverse patches retain the exact prior checkpoint for conflict-checked personal Undo; a stale hash cannot apply.
- Snapshot decoding retains unknown valid FLM data. It excludes local views, and canonical encoding must reach a fixed point.
- These are transport primitives for the pending authored operation protocol. They do not enable live editing or change desktop behavior.

## Task 1: Checked Honeydew checkpoints

**Files:** Honeydew `src/collaboration/checkpoint.rs`, module declaration in `src/collaboration.rs`; packaged into the existing upstream diff.
**Interface:** `encode(&Song) -> Result<Vec<u8>, Conflict>`, `decode(&[u8]) -> Result<Song, Conflict>`, `merge_bytes(base, current, edited) -> Result<Vec<u8>, Conflict>`.

- [x] Write tests for deterministic encoding, local-view exclusion, retained unknown chunks, native instrument/note round trips, rejected malformed/noncanonical bytes and conflicts between decoded edits.
- [x] Run the new tests and observe failure before implementing the codec.
- [x] Encode the shared projection through FLM; normalize reader defaults once and require a stable re-encoding. Require exact canonical bytes and valid cross-object references from peers. Enforce the web file-size limit.
- [x] Expose the checked merge through a wasm-bindgen export for the subsequent bridge, with string errors and no native startup changes.
- [x] Run core tests, native library check and wasm check. Export and check the upstream patch.

## Task 2: Reversible bounded wire edits

**Files:** Playground `shell/document-delta.js`, `tests/document-delta.test.mjs`.
**Interface:** `delta(before, after) -> Promise<{version, base, result, at, remove, insert}>`, `applyDelta(bytes, edit, reverse = false) -> Promise<Uint8Array>`.

- [x] Write failing tests for tiny edits in large documents, insertion/deletion, empty edits, inverse restoration, corrupted or wrong bases, forged lengths, malformed hashes and oversized output.
- [x] Trim only equal prefixes/suffixes; keep exact removed and inserted bytes. Hash both complete checkpoints with Web Crypto. Apply only after validating bounds and the expected hash, then verify the resulting hash.
- [x] Run tests and commit the checked codec and delta together. Record that transport integration, revision fencing, app hooks, assets and presence are still outstanding; do not advertise live editing.

## Verified result

Honeydew `942e6fb` plus this patch: 4,365 native library tests passed, 2 ignored, including
28 collaboration tests. The WebAssembly library check passed. The delta and signaling tests passed
11/11. The combined diff applies cleanly to main and v0.1.6, which still name the same base.

A fresh review found five defects, reproduced and fixed in one pass: preserved EVN2 bytes could hide
repairs; clip identities needed validation; position-derived clip order caused false conflicts;
Buffer slices could alias caller data; fixed-width metadata could truncate. Regressions also cover
module/pad IDs and preservation of valid extended event-record bytes.

The existing-source footprint remains two lines in Honeydew's lib.rs. The model and codec live in
added modules. No runtime hooks, connection protocol, personal Undo integration, presence drawing,
asset mounting or production rollout is claimed. A raw delta is not an authorized operation.
The next integration must bind authors, operation IDs, revisions and project compatibility before
calling the model merge, including ABA protection and offline recovery. TURN remains unverified.
