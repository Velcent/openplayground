# Honeydew collaboration document core implementation plan

> **For agentic workers:** Use superpowers:executing-plans. The user has authorized autonomous implementation.

**Goal:** Merge independent musical edits and undo an author's change without overwriting other edits or personal views.

**Architecture:** Add one isolated, pure Rust module beside Honeydew's app code. Its three-way merge compares the acknowledged base, current shared state and proposed edit. It rejects overlapping changes atomically. This is the model core used by the later ordered peer protocol, not a standalone live-editing feature.

**Tech stack:** Existing Rust song types and FLM validation. No dependencies or model serialization derives.

**Spec:** `docs/superpowers/specs/2026-10-15-peer-collaboration-design.md` and `2026-10-15-honeydew-adapter-audit.md`.

## Global constraints

- Native behavior stays unchanged; compile the module for wasm or tests until its web bridge is ready.
- No whole-file remote replacement, no universal CRDT, and no silent conflict resolution.
- Keep model logic in one added source file; existing source gets only the module declaration.
- Inputs are real `Song` values. The later wire decoder must validate sizes, identities and finite numbers before this API.
- A rejected merge must leave every input unchanged, including the proposed local edit kept for recovery.

## Review focus

- A track insertion must not redirect an older clip edit to its neighbor.
- Undo must not restore an old sample/effect setting over another author's later edit.
- A delete racing an edit must preserve the edited object and report a conflict.
- Restoring local views must match IDs and never copy a deleted object's settings onto an unrelated replacement.
- Counter rollback during Undo must not allow an old object ID to be reused.

## Task 1: Musical projection and local views

**Files:** Honeydew `src/collaboration.rs`, `src/lib.rs`.

**Interfaces:** `pub fn shared(song: &Song) -> Song`; `pub fn keep_local(song: &mut Song, local: &Song)`.

- [x] Add real-model tests that change playlist/channel/clip zoom, current clips, play loop, keyboard performance controls, module minimized flags and channel arm/monitor state, then assert `shared(&a) == shared(&b)`.
- [x] Assert project metadata, instrument parameters, clip positions and sample paths remain different in the projection.
- [x] Run `cargo test --lib collaboration::tests --offline` and observe the missing implementation.
- [x] Normalize only local fields to deterministic defaults. Restore them by channel/clip IDs, with lane matching guarded against structural changes. Use exhaustive field patterns at projection boundaries so new model fields require a classification.
- [x] Run the projection tests. Native builds without a session get no new behavior.

## Task 2: Conflict-checked merge and inverse

**Files:** Honeydew `src/collaboration.rs`.

**Interfaces:** `pub fn merge(base: &Song, current: &Song, edited: &Song) -> Result<Song, Conflict>`; `Conflict` identifies the affected object or field.

- [x] Write tests for different clips edited concurrently, different channels, tempo versus a clip, same-clip conflicts, delete versus edit, track insertion/reordering, colliding newly allocated IDs and atomic failure after an earlier field could merge.
- [x] Test personal Undo with `merge(&author_after, &latest_shared, &author_before)`: another person's independent edits remain; an overlapping later edit rejects the Undo. Test that allocation counters never decrease.
- [x] Observe failing assertions before implementing the merge.
- [x] Merge only fields that differ between base and edit. Accept when current equals base or the exact intended result; otherwise return a conflict. Merge channels and clips by IDs. Treat lane structure changes as an atomic unit because lanes lack stable IDs. Keep clip event arrays atomic; concurrent editing within one clip requires the ordered protocol's conflict handling.
- [x] Preserve local settings from `current` after a successful merge. Validate resulting cross-object invariants with the existing FLM writer. Keep ID counters at their maximum observed value.
- [x] Run all new tests and existing model/history/FLM tests.

## Task 3: Patch packaging and integration record

**Files:** Playground `patches/fl-studio-mobile/peer-document.diff`, adapter audit and execution ledger.

- [x] Package the added module and small declaration as a normal upstream diff, with no replacement of existing UI functions.
- [x] Prove the diff applies to current Honeydew main and the 0.1.6 release. Run native checks and `cargo check --target wasm32-unknown-unknown --lib` for the module declaration.
- [x] Review the complete core once using the execution skill's fresh reviewer; fix data-loss findings with regressions.
- [x] Record the exact remaining web bridge work: acknowledged operation transport/history, app mutation/Undo hooks, dependency mapping and document-coordinate presence. Do not enable or label live editing from this core alone.

The next plan consumes these tested functions to implement the ordered browser adapter. TURN credentials remain a separate deployment prerequisite; they do not block this local model work.

## Verified result

On Honeydew `942e6fb`, all 4,354 native library tests passed, with 2 ignored. The 17
collaboration tests cover independent edits, inverse changes, identity collisions, ambiguous track
reorders, drum-pad changes, dangling routing and cycles. The wasm library check and clean patch
application passed. One independent review found four defects; each was reproduced and fixed.

Same-header lanes merge as one unit until the source model supplies stable identities. Ambiguous
view matches reset zoom instead of copying another track's view. No live UI or app hook is enabled.
The next integration still needs operation revisions/authors, browser hooks, assets and presence.
