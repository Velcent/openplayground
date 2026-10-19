// The home page's background in the normal theme: the "Neuro Noise" shader, glowing filaments drifting over black,
// on one WebGL canvas behind the page. Adapted from the 21st.dev Shader Builder's export of Paper Shaders' Neuro Noise
// (https://shaders.paper.design/neuro-noise, Apache-2.0), reduced to the parameters it uses. The night theme ("Use
// latest commits") keeps its stars: there the canvas fades out and stops drawing. Reduced motion draws one still frame.

const VERT = `attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`

const FRAG = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec3 u_colors[4];
uniform vec3 u_scene; // resolution.xy, time
const float SCALE = 1.26;
const float INTENSITY = 0.35;
const float GLOW = 0.28;
const float GRAIN = 0.042;
const float SEED = 1.0;

vec3 palette(float x) {
  float f = clamp(x, 0.0, 1.0) * 3.0;
  vec3 col = u_colors[0];
  col = mix(col, u_colors[1], smoothstep(0.0, 1.0, clamp(f, 0.0, 1.0)));
  col = mix(col, u_colors[2], smoothstep(0.0, 1.0, clamp(f - 1.0, 0.0, 1.0)));
  col = mix(col, u_colors[3], smoothstep(0.0, 1.0, clamp(f - 2.0, 0.0, 1.0)));
  return col;
}

// Even white noise for the film grain (Dave Hoskins' hash12).
float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_scene.xy) / min(u_scene.x, u_scene.y) * SCALE;
  float t = u_scene.z;
  vec2 q = p * (1.6 + INTENSITY * 2.4);
  float field = 0.0;
  float weight = 0.55;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    q += vec2(
      sin(q.y * (1.7 + fi * 0.09) + t * (0.35 + fi * 0.04) + SEED),
      cos(q.x * (1.5 + fi * 0.11) - t * (0.28 + fi * 0.03))
    ) * (0.22 + INTENSITY * 0.14);
    field += weight / (0.08 + abs(sin(q.x + q.y + fi * 0.72)));
    weight *= 0.62;
    q = q.yx * vec2(-1.08, 1.04);
  }
  vec3 col = palette(1.0 - exp(-field * (0.018 + GLOW * 0.04)));
  col = (col - 0.5) * 1.005 + 0.5;
  col += (grainHash(gl_FragCoord.xy + vec2(SEED * 17.0, SEED * 31.0)) - 0.5) * GRAIN;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`

// Near-black violet, deep purple, magenta, warm yellow.
const COLORS = [[7, 3, 13], [42, 10, 72], [214, 41, 118], [255, 218, 121]].flat().map((c) => c / 255)
const TIME_SCALE = 0.575

const canvas = document.createElement('canvas')
canvas.className = 'shader-bg'
canvas.setAttribute('aria-hidden', 'true')
document.body.prepend(canvas)
const gl = canvas.getContext('webgl', { antialias: false })

if (gl) {
  const shader = (type, src) => {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    return s
  }
  const program = gl.createProgram()
  gl.attachShader(program, shader(gl.VERTEX_SHADER, VERT))
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(program)
  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'a_position')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  gl.uniform3fv(gl.getUniformLocation(program, 'u_colors'), new Float32Array(COLORS))
  const scene = gl.getUniformLocation(program, 'u_scene')

  const still = matchMedia('(prefers-reduced-motion: reduce)')
  const start = performance.now()
  let raf = 0

  // At most about two million pixels, so a large screen doesn't cost more GPU than the effect is worth.
  const resize = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(innerWidth * dpr)), h = Math.max(1, Math.round(innerHeight * dpr))
    const k = Math.min(1, Math.sqrt(2e6 / (w * h)))
    canvas.width = Math.round(w * k)
    canvas.height = Math.round(h * k)
    gl.viewport(0, 0, canvas.width, canvas.height)
  }
  const shown = () => document.visibilityState === 'visible' && document.documentElement.dataset.channel !== 'head'
  const draw = (now) => {
    raf = 0
    gl.uniform3f(scene, canvas.width, canvas.height, still.matches ? 0 : ((now - start) / 1000) * TIME_SCALE)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (!still.matches && shown()) raf = requestAnimationFrame(draw)
  }
  const update = () => {
    if (shown() && !raf) raf = requestAnimationFrame(draw)
  }

  resize()
  addEventListener('resize', () => { resize(); if (!raf) raf = requestAnimationFrame(draw) })
  document.addEventListener('visibilitychange', update)
  still.addEventListener('change', update)
  new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ['data-channel'] })
  raf = requestAnimationFrame(draw)
}
