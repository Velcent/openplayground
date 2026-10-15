# Honeydew live adapter audit

Audited `daijro/honeydew` at `942e6fb8892dd96899478b0928913b580c6a5df7` (0.1.6).
This is the source audit for the next delivery in the approved collaboration design, not a claim of
working live editing. The shared file-session foundation makes no upstream changes.

## Existing seams to reuse

| Code | What it provides | Constraint |
| --- | --- | --- |
| `src/app.rs::song_edited` | Central handling of most changes, including ongoing and final gestures | It is a notification after mutation, not an operation log. |
| `src/app.rs::frame` | End-of-frame access to the final song after UI, recording, imports and Undo | Some paths run after the main `song_edited` call, so that call alone is insufficient. |
| `src/app.rs::step` | One shared Undo/Redo entry for transport controls and shortcuts | Restores a whole-song snapshot; cannot consume remote edits as ordinary local history. |
| `src/history.rs::History` | Gesture grouping and local snapshots, sharing unchanged channels with `Arc` | Its steps do not carry authors or inverse operations. Some rack settings propagate across history. |
| `src/flm/{write,read}.rs` | Deterministic project encoding and bounded, validated decoding | Suitable for initial checkpoints and explicit recovery, not a concurrent-edit protocol. |
| `src/project_files/export.rs::user_files_of` | Finds the project's user assets, follows DWP dependencies, excludes bundled content | Currently private and eagerly copies assets; reports excluded content, but missing reads can disappear silently. |
| `src/lib.rs::run_web` | Existing `WebRunner::app_mut` event bridge | Optional web-only commands can follow this pattern without modifying native startup. |
| `src/ui/main_screen.rs::axis` and `MainScreen::clips` | Timeline coordinate conversion and local clip selection | Remote presence must use this geometry, not pointer pixels measured by the shell. |

## Identity and conflicts

- Channel IDs are unique within a song and survive reordering. They are bounded to 0–4095.
  Two disconnected editors can allocate the same next ID. Peer-derived numeric ranges would exhaust
  or violate the existing format, so do not change the native allocator that way.
- Channels also have GUIDs, but the master of an unsaved song can have a zero GUID. Importing may
  repair identifiers. A checkpoint must settle identity once; peers must not independently invent it.
- Lanes have no stable ID. Their indices change when inserting and removing automation tracks.
- Clip IDs are unique only within a lane. Notes, hits and automation points have no immutable IDs.
  They are ordered values in `Clip::events`.
- These facts rule out broadcasting vector indices as globally stable object identities. The adapter
  must fence topology changes or maintain a session identity map; a stale selection must disappear
  rather than highlight a different object after an insertion.

Use the approved ordered-operation path for the first DAW integration. Each operation needs an author,
unique ID, expected object revision and an atomic validation/apply result. Edits to distinct clips can
proceed independently; nonmergeable edits to the same clip, rack or track structure need a short lock
or an explicit conflict result. Do not introduce a universal CRDT to solve Honeydew's model.

The coordinating browser must retain the acknowledged log and checkpoint. If it disappears before a
consistent handoff, pause shared editing and preserve each browser's local work. Never elect a peer
and overwrite the others from its latest saved file.

## Shared state versus local state

Share the musical document: tempo/time signature/key settings, track order, clips/events, positions,
automation, routing, instruments/effects, sample references and project metadata. Initial checkpoints
must retain unknown file-format data so opening a session does not damage a later export.

Keep navigation and performance controls local: selected channel/clip, playlist scroll and zoom,
per-channel views, clip editor zoom, panels, keyboard range, playhead/transport, input monitoring and
record-arm state. A recording's resulting notes/audio are shared edits; its device state is not.

`Song::keep_unedited` is useful evidence, not the collaboration projection: it also preserves project
title, author, URL and metadata lock. Reusing it unmodified would incorrectly hide document changes.
Likewise, `Channel::same_edit` does not exclude every personal setting, and `ClipFileState::zoom` must
not become a remote edit just because it is serialized in FLM.

Remote apply must use the existing audio rebuild and track-rekey machinery while preserving local
views. `SongEdit::Replaced` resets navigation, selection, history, playback and sample caches, so it is
only appropriate for explicitly entering a project, never ordinary remote edits.

Personal Undo must invert a person's acknowledged operations with current conflict checks. Calling
the existing snapshot Undo during a shared session would also roll back later edits by other people.
The native/non-session Undo path must retain its current behavior.

## Asset bridge

Honeydew's browser file provider uses its own import/download path; it does not currently implement
Playground's Files hooks. A received session asset must be explicitly exposed to the app's sample
resolver under a session namespace, without copying it over a personal filename.

Reuse the dependency traversal behind `user_files_of`, separating discovery from reading where needed.
Keep the logical sample path distinct from the transport's display filename: DWP samples can refer to
relative folders, while the current file-sharing manifest intentionally rejects path names. The live
adapter needs a validated logical-path-to-asset map carried over the encrypted channel. A missing
dependency must be reported; ZIP export's omission behavior is insufficient for a ready shared project.

The web import limit is 128 MiB per file (`MAX_FILE_BYTES`); desktop uses 512 MiB. The transport's larger
8 GiB file allowance does not expand Honeydew's limits. Check capability limits before copying into
Wasm memory. Bundled instruments require a matching content/version contract rather than retransmitting
the entire sound library into every session.

## Smallest next implementation slice

1. Define and test the musical-document projection and conflict units against real `Song` values.
   Prove that changing views produces no operation, that different-clip changes merge, and that
   conflicting changes preserve the rejected local work. Include new/deleted/reordered tracks.
2. Define versioned optional web hooks for capabilities, checkpoint/dependencies, document operations,
   remote apply, personal Undo and timeline-coordinate presence. Keep their implementation in one
   adapter module with only a few calls from the existing frame/Undo/drawing seams.
3. Connect that adapter to the shared session transport and recovery store. Add authored history and
   acknowledged revisions; file transfer alone must never enable a live-editing badge.
4. Exercise two actual Honeydew browsers with different zoom/scroll, concurrent edits, personal Undo,
   missing assets, incompatible versions and a late join. Run native checks for every upstream hook.

Do not add broad model serialization derives or replace UI functions with large string patches merely
to get an initial demo. New upstream model fields should fail an explicit adapter coverage check,
not silently disappear from shared documents.

## Implemented model and checkpoint layer

The isolated patch `patches/fl-studio-mobile/peer-document.diff` now provides musical projection,
conflict-checked merging and inverse merging, plus bounded canonical FLM checkpoints. Clip ordering
follows start positions after identity-based merging. Similar-header tracks remain one conflict
unit because lanes have no stable identities; ambiguous personal view matches reset instead of
being copied to the wrong track.

`document-delta.js` sends changed byte spans with before/after SHA-256 hashes and exact inverse data.
These reconstruct proposed checkpoints for the model merge. They do not authorize edits or apply
them to a running app. The mutation/Undo hooks, authored revision protocol, dependencies and presence
listed above remain the next work. No browser live-editing capability is enabled.
