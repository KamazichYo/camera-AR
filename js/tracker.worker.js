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
  minPointStd: 6,         // минимальный локальный контраст точки (уровней) — не цепляться за шум
  ransacRefine: 2.0,      // px
  minRefine: 10,
  ransacLK: 2.5,          // px
  ransacORB: 4.0,         // px
  orbFeatures: 900,
  ratio: 0.78,            // тест Лоу
  minInliersLK: 8,
  minInliersORB: 16,
  relocEvery: 20,         // кадров между проверками дрейфа (ORB)
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
function orderQuad(pts) {
  const [cx, cy] = centroid(pts);
  const s = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let k = 0;
  s.forEach((p, i) => { if (p[0] + p[1] < s[k][0] + s[k][1]) k = i; });
  return [...s.slice(k), ...s.slice(0, k)];
}

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

function detectCorners(img, mask, max, exclude) {
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
  if (st.tmpl) st.tmpl.img.delete();
  st.tmpl = null;
}

/** Сопоставление ORB текущего кадра с ключевыми кадрами. */
function relocalize(img, Hguess) {
  const mask = Hguess ? polyMask(mapQuad(Hguess, expandQuad(st.quad, 0.25))) : new cv.Mat();
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
  const { idx, out } = lkPairs(prevNorm, norm, st.cur, CFG.lkWin, CFG.lkLevels, CFG.lkBackCheck);
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
function seedPoints(Hm, keep) {
  const mask = currentMask(Hm);
  const curPts = keep ? Array.from(st.cur) : [];
  const refPts = keep ? Array.from(st.ref) : [];
  const need = CFG.maxCorners - curPts.length / 2;
  if (need > 10) {
    const fresh = detectCorners(gray, mask, need, curPts);
    const inv = invertH(Hm);
    for (let i = 0; i < fresh.length; i += 2) {
      const r = applyH(inv, fresh[i], fresh[i + 1]);
      curPts.push(fresh[i], fresh[i + 1]);
      refPts.push(r[0], r[1]);
    }
  }
  mask.delete();
  st.cur = Float32Array.from(curPts);
  st.ref = Float32Array.from(refPts);
}

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
  if (st.tmpl) st.tmpl.img.delete();
  const mask = polyMask(st.fullFrame ? [[0, 0], [W, 0], [W, H], [0, H]] : st.searchQuad);
  if (validMask) cv.bitwise_and(mask, validMask, mask);
  const pts = detectCorners(rawRef, mask, CFG.tmplCorners);
  mask.delete();
  const img = new cv.Mat();
  normalize(rawRef, img);
  st.tmpl = { img, pts: Float32Array.from(pts), n: pts.length / 2, low: 0 };
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
  const raw = warpToRef(gray, Hm);
  const warped = new cv.Mat();
  normalize(raw, warped);
  raw.delete();
  const { idx, out } = lkPairs(t.img, warped, t.pts, 15, 2, CFG.tmplBackCheck);
  warped.delete();
  if (idx.length < 4) return res;
  const src = [];
  for (const i of idx) src.push(t.pts[i * 2], t.pts[i * 2 + 1]);
  let mask = null;
  if (idx.length >= 8) {
    const r = findH(src, out, CFG.ransacRefine, 500);
    if (r) mask = r.mask;
  }
  for (let i = 0; i < idx.length; i++) {
    if (mask && !mask[i]) continue;
    const c = applyH(Hm, out[i * 2], out[i * 2 + 1]);
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
    st.edges.push({ use: len > 20 && n >= 8 && Math.abs(diff) >= CFG.edgeMinContrast, pol: Math.sign(diff), contrast: Math.abs(diff) });
  }
}

/** Прямая по точкам методом RANSAC + уточнение МНК. Возвращает inlier-точки. */
function fitLine(pts) {
  const n = pts.length;
  if (n < CFG.edgeMinInliers) return null;
  let best = null;
  for (let it = 0; it < 40; it++) {
    const a = pts[(Math.random() * n) | 0], b = pts[(Math.random() * n) | 0];
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    if (L < 5) continue;
    const nx = -dy / L, ny = dx / L;
    const inl = pts.filter((p) => Math.abs((p[0] - a[0]) * nx + (p[1] - a[1]) * ny) < 1.2);
    if (!best || inl.length > best.length) best = inl;
  }
  return best && best.length >= CFG.edgeMinInliers ? best : null;
}

/** Поиск краёв холста вокруг позы Hm. Возвращает наблюдения { j, pts } для надёжных сторон. */
function edgeObservations(Hm, radius) {
  const out = [];
  if (!st.edges) return out;
  const q = mapQuad(Hm, st.quad);
  const S = CFG.edgeSamples;
  for (let j = 0; j < 4; j++) {
    const e = st.edges[j];
    if (!e.use) continue;
    const { A, B, len, nx, ny } = edgeGeom(q, j);
    if (len < 20) continue;
    const minD = Math.max(5, e.contrast * 0.3);
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
    if (inl && inl.length >= S * 0.35) out.push({ j, pts: inl });
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
    for (let i = 0; i < 8; i++) r.push(wPrior * (xv[i] - prior[(i / 2) | 0][i % 2]));
    return r;
  };

  let r = residuals(x);
  if (!r) return { H: Hinit, rms: Infinity };
  const m = r.length, nPrior = 8;
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
  dropState();
  const quad = inQuad(msg.quad);
  st = {
    quad,
    searchQuad: expandQuad(quad, msg.margin ?? CFG.margin),
    fullFrame: !!msg.fullFrame,
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
  };
  learnEdges();
  seedPoints(st.H, false);
  st.initialPts = st.cur.length / 2;
  setTemplate(gray, null);
  st.keyframes.push(makeKeyframe(gray, st.H, now()));
  norm.copyTo(prevNorm);
  const kf = st.keyframes[0];
  const goodEdges = st.edges.filter((e) => e.use).length;
  return {
    type: 'locked',
    points: st.initialPts,
    features: kf.n,
    edges: goodEdges,
    weak: st.tmpl.n < 15 && goodEdges < 3,
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
  if (wasLost || st.frame - st.lastReloc >= CFG.relocEvery) {
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

  // измерения без дрейфа
  const pairs = templatePairs(pred);
  lap('tmpl');
  const motion = quadDist(pred, Hprev);
  const radius = Math.round(Math.min(24, CFG.edgeRadius + (source === 'lk' ? 0 : motion * 0.5) + (wasLost ? 6 : 0)));
  const edges = edgeObservations(pred, radius);
  lap('edges');

  // достаточно ли измерений, чтобы доверять позе
  const nEdges = edges.length;
  // точки шаблона засчитываются, только если совпала заметная их доля (иначе это шум)
  const tmplOk = pairs.n >= CFG.minRefine && (pairs.ratio >= 0.12 || pairs.n >= 30);
  const good = tmplOk || nEdges >= 3 || (nEdges >= 2 && pairs.n >= 4) ||
    (!wasLost && lkInl >= 15 && pairs.n >= 4);
  let state = 'lost', rms = 0;
  if (good) {
    const opt = optimize(pred, pred, pairs, edges);
    rms = opt.rms;
    if (plausible(opt.H) && opt.rms < 3) {
      st.prevH = wasLost ? null : Hprev;
      st.H = opt.H;
      st.lost = 0;
      state = 'tracking';
    }
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
    // рисунок заметно изменился — обновляем шаблон
    st.tmpl.low = st.tmpl.n >= 8 && pairs.ratio < 0.4 ? st.tmpl.low + 1 : 0;
    if (st.tmpl.low > 20 && st.stable > 5) updateTemplate();
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
  return {
    type: 'pose',
    state,
    H: outH(st.H),
    inliers: lkInl,
    refined: pairs.n,
    edges: nEdges,
    rms: +rms.toFixed(2),
    points: st.cur.length / 2,
    keyframes: st.keyframes.length,
    source,
    ms: Math.round(now() - tStart),
    prof,
  };
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
function gradientMaps() {
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
  const edges = new cv.Mat.zeros(H, W, cv.CV_8UC1);
  for (let c = 0; c < 3; c++) {
    const plane = ch.get(c), e = new cv.Mat();
    cv.Canny(plane, e, 14, 42);
    cv.bitwise_or(edges, e, edges);
    plane.delete(); e.delete();
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
function refineQuad(maps, q) {
  const ls = [];
  for (let j = 0; j < 4; j++) {
    const A = q[j], B = q[(j + 1) % 4];
    let l;
    if (onBorder(A, B)) {
      const d = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
      l = { x: A[0], y: A[1], ux: (B[0] - A[0]) / d, uy: (B[1] - A[1]) / d }; // граница кадра остаётся как есть
    } else {
      l = fitPts(sideSupport(maps, A, B, true).pts);
    }
    if (!l) return null;
    ls.push(l);
  }
  const nq = [0, 1, 2, 3].map((j) => lineIntersect(ls[(j + 3) % 4], ls[j]));
  if (nq.some((p) => !p)) return null;
  const diag = Math.hypot(W, H);
  if (nq.some((p, i) => Math.hypot(p[0] - q[i][0], p[1] - q[i][1]) > 0.04 * diag)) return null;
  return quadOk(nq) ? nq : null;
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
      }
      postMessage({ type: 'ready', id: msg.id, bitmap: typeof OffscreenCanvas !== 'undefined' });
      return;
    }
    if (!ready) throw new Error('OpenCV ещё не загружен');
    let res;
    if (msg.type === 'lock') res = lock(msg);
    else if (msg.type === 'frame') res = track(msg);
    else if (msg.type === 'detect') res = detect(msg);
    else if (msg.type === 'setQuad') {
      // пользователь поправил рамку холста во время трекинга (в опорных координатах)
      if (st) { st.quad = inQuad(msg.quad); st.searchQuad = expandQuad(st.quad, msg.margin ?? CFG.margin); }
      res = { type: 'ok' };
    } else if (msg.type === 'unlock') {
      dropState(); st = null; res = { type: 'unlocked' };
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
