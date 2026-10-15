# Playground peer collaboration design

Date: 2026-10-15. Status: direction approved in conversation; written spec awaiting review.

## Intended result

People open a shared Playground link and work on the same project. The toolbar shows who is connected
and how far each participant has progressed through receiving the project and its assets. Edits happen
live, before Save. Views, zoom, panels and window layouts stay local.

Files, assets, document snapshots and edit history are never persisted on Playground's servers. They
live in participants' browser storage. Encrypted WebRTC data channels carry them directly between
browsers, with Cloudflare TURN as the fallback when a direct connection cannot be established.

The user approved relay fallback and the design discussed in chat. This document records that design
and specifies the first deliverable. Subsequent app integrations remain part of the requested work.

## Delivery order and scope

1. Shared sessions, invitation access, encrypted connections, isolated session files, resumable file
   transfer, participant count and progress. This is the first implementation plan's scope.
2. Honeydew live timeline integration, including project settings, assets, remote cursors and selected
   clips. Audit its current document/command model before specifying its operation format.
3. Word live text integration, including concurrent editing, remote carets and selections, and personal
   Undo. This proves the text-editing path before applying it to other document apps.
4. Remaining app integrations, grouped by document model as listed below.

Deliverable 1 is independently testable with browser files. It must be labelled file sharing while an
app has no live editing adapter. The shared shell cannot infer live editing from saved files or canvas
pointer events. It must never advertise full collaborative editing for an unsupported build.

## Current code and boundaries

- `worker.js` serves assets and dispatches the existing scheduled update workflows. Extend it for
  session endpoints without changing either existing responsibility.
- `wrangler.jsonc` owns deployment configuration. Add a room Durable Object binding and route only the
  session API through the Worker before static assets.
- `shell/app.js`, `shell/topbar.js`, `shell/ui.js` and `shell/shell.css` own the shared interface. Reuse
  their DOM helpers, colors, buttons, popovers and keyboard behavior.
- `shell/store.js` owns personal OPFS files under `playground-files`. Its flattening migration moves
  nested files to the top level. Session storage must be a sibling OPFS root, `playground-sessions`,
  so this migration cannot rename or delete session data.
- `shell/files.js` exposes open/save/read hooks, not live editing. Existing personal-file APIs retain
  their behavior; receiving a peer's file never writes into a personal path.
- `vite.config.js` serves and copies the shell. Development must proxy the session API to local
  Wrangler so browsers exercise the same backend used in production.
- Existing `node:test`, Playwright and Wrangler tooling cover unit, browser and Worker checks. No
  framework migration or new server runtime is needed.
- `patches/*.yaml` currently integrates upstream apps. Prefer small upstream collaboration hooks and
  a versioned adapter to large replacement patches. Honeydew's current patch only bundles sounds;
  it does not expose a collaboration or browser-files interface.

## Hosting

Use the existing Cloudflare account and Worker. A VPS is unnecessary.

| Component | Responsibility | Content retained |
| --- | --- | --- |
| Worker | Session routing, admission checks, short-lived TURN credentials | No project content |
| One Durable Object per room | Connected peers, access grants, signaling, room lifecycle | Minimal coordination metadata only |
| Cloudflare TURN | Forward WebRTC packets when direct connectivity fails | No application file store; encrypted packets in transit |
| Participant browser | Documents, asset chunks, history, local recovery | Local session copy |

Use hibernating WebSockets for signaling. Restore connection metadata from socket attachments after
hibernation instead of trusting a JavaScript map to survive. Room admission metadata must survive
hibernation and fail closed on unexpected loss. Do not put documents, filenames, asset bytes, edit
operations, invite decryption secrets or plaintext signaling into attachments or Durable Object storage.
No R2, D1, KV or server-side project snapshots are required. Do not log request bodies, invitations,
credentials, document messages or asset manifests.

Cloudflare TURN is a separate managed service, not a TURN implementation inside a Worker. Keep its API
key in a Worker secret. Issue expiring credentials only to admitted members, with issuance rate limits
and a bounded TTL. Missing credentials must produce a useful connection error, never claim a working
relay. Provisioning and an actual forced-relay test are release prerequisites.

## Invitation and access

Use the app's canonical URL with an opaque room identifier and a high-entropy invitation secret in
the URL fragment. The browser does not send the fragment in HTTP requests. Preserve other app URL
state and do not forward the invitation to unrelated apps or external links.

The room creator is its owner. Invitations grant editor or viewer access; a viewer cannot change the
project by sending a forged network message. Admission, role changes, locking invitations and removing
members are checked both by the room service and by the receiving peers. Bind grants to a peer identity
and room epoch; do not trust a sender-provided display name or role field.

Use browser cryptographic APIs and standard authenticated encryption for signaling envelopes. Bind
the room, sender, recipient and connection generation into authentication, reject replayed envelopes,
and authenticate the negotiated WebRTC endpoints before exchanging content. Keep the invitation's
decryption secret out of the signaling service. DTLS encrypts the resulting data channels end to end.
The implementation plan must specify the exact key and admission flow and tests before product code.

Removing a participant closes their channels, revokes their grant and invalidates old invitations for
future admission. Remaining peers reconnect under the new membership epoch. Removal cannot erase data
already received by that person. Anyone allowed to view a file can retain their copy.

## Session behavior and interface

One room belongs to one app/project. Share explicitly selected open project content and its dependencies,
not the entire personal Files collection. The initial file-sharing UI lets the owner select files;
later live adapters supply the active project and enumerate its required dependencies.

Add a Share control to the toolbar. Opening an invitation shows the app, requested access and required
download size before receiving content. Display names are user-editable and rendered as plain text.
Use consistent session colors, names and icons so color is never the only participant indicator.

Show `4 people` and a progress bar while syncing. The participant popover distinguishes connecting,
receiving files, catching up on edits, ready, reconnecting and failed. Progress counts receiver-verified
bytes, not bytes merely queued for sending. Zero-byte files, reused assets and failed writes must not
leave progress stuck or incorrectly report success. A live adapter supplies the edit catch-up status.

Start with a maximum of eight participants, including the owner, in a peer mesh. This is an initial
resource bound, not a promise of arbitrarily large rooms. File transfers use one source per asset;
the mesh must not broadcast every asset to every peer unnecessarily. Edit and presence messages take
priority over bulk transfers. The owner can leave without deleting other participants' local copies.

Keep session files in browser storage until the user removes them. Offer explicit export/copy to personal
Files; never silently overwrite an existing file. Browser quota failures keep verified prior data and
show the failed transfer. Clearing browser storage still removes that browser's copies.

## Transfer and recovery

Assets are immutable versions identified by content hashes, with logical file IDs separate from display
names. Use a manifest with names, lengths and chunk hashes, transferred only through authenticated peer
channels. Reject malformed paths, impossible lengths, invalid chunk indices, unsolicited content and
messages larger than protocol limits before allocating or writing.

Stream bounded chunks from source files into a temporary session object. Apply backpressure rather than
loading multi-gigabyte media into memory or filling the data-channel queue. Verify chunks before marking
them received. A verified completion marker makes a file visible to the app only after all data is
written successfully. Partial transfers survive reconnects and resume using their verified chunk list.
Identical content is reused; replacing a file creates a new version instead of mutating a transfer.

New participants receive a consistent document snapshot and its revision, required assets, then edits
after that revision. They become ready only after catching up. Late or duplicate packets cannot apply
an edit twice. A missing asset remains visibly missing rather than silently becoming an empty file.

Disconnected participants keep a local copy. File transfer can resume from another peer holding the
same verified asset. Live editing can hand off coordination only when peers establish a consistent
checkpoint; otherwise pause shared editing and preserve local changes for explicit recovery. Never
resolve divergent documents by replacing one with the last file received.

When nobody with the project is online, the link shows that the session is unavailable. A returning
participant with a local copy can restore sharing. There is no server backup or offline download.

## Live app integration contract

Each live adapter exposes capabilities and protocol/document versions, a snapshot boundary, dependencies,
local document operations, remote operation application and document-coordinate presence. Verify build
compatibility before applying content. File-format compatibility alone is not sufficient. Unsupported
or incompatible builds explain the mismatch and preserve current work.

Operations need stable object IDs, authors and unique operation IDs. They must merge deterministically
or use an ordered operation path with conflict checks. Text needs an established collaborative text
model. Nonmergeable operations may require short object/layer/clip locks. Do not build a custom universal
CRDT or treat periodic full-file replacement as concurrent editing.

Shared history records authors. Undo targets a person's own operations; a checkpoint restoration is an
explicit new shared operation. Remote operations cannot leak into personal Undo as if locally authored.
Selections and cursors are transient presence, not document edits. They disappear on disconnect and
use document/world coordinates so personal scrolling and zoom remain independent.

| Apps, using the user's familiar names | Shared content and presence |
| --- | --- |
| Photoshop, Illustrator, InDesign, Lightroom, Lightroom Classic | Active document/image/drawing, layers, edit history and document cursor. Selected layer and panels stay local. |
| Acrobat, Word, Excel, PowerPoint, Revu | Editable document content plus colored textbox/object/cell selections and text carets where supported by the document model. |
| Premiere, After Effects, Pro Tools, FL Studio/Lemon Studio, FL Studio Mobile/Honeydew | Timeline, tracks/clips/notes, media, positions, tempo, automation, effects/instrument state and dependencies; remote selected clips and document cursors. Layout and playback transport stay local. |
| Figma | Scene objects, remote cursors and selected items. |
| AutoCAD, Fusion 360, Substance Painter | Model, objects/layers, drawings and required materials/textures. |
| Outlook | No file or editing synchronization. |

An adapter is complete only after auditing all document-mutating paths, including keyboard shortcuts,
dragging, imports, Undo/Redo and programmatic changes. Native builds retain their behavior: browser
collaboration hooks are optional and web-only.

## Verification and release criteria

For the shared foundation, use at least three independent browser profiles. Prove invitation admission,
participant counts, role enforcement, removal, encrypted transfer and correct progress. Include an
empty file, duplicate names, binary media, interrupted/resumed transfers, corruption, quota failure,
stale packets, wrong secrets, foreign origins and a late joiner. Confirm personal files remain untouched.

Exercise Durable Object hibernation and restart, credential expiry and connection recovery. Inspect
server requests/storage/logging paths to verify no project payload or decryption key is persisted.
Test direct connectivity and force `iceTransportPolicy: 'relay'` in a real deployed TURN smoke test.
Passing a local direct-connection test does not establish relay readiness.

For Honeydew and subsequent adapters, test concurrent edits to different objects and conflicting edits
to the same object, personal Undo, different zoom/scroll, missing assets, version mismatch and late joins.
Check native builds for every upstream web hook. Run existing file-store, Files, toolbar, shell and URL
redirect checks where touched. Do not rebuild every upstream app merely for shell changes.

No live collaboration claim or production rollout until the corresponding integration passes these
checks. Do not expose a partially working feature by default.

## References checked on 2026-10-15

- [Cloudflare TURN](https://developers.cloudflare.com/realtime/turn/)
- [TURN credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
- [TURN encryption and pricing FAQ](https://developers.cloudflare.com/realtime/turn/faq/)
- [Durable Object WebSockets and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [WebRTC data channels](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels)
