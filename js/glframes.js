// Кадры камеры в видеопамяти (WebGL): один синхронный снимок кадра идёт и на экран, и в трекер.
//
// Зачем. Раньше кадр для показа и кадр для трекера снимались двумя отдельными асинхронными createImageBitmap(video),
// а «чей это кадр» определялось по меткам времени. На телефоне (iOS особенно) такой снимок занимает десятки
// миллисекунд, и в него может попасть уже следующий кадр камеры: поза относится к одному кадру, а на экране —
// другой, и референс дёргается относительно картинки. Здесь кадр камеры загружается в текстуру синхронно, прямо
// в обработчике «пришёл новый кадр»; из этой же текстуры делается уменьшенная копия для трекера и рисуется картинка
// на экране. Поза и картинка относятся к одному и тому же кадру по построению, без подгонки по времени.
//
// Ориентация: у всех текстур строка 0 — верх кадра (как загружает texImage2D). Промежуточные проходы её сохраняют,
// поэтому readPixels отдаёт строки сверху вниз; переворот — только при выводе на экран.

// rot — поворот снимаемого кадра по часовой (0–3 четверти): кадр камеры приводится к ориентации, закреплённой в AR
import { drawRotated } from './orient.js';

const VS = `
attribute vec2 p;
uniform float flip;
uniform float rot;
varying vec2 uv;
void main() {
  vec2 t = vec2(p.x * 0.5 + 0.5, flip > 0.5 ? 0.5 - p.y * 0.5 : p.y * 0.5 + 0.5);
  if (rot > 0.5 && rot < 1.5) t = vec2(t.y, 1.0 - t.x);
  else if (rot > 1.5 && rot < 2.5) t = vec2(1.0 - t.x, 1.0 - t.y);
  else if (rot > 2.5) t = vec2(1.0 - t.y, t.x);
  uv = t;
  gl_Position = vec4(p, 0.0, 1.0);
}`;
const PREC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 uv;
uniform sampler2D t;
`;
const FS_COPY = PREC + `
void main() { gl_FragColor = vec4(texture2D(t, uv).rgb, 1.0); }`;
// Уменьшение с усреднением по площади: 4×4 билинейных выборки на пиксель результата (до ≈ 8 раз без «лесенок» и
// мерцания мелких деталей — для трекера это шум в положении краёв и точек)
const FS_BOX = PREC + `
uniform vec2 px;
void main() {
  vec3 s = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    for (int j = 0; j < 4; j++) {
      s += texture2D(t, uv + ((vec2(float(i), float(j)) + 0.5) / 4.0 - 0.5) * px).rgb;
    }
  }
  gl_FragColor = vec4(s / 16.0, 1.0);
}`;

export class GlFrames {
  /** canvas — куда рисуется картинка; slots — сколько кадров хранить. Бросает исключение, если WebGL недоступен. */
  constructor(canvas, slots) {
    this.canvas = canvas;
    const opts = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' };
    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) throw new Error('WebGL недоступен');
    this.gl = gl;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    this.n = slots;
    this.copy = this._program(FS_COPY);
    this.box = this._program(FS_BOX);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.up = this._texture();          // кадр камеры как есть (размер видео)
    this.ring = [];                     // { tex, fbo, free }
    this.proc = null;                   // { tex, fbo, w, h } — уменьшенный кадр для трекера
    this.bw = 0; this.bh = 0;
    this.upMs = 0; this.readMs = 0;     // скользящие средние: загрузка кадра в текстуру и чтение кадра для трекера
  }

  _program(fsSrc) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('шейдер: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.bindAttribLocation(p, 0, 'p');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('программа: ' + gl.getProgramInfoLog(p));
    return { p, flip: gl.getUniformLocation(p, 'flip'), rot: gl.getUniformLocation(p, 'rot'), t: gl.getUniformLocation(p, 't'), px: gl.getUniformLocation(p, 'px') };
  }

  _texture(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (w) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return tex;
  }

  _target(w, h) {
    const gl = this.gl;
    const tex = this._texture(w, h);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('буфер кадра не собран');
    return { tex, fbo, w, h };
  }

  /** Размер хранимых кадров (и холста показа). Все хранимые кадры сбрасываются. */
  resize(bw, bh) {
    const gl = this.gl;
    for (const r of this.ring) { gl.deleteTexture(r.tex); gl.deleteFramebuffer(r.fbo); }
    this.ring = [];
    this.bw = bw; this.bh = bh;
    this.canvas.width = bw; this.canvas.height = bh;
    for (let i = 0; i < this.n; i++) this.ring.push({ ...this._target(bw, bh), free: true });
  }

  _pass(prog, tex, fbo, w, h, flip, px, rot = 0) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(prog.t, 0);
    gl.uniform1f(prog.flip, flip ? 1 : 0);
    gl.uniform1f(prog.rot, rot);
    if (prog.px && px) gl.uniform2f(prog.px, px[0], px[1]);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Снять текущий кадр видео в свободную ячейку, повернув на rot° по часовой. Возвращает номер ячейки или −1. */
  capture(video, rot = 0) {
    if (this.lost) return -1;
    const i = this.ring.findIndex((r) => r.free);
    if (i < 0) return -1;
    const gl = this.gl;
    const t0 = performance.now();
    gl.bindTexture(gl.TEXTURE_2D, this.up);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    const r = this.ring[i];
    // уменьшение до двух раз билинейная выборка делает чисто; сильнее — с усреднением по площади
    const q = Math.round(rot / 90) & 3, sw = q & 1 ? r.h : r.w, sh = q & 1 ? r.w : r.h; // ячейка в осях источника
    const ratio = Math.max(video.videoWidth / sw, video.videoHeight / sh);
    if (ratio > 2.05) this._pass(this.box, this.up, r.fbo, r.w, r.h, false, [1 / sw, 1 / sh], q);
    else this._pass(this.copy, this.up, r.fbo, r.w, r.h, false, null, q);
    r.free = false;
    this.upMs += 0.1 * (performance.now() - t0 - this.upMs);
    return i;
  }

  release(i) { if (i >= 0 && this.ring[i]) this.ring[i].free = true; }

  /** Нарисовать кадр из ячейки на экранный холст. */
  draw(i) {
    if (this.lost || !this.ring[i]) return;
    this._pass(this.copy, this.ring[i].tex, null, this.bw, this.bh, true);
  }

  /** Уменьшенная копия кадра из ячейки: RGBA, строки сверху вниз. out — готовый буфер нужного размера (или будет новый). */
  read(i, w, h, out = null) {
    if (this.lost || !this.ring[i]) return null;
    const gl = this.gl;
    if (!this.proc || this.proc.w !== w || this.proc.h !== h) {
      if (this.proc) { gl.deleteTexture(this.proc.tex); gl.deleteFramebuffer(this.proc.fbo); }
      this.proc = this._target(w, h);
    }
    const t0 = performance.now();
    if (Math.max(this.bw / w, this.bh / h) > 1.5) this._pass(this.box, this.ring[i].tex, this.proc.fbo, w, h, false, [1 / w, 1 / h]);
    else this._pass(this.copy, this.ring[i].tex, this.proc.fbo, w, h, false);
    if (!out || out.length !== w * h * 4) out = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    if (w > 32) this.readMs += 0.1 * (performance.now() - t0 - this.readMs);
    return out;
  }

  dispose() {
    const gl = this.gl;
    for (const r of this.ring) { gl.deleteTexture(r.tex); gl.deleteFramebuffer(r.fbo); }
    this.ring = [];
    if (this.proc) { gl.deleteTexture(this.proc.tex); gl.deleteFramebuffer(this.proc.fbo); this.proc = null; }
  }
}

/**
 * Самопроверка: совпадает ли кадр, снятый через WebGL, с тем, что рисует обычный drawImage(video) (ориентация, не чёрный
 * ли он). true — совпадает, false — нет, null — по этому кадру не понять (однотонная картинка).
 */
export function checkAgainst2d(frames, slot, video, rot = 0) {
  const N = 16;
  const g = frames.read(slot, N, N);
  if (!g) return false;
  const c = document.createElement('canvas');
  c.width = N; c.height = N;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  drawRotated(ctx, video, video.videoWidth, video.videoHeight, rot, N, N);
  const d = ctx.getImageData(0, 0, N, N).data;
  const lum = (a, k) => 0.299 * a[k] + 0.587 * a[k + 1] + 0.114 * a[k + 2];
  let ma = 0, mb = 0;
  const A = [], B = [];
  for (let k = 0; k < N * N * 4; k += 4) { const a = lum(g, k), b = lum(d, k); A.push(a); B.push(b); ma += a; mb += b; }
  ma /= A.length; mb /= B.length;
  let saa = 0, sbb = 0, sab = 0;
  for (let k = 0; k < A.length; k++) { saa += (A[k] - ma) ** 2; sbb += (B[k] - mb) ** 2; sab += (A[k] - ma) * (B[k] - mb); }
  if (Math.sqrt(sbb / A.length) < 6) return mb > 24 && ma < 6 ? false : null; // однотонно: ловим только «чёрный кадр»
  return sab / Math.sqrt(saa * sbb || 1) > 0.6;
}
