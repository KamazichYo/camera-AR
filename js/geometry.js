// Геометрия: гомографии 3x3 (row-major, 9 чисел), четырёхугольники [[x,y]x4].

export const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Гомография, переводящая 4 точки src в 4 точки dst. */
export function homographyFromQuads(src, dst) {
  // Решаем 8x8 систему методом Гаусса с выбором главного элемента.
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = new Array(9);
  for (let i = 0; i < n; i++) h[i] = A[i][n] / A[i][i];
  h[8] = 1;
  return h;
}

export function multiply(A, B) {
  const R = new Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      R[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return R;
}

export function invert(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}

export function apply(H, [x, y]) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export const applyQuad = (H, q) => q.map((p) => apply(H, p));

/** Масштабирующая матрица (для перехода между системами координат). */
export const scaling = (s) => [s, 0, 0, 0, s, 0, 0, 0, 1];

/** CSS matrix3d для элемента размером w×h, чтобы его углы легли на quad. */
export function cssMatrix3d(w, h, quad) {
  const H = homographyFromQuads([[0, 0], [w, 0], [w, h], [0, h]], quad);
  if (!H) return null;
  const n = H.map((v) => v / H[8]);
  // column-major: a d 0 g / b e 0 h / 0 0 1 0 / c f 0 1
  const m = [n[0], n[3], 0, n[6], n[1], n[4], 0, n[7], 0, 0, 1, 0, n[2], n[5], 0, 1];
  return `matrix3d(${m.map((v) => +v.toFixed(10)).join(',')})`;
}

export function signedArea(q) {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const [x1, y1] = q[i];
    const [x2, y2] = q[(i + 1) % q.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/** Выпуклый невырожденный четырёхугольник с обходом по часовой (в экранных координатах). */
export function isConvexQuad(q, minArea = 1) {
  if (!q || q.length !== 4 || q.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
    const cr = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cr) < 1e-9) return false;
    const s = Math.sign(cr);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return Math.abs(signedArea(q)) >= minArea;
}

export function centroid(q) {
  let x = 0, y = 0;
  for (const p of q) { x += p[0]; y += p[1]; }
  return [x / q.length, y / q.length];
}

export function pointInQuad(q, [x, y]) {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const [xi, yi] = q[i], [xj, yj] = q[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Подобие (масштаб s, поворот a вокруг точки c, затем сдвиг t). */
export function similarity(q, { c = [0, 0], s = 1, a = 0, t = [0, 0] }) {
  const cos = Math.cos(a) * s, sin = Math.sin(a) * s;
  return q.map(([x, y]) => {
    const dx = x - c[0], dy = y - c[1];
    return [c[0] + dx * cos - dy * sin + t[0], c[1] + dx * sin + dy * cos + t[1]];
  });
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Прямоугольник w×h, вписанный в рамку (cx, cy, maxW, maxH). */
export function fitRect(w, h, cx, cy, maxW, maxH) {
  const s = Math.min(maxW / w, maxH / h);
  const hw = (w * s) / 2, hh = (h * s) / 2;
  return [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx + hw, cy + hh], [cx - hw, cy + hh]];
}

/**
 * Вписать картинку с соотношением сторон aspect в четырёхугольник холста с сохранением
 * пропорций. Реальные пропорции холста оцениваются по средним длинам сторон.
 */
export function fitIntoQuad(aspect, quad) {
  const top = dist(quad[0], quad[1]), bottom = dist(quad[3], quad[2]);
  const left = dist(quad[0], quad[3]), right = dist(quad[1], quad[2]);
  const canvasAspect = (top + bottom) / (left + right);
  let u0 = 0, u1 = 1, v0 = 0, v1 = 1;
  if (aspect > canvasAspect) {
    const hgt = canvasAspect / aspect;
    v0 = (1 - hgt) / 2; v1 = v0 + hgt;
  } else {
    const wid = aspect / canvasAspect;
    u0 = (1 - wid) / 2; u1 = u0 + wid;
  }
  const H = homographyFromQuads([[0, 0], [1, 0], [1, 1], [0, 1]], quad);
  return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map((p) => apply(H, p));
}

/** Упорядочить 4 точки: TL, TR, BR, BL. */
export function orderQuad(pts) {
  const c = centroid(pts);
  const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
  // начинаем с точки с минимальной суммой x+y (верхний левый)
  let k = 0;
  sorted.forEach((p, i) => { if (p[0] + p[1] < sorted[k][0] + sorted[k][1]) k = i; });
  return [...sorted.slice(k), ...sorted.slice(0, k)];
}

/**
 * Фильтр Калмана с постоянной скоростью для четырёх углов (8 независимых каналов).
 * Позы приходят нерегулярно (~10–25 Гц, с шумом), а показывать нужно на моменте показанного видеокадра:
 * update(q, t) вливает измерение, predict(t) отдаёт сглаженное положение на момент t — с экстраполяцией
 * по оценённой скорости (не дальше maxLead мс, чтобы не «улетать», если позы перестали приходить).
 *  accel — шум ускорения, px/с² (насколько резко может менять движение);
 *  meas  — шум измерения позы, px.
 */
export class QuadKalman {
  constructor({ accel = 1200, meas = 0.5, maxLead = 120, gate = 40 } = {}) {
    Object.assign(this, { accel, meas, maxLead, gate });
    this.reset();
  }
  reset() { this.c = null; this.t = 0; }
  update(q, t) {
    const z = q.flat();
    const R = this.meas * this.meas;
    const init = () => { this.c = z.map((v) => ({ x: v, v: 0, p00: R, p01: 0, p11: 250000 })); this.t = t; };
    if (!this.c || t - this.t > 400 || t <= this.t) return init();
    const dt = (t - this.t) / 1000;
    const qa = this.accel * this.accel;
    // скачок позы (перепривязка трекера) — не сглаживаем, а принимаем как есть
    let jump = false;
    for (let k = 0; k < 8; k += 2) {
      const c0 = this.c[k], c1 = this.c[k + 1];
      if (Math.hypot(z[k] - (c0.x + c0.v * dt), z[k + 1] - (c1.x + c1.v * dt)) > this.gate) jump = true;
    }
    if (jump) return init();
    this.c.forEach((c, k) => {
      const x1 = c.x + c.v * dt;
      const P00 = c.p00 + 2 * dt * c.p01 + dt * dt * c.p11 + qa * dt ** 4 / 4;
      const P01 = c.p01 + dt * c.p11 + qa * dt ** 3 / 2;
      const P11 = c.p11 + qa * dt * dt;
      const S = P00 + R, K0 = P00 / S, K1 = P01 / S, y = z[k] - x1;
      c.x = x1 + K0 * y;
      c.v += K1 * y;
      c.p00 = (1 - K0) * P00;
      c.p01 = (1 - K0) * P01;
      c.p11 = P11 - K1 * P01;
    });
    this.t = t;
  }
  /** Положение углов на момент t (мс). extrapolate=false — без экстраполяции по скорости. */
  predict(t, extrapolate = true) {
    if (!this.c) return null;
    const lead = extrapolate ? Math.min(this.maxLead, Math.max(0, t - this.t)) / 1000 : 0;
    const o = this.c.map((c) => c.x + c.v * lead);
    return [[o[0], o[1]], [o[2], o[3]], [o[4], o[5]], [o[6], o[7]]];
  }
}
