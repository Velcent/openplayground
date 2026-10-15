# OpenPlayground

Use open-source, clean-room alternatives to popular creative and office apps, by [ArtCraft](https://github.com/storytold) and others, in your browser.

Releases are fetched every 15min.

> [!NOTE]
> Note: Hardware accelerated GPU is highly recommended!

### Optimizations

- Apps are recompiled with -O3 & SIMD acceleration
- WASM files compressed with gzip for faster load time
- Compile shaders in the background to prevent hanging
- Render viewers on the page's own GPU instead of in background workers
- Video frames are copied straight to the GPU as YUV & skips late frames so stacked clips play smoother
- Preload neighboring photos in background workers so LightCraft and LightCraft Classic don't freeze

### Features

- [Community plugins](https://github.com/akkk09/artcraft-store) integration
- Support for reading your system's fonts
- Dark theme follows your system preference
- Workaround to enable clipboard access
- In browser file explorer & file menu (draggable into your apps)

### Trademarks

This site and the apps it serves are not affiliated with, endorsed by or sponsored by Adobe, Microsoft, Autodesk, Avid, Image-Line or Figma, Inc. Photoshop, Illustrator, InDesign, Lightroom, Premiere Pro, After Effects, Acrobat and Substance Painter are trademarks of Adobe; Word, Excel, PowerPoint and Outlook of Microsoft; AutoCAD and Fusion 360 of Autodesk; Pro Tools of Avid; FL Studio and FL Studio Mobile of Image-Line; Figma of Figma, Inc. Their names appear only to say which product each open-source app is an alternative to.

### Peer file-sharing development

The collaboration branch adds private browser-to-browser file sessions. This is file sharing only;
app-specific live editing adapters are still in development. Production stays disabled with
`SESSIONS_ENABLED: "false"` in `wrangler.jsonc`.

For local development, run `npm run build`, then start these in separate terminals:

```sh
npx wrangler dev --var SESSIONS_ENABLED:true
SESSION_API=http://localhost:8787 npm run dev
```

Open the Vite address in separate browser profiles. Share explicitly chosen files, copy an editor or
viewer invitation, and accept the file list in the receiving browser. Session files live in a separate
OPFS folder, `playground-sessions`; personal Files are unchanged. Reopen a local session from Share to
export its files or reconnect. Closing the last browser makes its files unavailable to other people
until a participant with a copy returns. A new participant needs an owner/editor online to announce
the file list; a viewer can send already-known verified assets but cannot announce new files.

Before enabling the service publicly, configure `TURN_KEY_ID` and `TURN_API_TOKEN` as Worker secrets
from a Cloudflare Realtime TURN key, and verify an actual relay transfer. The existing Wrangler OAuth
login does not have Calls/TURN API permissions. These credentials have not been provisioned, and relay
connectivity has not yet been verified. Local tests currently exercise direct connections.

With those credentials in the ignored `.dev.vars` file, run the same three-browser transfer through
TURN. The test forces relay transport and checks the selected ICE candidates as well as the file bytes:

```sh
SESSION_RELAY=1 node --env-file=.dev.vars --test tests/session.e2e.test.mjs
```

No files, filenames, project history or decryption secrets are written to the room service. It retains
only admission metadata and forwards encrypted signaling. A room is limited to eight admitted members;
the owner can remove online or offline members to free a place. Removing someone invalidates old
invitation links but cannot erase files they already received. Opening the same session in a second
tab stops the first tab's connection; both keep their local copies.
