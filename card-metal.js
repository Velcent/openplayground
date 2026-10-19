// A liquid-metal border on the hovered card: Paper Shaders' Liquid Metal (Apache-2.0), with the settings of the
// 21st.dev Liquid Metal Button. One shader for the whole page, made on the first hover and moved into whichever card
// is hovered or focused (a WebGL context per card would run into the browser's limit); CSS masks it to a ring.

import { liquidMetalFragmentShader, ShaderMount } from '@paper-design/shaders'

const ring = document.createElement('div')
ring.className = 'metal-ring'
ring.setAttribute('aria-hidden', 'true')
const surface = document.createElement('div')
surface.className = 'metal-surface'
ring.append(surface)

const still = matchMedia('(prefers-reduced-motion: reduce)')
let mount = null
let stopping = 0

const show = (card) => {
  if (!card || ring.parentElement === card) return
  card.append(ring)
  clearTimeout(stopping)
  mount ??= new ShaderMount(surface, liquidMetalFragmentShader, {
    u_repetition: 4, u_softness: 0.5, u_shiftRed: 0.3, u_shiftBlue: 0.3, u_distortion: 0, u_contour: 0,
    u_angle: 45, u_scale: 8, u_shape: 1, u_offsetX: 0.1, u_offsetY: -0.1,
  }, undefined, 0)
  mount.setSpeed(still.matches ? 0 : 1)
}
// After the ring fades out the shader stops, so an idle page draws nothing.
const hide = () => {
  clearTimeout(stopping)
  stopping = setTimeout(() => mount?.setSpeed(0), 400)
}

for (const card of document.querySelectorAll('.tool')) {
  card.addEventListener('pointerenter', () => show(card))
  card.addEventListener('pointerleave', hide)
  card.addEventListener('focusin', () => show(card))
  card.addEventListener('focusout', hide)
}
