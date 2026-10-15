# Encrypted peer sessions implementation plan

> Execute with superpowers:executing-plans in this session. The user approved the spec and explicitly authorized autonomous planning and implementation on 2026-10-15.

**Goal:** Working multi-person browser file sessions with encrypted peer transfers, Cloudflare signaling, relay support and truthful toolbar progress.

**Architecture:** Keep the existing static shell and Worker. Add one Durable Object per room, native WebRTC/Web Crypto clients and a separate OPFS session store. File sharing is labelled separately from future live editing adapters.

**Tech stack:** Existing JavaScript, node:test, Playwright, Wrangler; browser WebRTC, Web Crypto and OPFS. No new runtime framework.

**Spec:** `docs/superpowers/specs/2026-10-15-peer-collaboration-design.md`.

## Global constraints

- No server persistence of files, filenames, project payloads, history or invite decryption secrets.
- Preserve personal files, existing save/open behavior, static routing and scheduled builds.
- Eight participants maximum. Outlook excluded. No live-editing claim without an adapter.
- Session data in OPFS `playground-sessions`, outside `playground-files` and its flattening migration.
- Actual receiver verification and completed writes determine transfer progress.
- Direct WebRTC plus Cloudflare TURN fallback. Missing TURN provisioning is a release blocker, not a reason to fake a passing relay test.
- Subsequent Honeydew, Word and remaining adapters are separate work after this foundation.

## Review focus

- Malicious authenticated viewer: cannot submit a manifest or content replacement; receivers enforce roster roles.
- Hibernation/reconnect: no owner role accidentally granted, no stale signaling replay or file overwrite.
- Failed partial writes: no false completion or loss of previously verified files.
- Concurrent large transfers: bounded messages and memory; avoid a binary-file-size allocation.
- Expired/revoked credentials and invitations: fail closed, preserve local copies, explain recovery.

## Protocol decisions

Room IDs, member IDs and connection generations are random UUIDs. Invitation secrets and bearer credentials are independent random 256-bit values encoded base64url. A link contains a single namespaced fragment parameter carrying room ID, invitation credential, AES secret and app path. Keep other fragment parameters; never carry these values into the query string.

The owner creates a room with SHA-256 hashes of independent owner/editor/viewer bearer tokens. Only hashes persist in the DO. A join sends its bearer over HTTPS in a bounded POST body, receives a random personal reconnect credential, member ID and role; its hash persists. Owner authentication is separate from editor/viewer invitations. Reconnect cannot change a role. Roles come only from the service's roster. Backend is trusted for membership authorization but never receives the signaling AES key or project payloads.

A WebSocket's first frame contains the personal reconnect credential. Credentials never appear in URLs or access logs. Each socket has a new generation. The service stamps sender ID/generation and routes only to admitted room members. An AES-256-GCM signaling envelope binds protocol, room ID, epoch, sender/recipient IDs and generations plus sequence number as associated data. Each sender uses fresh random 96-bit IVs. Receivers reject old sequence numbers and unknown generations. DTLS protects subsequent data channels; a successfully authenticated SDP exchange binds the connection to the service-authorized peer identity. This avoids implementing a second custom key exchange.

Room administration uses the owner's bearer. Lock disables invites; role change/removal increments epoch and closes existing sockets to force fresh rosters and channel negotiation. Removal rotates both invite tokens. Existing personal reconnect credentials stay valid except the removed member's. No changing role based on a data message. AES signaling key need not rotate to revoke a member because the revoked credential cannot join or signal; fresh DTLS sessions prevent reading later content. Remaining peers do not send content until their updated roster is known.

The DO retains only app key, owner/invite hashes, epoch, lock state, member IDs/credential hashes/roles and bounded timestamps. Limit stored member slots to eight, with owner-controlled removal. Socket attachments hold member ID, generation, authenticated state and message-rate bookkeeping. Requests/messages have size limits. Worker rate limits protect room creation/join and TURN issuance; per-room socket rate limits protect signaling. TURN credentials expire after 600 seconds and only authenticated connected members can obtain them; refresh before a new ICE negotiation. No request bodies are logged.

Reliable ordered control/data channels carry manifests and requested chunks. The first implementation uses 64 KiB asset chunks, sent as bounded frames, and a 256 KiB send buffer high-water mark. SHA-256 hashes each chunk. The asset ID hashes a canonical descriptor of size and chunk hashes, allowing incremental hashing of huge files without a whole-file buffer. Logical file IDs and display names stay separate from asset IDs. Limit manifests to 256 files, 8 GiB per file, 32 GiB per room and 16 MiB metadata; page manifests across bounded messages. Session copy writes and chunk acknowledgements are awaited. Requests are sequential per asset; never accept unsolicited chunks. Store chunks as independently verified OPFS files with manifest metadata and a final completion marker. Recover verified chunks from disk; verify them on resume before trusting them.

## Task 1: Shared protocol and cryptographic boundaries

**Files:** create `shell/session-protocol.js`, `tests/session-protocol.test.mjs`.

**Produces:** `randomToken()`, `digest(bytes)`, `signalKey(secret)`, `seal(key, context, value)`, `open(key, context, envelope)`, `inviteURL(url, invite)`, `readInvite(url)`, `validateManifest(manifest)`, `assetId(size, hashes)`, protocol limits.

- [ ] Write tests for authenticated encryption, tampered room/sender/generation, wrong key, altered ciphertext; fragment round trip preserving unrelated state; malformed manifests/names/hash counts/oversized inputs.
- [ ] Run `node --test tests/session-protocol.test.mjs`; expect failure because exports do not exist.
- [ ] Implement native Web Crypto with bounded parsing and explicit validation.
- [ ] Rerun test; expect all passing. Commit protocol and tests.

## Task 2: Cloudflare room membership and signaling

**Files:** create `session-room.js`, `tests/session-room.test.mjs`; modify `worker.js`, `wrangler.jsonc`.

**Consumes:** Task 1 token/digest/limits. **Produces:** `/api/session/:room` endpoints `create`, `join`, `socket`, `turn`, `admin`; room roster `{epoch, app, peers:[{id,role,generation}]}`. HTTP create returns owner reconnect credentials; join returns member reconnect credentials. Authenticated socket sends encrypted `signal` envelopes and receives service-stamped peers/signals.

- [ ] Tests through real local workerd/Miniflare: create/join/reconnect, wrong token, foreign origin, maximum members, role enforcement, owner lock/remove/rotate, unauthenticated signaling, body/frame size limits, absent TURN configuration, restart from storage. Assert no project data in persisted records.
- [ ] Run `node --test tests/session-room.test.mjs`; expect missing room routes.
- [ ] Implement room DO using hibernating sockets and hashed credentials, native rate-limit binding, bounded request reading and a 10-second authentication timeout. Keep cron and static assets working. Make TURN issuance an external API boundary with predictable error handling.
- [ ] Rerun tests; expect passing. `wrangler deploy --dry-run` must bundle. Commit.

## Task 3: Browser session storage and verified chunks

**Files:** create `shell/session-store.js`, `tests/session-store.test.mjs`; modify `shell/store.js` only to expose streaming `file(path)` for chosen personal files.

**Consumes:** Task 1 manifests/hash functions. **Produces:** `SessionStore(room)` with `saveManifest`, `manifest`, `putChunk`, `missing`, `file`, `remove`; `describe(file, logicalId)` streams a File into a verified manifest. Operations return promises and never touch personal root.

- [ ] Browser tests: binary content over multiple chunks, empty file, corrupt/duplicate/out-of-order chunks, same name/different content, resume after reopening, personal-store flatten isolation and failed write never marking complete.
- [ ] Run `node --test tests/session-store.test.mjs`; expect missing session store.
- [ ] Implement bounded chunk reads/writes, validate before write, manifest and completion marker only after successful writes. Return a Blob/file handle for export without making a single giant Uint8Array.
- [ ] Rerun storage tests plus existing store tests; expect passing. Commit.

## Task 4: Peer transport and file synchronization

**Files:** create `shell/session.js`, `tests/session.e2e.test.mjs`, `tests/session-helpers.mjs`; modify `vite.config.js` for local session API proxy.

**Consumes:** Tasks 1-3. **Produces:** `PeerSession.create({app, files, name})`, `PeerSession.join(invite,{name})`, `connect()`, `receive()`, `share(files)`, `invite(role)`, `admin(action)`, `leave()`, change events exposing peers/manifest/progress/error. `receive()` is explicit acceptance after manifest and size preview. Peers carry roles from roster and display names from encrypted channels.

- [ ] Three isolated browser profiles transfer empty/binary files; verify bytes and participant counts. Test a late join, refusal before receive, viewer upload rejection, removed member, wrong secret, interrupted transfer/resume, local copy after all leave and wrong app.
- [ ] Run targeted e2e tests; expect missing transport.
- [ ] Implement deterministic offer initiator, serialized signaling, ICE candidate buffering, reconnect generations, bounded data buffers and sequential chunk requests. Roles checked on every manifest/change. Render no cursors inferred from raw screen pixels. Persist reconnect credentials only in the local session directory and never log them.
- [ ] Rerun e2e and protocol tests; expect passing. Commit.

## Task 5: Toolbar and file-session controls

**Files:** create `shell/share.js`, `tests/share.test.mjs`; modify `shell/topbar.js`, `shell/shell.css`, `shell/app.js`, `shell/ui.js` only as needed.

**Consumes:** Task 4 session API. **Produces:** accessible Share dialog, invite join flow, participant/progress toolbar and explicit export to personal Files. Outlook shows no Share; no active session when merely visiting an app.

- [ ] Browser tests: choosing explicit files, create/copy invitation, join size preview, participant count/progress, lock/remove/role changes, local export with collision-safe naming, keyboard/Escape, narrow viewport and unavailable backend error. Existing personal save/open unchanged.
- [ ] Run `node --test tests/share.test.mjs`; expect missing Share control.
- [ ] Implement using existing DOM/modal helpers and shell styles. Label initial capability `File sharing`; do not claim live editing. Keep incomplete production feature disabled unless session service and TURN are configured. Document local dev startup.
- [ ] Run tests plus existing toolbar/files/shell checks. Inspect screenshot and keyboard behavior. Commit.

## Task 6: Relay verification and review

**Files:** README documentation and deployment configuration only if needed by verified setup.

- [ ] Run all new tests and relevant existing checks. Run bare `npm test` once and report unrelated existing failures by name instead of silently discarding them.
- [ ] Use available Cloudflare account credentials to inspect/provision TURN only within existing authorized account and test deployment. Never print secrets. If permissions or billing block it, finish local work and record the exact remaining configuration.
- [ ] Forced-relay browser test must verify the selected ICE candidate pair is a relay and transfer hashes match across three browsers. Without credentials, explicitly record unverified; do not deploy the feature publicly.
- [ ] Run one fresh whole-branch review via executing-plans. Resolve security/data-loss findings with regression tests, then commit fixes.
- [ ] Record foundation status and begin the Honeydew model audit/spec. Do not call the full multi-app collaboration request complete.
