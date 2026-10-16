# Honeydew authored history implementation plan

> **For agentic workers:** Use superpowers:executing-plans, inline, with one final independent review.

**Goal:** Sequence authored Honeydew changes and selective Undo without allowing stale or replayed operations to overwrite intervening work.

**Architecture:** A browser-side journal uses the existing checked byte deltas and Honeydew model merge. It records actual accepted changes, checks intervening revisions, and calls a required durable commit callback before acknowledging anything. The journal is a local component of the pending live adapter, not a live-editing capability by itself.

**Tech stack:** Existing JavaScript modules, Web Crypto, node:test and the isolated Rust collaboration module. No dependencies.

**Spec:** `docs/superpowers/specs/2026-10-15-peer-collaboration-design.md` and `docs/superpowers/specs/2026-10-15-honeydew-adapter-audit.md`.

## Global constraints

- Files, assets, document snapshots and edit history are never persisted on Playground's servers.
- Undo targets a person's own operations.
- Native builds retain their behavior: browser collaboration hooks are optional and web-only.
- Do not expose a partially working feature by default.
- Admission comes from the caller's authenticated peer identity and current permission callback, never from fields inside a proposal.

## Review focus

- An edit followed by its reversal must still invalidate an older overlapping proposal.
- Several personal Undo/Redo actions must work around unrelated remote edits, including remote edits made between a local change and its Undo.
- An acknowledgement lost during reconnect must not apply an operation twice; reused IDs with different content must fail.
- Failed persistence or concurrent submissions must leave the last acknowledged document intact.
- Pruning and mutable caller buffers must not silently change history or revive expired edits.

### Task 1: Authored journal and selective Undo

**Files:** Create `shell/document-history.js` and `tests/document-history.test.mjs`; modify the exported Honeydew patch and its source in `/tmp/honeydew-collab-audit/src/collaboration.rs`.

**Interfaces:** `DocumentHistory.create({document, format, bytes, merge, commit, allowed})`; `submit(author, proposal)` returns the accepted entry; `snapshot()` returns a detached recovery record. Proposals include document/format/version, UUID id, base revision, kind and either a checked delta or the expected target revision. `merge(base,current,edited)` is the existing strict Honeydew byte merge. `commit(record)` must durably replace the browser recovery record or reject. `allowed(author)` checks the current admitted editor role. Restore and actual OPFS/transport/app bindings remain separate integration work.

- [ ] Write and run failing tests for strict same-value overlapping edits in Rust, then remove model-level idempotence; journal IDs own deduplication.
- [ ] Write and run failing JS tests for independent concurrent edits, same-object conflicts, ABA, author-only Undo/Redo, multiple personal Undo steps, replay, invalid messages, retention, buffer mutation and persistence failure.
- [ ] Implement the journal with serialized submission, detached data, bounded history of 100 operations and 256 MiB of delta bytes, a project/build identity, and exact request receipts. Expired bases/Undo targets fail explicitly; a rejected operation preserves its caller's draft.
- [ ] For ordinary edits, check every retained checkpoint after the proposed base. For Undo/Redo, reconstruct the target inverse and replay only other authors' subsequent operations into a temporary document before checking the inverse, so a person's own canceled actions do not block older Undo. Always merge the inverse against the current document too.
- [ ] Run JS history/delta/protocol tests, Rust collaboration tests and wasm check, export the patch, and verify clean upstream applicability.
- [ ] Review the complete slice once, fix important findings with regressions, record remaining limits, and commit locally.

## Scope still outstanding

Recovery loading/OPFS storage, authenticated live transport, app mutation/Undo hooks, read-only enforcement, assets, cursors, and real two-browser Honeydew tests are not implemented by this plan. Cloudflare TURN credentials remain needed for the relay test. No production deployment is enabled.
