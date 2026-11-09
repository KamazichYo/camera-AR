/* AR-трекер холста. Работает в Web Worker, использует OpenCV.js (WASM).
 *
 * Конвейер на каждый кадр (координаты — пиксели уменьшенного кадра, ~640 px):
 *  1. Подготовка: серое изображение + локальная нормализация контраста (LCN) —
 *     убирает влияние автоэкспозиции, теней от руки и неравномерного света.
 *  2. Прогноз: точки отслеживаются пирамидальным Лукасом–Канаде (проверка
 *     вперёд-назад), гомография считается RANSAC-ом. Если точек нет (пустой
 *     холст) — прогноз по постоянной скорости.
 *  3. Релокализация (при потере и периодически): ORB-дескрипторы против
 *     ключевых кадров; для пустого холста — поиск четырёхугольника по форме.
 *  4. Измерения без дрейфа:
 *     – шаблон: кадр «разворачивается» в опорные координаты и сравнивается
 *       с шаблоном холста (LK) → пары точек «опорный кадр ↔ текущий»;
 *     – края: вдоль каждой стороны холста ищется перепад яркости нужной
 *       полярности (бумага светлее/темнее фона), прямые — RANSAC-ом.
 *  5. Совместная оптимизация позы (Гаусс–Ньютон, функция Хьюбера) по точкам
 *     и краям. Параметры — 4 угла холста на кадре: хорошо обусловлено и
 *     работает и для холста с рисунком, и для пустого листа.
 *  6. Обслуживание: перепривязка точек, обновление шаблона и ключевых кадров
 *     по мере того, как рисунок меняется.
 */
/* global cv */
'use strict';

const CFG = {
  maxCorners: 160,
  minCorners: 25,
  cornerQuality: 0.006,
  cornerMinDist: 7,
  lkWin: 21,
  lkLevels: 3,
  fbMaxErr: 1.5,          // px — допустимая ошибка проверки вперёд-назад
  lkBackCheck: false,     // межкадровый поток — только прогноз, RANSAC и шаблон отсеют ошибки
  tmplBackCheck: true,    // защита от ложной позы (тёмный/закрытый кадр)
  tmplCorners: 160,       // точек в шаблоне для уточнения позы
  wPersp: 0.6,            // вес штрафа за перспективу в оптимизаторе
  coastMax: 8,            // сколько кадров подряд ехать по инерции при сбое, прежде чем объявить потерю
  edgeGate: 100,            // px: когда поза по потоку надёжна, край ищется только в такой окрестности предсказания
  envEdgeErr: 4.5,        // px: края листа стабильно дальше этого от позы по фону — лист двигают отдельно от окружения
  liteMs: 55,             // среднее время кадра выше этого (слабый телефон) — включается облегчённый режим (ниже 0.75× — выключается)
  anchorPts: 14,          // сколько точек потока держим в каждой опорной области
  anchorR: 34,            // px (кадра анализа): радиус опорной области
  autoEnvPts: 30,        // меньше стольких собственных точек у холста (пустая бумага) — окружение подключается само
  eccEvery: 8,            // как часто (в кадрах) выравнивать по заплатке, когда точек хватает (богатая фактура)
  eccSparse: 70,          // меньше стольких точек потока — подключаем плотное выравнивание (ECC)
  minPointStd: 6,         // минимальный локальный контраст точки (уровней) — не цепляться за шум
  ransacRefine: 2.0,      // px
  minRefine: 10,
  ransacLK: 2.5,          // px
  ransacORB: 4.0,         // px
  orbFeatures: 900,
  ratio: 0.78,            // тест Лоу
  minInliersLK: 8,
  minInliersORB: 16,
  relocEvery: 20,
  relocEnv: 8,            // в режиме окружения абсолютную поверхность проверяем чаще         // кадров между проверками дрейфа (ORB)
  driftFix: 5,            // px — если ORB и трекинг расходятся больше, доверяем ORB
  keyframeEveryMs: 2500,
  maxKeyframes: 6,
  margin: -0.02,          // область точек: чуть внутри холста (край ведёт отдельный трекер,
                          // а фон за краем может двигаться иначе, чем холст)
  lcnBox: 21,             // окно локальной нормализации контраста
  lcnFloor: 64,           // минимальная дисперсия (8² уровней) — не раздувать шум бумаги
  edgeSamples: 28,        // точек поиска на каждую сторону холста
  edgeRadius: 10,         // px — радиус поиска края по нормали
  edgeMinContrast: 10,    // уровней яркости — сторона с меньшим перепадом не используется
  edgeMinInliers: 8,
  huber: 1.5,             // px
};

let ready = false;
let W = 0, H = 0;
let rgba = null, gray = null, norm = null, prevNorm = null;
let F32 = null, MU = null, D = null, V = null;
let orb = null, matcher = null;
let offscreen = null, offctx = null;
let st = null; // состояние трекинга
let sel = null; // выбор углов на живом видео: { pts: [{ p, rays, snapped, miss, fail, score }] }

const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Снаружи (главный поток, canvas/CSS) центр пикселя i — это i+0.5, у OpenCV — i.
// Внутри работаем в координатах OpenCV, на входе/выходе переводим.
const inQuad = (q) => q.map(([x, y]) => [x - 0.5, y - 0.5]);
const outQuad = (q) => q.map(([x, y]) => [x + 0.5, y + 0.5]);
const outH = (Hm) => mulH([1, 0, 0.5, 0, 1, 0.5, 0, 0, 1], mulH(Hm, [1, 0, -0.5, 0, 1, -0.5, 0, 0, 1]));
const now = () => performance.now();

// ---------- загрузка OpenCV ----------
async function loadCv(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      importScripts(url);
      let c = self.cv;
      if (!c) throw new Error('cv не определён');
      // Объект модуля emscripten «thenable» — нельзя делать await на нём напрямую
      // (бесконечная рекурсия), поэтому разворачиваем вручную.
      if (!c.Mat) {
        c = await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('таймаут инициализации OpenCV')), 60000);
          c.then((m) => { clearTimeout(t); delete m.then; res(m); });
        });
      }
      self.cv = c;
      return url;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Не удалось загрузить OpenCV');
}

// ---------- кадр ----------
function ensureBuffers(w, h) {
  if (w === W && h === H && gray) return;
  [rgba, gray, norm, prevNorm, F32, MU, D, V].forEach((m) => m && m.delete());
  W = w; H = h;
  rgba = new cv.Mat(h, w, cv.CV_8UC4);
  gray = new cv.Mat(h, w, cv.CV_8UC1);
  norm = new cv.Mat(h, w, cv.CV_8UC1);
  prevNorm = new cv.Mat(h, w, cv.CV_8UC1);
  F32 = new cv.Mat(); MU = new cv.Mat(); D = new cv.Mat(); V = new cv.Mat();
}

/** Кадр приходит либо RGBA-буфером, либо ImageBitmap (тогда пиксели читаются здесь, вне главного потока). */
function loadFrame(msg) {
  const { w, h } = msg;
  ensureBuffers(w, h);
  if (msg.bmp) {
    if (!offscreen || offscreen.width !== w || offscreen.height !== h) {
      offscreen = new OffscreenCanvas(w, h);
      offctx = offscreen.getContext('2d', { willReadFrequently: true });
    }
    offctx.drawImage(msg.bmp, 0, 0, w, h);
    msg.bmp.close();
    rgba.data.set(offctx.getImageData(0, 0, w, h).data);
  } else {
    rgba.data.set(new Uint8Array(msg.buf));
  }
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
}

/** Локальная нормализация контраста: (I − μ) / σ в окне. Инвариантна к яркости и мягким теням. */
function normalize(src, dst) {
  const k = new cv.Size(CFG.lcnBox, CFG.lcnBox);
  src.convertTo(F32, cv.CV_32F);
  cv.blur(F32, MU, k);
  cv.subtract(F32, MU, D);
  cv.multiply(D, D, V);
  cv.blur(V, V, k);
  V.convertTo(V, -1, 1, CFG.lcnFloor);
  cv.sqrt(V, V);
  cv.divide(D, V, D);
  D.convertTo(dst, cv.CV_8U, 42, 128);
}

/** Яркость с билинейной интерполяцией (исходное серое изображение). */
function sample(x, y) {
  if (x < 0 || y < 0 || x > W - 2 || y > H - 2) return NaN;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const d = gray.data, i = y0 * W + x0;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + W] * (1 - fx) + d[i + W + 1] * fx) * fy;
}

// ---------- геометрия ----------
function applyH(Hm, x, y) {
  const w = Hm[6] * x + Hm[7] * y + Hm[8];
  return [(Hm[0] * x + Hm[1] * y + Hm[2]) / w, (Hm[3] * x + Hm[4] * y + Hm[5]) / w];
}
const mapQuad = (Hm, q) => q.map(([x, y]) => applyH(Hm, x, y));

function invertH(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

function mulH(A, B) {
  const R = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) R[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return R;
}

/** Гомография по 4 парам точек (Гаусс с выбором главного элемента). */
function homog4(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    const tmp = A[c]; A[c] = A[p]; A[p] = tmp;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (f) for (let k = c; k <= 8; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = new Array(9);
  for (let i = 0; i < 8; i++) h[i] = A[i][8] / A[i][i];
  h[8] = 1;
  return h;
}

function expandQuad(q, m) {
  const [cx, cy] = centroid(q);
  return q.map(([x, y]) => [cx + (x - cx) * (1 + m), cy + (y - cy) * (1 + m)]);
}

function centroid(q) {
  return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
}

function quadArea(q) {
  let s = 0;
  for (let i = 0; i < 4; i++) s += q[i][0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * q[i][1];
  return s / 2;
}

function convex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const s = Math.sign(cr);
    if (!s) return false;
    if (!sign) sign = s; else if (s !== sign) return false;
  }
  return true;
}

/** Упорядочить 4 точки по часовой стрелке (на экране), начиная с верхней левой. */
function orderIdx(pts) {
  const [cx, cy] = centroid(pts);
  const idx = pts.map((_, i) => i).sort((a, b) => Math.atan2(pts[a][1] - cy, pts[a][0] - cx) - Math.atan2(pts[b][1] - cy, pts[b][0] - cx));
  let k = 0;
  idx.forEach((id, i) => { if (pts[id][0] + pts[id][1] < pts[idx[k]][0] + pts[idx[k]][1]) k = i; });
  return [...idx.slice(k), ...idx.slice(0, k)];
}
function orderQuad(pts) { return orderIdx(pts).map((i) => pts[i]); }

/** Правдоподобие позы: холст выпуклый, без отражения, разумного размера и не улетел. */
function plausible(Hm) {
  if (!Hm || Hm.some((v) => !Number.isFinite(v))) return false;
  const q = mapQuad(Hm, st.quad);
  if (!convex(q)) return false;
  const a0 = quadArea(st.quad), a1 = quadArea(q);
  if (Math.sign(a0) !== Math.sign(a1)) return false;
  const r = Math.abs(a1 / a0);
  if (r < 0.04 || r > 25) return false;
  const lim = 3 * Math.max(W, H);
  return q.every(([x, y]) => x > -lim && x < W + lim && y > -lim && y < H + lim);
}

/** Форма рамки не выродилась: не «щепка» и не сильно сплюснута по сравнению с моментом захвата. */
function shapeOk(Hm) {
  const q = mapQuad(Hm, st.quad);
  const shape = (c) => {
    const L = [0, 1, 2, 3].map((i) => Math.hypot(c[(i + 1) % 4][0] - c[i][0], c[(i + 1) % 4][1] - c[i][1]));
    const ang = [0, 1, 2, 3].map((i) => {
      const p = c[i], a = c[(i + 3) % 4], b = c[(i + 1) % 4];
      const v1 = [a[0] - p[0], a[1] - p[1]], v2 = [b[0] - p[0], b[1] - p[1]];
      return Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / ((Math.hypot(...v1) * Math.hypot(...v2)) || 1))));
    });
    return { ratio: Math.min(...L) / (Math.max(...L) || 1), minAng: Math.min(...ang) };
  };
  if (!st.shape0) st.shape0 = shape(st.quad);
  const c = shape(q);
  return c.ratio >= 0.4 * st.shape0.ratio && c.minAng >= Math.min(0.5, 0.45 * st.shape0.minAng);
}

function quadDist(H1, H2) {
  let s = 0;
  for (const [x, y] of st.quad) {
    const a = applyH(H1, x, y), b = applyH(H2, x, y);
    s += Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  return s / 4;
}

// ---------- маски и признаки ----------
function polyMask(quad) {
  const mask = cv.Mat.zeros(H, W, cv.CV_8UC1);
  const flat = [];
  for (const [x, y] of quad) flat.push(Math.round(Math.max(-4 * W, Math.min(5 * W, x))), Math.round(Math.max(-4 * H, Math.min(5 * H, y))));
  const pts = cv.matFromArray(4, 1, cv.CV_32SC2, flat);
  const mv = new cv.MatVector();
  mv.push_back(pts);
  cv.fillPoly(mask, mv, new cv.Scalar(255));
  mv.delete(); pts.delete();
  return mask;
}

/** Маска области поиска в текущем кадре (по текущей оценке позы). */
function currentMask(Hm) {
  if (st.fullFrame) return new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(255));
  return polyMask(mapQuad(Hm, st.searchQuad));
}

function detectCorners(img, mask, max, exclude, imgNorm) {
  const m = mask.clone();
  if (exclude && exclude.length) {
    for (let i = 0; i < exclude.length; i += 2)
      cv.circle(m, new cv.Point(Math.round(exclude[i]), Math.round(exclude[i + 1])), CFG.cornerMinDist, new cv.Scalar(0), -1);
  }
  const corners = new cv.Mat();
  cv.goodFeaturesToTrack(img, corners, max, CFG.cornerQuality, CFG.cornerMinDist, m, 5, false, 0.04);
  const c = corners.data32F;
  const out = [];
  for (let i = 0; i < c.length; i += 2) {
    if (localStd(img, c[i], c[i + 1]) >= CFG.minPointStd) out.push(c[i], c[i + 1]);
  }
  corners.delete(); m.delete();
  // Малоконтрастная поверхность (кожа, бумага): угловых точек мало — добираем на кадре, нормализованном
  // по локальному контрасту, с более мягкими порогами и меньшим расстоянием между точками
  if (imgNorm && out.length / 2 < max * 0.5) {
    const m2 = mask.clone();
    const ex = (exclude || []).concat(out);
    for (let i = 0; i < ex.length; i += 2) cv.circle(m2, new cv.Point(Math.round(ex[i]), Math.round(ex[i + 1])), 4, new cv.Scalar(0), -1);
    const c2 = new cv.Mat();
    cv.goodFeaturesToTrack(imgNorm, c2, Math.max(8, max - out.length / 2), 0.002, 4, m2, 5, false, 0.04);
    const d = c2.data32F;
    for (let i = 0; i < d.length; i += 2) if (localStd(imgNorm, d[i], d[i + 1]) >= 14) out.push(d[i], d[i + 1]);
    c2.delete(); m2.delete();
  }
  return out;
}

/** Стандартное отклонение яркости в окне 9×9 вокруг точки. */
function localStd(img, x, y) {
  const d = img.data, w = img.cols, h = img.rows;
  const cx = Math.round(x), cy = Math.round(y);
  let s = 0, s2 = 0, n = 0;
  for (let yy = Math.max(0, cy - 4); yy <= Math.min(h - 1, cy + 4); yy++) {
    for (let xx = Math.max(0, cx - 4); xx <= Math.min(w - 1, cx + 4); xx++) {
      const v = d[yy * w + xx]; s += v; s2 += v * v; n++;
    }
  }
  return n ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0;
}

function orbDetect(img, mask) {
  const kps = new cv.KeyPointVector();
  const desc = new cv.Mat();
  orb.detectAndCompute(img, mask, kps, desc);
  const n = kps.size();
  const pts = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = kps.get(i).pt;
    pts[i * 2] = p.x; pts[i * 2 + 1] = p.y;
  }
  kps.delete();
  return { desc, pts, n };
}

function findH(src, dst, thr, iters = 2000) {
  const n = src.length / 2;
  if (n < 4) return null;
  const s = cv.matFromArray(n, 1, cv.CV_32FC2, src);
  const d = cv.matFromArray(n, 1, cv.CV_32FC2, dst);
  const mask = new cv.Mat();
  const Hm = cv.findHomography(s, d, cv.RANSAC, thr, mask, iters, 0.995);
  let res = null;
  if (!Hm.empty()) {
    const h = Array.from(Hm.data64F);
    const inl = mask.data;
    let count = 0;
    for (let i = 0; i < n; i++) if (inl[i]) count++;
    res = { H: h, inliers: count, mask: Uint8Array.from(inl) };
  }
  s.delete(); d.delete(); mask.delete(); Hm.delete();
  return res;
}

// ---------- ключевые кадры и релокализация ----------
function makeKeyframe(img, Hm, t) {
  const mask = currentMask(Hm);
  const f = orbDetect(img, mask);
  mask.delete();
  const inv = invertH(Hm);
  const ref = new Float32Array(f.n * 2);
  for (let i = 0; i < f.n; i++) {
    const p = applyH(inv, f.pts[i * 2], f.pts[i * 2 + 1]);
    ref[i * 2] = p[0]; ref[i * 2 + 1] = p[1];
  }
  return { desc: f.desc, ref, n: f.n, t };
}

function dropState() {
  if (!st) return;
  st.keyframes.forEach((k) => k.desc.delete());
  if (st.tmpl) { st.tmpl.img.delete(); st.tmpl.crop.delete(); if (st.tmpl.ecc) st.tmpl.ecc.T.delete(); }
  if (st.eccRecent) st.eccRecent.delete();
  if (st.skin) st.skin.delete();
  st.tmpl = null; st.eccRecent = null; st.skin = null;
}

/** Сопоставление ORB текущего кадра с ключевыми кадрами. */
function relocalize(img, Hguess) {
  const mask = Hguess && !st.fullFrame ? polyMask(mapQuad(Hguess, expandQuad(st.quad, 0.25))) : new cv.Mat();
  const cur = orbDetect(img, mask);
  mask.delete();
  let best = null;
  if (cur.n >= CFG.minInliersORB) {
    for (const kf of st.keyframes.slice().reverse()) { // новейшие первыми
      if (kf.n < CFG.minInliersORB) continue;
      const matches = new cv.DMatchVectorVector();
      matcher.knnMatch(cur.desc, kf.desc, matches, 2);
      const src = [], dst = [];
      for (let i = 0; i < matches.size(); i++) {
        const m = matches.get(i);
        if (m.size() >= 2) {
          const a = m.get(0), b = m.get(1);
          if (a.distance < CFG.ratio * b.distance && a.distance < 64) {
            src.push(kf.ref[a.trainIdx * 2], kf.ref[a.trainIdx * 2 + 1]);
            dst.push(cur.pts[a.queryIdx * 2], cur.pts[a.queryIdx * 2 + 1]);
          }
        }
        m.delete();
      }
      matches.delete();
      if (src.length / 2 < CFG.minInliersORB) continue;
      const r = findH(src, dst, CFG.ransacORB);
      if (r && r.inliers >= CFG.minInliersORB && r.inliers / (src.length / 2) > 0.25 && plausible(r.H)) {
        if (!best || r.inliers > best.inliers) best = { H: r.H, inliers: r.inliers };
        if (r.inliers > 60) break;
      }
    }
  }
  cur.desc.delete();
  return best;
}

/** Четырёхугольники-кандидаты (листы, холсты) в кадре, крупные первыми. */
function findQuads(img) {
  const cands = [];
  const blur = new cv.Mat(), edges = new cv.Mat(), bin = new cv.Mat();
  cv.GaussianBlur(img, blur, new cv.Size(5, 5), 0);
  cv.Canny(blur, edges, 40, 120);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, k);
  cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  for (const im of [edges, bin]) {
    const contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(im, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > W * H * 0.03 && area < W * H * 0.97) {
        const hull = new cv.Mat(), approx = new cv.Mat();
        cv.convexHull(c, hull);
        const peri = cv.arcLength(hull, true);
        for (const eps of [0.02, 0.035, 0.05]) {
          cv.approxPolyDP(hull, approx, eps * peri, true);
          if (approx.rows === 4) {
            const d = approx.data32S;
            cands.push({ area: cv.contourArea(approx), q: orderQuad([[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]]) });
            break;
          }
        }
        hull.delete(); approx.delete();
      }
      c.delete();
    }
    contours.delete(); hier.delete();
  }
  [blur, edges, bin, k].forEach((m) => m.delete());
  return cands.sort((a, b) => b.area - a.area);
}

/** Релокализация пустого холста: подходящий по размеру четырёхугольник рядом с последней позой. */
function relocalizeByShape(Hlast) {
  const last = mapQuad(Hlast, st.quad);
  const aLast = Math.abs(quadArea(last));
  let best = null;
  for (const c of findQuads(gray)) {
    const r = c.area / aLast;
    if (r < 0.5 || r > 2) continue;
    for (let rot = 0; rot < 4; rot++) {
      const q = [0, 1, 2, 3].map((i) => c.q[(i + rot) % 4]);
      const Hc = homog4(st.quad, q);
      if (!plausible(Hc)) continue;
      let d = 0;
      for (let i = 0; i < 4; i++) d += Math.hypot(q[i][0] - last[i][0], q[i][1] - last[i][1]);
      d /= 4;
      if (!best || d < best.d) best = { H: Hc, d };
    }
  }
  return best && best.d < Math.max(W, H) * 0.5 ? best : null;
}

// ---------- оптический поток ----------
/** Пирамидальный LK с проверкой вперёд-назад. Возвращает индексы и новые координаты надёжных точек. */
function lkPairs(imgA, imgB, ptsA, win, levels, backCheck = true) {
  const n = ptsA.length / 2;
  const idx = [], out = [];
  if (n < 1) return { idx, out };
  const p0 = cv.matFromArray(n, 1, cv.CV_32FC2, ptsA);
  const p1 = new cv.Mat(), pb = new cv.Mat();
  const s1 = new cv.Mat(), s2 = new cv.Mat(), e1 = new cv.Mat(), e2 = new cv.Mat();
  const size = new cv.Size(win, win);
  const crit = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 20, 0.03);
  cv.calcOpticalFlowPyrLK(imgA, imgB, p0, p1, s1, e1, size, levels, crit);
  if (backCheck) cv.calcOpticalFlowPyrLK(imgB, imgA, p1, pb, s2, e2, size, levels, crit);
  const a = p0.data32F, b = p1.data32F, c = backCheck ? pb.data32F : null;
  for (let i = 0; i < n; i++) {
    if (!s1.data[i] || (backCheck && !s2.data[i])) continue;
    const x = b[i * 2], y = b[i * 2 + 1];
    if (!(x >= 0 && y >= 0 && x < W && y < H)) continue;
    if (backCheck && Math.hypot(a[i * 2] - c[i * 2], a[i * 2 + 1] - c[i * 2 + 1]) > CFG.fbMaxErr) continue;
    idx.push(i); out.push(x, y);
  }
  [p0, p1, pb, s1, s2, e1, e2].forEach((m) => m.delete());
  return { idx, out };
}

/** Межкадровый трекинг: быстрый прогноз позы. */
function trackLK() {
  const lkr = lkPairs(prevNorm, norm, st.cur, CFG.lkWin, CFG.lkLevels, CFG.lkBackCheck);
  let idx = lkr.idx, out = lkr.out;
  // точки, попавшие на руку, — не опора: движущаяся рука иначе образует самую большую согласованную группу
  // и RANSAC принимает её движение за движение бумаги
  if (st.skinOn && st.skin) {
    const ki = [], ko = [];
    for (let k = 0; k < idx.length; k++) if (!onSkin(st.skin, out[k * 2], out[k * 2 + 1])) { ki.push(idx[k]); ko.push(out[k * 2], out[k * 2 + 1]); }
    idx = ki; out = ko;
  }
  if (idx.length < CFG.minInliersLK) return null;
  const ref = [];
  for (const i of idx) ref.push(st.ref[i * 2], st.ref[i * 2 + 1]);
  const r = findH(ref, out, CFG.ransacLK);
  if (!r || r.inliers < CFG.minInliersLK || !plausible(r.H)) return null;
  const keepRef = [], keepCur = [];
  for (let i = 0; i < r.mask.length; i++) {
    if (!r.mask[i]) continue;
    keepRef.push(ref[i * 2], ref[i * 2 + 1]);
    keepCur.push(out[i * 2], out[i * 2 + 1]);
  }
  return { H: r.H, inliers: r.inliers, ref: keepRef, cur: keepCur };
}

/** Засеять точки для оптического потока в текущем кадре по позе Hm. */
/**
 * Признаки по ячейкам сетки в области маски: опорные точки равномерно по всей области, а не кучей в самом
 * контрастном месте. Иначе геометрия вырождена (все точки внизу), и дальние части рамки плывут.
 * exclude — уже имеющиеся точки (плоский массив x,y): они учитываются в квотах ячеек.
 */
function detectGrid(mask, total, exclude) {
  const bb = cv.boundingRect(mask);
  if (bb.width < 24 || bb.height < 24) return detectCorners(gray, mask, total, exclude, norm);
  const G = st.fullFrame ? 4 : 3;
  const perCell = Math.ceil(CFG.maxCorners / (G * G)) + 2;
  const out = [];
  for (let gy = 0; gy < G; gy++) {
    for (let gx = 0; gx < G; gx++) {
      const rx = Math.round(bb.x + gx * bb.width / G), ry = Math.round(bb.y + gy * bb.height / G);
      const rw = Math.round(bb.x + (gx + 1) * bb.width / G) - rx, rh = Math.round(bb.y + (gy + 1) * bb.height / G) - ry;
      if (rw < 8 || rh < 8) continue;
      let have = 0;
      const ex = [];
      for (let i = 0; i < (exclude || []).length; i += 2) {
        const x = exclude[i], y = exclude[i + 1];
        if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) { have++; ex.push(x - rx, y - ry); }
      }
      const need = perCell - have;
      if (need < 3) continue;
      const rect = new cv.Rect(rx, ry, rw, rh);
      const m = mask.roi(rect).clone();
      if (cv.countNonZero(m) > 150) {
        const g = gray.roi(rect).clone(), n = norm.roi(rect).clone();
        const pts = detectCorners(g, m, need, ex, n);
        for (let i = 0; i < pts.length; i += 2) out.push(pts[i] + rx, pts[i + 1] + ry);
        g.delete(); n.delete();
      }
      m.delete();
    }
  }
  return out;
}

function seedPoints(Hm, keep) {
  const mask = currentMask(Hm);
  if (st.skinOn && st.skin) cv.subtract(mask, st.skin, mask);
  const curPts = keep ? Array.from(st.cur) : [];
  const refPts = keep ? Array.from(st.ref) : [];
  const need = CFG.maxCorners - curPts.length / 2;
  if (need > 10) {
    const fresh = detectGrid(mask, need, curPts);
    const inv = invertH(Hm);
    for (let i = 0; i < fresh.length; i += 2) {
      const r = applyH(inv, fresh[i], fresh[i + 1]);
      curPts.push(fresh[i], fresh[i + 1]);
      refPts.push(r[0], r[1]);
    }
  }
  mask.delete();
  seedAnchors(Hm, curPts, refPts);
  st.cur = Float32Array.from(curPts);
  st.ref = Float32Array.from(refPts);
}

/** Опорные области (точки опоры): круги вокруг отмеченных пользователем неподвижных предметов, в текущем кадре. */
function anchorDiscs(Hm) {
  return st.anchors.map((a) => {
    const c = applyH(Hm, a.ref[0], a.ref[1]), e = applyH(Hm, a.ref[0] + a.r, a.ref[1]);
    return { c, r: Math.max(10, Math.hypot(e[0] - c[0], e[1] - c[1])) };
  });
}

/** В каждой опорной области держим свои точки потока: они входят в общую гомографию вместе с точками холста. */
function seedAnchors(Hm, curPts, refPts) {
  if (!st.anchors.length) return;
  const inv = invertH(Hm);
  if (!inv) return;
  for (const d of anchorDiscs(Hm)) {
    if (d.c[0] < -d.r || d.c[1] < -d.r || d.c[0] > W + d.r || d.c[1] > H + d.r) continue;
    const ex = [];
    let have = 0;
    for (let i = 0; i < curPts.length; i += 2) {
      if (Math.hypot(curPts[i] - d.c[0], curPts[i + 1] - d.c[1]) < d.r) { have++; ex.push(curPts[i], curPts[i + 1]); }
    }
    const need = CFG.anchorPts - have;
    if (need < 4) continue;
    const m = cv.Mat.zeros(H, W, cv.CV_8UC1);
    cv.circle(m, new cv.Point(Math.round(d.c[0]), Math.round(d.c[1])), Math.round(d.r), new cv.Scalar(255), -1);
    if (st.skinOn && st.skin) cv.subtract(m, st.skin, m);
    const fresh = detectCorners(gray, m, need, ex, norm);
    m.delete();
    for (let i = 0; i < fresh.length; i += 2) {
      const r = applyH(inv, fresh[i], fresh[i + 1]);
      curPts.push(fresh[i], fresh[i + 1]);
      refPts.push(r[0], r[1]);
    }
  }
}

/** Пользователь отметил неподвижный предмет (точка в текущем кадре анализа). */
function addAnchor(msg) {
  if (!st) return { type: 'anchors', anchors: [], n: 0 };
  const inv = invertH(st.H);
  const [x, y] = msg.point;
  if (inv && x >= 0 && y >= 0 && x < W && y < H) {
    st.anchors.push({ ref: applyH(inv, x, y), r: CFG.anchorR });
    if (!st.fail) seedPoints(st.H, true);
  }
  return { type: 'anchors', n: st.anchors.length, anchors: anchorPositions() };
}
function removeAnchor(msg) {
  if (!st) return { type: 'anchors', anchors: [], n: 0 };
  if (msg.all) st.anchors = []; else st.anchors.pop();
  return { type: 'anchors', n: st.anchors.length, anchors: anchorPositions() };
}
const anchorPositions = () => (st ? st.anchors.map((a) => applyH(st.H, a.ref[0], a.ref[1])) : []);

/** Пересчитать опорные координаты точек LK по уточнённой позе (убирает их дрейф). */
function reanchor(Hm) {
  const inv = invertH(Hm);
  if (!inv) return;
  for (let i = 0; i < st.cur.length; i += 2) {
    const r = applyH(inv, st.cur[i], st.cur[i + 1]);
    st.ref[i] = r[0]; st.ref[i + 1] = r[1];
  }
}

// ---------- шаблон ----------
function warpToRef(img, Hm) {
  const Hmat = cv.matFromArray(3, 3, cv.CV_64F, Hm);
  const warped = new cv.Mat();
  cv.warpPerspective(img, warped, Hmat, new cv.Size(W, H), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP,
    cv.BORDER_CONSTANT, new cv.Scalar(0));
  Hmat.delete();
  return warped;
}

/**
 * Шаблон: вид холста в опорных координатах. Хранится нормализованным (LCN),
 * точки выбираются по исходной яркости. Нормализация делается ПОСЛЕ разворота
 * кадра, поэтому шаблон и текущий вид сравниваются в одинаковых условиях.
 */
function setTemplate(rawRef, validMask) {
  if (st.tmpl) { st.tmpl.img.delete(); st.tmpl.crop.delete(); if (st.tmpl.ecc) st.tmpl.ecc.T.delete(); }
  const mask = polyMask(st.fullFrame ? [[0, 0], [W, 0], [W, H], [0, H]] : st.searchQuad);
  if (validMask) cv.bitwise_and(mask, validMask, mask);
  const img = new cv.Mat();
  normalize(rawRef, img);
  const pts = detectCorners(rawRef, mask, CFG.tmplCorners, null, img);
  mask.delete();
  // заплатка для плотного выравнивания: область холста в опорных координатах, уменьшенная до ECC.side
  const box = eccBox();
  const roi = rawRef.roi(new cv.Rect(box.x0, box.y0, box.bw, box.bh));
  const T = new cv.Mat();
  cv.resize(roi, T, new cv.Size(box.w, box.h), 0, 0, cv.INTER_AREA);
  roi.delete();
  // область, в которой считаются точки шаблона (меньше кадра — и разворот, и нормализация дешевле)
  const tb = st.fullFrame ? { x0: 0, y0: 0, w: W, h: H } : boxOf(st.searchQuad, 0.1);
  const crop = img.roi(new cv.Rect(tb.x0, tb.y0, tb.w, tb.h)).clone();
  const loc = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) { loc[i] = pts[i] - tb.x0; loc[i + 1] = pts[i + 1] - tb.y0; }
  // фактура заплатки (СКО яркости после лёгкого сглаживания): на гладком листе ECC цепляется за шум
  const sm = new cv.Mat(), mean = new cv.Mat(), sd = new cv.Mat();
  cv.GaussianBlur(T, sm, new cv.Size(5, 5), 0);
  const inner = cv.Mat.zeros(box.h, box.w, cv.CV_8UC1); // только внутри четырёхугольника, без фона вокруг
  const flat = [];
  for (const [x, y] of st.quad) flat.push(Math.round((x - box.x0) * box.s), Math.round((y - box.y0) * box.s));
  const poly = cv.matFromArray(4, 1, cv.CV_32SC2, flat), mv = new cv.MatVector();
  mv.push_back(poly);
  cv.fillPoly(inner, mv, new cv.Scalar(255));
  const ek = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)); // отступ от границы: там перепад «холст/фон»
  cv.erode(inner, inner, ek);
  ek.delete();
  cv.meanStdDev(sm, mean, sd, inner);
  const texStd = sd.data64F[0];
  mv.delete(); poly.delete(); inner.delete(); sm.delete(); mean.delete(); sd.delete();
  st.tmpl = { img, crop, tb, loc, pts: Float32Array.from(pts), n: pts.length / 2, low: 0, ecc: { T, box, texStd } };
}

/** Целочисленная рамка вокруг четырёхугольника с запасом m (доля размера), в пределах кадра. */
function boxOf(q, m) {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const mx = (Math.max(...xs) - Math.min(...xs)) * m, my = (Math.max(...ys) - Math.min(...ys)) * m;
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - mx)), y0 = Math.max(0, Math.floor(Math.min(...ys) - my));
  const x1 = Math.min(W, Math.ceil(Math.max(...xs) + mx)), y1 = Math.min(H, Math.ceil(Math.max(...ys) + my));
  return { x0, y0, w: Math.max(16, x1 - x0), h: Math.max(16, y1 - y0) };
}

// ---------- плотное выравнивание (ECC) ----------
// Нужно там, где мало угловых точек: ладонь, пустая бумага, размытая картинка. ECC подбирает гомографию так,
// чтобы ВСЯ заплатка (а не горстка точек) совпала с шаблоном по нормированной корреляции — яркость
// не важна. Стартуем от предсказания потока, поэтому сходится за несколько итераций.
const ECC = { side: 96, iters: 30, eps: 1e-3, gauss: 5, minCC: 0.7, lostCC: 0.8, recentCC: 0.75, recentEvery: 1, anchorEvery: 1, minTex: 4, suspect: 10 };

/** «Свежая» заплатка: вид поверхности по текущей позе. Ведёт от кадра к кадру, пока вид меняется (поворот ладони). */
function updateRecentEcc() {
  const e = st.tmpl && st.tmpl.ecc;
  if (!e) return;
  const { box } = e, s = box.s;
  const Tfi = invertH([s, 0, -box.x0 * s, 0, s, -box.y0 * s, 0, 0, 1]);
  const Hmat = cv.matFromArray(3, 3, cv.CV_64F, mulH(st.H, Tfi));
  const T = new cv.Mat();
  cv.warpPerspective(gray, T, Hmat, new cv.Size(box.w, box.h), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE);
  Hmat.delete();
  if (st.eccRecent) st.eccRecent.delete();
  st.eccRecent = T;
}

function eccBox() {
  const xs = st.quad.map((p) => p[0]), ys = st.quad.map((p) => p[1]);
  const mx = (Math.max(...xs) - Math.min(...xs)) * 0.06, my = (Math.max(...ys) - Math.min(...ys)) * 0.06;
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - mx)), y0 = Math.max(0, Math.floor(Math.min(...ys) - my));
  const x1 = Math.min(W, Math.ceil(Math.max(...xs) + mx)), y1 = Math.min(H, Math.ceil(Math.max(...ys) + my));
  const bw = Math.max(16, x1 - x0), bh = Math.max(16, y1 - y0);
  const s = Math.min(1, ECC.side / Math.max(bw, bh));
  return { x0, y0, bw, bh, s, w: Math.max(16, Math.round(bw * s)), h: Math.max(16, Math.round(bh * s)) };
}

/** Гомография «опорные → текущие координаты», уточнённая плотным выравниванием от предсказания Hm. */
function eccRefine(Hm, Tpl, coarse, affine) {
  const e = st.tmpl && st.tmpl.ecc;
  if (!e) return null;
  const { box } = e, s = box.s;
  const Tf = [s, 0, -box.x0 * s, 0, s, -box.y0 * s, 0, 0, 1];   // опорные → координаты заплатки
  const Tfi = invertH(Tf);
  const Hmat = cv.matFromArray(3, 3, cv.CV_64F, mulH(Hm, Tfi));  // заплатка → текущий кадр
  const U = new cv.Mat();
  cv.warpPerspective(gray, U, Hmat, new cv.Size(box.w, box.h), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE);
  const C = affine ? cv.Mat.eye(2, 3, cv.CV_32F) : cv.Mat.eye(3, 3, cv.CV_32F);
  const motion = affine ? cv.MOTION_AFFINE : cv.MOTION_HOMOGRAPHY;
  if (coarse) {
    // от грубого к точному: на половинном масштабе ECC захватывает вдвое большее смещение
    const T2 = new cv.Mat(), U2 = new cv.Mat(), C2 = affine ? cv.Mat.eye(2, 3, cv.CV_32F) : cv.Mat.eye(3, 3, cv.CV_32F);
    const sz = new cv.Size(Math.max(16, box.w >> 1), Math.max(16, box.h >> 1));
    cv.resize(Tpl || e.T, T2, sz, 0, 0, cv.INTER_AREA);
    cv.resize(U, U2, sz, 0, 0, cv.INTER_AREA);
    let cc2 = -1;
    try { cc2 = cv.findTransformECC(T2, U2, C2, motion, new cv.TermCriteria(3, 50, 1e-3), new cv.Mat(), 3); } catch (err) { cc2 = -1; }
    if (cc2 > 0.3) {
      const sx = sz.width / box.w, sy = sz.height / box.h, Sf = [sx, 0, 0, 0, sy, 0, 0, 0, 1];
      const c2 = Array.from(C2.data32F);
      const Cf = mulH(invertH(Sf), mulH(c2.length === 6 ? c2.concat([0, 0, 1]) : c2, Sf));
      C.data32F.set(c2.length === 6 ? Cf.slice(0, 6) : Cf);
    }
    T2.delete(); U2.delete(); C2.delete();
  }
  let cc = -1;
  try {
    cc = cv.findTransformECC(Tpl || e.T, U, C, motion, new cv.TermCriteria(3, ECC.iters, ECC.eps), new cv.Mat(), ECC.gauss);
  } catch (err) { cc = -1; } // не сошлось
  let res = null;
  if (cc > 0) {
    const cw = Array.from(C.data32F);
    const Hn = mulH(Hm, mulH(Tfi, mulH(cw.length === 6 ? cw.concat([0, 0, 1]) : cw, Tf)));
    const k = Hn[8];
    res = { H: Hn.map((v) => v / k), cc };
  }
  Hmat.delete(); U.delete(); C.delete();
  return res;
}

function updateTemplate() {
  const raw = warpToRef(gray, st.H);
  const valid = new cv.Mat();
  // пиксели вне кадра после разворота нулевые — исключаем их с запасом
  cv.threshold(raw, valid, 0, 255, cv.THRESH_BINARY);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(CFG.lcnBox, CFG.lcnBox));
  cv.erode(valid, valid, k);
  setTemplate(raw, valid);
  [raw, valid, k].forEach((m) => m.delete());
}

/**
 * Сравнение с шаблоном: кадр разворачивается в опорные координаты по Hm,
 * остаточные сдвиги точек шаблона дают пары «опорные ↔ текущие» без накопления ошибки.
 */
function templatePairs(Hm) {
  const t = st.tmpl;
  const res = { ref: [], cur: [], n: 0, ratio: 0 };
  if (!t || t.n < 4) return res;
  // кадр разворачивается в опорные координаты только внутри рамки области шаблона
  const { tb } = t;
  const Hmat = cv.matFromArray(3, 3, cv.CV_64F, mulH(Hm, [1, 0, tb.x0, 0, 1, tb.y0, 0, 0, 1]));
  const raw = new cv.Mat();
  cv.warpPerspective(gray, raw, Hmat, new cv.Size(tb.w, tb.h), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_CONSTANT, new cv.Scalar(0));
  Hmat.delete();
  const warped = new cv.Mat();
  normalize(raw, warped);
  raw.delete();
  const { idx, out } = lkPairs(t.crop, warped, t.loc, 15, 2, CFG.tmplBackCheck);
  warped.delete();
  if (idx.length < 4) return res;
  const src = [], dst = [];
  for (let k = 0; k < idx.length; k++) {
    src.push(t.pts[idx[k] * 2], t.pts[idx[k] * 2 + 1]);
    dst.push(out[k * 2] + tb.x0, out[k * 2 + 1] + tb.y0);
  }
  let mask = null;
  if (idx.length >= 8) {
    const r = findH(src, dst, CFG.ransacRefine, 500);
    if (r) mask = r.mask;
  }
  for (let i = 0; i < idx.length; i++) {
    if (mask && !mask[i]) continue;
    const c = applyH(Hm, dst[i * 2], dst[i * 2 + 1]);
    res.ref.push([src[i * 2], src[i * 2 + 1]]);
    res.cur.push(c);
  }
  res.n = res.ref.length;
  res.ratio = res.n / t.n;
  return res;
}

// ---------- края холста ----------
/** Нормаль наружу и точки стороны j четырёхугольника q. */
function edgeGeom(q, j) {
  const A = q[j], B = q[(j + 1) % 4];
  const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const ux = (B[0] - A[0]) / len, uy = (B[1] - A[1]) / len;
  let nx = -uy, ny = ux;
  const [cx, cy] = centroid(q);
  if (nx * ((A[0] + B[0]) / 2 - cx) + ny * ((A[1] + B[1]) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
  return { A, B, len, nx, ny };
}

/** При захвате: какие стороны контрастны и какой полярности (лист светлее/темнее фона). */
function learnEdges() {
  st.edges = [];
  for (let j = 0; j < 4; j++) {
    const { A, B, len, nx, ny } = edgeGeom(st.quad, j);
    let sum = 0, n = 0;
    for (let k = 0; k < 20; k++) {
      const s = 0.1 + 0.8 * k / 19;
      const x = A[0] + (B[0] - A[0]) * s, y = A[1] + (B[1] - A[1]) * s;
      const o = sample(x + nx * 4, y + ny * 4), i = sample(x - nx * 4, y - ny * 4);
      if (Number.isFinite(o) && Number.isFinite(i)) { sum += o - i; n++; }
    }
    const diff = n ? sum / n : 0;
    // цвета внутри (бумага/холст) и снаружи (фон) у грани — чтобы отличать настоящий край от контура руки/карандаша
    const cin = [], cout = [];
    let outAll = 0;
    for (let k = 0; k < 20; k++) {
      const s2 = 0.1 + 0.8 * k / 19;
      const x = A[0] + (B[0] - A[0]) * s2, y = A[1] + (B[1] - A[1]) * s2;
      for (const d of [5, 7, 9]) {
        const ax = x - nx * d, ay = y - ny * d, bx = x + nx * d, by = y + ny * d;
        const a = rgbAt(ax, ay), b = rgbAt(bx, by);
        if (a && !(st.skinOn && st.skin && onSkin(st.skin, ax, ay))) cin.push(a); // рука в кадре при выборе углов не должна портить эталон цвета
        if (b) outAll++;
        if (b && !(st.skinOn && st.skin && onSkin(st.skin, bx, by))) cout.push(b);
      }
    }
    const inS = colorStats(cin), outS = colorStats(cout);
    st.edges.push({
      use: len > 20 && n >= 8 && Math.abs(diff) >= CFG.edgeMinContrast, pol: Math.sign(diff), contrast: Math.abs(diff),
      inC: inS.mean, sdIn: inS.sd, outC: outS.mean, sdOut: outS.sd,
      bgSkin: outAll > 0 && cout.length / outAll < 0.25, // фон сам телесного цвета (стол, дерево): по коже края не отсеиваем
      useOut: outS.sd < 28 && cout.length > 0, // фон ровный (флис, стол) — по нему можно сверять; пёстрый (чужие предметы) — нет
    });
  }
  // одна-единственная «контрастная» сторона — обычно случайность (контур кожи у ладони); край в помощь только когда сторон хватает
  if (st.edges.filter((e) => e.use).length < 2) for (const e of st.edges) e.use = false;
}

// ---------- маска кожи (руки не должны считаться опорой) ----------
let skinLo = null, skinHi = null;
/** Бинарная маска «кожа» по текущему кадру: YCrCb-диапазон + небольшое расширение. Освобождать вызывающему. */
function computeSkin() {
  const rgb = new cv.Mat(), ycc = new cv.Mat(), m = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, ycc, cv.COLOR_RGB2YCrCb);
  if (!skinLo || skinLo.rows !== H || skinLo.cols !== W) {
    if (skinLo) { skinLo.delete(); skinHi.delete(); }
    skinLo = new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(40, 140, 80));
    skinHi = new cv.Mat(H, W, cv.CV_8UC3, new cv.Scalar(255, 178, 128));
  }
  cv.inRange(ycc, skinLo, skinHi, m);
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
  cv.dilate(m, m, k);
  [rgb, ycc, k].forEach((x) => x.delete());
  return m;
}
const onSkin = (m, x, y) => {
  const xi = Math.round(x), yi = Math.round(y);
  return xi >= 0 && yi >= 0 && xi < W && yi < H && m.data[yi * W + xi] > 0;
};

function rgbAt(x, y) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W || yi >= H) return null;
  const i = (yi * W + xi) * 4;
  return [rgba.data[i], rgba.data[i + 1], rgba.data[i + 2]];
}
function colorStats(list) {
  if (!list.length) return { mean: [128, 128, 128], sd: 99 };
  const mean = [0, 0, 0];
  for (const c of list) for (let k = 0; k < 3; k++) mean[k] += c[k] / list.length;
  let v = 0;
  for (const c of list) for (let k = 0; k < 3; k++) v += (c[k] - mean[k]) ** 2;
  return { mean, sd: Math.sqrt(v / (list.length * 3)) };
}
const colorDist = (a, b) => (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;

/** Прямая по точкам методом RANSAC + уточнение МНК. Возвращает inlier-точки. */
function fitLine(pts) {
  const n = pts.length;
  if (n < CFG.edgeMinInliers) return null;
  let best = null, bestCost = Infinity;
  // перебор всех пар: детерминированно (случайные пары давали разные результаты от запуска к запуску) и недорого
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = pts[i], b = pts[j];
      const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      if (L < 5) continue;
      const nx = -dy / L, ny = dx / L;
      const inl = [];
      let cost = 0;
      for (const p of pts) {
        const d = Math.abs((p[0] - a[0]) * nx + (p[1] - a[1]) * ny);
        if (d < 1.2) { inl.push(p); cost += d; }
      }
      if (!best || inl.length > best.length || (inl.length === best.length && cost < bestCost)) { best = inl; bestCost = cost; }
    }
  }
  return best && best.length >= CFG.edgeMinInliers ? best : null;
}

/** Поиск краёв холста вокруг позы Hm. Возвращает наблюдения { j, pts } для надёжных сторон. */
function edgeObservations(Hm, radius, only, strictDir) {
  const out = [];
  if (!st.edges) return out;
  const q = mapQuad(Hm, st.quad);
  const S = CFG.edgeSamples;
  for (let j = 0; j < 4; j++) {
    if (only && !only.includes(j)) continue;
    const e = st.edges[j];
    if (!e.use) continue;
    const { A, B, len, nx, ny } = edgeGeom(q, j);
    if (len < 20) continue;
    const minD = Math.max(5, e.contrast * 0.3);
    const tolIn = Math.max(38, 3 * e.sdIn), tolOut = Math.max(50, 3 * e.sdOut);
    const pts = [];
    for (let k = 0; k < S; k++) {
      const s = 0.06 + 0.88 * k / (S - 1);
      const px = A[0] + (B[0] - A[0]) * s, py = A[1] + (B[1] - A[1]) * s;
      let best = -Infinity, bt = 0, bd = 0;
      const prof = [];
      for (let t = -radius; t <= radius; t++) {
        const d = e.pol * (sample(px + nx * (t + 1.5), py + ny * (t + 1.5)) - sample(px + nx * (t - 1.5), py + ny * (t - 1.5)));
        prof.push(d);
        if (!(d >= minD)) continue;
        const score = d - 0.5 * Math.abs(t);
        if (score > best) { best = score; bt = t; bd = d; }
      }
      if (best === -Infinity) continue;
      // внутри — цвет бумаги, снаружи — цвет фона; иначе это край чего-то постороннего (пальцы, карандаш)
      {
        const ex = px + nx * bt, ey = py + ny * bt;
        const ci = rgbAt(ex - nx * 7, ey - ny * 7), co = rgbAt(ex + nx * 7, ey + ny * 7);
        if (st.skinOn && st.skin && (onSkin(st.skin, ex - nx * 7, ey - ny * 7) || (!e.bgSkin && onSkin(st.skin, ex + nx * 7, ey + ny * 7)))) continue; // контур пальцев
        if (!ci || colorDist(ci, e.inC) > tolIn) continue;
        if (e.useOut && (!co || colorDist(co, e.outC) > tolOut)) continue;
      }
      // субпиксель: парабола по соседям
      const i = bt + radius;
      const l = prof[i - 1], r = prof[i + 1];
      let off = 0;
      if (Number.isFinite(l) && Number.isFinite(r)) {
        const den = l - 2 * bd + r;
        if (den < 0) off = Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / den));
      }
      pts.push([px + nx * (bt + off), py + ny * (bt + off)]);
    }
    const inl = fitLine(pts);
    if (inl && inl.length >= (strictDir ? Math.max(6, S * 0.22) : S * 0.35)) {
      if (strictDir) { // широкий поиск (перезахват грани): направление должно совпасть с предсказанным
        const l = fitPts(inl), ux = (B[0] - A[0]) / len, uy = (B[1] - A[1]) / len;
        if (!l || Math.abs(l.ux * uy - l.uy * ux) > 0.1) continue;
      }
      out.push({ j, pts: inl });
    }
  }
  return out;
}

// ---------- совместная оптимизация ----------
/**
 * Поза = 4 угла холста на кадре (8 параметров). Минимизируем (по Хьюберу):
 *  – отклонения точек шаблона, – расстояния точек края до проекции стороны холста,
 *  – слабую привязку к прогнозу (стабилизирует, если измерений мало).
 */
function optimize(Hinit, Hprior, pairs, edges) {
  const corners0 = mapQuad(Hinit, st.quad);
  const prior = mapQuad(Hprior, st.quad);
  let x = corners0.flat();
  const np = pairs.ref.length;
  const step = np > 160 ? Math.ceil(np / 160) : 1; // не больше ~160 точек — хватает с запасом
  const P = [];
  for (let i = 0; i < np; i += step) P.push(i);
  const wPrior = 0.08, wEdge = 1.0;

  const residuals = (xv) => {
    const q = [[xv[0], xv[1]], [xv[2], xv[3]], [xv[4], xv[5]], [xv[6], xv[7]]];
    const Hx = homog4(st.quad, q);
    if (!Hx) return null;
    const r = [];
    for (const i of P) {
      const [u, v] = applyH(Hx, pairs.ref[i][0], pairs.ref[i][1]);
      r.push(u - pairs.cur[i][0], v - pairs.cur[i][1]);
    }
    for (const e of edges) {
      const A = q[e.j], B = q[(e.j + 1) % 4];
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
      const nx = -(B[1] - A[1]) / L, ny = (B[0] - A[0]) / L;
      for (const p of e.pts) r.push(wEdge * ((p[0] - A[0]) * nx + (p[1] - A[1]) * ny));
    }
    // мягкая регуляризация: перспективные члены гомографии (знаменатель в углах рамки) тянем к 1. На малоконтрастной
    // поверхности они почти не определяются данными и иначе дрейфуют — рамка сплющивается в «щепку». Когда точек
    // много (холст), данные перевешивают этот штраф.
    const size = Math.sqrt(Math.abs(quadArea(st.quad)));
    const wp = st.lowTex ? CFG.wPersp : 0; // только когда данных мало (кожа, бумага); у холста данных хватает
    for (const [cx, cy] of st.quad) r.push(wp * size * (Hx[6] * cx + Hx[7] * cy + Hx[8] - 1));
    for (let i = 0; i < 8; i++) r.push(wPrior * (xv[i] - prior[(i / 2) | 0][i % 2]));
    return r;
  };

  let r = residuals(x);
  if (!r) return { H: Hinit, rms: Infinity };
  const m = r.length, nPrior = 12; // 4 перспективных + 8 априорных невязок идут без весов Хьюбера
  for (let iter = 0; iter < 6; iter++) {
    // веса Хьюбера (для априорных невязок вес 1)
    const w = r.map((v, i) => (i >= m - nPrior ? 1 : Math.abs(v) <= CFG.huber ? 1 : CFG.huber / Math.abs(v)));
    const J = [];
    for (let k = 0; k < 8; k++) {
      const xp = x.slice(); xp[k] += 0.05;
      const rp = residuals(xp);
      if (!rp) return { H: Hinit, rms: Infinity };
      J.push(rp.map((v, i) => (v - r[i]) / 0.05));
    }
    // нормальные уравнения (JᵀWJ + λI) Δ = −JᵀWr
    const A = Array.from({ length: 8 }, () => new Array(9).fill(0));
    for (let a = 0; a < 8; a++) {
      for (let b = a; b < 8; b++) {
        let s = 0;
        const Ja = J[a], Jb = J[b];
        for (let i = 0; i < m; i++) s += w[i] * Ja[i] * Jb[i];
        A[a][b] = A[b][a] = s;
      }
      let g = 0;
      for (let i = 0; i < m; i++) g += w[i] * J[a][i] * r[i];
      A[a][8] = -g;
      A[a][a] += 1e-3;
    }
    const delta = solve8(A);
    if (!delta) break;
    const xn = x.map((v, i) => v + delta[i]);
    const rn = residuals(xn);
    if (!rn) break;
    x = xn; r = rn;
    if (Math.max(...delta.map(Math.abs)) < 0.01) break;
  }
  const q = [[x[0], x[1]], [x[2], x[3]], [x[4], x[5]], [x[6], x[7]]];
  let s = 0, c = 0;
  for (let i = 0; i < m - nPrior; i++) { const v = Math.min(Math.abs(r[i]), 3 * CFG.huber); s += v * v; c++; }
  return { H: homog4(st.quad, q) || Hinit, rms: c ? Math.sqrt(s / c) : 0 };
}

function solve8(A) {
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null;
    const t = A[c]; A[c] = A[p]; A[p] = t;
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (f) for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = A[i][n];
    for (let k = i + 1; k < n; k++) s -= A[i][k] * x[k];
    x[i] = s / A[i][i];
  }
  return x;
}

/** Прогноз по постоянной скорости углов холста (когда оптического потока нет). */
function extrapolate(H1, H0) {
  if (!H0) return H1;
  const c1 = mapQuad(H1, st.quad), c0 = mapQuad(H0, st.quad);
  const c = c1.map((p, i) => [p[0] + 0.8 * (p[0] - c0[i][0]), p[1] + 0.8 * (p[1] - c0[i][1])]);
  const Hn = homog4(st.quad, c);
  return Hn && plausible(Hn) ? Hn : H1;
}

// ---------- обработчики сообщений ----------
function lock(msg) {
  loadFrame(msg);
  normalize(gray, norm);
  return startTracking(inQuad(msg.quad), msg);
}

/** Начать трекинг холста по текущему кадру (gray и norm уже загружены). quad — в координатах OpenCV. */
function startTracking(quad, msg) {
  dropState();
  sel = null;
  st = {
    quad,
    searchQuad: expandQuad(quad, msg.margin ?? CFG.margin),
    fullFrame: !!msg.fullFrame,
    anchors: [],
    H: I3(),
    prevH: null,
    cur: new Float32Array(0),
    ref: new Float32Array(0),
    keyframes: [],
    tmpl: null,
    edges: null,
    frame: 0,
    lastReloc: 0,
    lost: 0,
    stable: 0,
    lastAgree: -1e9,
    lastKfT: now(),
    initialPts: 0,
    shape0: null,
    ancLow: 0,
    Hgood: null,
  };
  // маска кожи включается, только если внутри рамки кожи нет (на ладони цель — сама кожа)
  {
    const sm = computeSkin(), inner = polyMask(quad);
    const total = cv.countNonZero(inner);
    cv.bitwise_and(sm, inner, sm);
    st.skinOn = total > 0 && cv.countNonZero(sm) / total < 0.15;
    sm.delete(); inner.delete();
    st.skin = st.skinOn ? computeSkin() : null;
  }
  learnEdges();
  seedPoints(st.H, false);
  // у пустой бумаги своих признаков почти нет — держимся за окружение (статичные предметы вокруг)
  if (!st.fullFrame && !msg.noAuto && st.cur.length / 2 < CFG.autoEnvPts) {
    const own = [st.cur, st.ref];
    st.fullFrame = true; st.auto = true;
    seedPoints(st.H, false);
    // окружение берём, только если оно заметно богаче собственных признаков листа (у гладкого фона точек тоже нет)
    if (st.cur.length / 2 < Math.max(CFG.autoEnvPts * 0.8, own[0].length / 2 * 2)) {
      st.fullFrame = false; st.auto = false;
      st.cur = own[0]; st.ref = own[1];
    }
  }
  st.initialPts = st.cur.length / 2;
  setTemplate(gray, null);
  st.eccOk = st.tmpl.ecc.texStd >= ECC.minTex; // текстура считается один раз — по эталонному кадру (позже в заплатку может попасть рука)
  st.keyframes.push(makeKeyframe(gray, st.H, now()));
  updateRecentEcc();
  norm.copyTo(prevNorm);
  const kf = st.keyframes[0];
  const goodEdges = st.edges.filter((e) => e.use).length;
  return {
    type: 'locked',
    quad: outQuad(quad),
    points: st.initialPts,
    features: kf.n,
    edges: goodEdges,
    weak: st.tmpl.n < 15 && goodEdges < 3,
    eccStd: +st.tmpl.ecc.texStd.toFixed(1),
    auto: !!st.auto,
  };
}

function track(msg) {
  if (!st) return { type: 'pose', state: 'off' };
  if (msg.w !== W || msg.h !== H) return { type: 'pose', state: 'lost', H: outH(st.H) };
  const prof = {};
  let t0 = now();
  const lap = (k) => { const t = now(); prof[k] = +(t - t0).toFixed(2); t0 = t; };
  const tStart = t0;

  loadFrame(msg);
  normalize(gray, norm);
  st.frame++;
  if (st.skinOn) { if (st.skin) st.skin.delete(); st.skin = computeSkin(); }
  lap('prep');

  const Hprev = st.H;
  const wasLost = st.lost > 0;
  let pred = null, source = 'lk', lkInl = 0;
  if (!wasLost && st.cur.length) {
    const lk = trackLK();
    if (lk && quadDist(lk.H, Hprev) < Math.max(W, H) * 0.25) {
      pred = lk.H;
      st.cur = Float32Array.from(lk.cur);
      st.ref = Float32Array.from(lk.ref);
      lkInl = lk.inliers;
    } else {
      st.cur = new Float32Array(0); st.ref = new Float32Array(0);
    }
  }
  if (!pred) { pred = wasLost ? Hprev : extrapolate(Hprev, st.prevH); source = wasLost ? 'hold' : 'motion'; }
  lap('lk');

  // релокализация: при потере — по всему кадру; периодически — проверка дрейфа
  let reloc = null;
  if (wasLost || st.frame - st.lastReloc >= (st.fullFrame ? CFG.relocEnv : CFG.relocEvery)) {
    st.lastReloc = st.frame;
    reloc = relocalize(gray, wasLost ? null : pred);
    if (reloc) {
      const d = quadDist(reloc.H, pred);
      if (wasLost || (d >= CFG.driftFix && reloc.inliers >= 25)) { pred = reloc.H; source = 'orb'; }
      if (d < CFG.driftFix) st.lastAgree = st.frame;
    } else if (wasLost && st.lost >= 2) {
      const sh = relocalizeByShape(Hprev);
      if (sh) { pred = sh.H; source = 'shape'; }
    }
  }
  lap('reloc');

  // плотное выравнивание: сначала по «свежей» заплатке (держит при смене вида), затем по якорной
  // (первый кадр — без дрейфа). Нужно, когда точек потока мало (кожа, бумага) или поза потеряна.
  let ecc = null;
  if (st.tmpl && st.tmpl.ecc && st.eccOk && (wasLost || st.lowTex || st.cur.length / 2 < CFG.eccSparse || st.frame % CFG.eccEvery === 0)) {
    const sane = (r) => r && plausible(r.H) && shapeOk(r.H) && quadDist(r.H, pred) < Math.max(W, H) * 0.15;
    const coarse = wasLost || st.fail > 0;
    // «свежая» заплатка сама по себе может зацепиться за фон: без подтверждения якорем верим ей, только если
    // поток в этом кадре дал позу (source === 'lk') — иначе (телепортация, смаз) поза берётся только по якорю
    const lkOk = source === 'lk' && lkInl >= CFG.minInliersLK;
    let rec = null;
    if (st.eccRecent) {
      rec = eccRefine(pred, st.eccRecent, coarse, true);
      if (!(rec && rec.cc >= ECC.recentCC && sane(rec))) rec = null;
    }
    // якорная заплатка снимает накопленный дрейф; пока «свежая» держит, хватает раза в несколько кадров
    const anc = (!rec || wasLost || st.frame % ECC.anchorEvery === 0) ? eccRefine(rec ? rec.H : pred, null, coarse) : null;
    if (anc && anc.cc >= (wasLost && !rec ? ECC.lostCC : ECC.minCC) && sane(anc)) {
      pred = anc.H; ecc = anc; source = rec ? 'ecc' : (wasLost ? 'ecc-reacq' : source + '+ecc');
      st.ancLow = 0;
      if (anc.cc >= 0.85) st.Hgood = anc.H.slice(); // последняя поза, в которой вид совпадал с эталоном
    } else {
      if (rec && lkOk) { pred = rec.H; ecc = rec; source = 'ecc-rec'; }
      if (anc !== null || !rec) st.ancLow = (st.ancLow || 0) + 1;
    }
    // Самоконтроль: «свежая» заплатка может незаметно увести позу, пока якорная давно не сходится.
    // Тогда пробуем перезахват по якорю от последней хорошей позы и от стартовой (ладонь часто возвращается).
    if ((st.ancLow || 0) >= ECC.suspect && st.frame % 3 === 0) {
      for (const Hc of [st.Hgood, I3()]) {
        if (!Hc) continue;
        const rr = eccRefine(Hc, null, true);
        if (rr && rr.cc >= ECC.lostCC && plausible(rr.H) && shapeOk(rr.H)) {
          pred = rr.H; ecc = rr; source = 'ecc-reloc'; st.ancLow = 0; st.Hgood = rr.H.slice();
          break;
        }
      }
    }
  }
  lap('ecc');

  // измерения без дрейфа
  // Сравнение с шаблоном — самая дорогая часть кадра. На медленном устройстве, когда поток уверенно держит позу
  // (богатая фактура), делаем его не на каждом кадре.
  const lite = !!st.lite;
  const skipTmpl = lite && source === 'lk' && lkInl >= 30 && !wasLost && !st.fail && !st.lowTex &&
    !ecc && st.frame % 3 !== 0;
  const pairs = skipTmpl ? { ref: [], cur: [], n: 0, ratio: 0, skipped: true } : templatePairs(pred);
  if (!skipTmpl) st.lowTex = pairs.n < 60;
  if (false) st.lowTex = false; // мало опорных точек: кожа, пустая бумага — тогда выравниваем по заплатке каждый кадр
  if (ecc) { // сетка точек по рамке, перенесённая по ECC-позе, — плотная опора для оптимизации
    const q = st.quad, G = 5;
    for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) {
      const u = i / (G - 1), v = j / (G - 1);
      const rx = (1 - u) * ((1 - v) * q[0][0] + v * q[3][0]) + u * ((1 - v) * q[1][0] + v * q[2][0]);
      const ry = (1 - u) * ((1 - v) * q[0][1] + v * q[3][1]) + u * ((1 - v) * q[1][1] + v * q[2][1]);
      pairs.ref.push([rx, ry]); pairs.cur.push(applyH(ecc.H, rx, ry));
    }
    pairs.n = pairs.ref.length;
  }
  lap('tmpl');
  const motion = quadDist(pred, Hprev);
  let radius = Math.round(Math.min(24, CFG.edgeRadius + (source === 'lk' ? 0 : motion * 0.5) + (wasLost ? 6 : 0)));
  // Когда поза по потоку надёжна, настоящий край должен лежать почти там, где предсказано. Узкое окно не даёт
  // позе «ползти» к ложному краю (контур пальцев поверх страницы, карандаш), пока настоящий закрыт рукой.
  const confident = source === 'lk' && lkInl >= 12;
  if (confident) radius = Math.min(radius, CFG.edgeGate + 2);
  let edges = edgeObservations(pred, radius);
  if ((st.auto || st.anchors.length) && source === 'lk' && edges.length >= 2) {
    // Режим «окружение» и точки опоры верны, пока лист неподвижен относительно фона. Если края листа (проверены по цвету)
    // стабильно лежат не там, где даёт фон, — лист двигают отдельно от окружения: переходим на свои точки и края.
    const qd = mapQuad(pred, st.quad), res = [];
    for (const e of edges) {
      const g = edgeGeom(qd, e.j);
      const ds = e.pts.map((p) => Math.abs((p[0] - g.A[0]) * g.nx + (p[1] - g.A[1]) * g.ny)).sort((a, b) => a - b);
      res.push(ds[ds.length >> 1]);
    }
    res.sort((a, b) => a - b);
    // авто-окружение сбрасываем быстро; точки опоры выбрал сам пользователь — им доверяем дольше (рука/листание искажают края)
    const lim = st.auto ? CFG.envEdgeErr : 2 * CFG.envEdgeErr, need = st.auto ? 3 : 12;
    st.envBad = res[res.length >> 1] > lim ? (st.envBad || 0) + 1 : 0;
    if (st.envBad >= need) {
      if (st.auto) { st.auto = false; st.fullFrame = false; st.autoDropped = true; }
      if (st.anchors.length) { st.anchors = []; st.anchorsDropped = true; }
      st.envBad = 0;
      st.cur = new Float32Array(0); st.ref = new Float32Array(0);
    }
  }
  if (st.edges) {
    // грань, которую давно не видно (закрыта рукой), ищем заново широко; цвета и направление защищают от ложных краёв
    const seen = new Set(edges.map((e) => e.j));
    st.edgeMiss = st.edgeMiss || [0, 0, 0, 0];
    const lostSides = [];
    for (let j = 0; j < 4; j++) {
      if (!st.edges[j].use) continue;
      st.edgeMiss[j] = seen.has(j) ? 0 : st.edgeMiss[j] + 1;
      if (st.edgeMiss[j] >= 4 && st.edgeMiss[j] % 2 === 0) lostSides.push(j);
    }
    if (lostSides.length && !wasLost) edges = edges.concat(edgeObservations(pred, 48, lostSides, true));
  }
  lap('edges');

  // достаточно ли измерений, чтобы доверять позе
  const nEdges = edges.length;
  // точки шаблона засчитываются, только если совпала заметная их доля (иначе это шум)
  const tmplOk = pairs.n >= CFG.minRefine && (pairs.ratio >= 0.12 || pairs.n >= 30);
  const good = tmplOk || !!ecc || skipTmpl || nEdges >= 3 || (nEdges >= 2 && pairs.n >= 4) ||
    (!wasLost && lkInl >= 15 && pairs.n >= 4);
  let state = 'lost', rms = 0, accepted = null;
  if (good) {
    const opt = optimize(pred, pred, pairs, edges);
    rms = opt.rms;
    if (plausible(opt.H) && shapeOk(opt.H) && opt.rms < 3) accepted = opt.H;
    else if (ecc && plausible(ecc.H) && shapeOk(ecc.H)) accepted = ecc.H; // оптимизация спорит с плотным выравниванием (мало точек) — верим ему
  }
  if (accepted) {
    st.prevH = wasLost ? null : Hprev;
    st.H = accepted;
    st.lost = 0; st.fail = 0;
    state = 'tracking';
  } else if (!wasLost && (st.fail || 0) < CFG.coastMax && plausible(pred)) {
    // кратковременный сбой (смаз, поза не сошлась): едем по инерции и пересеиваем точки, а не объявляем потерю
    st.fail = (st.fail || 0) + 1;
    st.prevH = st.fail > 1 ? null : Hprev; // экстраполяция по скорости — только первый кадр, дальше держим позу
    st.H = pred;
    state = 'tracking'; source = 'coast';
    seedPoints(st.H, false);
  }
  lap('opt');

  if (state === 'tracking') {
    const jump = quadDist(st.H, Hprev);
    st.stable = jump < 1.5 ? st.stable + 1 : 0;
    if (wasLost || !st.cur.length) seedPoints(st.H, false);
    else {
      reanchor(st.H);
      if (st.cur.length / 2 < Math.max(CFG.minCorners, st.initialPts * 0.35)) seedPoints(st.H, true);
    }
    // опорные точки не должны «слипаться» в одном углу кадра: периодически доливаем в пустые ячейки сетки
    if (st.frame % 10 === 0 && (st.cur.length / 2 < CFG.maxCorners - 15 || st.anchors.length) && !st.fail) seedPoints(st.H, true);
    // рисунок заметно изменился — обновляем шаблон
    if (!pairs.skipped) st.tmpl.low = st.tmpl.n >= 8 && pairs.ratio < 0.4 ? st.tmpl.low + 1 : 0;
    if (st.tmpl.low > 20 && st.stable > 5 && !st.fail && !st.auto) updateTemplate(); // у пустой бумаги шаблон не переучиваем: туда попадает рука
    if (st.tmpl && st.tmpl.ecc && !st.fail && st.frame % ECC.recentEvery === 0) updateRecentEcc(); // не запоминаем позу «по инерции»
    // новый ключевой кадр: позиция стабильна и недавно подтверждена ORB
    const t = now();
    if (st.stable > 8 && st.frame - st.lastAgree < CFG.relocEvery * 2 && t - st.lastKfT > CFG.keyframeEveryMs) {
      st.lastKfT = t;
      const kf = makeKeyframe(gray, st.H, t);
      if (kf.n >= 40) {
        st.keyframes.push(kf);
        if (st.keyframes.length > CFG.maxKeyframes) st.keyframes.splice(1, 1)[0].desc.delete(); // исходный храним всегда
      } else kf.desc.delete();
    }
  } else {
    st.lost++;
    st.stable = 0;
    st.cur = new Float32Array(0); st.ref = new Float32Array(0);
  }
  lap('upkeep');

  const tmp = prevNorm; prevNorm = norm; norm = tmp;
  const anchorsDropped = st.anchorsDropped;
  st.anchorsDropped = false;
  while (self.DEBUG_MIN_MS && now() - tStart < self.DEBUG_MIN_MS) { /* тесты: имитация медленного устройства */ }
  st.ems = st.ems === undefined ? now() - tStart : st.ems * 0.95 + (now() - tStart) * 0.05; // скользящее среднее времени кадра
  if (st.ems > CFG.liteMs) st.lite = true; else if (st.ems < CFG.liteMs * 0.75) st.lite = false;
  return {
    type: 'pose',
    state,
    H: outH(st.H),
    inliers: lkInl,
    refined: pairs.n,
    edges: nEdges,
    ecc: ecc ? +ecc.cc.toFixed(2) : 0,
    rms: +rms.toFixed(2),
    points: st.cur.length / 2,
    keyframes: st.keyframes.length,
    source,
    ms: Math.round(now() - tStart),
    prof,
    dbgPts: self.DEBUG_PTS ? Array.from(st.cur) : undefined,
    anchors: st.anchors.length ? anchorPositions() : undefined,
    anchorsDropped: anchorsDropped || undefined,
    dbgEnv: [st.auto ? 1 : 0, st.envBad || 0, st.autoDropped ? 1 : 0, st.fullFrame ? 1 : 0],
  };
}

// ---------- замер скорости устройства ----------
let benchMs = 0;
/**
 * Короткий замер на синтетическом кадре 640×360: нормализация, поиск признаков, поток, разворот — то же, что делает
 * трекинг каждый кадр. Возвращает медиану времени одного прохода (мс). Приложение по ней выбирает размер кадра анализа.
 */
function benchmark() {
  const w = 640, h = 360;
  const a = new cv.Mat(h, w, cv.CV_8UC1), b = new cv.Mat(), t = new cv.Mat();
  let seed = 12345;
  for (let i = 0; i < a.data.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; a.data[i] = (seed >> 16) & 255; }
  cv.GaussianBlur(a, a, new cv.Size(5, 5), 0);
  const M = cv.matFromArray(2, 3, cv.CV_64F, [1, 0, 2, 0, 1, 1]);
  cv.warpAffine(a, b, M, new cv.Size(w, h));
  const times = [];
  for (let k = 0; k < 5; k++) {
    const t0 = now();
    const c = new cv.Mat(), p1 = new cv.Mat(), s = new cv.Mat(), e = new cv.Mat();
    cv.GaussianBlur(a, t, new cv.Size(15, 15), 0);
    cv.goodFeaturesToTrack(a, c, 120, 0.01, 8);
    if (c.rows) cv.calcOpticalFlowPyrLK(a, b, c, p1, s, e, new cv.Size(21, 21), 3);
    cv.warpAffine(a, t, M, new cv.Size(w, h));
    [c, p1, s, e].forEach((m) => m.delete());
    if (k > 0) times.push(now() - t0); // первый проход — прогрев
  }
  [a, b, t, M].forEach((m) => m.delete());
  times.sort((x, y) => x - y);
  return +times[times.length >> 1].toFixed(1);
}

// ---------- автопоиск холста ----------
// Не «самый большой контур» (на реальной сцене это весь кадр или мольберт), а:
//  1) длинные прямые линии (Хаф по краям) → сливаем коллинеарные;
//  2) из четвёрок линий строим четырёхугольники-кандидаты;
//  3) каждого оцениваем по тому, на какой доле всех четырёх сторон РЕАЛЬНО есть
//     край (градиент перпендикулярен стороне) — рамка «в никуда» отсекается;
//  4) углы уточняются по найденным точкам края.
const DET = {
  gradMin: 14,          // минимальная величина градиента (Собель по размытому кадру)
  peakRatio: 2.2,       // пик края должен превосходить окружающую текстуру в столько раз
  alignCos: 0.85,       // |cos| между градиентом и нормалью стороны
  searchPx: 3,          // поиск края ±px от стороны
  minSide: 0.6,         // доля опоры на самой слабой стороне
  maxLines: 36,
  houghMinLen: 0.07,    // доля большей стороны кадра
};

/** Карты градиента кадра: величина и направление по цветовому каналу с самым сильным перепадом. */
function gradientMaps(needEdges = true) {
  const rgb = new cv.Mat(), blur = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  cv.GaussianBlur(rgb, blur, new cv.Size(5, 5), 1.2);
  const ch = new cv.MatVector();
  cv.split(blur, ch);
  const n = W * H;
  const mag2 = new Float32Array(n), gx = new Float32Array(n), gy = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    const plane = ch.get(c), dx = new cv.Mat(), dy = new cv.Mat();
    cv.Sobel(plane, dx, cv.CV_32F, 1, 0, 3);
    cv.Sobel(plane, dy, cv.CV_32F, 0, 1, 3);
    const a = dx.data32F, b = dy.data32F;
    for (let i = 0; i < n; i++) {
      const m = a[i] * a[i] + b[i] * b[i];
      if (m > mag2[i]) { mag2[i] = m; gx[i] = a[i]; gy[i] = b[i]; }
    }
    [plane, dx, dy].forEach((m) => m.delete());
  }
  const mag = new Float32Array(n);
  for (let i = 0; i < n; i++) mag[i] = Math.sqrt(mag2[i]);
  // карта краёв для Хафа — Кэнни по каждому каналу, объединение
  let edges = null;
  if (needEdges) {
    edges = new cv.Mat.zeros(H, W, cv.CV_8UC1);
    for (let c = 0; c < 3; c++) {
      const plane = ch.get(c), e = new cv.Mat();
      cv.Canny(plane, e, 14, 42);
      cv.bitwise_or(edges, e, edges);
      plane.delete(); e.delete();
    }
  }
  [rgb, blur].forEach((m) => m.delete());
  ch.delete();
  return { mag, gx, gy, edges };
}

/** Длинные прямые: сегменты Хафа, слитые по углу и смещению. */
function extractLines(edges) {
  const segs = new cv.Mat();
  const minLen = Math.max(30, DET.houghMinLen * Math.max(W, H));
  cv.HoughLinesP(edges, segs, 1, Math.PI / 180, 30, minLen, 8);
  const raw = [];
  for (let i = 0; i < segs.rows; i++) {
    const [x1, y1, x2, y2] = [segs.data32S[i * 4], segs.data32S[i * 4 + 1], segs.data32S[i * 4 + 2], segs.data32S[i * 4 + 3]];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < minLen * 0.9) continue;
    let th = Math.atan2(y2 - y1, x2 - x1);
    if (th < 0) th += Math.PI;
    if (th >= Math.PI) th -= Math.PI;
    const nx = -Math.sin(th), ny = Math.cos(th);
    raw.push({ x1, y1, x2, y2, len, th, rho: x1 * nx + y1 * ny });
  }
  segs.delete();
  raw.sort((a, b) => b.len - a.len);
  const cl = [];
  const dth = (a, b) => { const d = Math.abs(a - b); return Math.min(d, Math.PI - d); };
  for (const sg of raw) {
    let home = null;
    for (const c of cl) {
      if (dth(c.th, sg.th) > 0.05) continue;
      const nx = -Math.sin(c.th), ny = Math.cos(c.th);
      const r1 = sg.x1 * nx + sg.y1 * ny, r2 = sg.x2 * nx + sg.y2 * ny;
      if (Math.abs(r1 - c.rho) < 6 && Math.abs(r2 - c.rho) < 6) { home = c; break; }
    }
    if (home) { home.m.push(sg); home.len += sg.len; } else cl.push({ th: sg.th, rho: sg.rho, len: sg.len, m: [sg] });
  }
  // точная прямая по концам сегментов (взвешенная PCA) и протяжённость
  const lines = [];
  for (const c of cl) {
    let sx = 0, sy = 0, sw = 0;
    for (const g of c.m) { sx += (g.x1 + g.x2) * g.len / 2; sy += (g.y1 + g.y2) * g.len / 2; sw += g.len; }
    const mx = sx / sw, my = sy / sw;
    let cxx = 0, cxy = 0, cyy = 0;
    for (const g of c.m) for (const [x, y] of [[g.x1, g.y1], [g.x2, g.y2]]) {
      const dx = x - mx, dy = y - my;
      cxx += dx * dx * g.len; cxy += dx * dy * g.len; cyy += dy * dy * g.len;
    }
    const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const ux = Math.cos(ang), uy = Math.sin(ang);
    let t0 = Infinity, t1 = -Infinity;
    for (const g of c.m) for (const [x, y] of [[g.x1, g.y1], [g.x2, g.y2]]) {
      const t = (x - mx) * ux + (y - my) * uy;
      if (t < t0) t0 = t; if (t > t1) t1 = t;
    }
    lines.push({ x: mx, y: my, ux, uy, nx: -uy, ny: ux, t0, t1, len: c.len });
  }
  return lines;
}

function lineIntersect(a, b) {
  const den = a.ux * b.uy - a.uy * b.ux;
  if (Math.abs(den) < 0.06) return null; // почти параллельны (< ~3.5°)
  const t = ((b.x - a.x) * b.uy - (b.y - a.y) * b.ux) / den;
  return [a.x + a.ux * t, a.y + a.uy * t];
}

/** Доля точек стороны A→B, рядом с которыми есть край, перпендикулярный стороне; plus точки края. */
function sideSupport(maps, A, B, want) {
  const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
  if (len < 24) return { s: 0, pts: [] };
  const ux = (B[0] - A[0]) / len, uy = (B[1] - A[1]) / len, nx = -uy, ny = ux;
  const S = Math.max(12, Math.min(60, Math.round(len / 3)));
  const pts = [];
  let ok = 0;
  const R = DET.searchPx;
  for (let k = 0; k < S; k++) {
    const f = 0.03 + 0.94 * (k + 0.5) / S;
    const px = A[0] + (B[0] - A[0]) * f, py = A[1] + (B[1] - A[1]) * f;
    let best = 0, bt = 0;
    for (let t = -R; t <= R; t++) {
      const x = Math.round(px + nx * t), y = Math.round(py + ny * t);
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      const i = y * W + x, m = maps.mag[i];
      if (m < DET.gradMin || m <= best) continue;
      if (Math.abs(maps.gx[i] * nx + maps.gy[i] * ny) / m < DET.alignCos) continue;
      best = m; bt = t;
    }
    if (best > 0) {
      // настоящий край — выраженный пик на фоне спокойной окрестности; в текстуре (рисунок, фон)
      // градиент высок по обе стороны, и такой «край» отбрасывается
      let sum = 0, cnt = 0;
      for (const t of [-9, -8, -7, -6, -5, 5, 6, 7, 8, 9]) {
        const x = Math.round(px + nx * (bt + t)), y = Math.round(py + ny * (bt + t));
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        sum += maps.mag[y * W + x]; cnt++;
      }
      if (cnt >= 4 && best >= DET.peakRatio * (sum / cnt)) { ok++; if (want) pts.push([px + nx * bt, py + ny * bt]); }
    }
  }
  return { s: ok / S, pts };
}

/** Прямая по точкам (ортогональная регрессия, 3 прохода с отбросом выбросов). */
function fitPts(pts) {
  if (pts.length < 6) return null;
  let use = pts, line = null;
  for (let it = 0; it < 3; it++) {
    let mx = 0, my = 0;
    for (const p of use) { mx += p[0]; my += p[1]; }
    mx /= use.length; my /= use.length;
    let cxx = 0, cxy = 0, cyy = 0;
    for (const p of use) { const dx = p[0] - mx, dy = p[1] - my; cxx += dx * dx; cxy += dx * dy; cyy += dy * dy; }
    const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    line = { x: mx, y: my, ux: Math.cos(ang), uy: Math.sin(ang) };
    line.nx = -line.uy; line.ny = line.ux;
    const keep = pts.filter((p) => Math.abs((p[0] - mx) * line.nx + (p[1] - my) * line.ny) < (it === 0 ? 2.5 : 1.5));
    if (keep.length < 6) break;
    use = keep;
  }
  return line;
}

function quadOk(q) {
  if (!convex(q)) return false;
  const a = Math.abs(quadArea(q)) / (W * H);
  if (a < 0.03 || a > 0.9) return false;
  const mx = 0.12 * W, my = 0.12 * H;
  if (q.some(([x, y]) => x < -mx || x > W + mx || y < -my || y > H + my)) return false;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4], pr = q[(i + 3) % 4];
    const v1 = [pr[0] - p[0], pr[1] - p[1]], v2 = [n[0] - p[0], n[1] - p[1]];
    const c = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
    if (c > 0.82 || c < -0.82) return false; // угол < 35° или > 145°
  }
  return true;
}

/** Сторона A→B лежит на границе кадра (холст выходит за кадр — его край не виден). */
function onBorder(A, B) {
  const e = 4;
  return (A[0] <= e && B[0] <= e) || (A[0] >= W - 1 - e && B[0] >= W - 1 - e) ||
    (A[1] <= e && B[1] <= e) || (A[1] >= H - 1 - e && B[1] >= H - 1 - e);
}

function scoreQuad(maps, q, want) {
  const sides = [];
  let prod = 1, minS = 1, nb = 0;
  const border = [false, false, false, false];
  for (let j = 0; j < 4; j++) {
    const A = q[j], B = q[(j + 1) % 4];
    if (onBorder(A, B)) { border[j] = true; nb++; sides.push({ s: 1, pts: [] }); continue; }
    const r = sideSupport(maps, A, B, want);
    if (r.s < DET.minSide) return null;
    sides.push(r); prod *= r.s; minS = Math.min(minS, r.s);
  }
  // холст может выходить за кадр: допускаем одну сторону на границе кадра или две смежные,
  // но не противоположные и не больше (иначе «рамка во весь кадр» получает опору задаром)
  if (nb > 2 || (nb === 2 && border[0] === border[2])) return null;
  const g = Math.pow(prod, 1 / (4 - nb));
  const area = Math.abs(quadArea(q)) / (W * H);
  // крупный холст в кадре предпочтительнее; сторона на границе кадра — с неё штраф
  const score = g * Math.pow(area, 0.3) * Math.pow(0.82, nb);
  return { score, g, minS, sides, border: nb };
}

function findCanvasCandidates() {
  const maps = gradientMaps();
  let lines = extractLines(maps.edges);
  maps.edges.delete();
  // оставляем только линии, вдоль которых действительно есть край, и ранжируем по «опорной» длине
  lines = lines.map((l) => {
    const A = [l.x + l.ux * l.t0, l.y + l.uy * l.t0], B = [l.x + l.ux * l.t1, l.y + l.uy * l.t1];
    const sp = sideSupport(maps, A, B, false).s;
    return { ...l, sp, rank: sp * (l.t1 - l.t0) };
  }).filter((l) => l.sp >= 0.5).sort((a, b) => b.rank - a.rank).slice(0, DET.maxLines);
  // границы кадра как «виртуальные» линии: холст может не помещаться в кадр
  const m = 2;
  for (const [x, y, ux, uy, len] of [[m, 0, 0, 1, H], [W - 1 - m, 0, 0, 1, H], [0, m, 1, 0, W], [0, H - 1 - m, 1, 0, W]]) {
    lines.push({ x, y, ux, uy, nx: -uy, ny: ux, t0: 0, t1: len, len, sp: 1, rank: 0, border: true });
  }
  const out = [];
  const K = lines.length;
  for (let a = 0; a < K; a++) for (let b = a + 1; b < K; b++) for (let c = b + 1; c < K; c++) for (let d = c + 1; d < K; d++) {
    const L = [lines[a], lines[b], lines[c], lines[d]];
    for (const [i0, i1, j0, j1] of [[0, 1, 2, 3], [0, 2, 1, 3], [0, 3, 1, 2]]) {
      // противоположные пары (i0,i1) и (j0,j1): вершины i0∩j0, j0∩i1, i1∩j1, j1∩i0
      const v0 = lineIntersect(L[i0], L[j0]), v1 = lineIntersect(L[j0], L[i1]);
      const v2 = lineIntersect(L[i1], L[j1]), v3 = lineIntersect(L[j1], L[i0]);
      if (!v0 || !v1 || !v2 || !v3) continue;
      const q = [v0, v1, v2, v3];
      if (!quadOk(q)) continue;
      const r = scoreQuad(maps, q, false);
      if (r) out.push({ q, ...r });
    }
  }
  out.sort((x, y) => y.score - x.score);
  // убираем почти одинаковые, уточняем углы у лучших
  const res = [];
  const diag = Math.hypot(W, H);
  for (const c of out) {
    const o = orderQuad(c.q);
    if (res.some((r) => r.q.every((p, i) => Math.hypot(p[0] - o[i][0], p[1] - o[i][1]) < 0.03 * diag))) continue;
    const refined = refineQuad(maps, o) || o;
    const sc = scoreQuad(maps, refined, false) || c;
    res.push({ q: refined, score: sc.score, support: sc.g, weakest: sc.minS });
    if (res.length >= 4) break;
  }
  return res;
}

/** Уточнение углов: прямые заново подгоняются по точкам края вдоль каждой стороны. */
function refineQuad(maps, q, opt = {}) {
  let cur = q, ok = false;
  for (let it = 0; it < (opt.iters || 1); it++) {
    const keep = DET.searchPx;
    DET.searchPx = opt.iters ? [7, 5, 3][Math.min(it, 2)] : keep; // сначала широкий поиск краёв, затем уже точнее
    const nq = refineOnce(maps, cur, !opt.anchors);
    DET.searchPx = keep;
    if (!nq) break;
    // не уходим от того, что показал пользователь: угол остаётся рядом с касанием
    if (opt.anchors && nq.some((p, i) => Math.hypot(p[0] - opt.anchors[i][0], p[1] - opt.anchors[i][1]) > opt.rad)) break;
    const moved = Math.max(...nq.map((p, i) => Math.hypot(p[0] - cur[i][0], p[1] - cur[i][1])));
    cur = nq; ok = true;
    if (moved < 0.3) break;
  }
  return ok ? cur : null;
}

function refineOnce(maps, q, limitMove) {
  const ls = [];
  for (let j = 0; j < 4; j++) {
    const A = q[j], B = q[(j + 1) % 4];
    let l;
    if (onBorder(A, B)) {
      const d = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
      l = { x: A[0], y: A[1], ux: (B[0] - A[0]) / d, uy: (B[1] - A[1]) / d }; // граница кадра остаётся как есть
    } else {
      l = fitPts(sideSupport(maps, A, B, true).pts);
      if (!l) { // край не виден — оставляем сторону как есть (прямая через заданные углы)
        const d = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
        l = { x: A[0], y: A[1], ux: (B[0] - A[0]) / d, uy: (B[1] - A[1]) / d };
      }
    }
    ls.push(l);
  }
  const nq = [0, 1, 2, 3].map((j) => lineIntersect(ls[(j + 3) % 4], ls[j]));
  if (nq.some((p) => !p)) return null;
  const diag = Math.hypot(W, H);
  if (limitMove && nq.some((p, i) => Math.hypot(p[0] - q[i][0], p[1] - q[i][1]) > 0.04 * diag)) return null;
  return quadOk(nq) ? nq : null;
}

// ---------- выбор холста касаниями ----------
// Пользователь касается углов холста (в любом порядке). Каждое касание притягивается к ближайшему
// настоящему углу: точке, из которой выходят два длинных прямых края под разумным углом.
// Затем 4 точки упорядочиваются и уточняются по краям между ними.
const SNAP = {
  radius: 0.05,         // радиус поиска угла вокруг касания, доля большей стороны кадра (≈ 37 css-px на телефоне)
  rayLen: 0.11,         // длина лучей-краёв
  rays: 24,             // направлений (шаг 15°)
  minSupport: 0.5,      // доля луча, на которой есть край нужного направления
  minScore: 0.4,
  minAngle: 40, maxAngle: 140, // допустимый угол между краями, градусы (перспектива)
};

/** Карта «пиксель края»: номер ориентации (1..12) или 0. Пик градиента заметно выше соседей вдоль градиента. */
function edgeOrientMap(maps, x0, y0, x1, y1) {
  const edge = new Uint8Array(W * H);
  const { mag, gx, gy } = maps;
  for (let y = Math.max(10, y0); y < Math.min(H - 10, y1); y++) {
    for (let x = Math.max(10, x0); x < Math.min(W - 10, x1); x++) {
      const i = y * W + x, m = mag[i];
      if (m < DET.gradMin) continue;
      const nx = gx[i] / m, ny = gy[i] / m;
      const at = (t) => mag[Math.round(y + ny * t) * W + Math.round(x + nx * t)];
      if (m < at(-1) || m < at(1)) continue; // локальный максимум поперёк края
      const mean = (at(-9) + at(-8) + at(-7) + at(-6) + at(-5) + at(5) + at(6) + at(7) + at(8) + at(9)) / 10;
      if (m < DET.peakRatio * mean) continue;
      let ang = Math.atan2(ny, nx) + Math.PI / 2; // направление края
      ang = ((ang % Math.PI) + Math.PI) % Math.PI;
      edge[i] = 1 + (Math.floor(ang / (Math.PI / 12)) % 12);
    }
  }
  return edge;
}

/**
 * Опора луча из q в направлении θ (рад): доля точек луча, рядом (±2 px поперёк) с которыми есть край
 * той же ориентации (±15°). pts, если передан, пополняется найденными краевыми точками.
 */
function raySupport(edge, qx, qy, th, L, pts) {
  const dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
  const want = Math.round((((th % Math.PI) + Math.PI) % Math.PI) / (Math.PI / 12)) % 12; // ожидаемая ориентация 0..11
  let hit = 0, n = 0;
  for (let t = 6; t <= L; t += 2) {
    n++;
    for (const o of [0, -1, 1, -2, 2]) {
      const x = Math.round(qx + dx * t + nx * o), y = Math.round(qy + dy * t + ny * o);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const e = edge[y * W + x];
      if (!e) continue;
      let d = Math.abs(e - 1 - want);
      d = Math.min(d, 12 - d);
      if (d > 1) continue;
      hit++;
      if (pts) pts.push([x, y]);
      break;
    }
  }
  return n ? hit / n : 0;
}

function snapCorner(maps, tap, others, opt = {}) {
  const M = Math.max(W, H), R = opt.radius || SNAP.radius * M, L = SNAP.rayLen * M;
  const pad = R + L + 8;
  const edge = edgeOrientMap(maps, Math.floor(tap[0] - pad), Math.floor(tap[1] - pad), Math.ceil(tap[0] + pad), Math.ceil(tap[1] + pad));
  const K = SNAP.rays, step = 2 * Math.PI / K;
  const toDeg = 180 / Math.PI;
  let best = null;
  for (let qy = Math.floor(tap[1] - R); qy <= tap[1] + R; qy += 2) {
    for (let qx = Math.floor(tap[0] - R); qx <= tap[0] + R; qx += 2) {
      const d = Math.hypot(qx - tap[0], qy - tap[1]);
      if (d > R || qx < 3 || qy < 3 || qx > W - 4 || qy > H - 4) continue;
      // угол лежит на краю: рядом (±2 px) должен быть краевой пиксель
      let onEdge = false;
      for (let oy = -2; oy <= 2 && !onEdge; oy++) for (let ox = -2; ox <= 2; ox++) if (edge[(qy + oy) * W + qx + ox]) { onEdge = true; break; }
      if (!onEdge) continue;
      const sup = new Float32Array(K);
      for (let k = 0; k < K; k++) {
        sup[k] = raySupport(edge, qx, qy, k * step, L, null);
        // луч в сторону другого касания — вероятное ребро холста
        for (const o of others) {
          let da = Math.abs(Math.atan2(o[1] - qy, o[0] - qx) - k * step); da = Math.min(da, 2 * Math.PI - da);
          if (sup[k] >= 0.5 && da < 10 / toDeg) { sup[k] = Math.min(1, sup[k] + 0.06); break; }
        }
      }
      for (let i = 0; i < K; i++) {
        if (sup[i] < SNAP.minSupport) continue;
        for (let j = i + 1; j < K; j++) {
          if (sup[j] < SNAP.minSupport) continue;
          let sep = (j - i) * step * toDeg; if (sep > 180) sep = 360 - sep;
          if (sep < SNAP.minAngle || sep > SNAP.maxAngle) continue;
          // ребро заканчивается в углу; продолжение «сквозь» точку (Т-образно) — слабый штраф
          const opp = (sup[(i + K / 2) % K] + sup[(j + K / 2) % K]) / 2;
          // настоящий угол: ОБА края опираются на весь луч; точка рядом с углом на одной стороне имеет
          // у второго луча лишь частичную опору — произведение это строго наказывает
          const base = Math.pow(sup[i] * sup[j], 0.75) * (1 - 0.3 * Math.max(0, opp - 0.25));
          let score = base * (1 - 0.2 * (d / R) * (d / R));
          if (opt.rays) { // тот же угол, что в прошлом кадре: края идут примерно в тех же направлениях
            const near = (a, b) => { let dd = Math.abs(a - b); dd = Math.min(dd, K - dd); return dd <= 1; };
            const [a, b] = opt.rays;
            if ((near(i, a) && near(j, b)) || (near(i, b) && near(j, a))) score *= 1.15;
            else score *= 0.8;
          }
          if (!best || score > best.score) best = { score, x: qx, y: qy, i, j };
        }
      }
    }
  }
  if (!best || best.score < (opt.minScore || SNAP.minScore)) return { snapped: false, p: tap, score: best ? best.score : 0 };
  // уточнение: прямые по краевым точкам вдоль двух лучей, угол — их пересечение
  let p = [best.x, best.y];
  const lines = [];
  for (const k of [best.i, best.j]) {
    const pts = [];
    raySupport(edge, best.x, best.y, k * step, L, pts);
    lines.push(fitPts(pts));
  }
  if (lines[0] && lines[1]) {
    const c = lineIntersect(lines[0], lines[1]);
    if (c && Math.hypot(c[0] - best.x, c[1] - best.y) < 6) p = c;
  }
  return { snapped: true, p, score: best.score, rays: [best.i, best.j] };
}

/** Четыре точки в любом порядке → упорядоченный четырёхугольник, уточнённый по краям между ними. */
function buildQuad(maps, pts, taps, rad) {
  const idx = orderIdx(pts), o = idx.map((i) => pts[i]);
  if (!convex(o) || Math.abs(quadArea(o)) < 0.002 * W * H) return { quad: null };
  const r = refineQuad(maps, o, { iters: 3, anchors: idx.map((i) => taps[i]), rad: rad || 1.6 * SNAP.radius * Math.max(W, H) });
  return { quad: r || o, refined: !!r };
}

// ---------- выбор углов на живом видео ----------
// Кадр не замирает. Касание ставит точку на ближайшем углу, и с этого момента точка ведётся
// сама: каждый кадр — оптический поток (прогноз), затем привязка к углу рядом с прогнозом
// (края того же направления, малый радиус) — так точка не уплывает вместе с фоном.
// Когда отмечены все 4 угла, рамка строится и трекинг холста стартует с текущего кадра.
const SELT = { lkWin: 21, snapRadius: 8, maxJump: 6, maxMiss: 12, maxFail: 25 };

function selSwap() { const t = prevNorm; prevNorm = norm; norm = t; }

/** Сдвинуть отмеченные точки с прошлого кадра на текущий. Возвращает карты градиента текущего кадра. */
function selUpdate() {
  const maps = gradientMaps(false);
  const act = sel.pts.filter((pt) => !pt.lost);
  if (!act.length) return maps;
  const flat = [];
  for (const pt of act) flat.push(pt.p[0], pt.p[1]);
  const { idx, out } = lkPairs(prevNorm, norm, flat, SELT.lkWin, 3, true);
  const got = new Map(idx.map((i, k) => [i, k]));
  act.forEach((pt, i) => {
    const k = got.get(i);
    if (k === undefined) { // поток потерял точку — держим на месте, пока не вернётся
      if (++pt.miss > SELT.maxMiss) pt.lost = true;
      return;
    }
    pt.miss = 0;
    const p = [out[k * 2], out[k * 2 + 1]];
    // точка, которая угла не нашла (кожа, гладкая бумага), ведётся одним потоком — без привязки к углу
    if (!pt.snapped) { pt.p = p; return; }
    const r = snapCorner(maps, p, [], { radius: SELT.snapRadius, rays: pt.rays, minScore: 0.35 });
    if (r.snapped && Math.hypot(r.p[0] - p[0], r.p[1] - p[1]) < SELT.maxJump) {
      pt.p = r.p; pt.rays = r.rays; pt.score = r.score; pt.fail = 0;
    } else {
      pt.p = p;
      if (++pt.fail > SELT.maxFail) pt.lost = true;
    }
  });
  return maps;
}

const selOut = () => sel.pts.map((pt) => ({ p: outQuad([pt.p])[0], snapped: pt.snapped, lost: !!pt.lost, score: +(pt.score || 0).toFixed(2) }));

function selStart(msg) {
  loadFrame(msg);
  normalize(gray, norm);
  norm.copyTo(prevNorm);
  dropState(); st = null;
  sel = { pts: [] };
  return { type: 'selStarted' };
}

function selFrame(msg) {
  if (msg.w !== W || msg.h !== H) { // сменился размер кадра (поворот) — выбор начинается заново
    loadFrame(msg); normalize(gray, norm); norm.copyTo(prevNorm);
    sel.pts = [];
    return { type: 'sel', pts: [], reset: true };
  }
  loadFrame(msg);
  normalize(gray, norm);
  selUpdate();
  selSwap();
  return { type: 'sel', pts: selOut() };
}

function selTap(msg) {
  if (!sel) throw new Error('выбор углов не начат');
  loadFrame(msg);
  normalize(gray, norm);
  const maps = selUpdate();
  const tap = inQuad([msg.point])[0];
  const active = sel.pts.filter((pt) => !pt.lost);
  const r = snapCorner(maps, tap, active.map((pt) => pt.p));
  sel.pts.push({ p: r.p, rays: r.rays || null, snapped: r.snapped, miss: 0, fail: 0, score: r.score });
  if (sel.pts.length < 4) { selSwap(); return { type: 'tapped', snapped: r.snapped, p: outQuad([r.p])[0], pts: selOut() }; }
  // все 4 угла отмечены: рамка = упорядоченные точки, уточнённые по краям между ними
  const pts = sel.pts.map((pt) => pt.p);
  // уточнять по краям есть смысл, только если углы найдены; иначе (ладонь, бумага) рамка — как отмечена
  const snappedN = sel.pts.filter((pt) => pt.snapped).length;
  let b;
  if (snappedN >= 3) b = buildQuad(maps, pts, pts, 26); // допуск: на сколько рамка может уйти от отмеченных точек
  else {
    const o = orderQuad(pts);
    b = convex(o) && Math.abs(quadArea(o)) > 0.002 * W * H ? { quad: o } : { quad: null };
  } // допуск: на сколько рамка может уйти от отмеченных точек
  if (!b.quad) { selSwap(); return { type: 'tapped', snapped: r.snapped, p: outQuad([r.p])[0], pts: selOut(), badQuad: true }; }
  const lockInfo = startTracking(b.quad, msg); // копирует norm → prevNorm и сбрасывает sel
  return { ...lockInfo, type: 'locked', tapped: true, snapped: r.snapped, p: outQuad([r.p])[0] };
}

function selBack() {
  if (sel) sel.pts.pop();
  return { type: 'ok', pts: sel ? selOut() : [] };
}

function detect(msg) {
  loadFrame(msg);
  const cands = findCanvasCandidates();
  return {
    type: 'detected',
    quad: cands.length ? outQuad(cands[0].q) : null,
    cands: cands.map((c) => ({ q: outQuad(c.q), score: +c.score.toFixed(3), support: +c.support.toFixed(2), weakest: +c.weakest.toFixed(2) })),
  };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      if (!ready) {
        await loadCv(msg.urls);
        orb = new cv.ORB(CFG.orbFeatures);
        matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
        ready = true;
        benchMs = benchmark();
      }
      postMessage({ type: 'ready', id: msg.id, bitmap: typeof OffscreenCanvas !== 'undefined', bench: benchMs });
      return;
    }
    if (!ready) throw new Error('OpenCV ещё не загружен');
    let res;
    if (msg.type === 'lock') res = lock(msg);
    else if (msg.type === 'frame') res = sel ? selFrame(msg) : track(msg);
    else if (msg.type === 'debugPts') { self.DEBUG_PTS = true; res = { type: 'ok' }; }
    else if (msg.type === 'debugMinMs') { self.DEBUG_MIN_MS = msg.ms; res = { type: 'ok' }; }
    else if (msg.type === 'selStart') res = selStart(msg);
    else if (msg.type === 'selTap') res = selTap(msg);
    else if (msg.type === 'selBack') res = selBack();
    else if (msg.type === 'addAnchor') res = addAnchor(msg);
    else if (msg.type === 'removeAnchor') res = removeAnchor(msg);
    else if (msg.type === 'detect') res = detect(msg);
    else if (msg.type === 'setQuad') {
      // пользователь поправил рамку холста во время трекинга (в опорных координатах)
      if (st) { st.quad = inQuad(msg.quad); st.searchQuad = expandQuad(st.quad, msg.margin ?? CFG.margin); }
      res = { type: 'ok' };
    } else if (msg.type === 'unlock') {
      dropState(); st = null; sel = null; res = { type: 'unlocked' };
    }
    if (res) postMessage({ ...res, id: msg.id });
  } catch (err) {
    if (msg.bmp && msg.bmp.close) msg.bmp.close();
    let message = String((err && err.message) || err);
    // исключения OpenCV приходят как указатель на C++-объект
    if (typeof err === 'number' && self.cv && cv.exceptionFromPtr) {
      try { message = cv.exceptionFromPtr(err).msg; } catch { /* оставить как есть */ }
    }
    postMessage({ type: 'error', id: msg.id, message });
  }
};
