// The upstream release starts light and saves no preferences. Pick dark once through its theme toggle.
// shortcut: toggle position verified on v0.5.1; recheck before enabling another release.
if (tool.tag === 'v0.5.1' && matchMedia('(prefers-color-scheme: dark)').matches) {
  addEventListener('TrunkApplicationStarted', () => {
    const step = () => new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 120))
    const timer = setInterval(() => {
      const canvas = document.getElementById('figcraft_canvas')
      if (!canvas || document.getElementById('figcraft_loading')) return
      clearInterval(timer)
      withInputHeld(async () => {
        await step()
        const rect = canvas.getBoundingClientRect()
        const at = { bubbles: true, cancelable: true, clientX: rect.right - 24, clientY: rect.top + 20, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }
        canvas.dispatchEvent(new MouseEvent('mousemove', at))
        await step()
        canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, buttons: 1 }))
        await step()
        canvas.dispatchEvent(new PointerEvent('pointerup', { ...at, buttons: 0 }))
      })
    }, 100)
    setTimeout(() => clearInterval(timer), 10000)
  }, { once: true })
}
