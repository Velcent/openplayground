// Inlined at the top of every app page by fetch.mjs, before the app's own scripts run. fetch.mjs
// defines `tool` just above this: { name, accent } from tools.yaml and `wasm`, each .wasm's unzipped size.

const mb = (bytes) => (bytes / 1e6).toFixed(1)

// For theme scripts that click through an app's own menus: run `steps` with the user's real mouse, touch
// and keyboard input held back from the app, so a moving (or resting) pointer can't pull the app's hover
// off the menu mid-sequence. Released when the steps finish, or after 10s at most.
const withInputHeld = async (steps) => {
  const types = ['pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointercancel',
    'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'click', 'contextmenu', 'wheel',
    'touchstart', 'touchmove', 'touchend', 'touchcancel', 'keydown', 'keyup', 'keypress']
  const hold = (e) => e.isTrusted && e.stopImmediatePropagation()
  const release = () => types.forEach((t) => removeEventListener(t, hold, true))
  types.forEach((t) => addEventListener(t, hold, true))
  const failsafe = setTimeout(release, 10000)
  try {
    return await steps()
  } finally {
    clearTimeout(failsafe)
    release()
  }
}

// Download/unzip progress, shown under the app's own loading text until the .wasm is unpacked.
const progressUI = (total, download) => {
  const box = document.createElement('div')
  box.style.cssText =
    'position:fixed;left:50%;top:calc(50% + 56px);transform:translateX(-50%);z-index:2147483647;display:grid;' +
    'gap:6px;justify-items:center;font:12px/1.4 system-ui,sans-serif;color:#8d8d93;pointer-events:none'
  const bar = document.createElement('progress')
  bar.style.cssText = `width:220px;accent-color:${tool.accent}`
  if (total) bar.max = total
  const label = document.createElement('span')
  box.append(bar, label)
  document.body.append(box)
  // Just below the app's own loading screen (#<app>_loading or #loading), measured by what's shown in it: the
  // element itself often fills the page, and some hold hidden messages (PhotoCraft's "taking longer than
  // usual"). Apps whose screen is taller than usual would otherwise overlap it.
  const place = () => {
    const screen = document.querySelector('[id$="_loading"], #loading')
    let bottom = 0
    for (const node of screen?.childNodes ?? []) {
      if (node.nodeType === Node.ELEMENT_NODE && node.checkVisibility?.({ visibilityProperty: true }) === false) continue
      if (node.nodeType === Node.TEXT_NODE && !node.textContent.trim()) continue
      const range = document.createRange()
      range.selectNode(node)
      const r = range.getBoundingClientRect()
      if (r.height) bottom = Math.max(bottom, r.bottom)
    }
    if (bottom) box.style.top = `${Math.round(bottom + 14)}px`
  }
  place()
  return {
    progress(bytes) {
      place()
      if (total) bar.value = bytes
      const pct = total ? ` · ${Math.floor((100 * bytes) / total)}%` : ''
      label.textContent = `Downloading and extracting${pct}${download ? ` of ${mb(download)} MB` : ''}`
    },
    done: () => box.remove(),
  }
}

// The apps' Ctrl/Cmd shortcuts also trigger the browser's own action (eframe only blocks Ctrl+S/O/P/,):
// Ctrl+Z undoes in eframe's hidden text field, Ctrl+D bookmarks, Ctrl+J opens downloads, Ctrl+-/= zoom the
// page. Cancel the browser's action; the app still gets the key. Copy, paste, cut, select all, reload,
// tab switching (Ctrl+1-9) and the developer tools stay the browser's.
addEventListener(
  'keydown',
  (e) => {
    if (e.target instanceof Element && e.target.closest('.pg-bar, .pg-modal, .pg-toasts, .pg-stack')) return
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return
    const k = e.key.toLowerCase()
    if (k.length !== 1 || 'cvxar123456789'.includes(k) || (e.shiftKey && 'ijc'.includes(k))) return
    e.preventDefault()
  },
  true,
)

// eframe only hands pasted text to the app, so pasting a screenshot or a copied image did nothing. Give
// an image-only paste to the app as a file dropped on the middle of its canvas, which every app opens or
// places. Text pastes stay eframe's.
addEventListener(
  'paste',
  (e) => {
    if (e.target instanceof Element && e.target.closest('.pg-bar, .pg-modal, .pg-toasts, .pg-stack')) return
    const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    const canvas = document.querySelector('canvas')
    if (!images.length || !canvas || e.clipboardData.getData('text')) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const dataTransfer = new DataTransfer()
    for (const f of images) dataTransfer.items.add(new File([f], f.name || `pasted.${f.type.split('/')[1]}`, { type: f.type }))
    const r = canvas.getBoundingClientRect()
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, dataTransfer }
    for (const type of ['dragenter', 'dragover', 'drop']) canvas.dispatchEvent(new DragEvent(type, at))
  },
  true,
)

// The app's .wasm files are stored gzipped (.wasm.gz) to fit the host's 25 MiB file limit: fetch the .gz and
// unzip it on the fly, so the app's loader still sees a normal application/wasm response. One still over the
// limit is split into parts (.wasm.gz.0, .1, …: tool.parts), fetched together and joined in order first. Other
// .wasm files (the plug-ins in plugins/) are fetched as they are.
const fetchOriginal = window.fetch
const fetchParts = (url, init, parts) =>
  Promise.all(Array.from({ length: parts }, (_, i) => fetchOriginal(`${url}.${i}`, init))).then((all) => {
    const failed = all.find((res) => !res.ok)
    if (failed) return failed
    const body = new ReadableStream({
      async start(c) {
        for (const res of all) {
          const reader = res.body.getReader()
          for (let read; !(read = await reader.read()).done; ) c.enqueue(read.value)
        }
        c.close()
      },
    })
    return new Response(body, { headers: { 'content-length': String(all.reduce((n, res) => n + Number(res.headers.get('content-length')), 0)) } })
  })
window.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input, location.href)
  const name = url.pathname.split('/').pop()
  const total = tool.wasm[name]
  if (!url.pathname.endsWith('.wasm') || total === undefined) return fetchOriginal(input, init)
  url.pathname += '.gz'
  const parts = tool.parts?.[name]
  return (parts ? fetchParts(url, init, parts) : fetchOriginal(url, init)).then((res) => {
    if (!res.ok) return res
    const ui = progressUI(total, Number(res.headers.get('content-length')))
    // A host that sends Content-Encoding: gzip (Vite's dev server does) has had the browser unzip it already.
    const unzipped = /gzip/.test(res.headers.get('content-encoding') ?? '')
    let received = 0
    const body = (unzipped ? res.body : res.body.pipeThrough(new DecompressionStream('gzip'))).pipeThrough(
      new TransformStream({
        transform(chunk, c) {
          ui.progress((received += chunk.byteLength))
          c.enqueue(chunk)
        },
        flush: ui.done,
      }),
    )
    return new Response(body, { headers: { 'content-type': 'application/wasm' } })
  })
}
