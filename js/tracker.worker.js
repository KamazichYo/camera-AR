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
  sbi: true,              // грубое предсказание движения по маленькому кадру (см. coarseShift)
  sbiMinMove: 12,
  edgeProfile: true,      // край ищется по профилю, запомненному при захвате (см. sideProfile)
  edgeZnccMin: 0.5,
  skin: true,             // маска кожи (рука не опора)
  skinUse: 14,            // где применять маску кожи (отладка): 1 поток, 2 посев точек, 4 края, 8 ECC
  skinBg: false,          // оттенки фона вокруг предмета кожей не считать (деревянный стол)
  eccGuardMax: true,      // ECC против потока — по худшей точке, а не по среднему
  eccEdgeArb: true,       // спор ECC и потока решают края
  relocAgree: true,       // перезахват по якорю — только с согласия точек потока
  eccLowLk: true,         // при сотнях точек потока ECC не включается из-за одной лишь слабой фактуры шаблона
  edgeGain: true,         // проверка цвета у края — с поправкой на яркость (блик)
  chromaNoSkin: false,    // цель с цветным силуэтом, ведомая своими точками, — без маски кожи
  chromaSnap: true,       // при захвате ставить стороны на край со сменой оттенка (см. snapSidesToChroma)
  envCheck: false,        // в режиме окружения сверять позу по своим точкам с позой по всем (см. trackLK)
  lkWeight: 0.6,          // вес точек потока в оптимизации позы (относительно точек шаблона и краёв)
  reanchorAlpha: 1,       // доля, на которую опорные координаты точек подтягиваются к позе кадра (см. reanchor)
  sup: true,              // автоопоры на плоскости холста (см. supUpkeep)         // px: меньшее движение поток находит сам
  maxCorners: 160,
  minCorners: 25,
  cornerQuality: 0.006,
  cornerMinDist: 7,
  lkWin: 21,              // окно потока (15 px быстрее на ≈ 3 мс, но у целей с малым числом деталей рамка начинает плыть)
  lkLevels: 3,
  fbMaxErr: 1.5,          // px — допустимая ошибка проверки вперёд-назад
  lkBackCheck: false,     // межкадровый поток — только прогноз, RANSAC и шаблон отсеют ошибки
  tmplBackCheck: true,    // защита от ложной позы (тёмный/закрытый кадр)
  tmplCorners: 160,       // точек в шаблоне для уточнения позы
  wPersp: 0.6,            // вес штрафа за перспективу в оптимизаторе
  coastMax: 8,            // сколько кадров подряд ехать по инерции при сбое, прежде чем объявить потерю
  edgeGate: 100,            // px: когда поза по потоку надёжна, край ищется только в такой окрестности предсказания
  eccVsLk: 5,              // px: допустимое расхождение ECC с уверенной позой по потоку (на видимой части холста)
  envEdgeErr: 4.5,        // px: края листа стабильно дальше этого от позы по фону — лист двигают отдельно от окружения
  liteMs: 55,             // среднее время кадра выше этого (слабый телефон) — включается облегчённый режим (ниже 0.75× — выключается)
  perspDev: 5,            // px: гомография по опорам отличается от аффинной больше этого — перспектива «чужая», берём аффинную
  ownMin: 20,             // столько своих точек холста — поза (гомография) по ним одним, без опор/окружения из других плоскостей
  ownFew: 6,              // от стольких своих точек — аффинная модель по ним (меньше — ведут опоры/окружение, тоже аффинно)
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
  relocStretch: 3,        // во сколько раз может вырасти интервал проверки дрейфа, пока она подтверждает позу
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
let small = null, prevSmall = null, smallK = 1; // маленький размытый кадр (см. coarseShift)
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
// «Часы» для логики трекера (как часто заводить ключевой кадр): в приложении — настоящее время, в тестах стенд присылает
// время кадра (номер кадра × 33 мс), чтобы прогон не зависел от скорости машины и повторялся один в один
let clockT = null;
const clock = () => (clockT !== null ? clockT : now());

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
  [rgba, gray, norm, prevNorm, F32, MU, D, V, small, prevSmall].forEach((m) => m && m.delete());
  small = new cv.Mat(); prevSmall = new cv.Mat();
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

/** Расхождение двух поз там, где холст виден в кадре (сетка точек холста внутри кадра): углы за кадром дают огромные, но неважные цифры. */
function visDist(H1, H2, useMax = false) {
  const q = st.quad, xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let s = 0, n = 0;
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
    const x = x0 + (x1 - x0) * i / 4, y = y0 + (y1 - y0) * j / 4;
    const a = applyH(H1, x, y);
    if (!(a[0] >= 0 && a[1] >= 0 && a[0] < W && a[1] < H)) continue;
    const b = applyH(H2, x, y);
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (useMax) s = Math.max(s, d); else s += d;
    n++;
  }
  return n >= 4 ? (useMax ? s : s / n) : quadDist(H1, H2);
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

function pointInPoly(x, y, q) {
  let inside = false;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    if ((q[i][1] > y) !== (q[j][1] > y) && x < (q[j][0] - q[i][0]) * (y - q[i][1]) / (q[j][1] - q[i][1]) + q[i][0]) inside = !inside;
  }
  return inside;
}

/** Аффинная модель (6 степеней свободы) по RANSAC: устойчивее гомографии, когда точек мало или они не в одной плоскости. */
function findAffine(src, dst, thr) {
  const n = src.length / 2;
  if (n < 3) return null;
  const s = cv.matFromArray(n, 1, cv.CV_32FC2, src);
  const d = cv.matFromArray(n, 1, cv.CV_32FC2, dst);
  const mask = new cv.Mat();
  const A = cv.estimateAffine2D(s, d, mask, cv.RANSAC, thr, 2000, 0.99, 10);
  let res = null;
  if (!A.empty()) {
    const a = Array.from(A.data64F);
    let count = 0;
    for (let i = 0; i < n; i++) if (mask.data[i]) count++;
    res = { H: [a[0], a[1], a[2], a[3], a[4], a[5], 0, 0, 1], inliers: count, mask: Uint8Array.from(mask.data) };
  }
  s.delete(); d.delete(); mask.delete(); A.delete();
  return res;
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
  if (st.validFrame) st.validFrame.m.delete();
  st.tmpl = null; st.eccRecent = null; st.skin = null; st.validFrame = null;
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
function lkPairs(imgA, imgB, ptsA, win, levels, backCheck = true, init = null) {
  const n = ptsA.length / 2;
  const idx = [], out = [];
  if (n < 1) return { idx, out };
  const p0 = cv.matFromArray(n, 1, cv.CV_32FC2, ptsA);
  // init — где ждать точки в imgB (грубое предсказание): поток стартует оттуда, и большой сдвиг кадра ему не помеха
  const p1 = init ? cv.matFromArray(n, 1, cv.CV_32FC2, init) : new cv.Mat(), pb = new cv.Mat();
  const s1 = new cv.Mat(), s2 = new cv.Mat(), e1 = new cv.Mat(), e2 = new cv.Mat();
  const size = new cv.Size(win, win);
  const crit = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 20, 0.03);
  if (init) cv.calcOpticalFlowPyrLK(imgA, imgB, p0, p1, s1, e1, size, levels, crit, cv.OPTFLOW_USE_INITIAL_FLOW, 1e-4);
  else cv.calcOpticalFlowPyrLK(imgA, imgB, p0, p1, s1, e1, size, levels, crit);
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
function trackLK(A) {
  let init = null;
  if (A) { init = new Float32Array(st.cur.length); for (let i = 0; i < init.length; i += 2) { const p = applyH(A, st.cur[i], st.cur[i + 1]); init[i] = p[0]; init[i + 1] = p[1]; } }
  const lkr = lkPairs(prevNorm, norm, st.cur, CFG.lkWin, CFG.lkLevels, CFG.lkBackCheck, init);
  let idx = lkr.idx, out = lkr.out;
  // точки, попавшие на руку, — не опора: движущаяся рука иначе образует самую большую согласованную группу
  // и RANSAC принимает её движение за движение бумаги
  if (st.skinOn && st.skin && ((CFG.skinUse & 1) || !st.chromaEdges)) { // (цель с цветным силуэтом: дерево стола — не рука)
    const ki = [], ko = [];
    for (let k = 0; k < idx.length; k++) if (!onSkin(st.skin, out[k * 2], out[k * 2 + 1])) { ki.push(idx[k]); ko.push(out[k * 2], out[k * 2 + 1]); }
    idx = ki; out = ko;
  }
  if (idx.length < CFG.minInliersLK) return null;
  const ref = [], grp = [], g0 = groupsOf();
  for (const i of idx) { ref.push(st.ref[i * 2], st.ref[i * 2 + 1]); grp.push(g0[i]); }
  let r = findH(ref, out, CFG.ransacLK);
  if (!r || r.inliers < CFG.minInliersLK || !plausible(r.H)) return null;
  // Точки опоры и окружение лежат в других плоскостях, чем холст (стол вокруг предмета, стена за ним): гомография по такой
  // смеси «уезжает» при смене ракурса и даёт клин вместо рамки. Поэтому: хватает собственных точек холста — поза по ним
  // одним (опоры остаются запасом); не хватает (рука, гладкая поверхность) — опоры/окружение ведут только аффинной
  // моделью: сдвиг, поворот и масштаб держат, а перспектива из чужой плоскости не вмешивается.
  let union = r.mask;
  // окружение (весь кадр) проверяем так же, как ручные опоры: своих точек холста хватает и поза по ним расходится с позой по
  // всем — окружение из другой плоскости (стена за мольбертом), верим своим. Пустой лист (своих точек нет) ведёт окружение
  if (st.anchors.length || (st.fullFrame && CFG.envCheck)) {
    const ownI = [];
    for (let i = 0; i < ref.length / 2; i++) if (!grp[i]) ownI.push(i);
    st.ownN = ownI.length; st.ownModel = 'all';
    if (ownI.length >= CFG.ownFew) {
      const oRef = [], oOut = [];
      for (const i of ownI) { oRef.push(ref[i * 2], ref[i * 2 + 1]); oOut.push(out[i * 2], out[i * 2 + 1]); }
      // своих точек мало (логотип на гладком корпусе) — аффинная модель по ним: перспектива по горстке точек вырождается
      const ro = ownI.length >= CFG.ownMin ? findH(oRef, oOut, CFG.ransacLK) : findAffine(oRef, oOut, CFG.ransacLK);
      // поза по своим точкам и поза по всем (с опорами) сходятся — всё в одной плоскости, берём все точки (их больше);
      // расходятся — опоры из другой плоскости, верим только своим
      if (ro && ro.inliers >= CFG.ownFew * 0.8 && plausible(ro.H) && visDist(r.H, ro.H) > CFG.perspDev) {
        union = Uint8Array.from(r.mask);
        ownI.forEach((i, k) => { if (ro.mask[k]) union[i] = 1; });
        r = { H: ro.H, inliers: ro.inliers, mask: union };
        st.ownModel = 'own';
      }
    } else {
      // ведут одни опоры. Если гомография по ним мало отличается от аффинной (опоры в одной плоскости с холстом) — оставляем её,
      // если сильно (перспектива из другой плоскости — «клин») — берём аффинную
      const ra = findAffine(ref, out, CFG.ransacLK);
      if (ra && ra.inliers >= CFG.minInliersLK && plausible(ra.H) && visDist(r.H, ra.H) > CFG.perspDev) { r = { H: ra.H, inliers: ra.inliers, mask: r.mask }; st.ownModel = 'affine'; }
    }
  }
  const keepRef = [], keepCur = [], keepGrp = [];
  for (let i = 0; i < r.mask.length; i++) {
    if (!r.mask[i]) continue;
    keepRef.push(ref[i * 2], ref[i * 2 + 1]);
    keepCur.push(out[i * 2], out[i * 2 + 1]);
    keepGrp.push(grp[i]);
  }
  return { H: r.H, inliers: r.inliers, ref: keepRef, cur: keepCur, grp: keepGrp, tried: st.cur.length / 2 };
}

// ---------- грубое предсказание по маленькому кадру ----------
// Рывок камеры (или редкие кадры на медленном телефоне) сдвигает картинку на десятки пикселей, да ещё со смазом: поток
// по точкам до такого сдвига не дотягивается и «находит» ложное движение. Маленький размытый кадр (длинная сторона
// SBI.side) смаза почти не замечает, а сдвиг в нём — считанные пиксели. Ищем в нём область цели из прошлого кадра
// (нормированная корреляция) — получаем грубый сдвиг; поток стартует уже от него. Приём известен по PTAM
// (Klein & Murray, «small blurry image»).
const SBI = { side: 72, minScore: 0.9, minTarget: 0.9, maxAniso: 1.18, minStd: 5, maxFrac: 0.62, ambig: 0.06 };

function makeSmall() {
  smallK = SBI.side / Math.max(W, H);
  cv.resize(gray, small, new cv.Size(Math.max(8, Math.round(W * smallK)), Math.max(8, Math.round(H * smallK))), 0, 0, cv.INTER_AREA);
  cv.GaussianBlur(small, small, new cv.Size(3, 3), 0);
}
function swapSmall() { const t = prevSmall; prevSmall = small; small = t; }

/** Где область (rx, ry, rw, rh) прошлого маленького кадра находится в текущем: пик нормированной корреляции и его однозначность. */
function sbiMatch(rx, ry, rw, rh) {
  const rect = new cv.Rect(rx, ry, rw, rh);
  const tpl = prevSmall.roi(rect);
  const done = (v) => { tpl.delete(); return v; };
  const mean = new cv.Mat(), sd = new cv.Mat();
  cv.meanStdDev(tpl, mean, sd);
  const std = sd.data64F[0];
  mean.delete(); sd.delete();
  if (std < SBI.minStd) return done(null); // гладко — корреляция ничего не скажет
  const res = new cv.Mat();
  cv.matchTemplate(small, tpl, res, cv.TM_CCOEFF_NORMED);
  const R = res.data32F, cw = res.cols, ch = res.rows;
  let bi = -1;
  for (let i = 0; i < R.length; i++) if (Number.isFinite(R[i]) && (bi < 0 || R[i] > R[bi])) bi = i;
  if (bi < 0) { res.delete(); return done(null); }
  const px = bi % cw, py = (bi / cw) | 0, score = R[bi];
  // однозначность: вдали от пика не должно быть почти такого же совпадения (полосатая фактура, повторяющийся узор)
  const ex = Math.max(3, Math.round(0.3 * Math.min(rw, rh)));
  let second = -1;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    if (Math.abs(x - px) <= ex && Math.abs(y - py) <= ex) continue;
    const v = R[y * cw + x];
    if (v > second) second = v;
  }
  res.delete();
  const ok = score >= 0.6 && score - second >= SBI.ambig;
  return done({ px, py, score, second, std, ok });
}

/**
 * Грубое движение между прошлым и текущим кадром: { A (аффинное, координаты кадра анализа), score } или null.
 * Определяется только когда вся сцена двигается как целое (двигается камера): одно аффинное преобразование должно
 * объяснять и середину кадра, и область цели. Если цель двигается отдельно от фона (лист двигают, ладонь) или над
 * ней ходит рука — такого преобразования нет, и предсказания нет: дальше всё работает как без него.
 */
function coarseShift(Hprev) {
  if (prevSmall.empty() || prevSmall.cols !== small.cols || prevSmall.rows !== small.rows) return null;
  const sw = small.cols, sh = small.rows, k = smallK;
  const gx = Math.round(sw * 0.2), gy = Math.round(sh * 0.2), gw = Math.round(sw * 0.6), gh = Math.round(sh * 0.6);
  // область цели в прошлом кадре (с небольшим запасом: граница «лист/стол» — самая заметная структура)
  const q = mapQuad(Hprev, st.quad).map(([x, y]) => [x * k, y * k]);
  let x0 = Math.max(0, Math.min(...q.map((p) => p[0])) - 1.5), x1 = Math.min(sw, Math.max(...q.map((p) => p[0])) + 1.5);
  let y0 = Math.max(0, Math.min(...q.map((p) => p[1])) - 1.5), y1 = Math.min(sh, Math.max(...q.map((p) => p[1])) + 1.5);
  const own = x1 - x0 >= 8 && y1 - y0 >= 8; // цель видна
  // образец не больше доли кадра: иначе ему некуда сдвигаться
  const mw = sw * SBI.maxFrac, mh = sh * SBI.maxFrac;
  if (x1 - x0 > mw) { const c = (x0 + x1) / 2; x0 = Math.max(0, Math.min(sw - mw, c - mw / 2)); x1 = x0 + mw; }
  if (y1 - y0 > mh) { const c = (y0 + y1) / 2; y0 = Math.max(0, Math.min(sh - mh, c - mh / 2)); y1 = y0 + mh; }
  const rx = Math.floor(x0), ry = Math.floor(y0), rw = Math.min(sw - rx, Math.ceil(x1 - x0)), rh = Math.min(sh - ry, Math.ceil(y1 - y0));
  // стартовый сдвиг: по области цели, иначе по середине кадра, иначе нулевой
  const m = own ? sbiMatch(rx, ry, rw, rh) : null;
  const g = m && m.ok ? null : sbiMatch(gx, gy, gw, gh);
  let dx = 0, dy = 0;
  if (m && m.ok) { dx = m.px - rx; dy = m.py - ry; } else if (g && g.ok) { dx = g.px - gx; dy = g.py - gy; }
  st.sbiRaw = [Math.round(dx / k), Math.round(dy / k), m ? +m.score.toFixed(2) : -1, g ? +g.score.toFixed(2) : -1];
  // аффинное движение середины кадра — плотным выравниванием от стартового сдвига
  const tpl = prevSmall.roi(new cv.Rect(gx, gy, gw, gh));
  const C = cv.matFromArray(2, 3, cv.CV_32F, [1, 0, gx + dx, 0, 1, gy + dy]);
  let cc = -1;
  try { cc = cv.findTransformECC(tpl, small, C, cv.MOTION_AFFINE, new cv.TermCriteria(3, 40, 1e-3), new cv.Mat(), 5); } catch (err) { cc = -1; }
  const a = Array.from(C.data32F);
  C.delete(); tpl.delete();
  st.sbiRaw.push(+cc.toFixed(2));
  // движение камеры за несколько кадров на маленьком кадре — почти подобие (сдвиг, поворот, масштаб). Сильный перекос
  // или разный масштаб по осям значит, что выравнивание «объяснило» перемену в кадре (вошла рука), а не движение
  const det = a[0] * a[4] - a[1] * a[3];
  const fro = a[0] * a[0] + a[1] * a[1] + a[3] * a[3] + a[4] * a[4];
  const disc = Math.sqrt(Math.max(0, fro * fro - 4 * det * det));
  const s1 = Math.sqrt((fro + disc) / 2), s2 = Math.sqrt(Math.max(1e-9, (fro - disc) / 2));
  st.sbiRaw.push(+(s1 / s2).toFixed(2));
  if (!(cc >= SBI.minScore) || !(det > 0.5 && det < 2) || s1 / s2 > SBI.maxAniso) return null;
  // a: координаты образца (середина прошлого кадра) → текущий маленький кадр. В координатах маленького кадра: p' = M·p
  const M = [a[0], a[1], a[2] - a[0] * gx - a[1] * gy, a[3], a[4], a[5] - a[3] * gx - a[4] * gy];
  // то же движение должно объяснять и область цели: текущий кадр, приведённый к прошлому, сравниваем с прошлым
  let tScore = 1;
  if (own && rw >= 6 && rh >= 6) {
    const Mm = cv.matFromArray(2, 3, cv.CV_64F, M), back = new cv.Mat(), res = new cv.Mat();
    cv.warpAffine(small, back, Mm, new cv.Size(sw, sh), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE);
    const rect = new cv.Rect(rx, ry, rw, rh);
    const r1 = back.roi(rect), r0 = prevSmall.roi(rect);
    cv.matchTemplate(r1, r0, res, cv.TM_CCOEFF_NORMED);
    tScore = res.data32F[0];
    r1.delete(); r0.delete(); Mm.delete(); back.delete(); res.delete();
    st.sbiRaw.push(+tScore.toFixed(2));
    if (!(tScore >= SBI.minTarget)) return null;
  }
  // маленький кадр → кадр анализа
  const A = [M[0], M[1], M[2] / k, M[3], M[4], M[5] / k, 0, 0, 1];
  return { A, score: Math.min(cc, tScore), tol: 2 / k };
}

/**
 * Насколько вид цели по позе Hm похож на её вид в прошлом кадре («свежая» заплатка): нормированная корреляция.
 * Независимая проверка позы: какая из двух спорящих оценок лучше объясняет картинку.
 */
function patchScore(Hm) {
  const e = st.tmpl && st.tmpl.ecc;
  if (!e || !st.eccRecent) return 0;
  const { box } = e, s = box.s;
  const Tfi = invertH([s, 0, -box.x0 * s, 0, s, -box.y0 * s, 0, 0, 1]);
  const Hmat = cv.matFromArray(3, 3, cv.CV_64F, mulH(Hm, Tfi));
  const U = new cv.Mat(), res = new cv.Mat();
  cv.warpPerspective(gray, U, Hmat, new cv.Size(box.w, box.h), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE);
  cv.matchTemplate(U, st.eccRecent, res, cv.TM_CCOEFF_NORMED);
  const v = res.data32F[0];
  Hmat.delete(); U.delete(); res.delete();
  return Number.isFinite(v) ? v : 0;
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
  if (st.skinOn && st.skin && (CFG.skinUse & 2)) cv.subtract(mask, st.skin, mask);
  const curPts = keep ? Array.from(st.cur) : [];
  const refPts = keep ? Array.from(st.ref) : [];
  // группа точки: 0 — на самом холсте, 1 — опора/окружение (другая плоскость). Группа назначается при посеве и не меняется
  const grpPts = keep ? Array.from(groupsOf()) : [];
  const need = CFG.maxCorners - curPts.length / 2;
  if (need > 10) {
    const fresh = detectGrid(mask, need, curPts);
    const inv = invertH(Hm);
    for (let i = 0; i < fresh.length; i += 2) {
      const r = applyH(inv, fresh[i], fresh[i + 1]);
      curPts.push(fresh[i], fresh[i + 1]);
      refPts.push(r[0], r[1]);
      grpPts.push(pointInPoly(r[0], r[1], st.quad) ? 0 : 1); // за рамкой (поле поиска, окружение) — не точка холста
    }
  }
  mask.delete();
  const n0 = curPts.length / 2;
  seedAnchors(Hm, curPts, refPts);
  for (let i = n0; i < curPts.length / 2; i++) grpPts.push(1);
  st.cur = Float32Array.from(curPts);
  st.ref = Float32Array.from(refPts);
  st.grp = Uint8Array.from(grpPts);
}

/** Группы точек потока (выровнены с st.cur); если выравнивания нет — все точки считаются точками холста. */
function groupsOf() {
  const n = st.cur.length / 2;
  return st.grp && st.grp.length === n ? st.grp : new Uint8Array(n);
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
// Плавно: опорные координаты точки — скользящее среднее. Раньше они переписывались целиком по позе каждого кадра, и
// один неудачный кадр (ложный край, ECC по однотонной обложке, смаз) навсегда «вписывался» в точки: поток дальше
// подтверждал ошибку. Теперь плохой кадр сдвигает их на долю, а следующие хорошие кадры возвращают на место.
function reanchor(Hm, alpha = CFG.reanchorAlpha) {
  const inv = invertH(Hm);
  if (!inv) return;
  for (let i = 0; i < st.cur.length; i += 2) {
    const r = applyH(inv, st.cur[i], st.cur[i + 1]);
    st.ref[i] += alpha * (r[0] - st.ref[i]); st.ref[i + 1] += alpha * (r[1] - st.ref[i + 1]);
  }
}

// ---------- автоопоры: неподвижные точки той же плоскости, что и холст ----------
// Холст в кадре часто мал (карта на столе, лист на мольберте) или закрыт рукой: поза по нему одному шумит — рамка
// дрожит и «плывёт» при смене ракурса. Вокруг же обычно есть та же плоскость (стол, стена) с массой деталей.
// Трекер сам сеет точки-кандидаты по всему кадру вне холста и следит за каждой. Точка той же плоскости, неподвижная
// относительно холста, при любом движении камеры едет по той же гомографии, что и холст; точка другой плоскости или
// движущийся предмет — нет, и это видно, как только камера сместилась (параллакс). Кандидат, выдержавший проверку при
// достаточном смещении камеры, становится опорой: участвует в оценке позы наравне с точками холста. Опоры проверяются
// каждый кадр и выбывают, если перестали сходиться с холстом (предмет подвинули, лист сдвинули по столу).
const SUP = {
  max: 64,          // всего точек (кандидаты + опоры)
  grid: 4,          // сетка ячеек по кадру: точки равномерно, а не кучей
  perCell: 4,
  expand: 0.14,     // запас вокруг холста, где кандидатов не сеем (кромка, тень, толщина подрамника)
  parallax: 0.07,   // на сколько должна сместиться камера (доля расстояния до плоскости), чтобы проверка что-то значила
  loose: 2.5, looseK: 0.02, // px (+ доля расстояния до холста): грубый отбор по позе холста (вдали от холста она неточна)
  tight: 1.6,       // px: согласие с общей гомографией плоскости
  keep: 2.5,        // px: опора дальше этого от своего места — промах
  alpha: 0.05,      // скорость подстройки опорных координат (усреднение шума позы; медленный дрейф потока)
  minUse: 8,        // меньше стольких согласных опор — в оценке позы они не участвуют
  minPose: 12,      // столько опор — поза по ним одним, если свой поток холста сорвался
  focal: 0.85,      // фокусное расстояние в долях длинной стороны кадра (основная камера телефона)
};

/** Подтверждённые опоры для показа: координаты опорного кадра (как у рамки). */
function supOut() {
  if (!st.sup) return undefined;
  const o = [];
  for (const p of st.sup.pts) if (p.ok) o.push([+(p.rx + 0.5).toFixed(1), +(p.ry + 0.5).toFixed(1)]);
  return o.length >= SUP.minUse ? o : [];
}

function supReset() { st.sup = { pts: [], batches: new Map(), nextId: 1 }; }

/** Насколько гомография G (кадр → кадр) отличается от чистого поворота камеры: ≈ сдвиг камеры / расстояние до плоскости. */
function parallaxOf(G) {
  const f = SUP.focal * Math.max(W, H), cx = W / 2, cy = H / 2;
  const M = mulH([1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1], mulH(G, [f, 0, cx, 0, f, cy, 0, 0, 1]));
  // сингулярные числа M: собственные числа симметричной MᵀM (замкнутая формула)
  const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i * 3 + j] = M[i] * M[j] + M[3 + i] * M[3 + j] + M[6 + i] * M[6 + j];
  const q = (a[0] + a[4] + a[8]) / 3;
  const p1 = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
  const p2 = (a[0] - q) ** 2 + (a[4] - q) ** 2 + (a[8] - q) ** 2 + 2 * p1;
  const pp = Math.sqrt(p2 / 6);
  if (!(pp > 1e-12 * Math.abs(q))) return 0;
  const b = a.map((v, i) => (v - (i % 4 === 0 ? q : 0)) / pp);
  const det = b[0] * (b[4] * b[8] - b[5] * b[7]) - b[1] * (b[3] * b[8] - b[5] * b[6]) + b[2] * (b[3] * b[7] - b[4] * b[6]);
  const phi = Math.acos(Math.max(-1, Math.min(1, det / 2))) / 3;
  const e1 = q + 2 * pp * Math.cos(phi), e3 = q + 2 * pp * Math.cos(phi + 2 * Math.PI / 3);
  return e3 > 0 ? Math.sqrt(e1 / e3) - 1 : 1;
}

/** Провести точки автоопор из прошлого кадра в текущий. G — ожидаемое движение плоскости холста (или null). */
function supTrack(G) {
  const S = st.sup;
  if (!S || !S.pts.length) return;
  const n = S.pts.length, flat = new Float32Array(n * 2);
  let init = null;
  S.pts.forEach((p, i) => { flat[i * 2] = p.x; flat[i * 2 + 1] = p.y; });
  if (G) {
    init = new Float32Array(n * 2);
    S.pts.forEach((p, i) => { const q = applyH(G, p.x, p.y); init[i * 2] = q[0]; init[i * 2 + 1] = q[1]; });
  }
  const { idx, out } = lkPairs(prevNorm, norm, flat, CFG.lkWin, G ? 2 : CFG.lkLevels, false, init);
  const keep = [];
  for (let k = 0; k < idx.length; k++) {
    const p = S.pts[idx[k]], x = out[k * 2], y = out[k * 2 + 1];
    if (x < 6 || y < 6 || x > W - 7 || y > H - 7) continue;
    p.x = x; p.y = y; keep.push(p);
  }
  S.pts = keep;
}

/** Доля точек потока (текущие ↔ опорные координаты), согласных с позой Hm (в пределах 4 px). */
function ptsAgree(Hm) {
  const n = st.cur.length / 2;
  if (n < CFG.minInliersLK) return 1; // точек нет — нечем проверять
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const p = applyH(Hm, st.ref[i * 2], st.ref[i * 2 + 1]);
    if (Math.hypot(p[0] - st.cur[i * 2], p[1] - st.cur[i * 2 + 1]) < 4) ok++;
  }
  return ok / n;
}

/** Поза по одним опорам (когда собственный поток холста сорвался). */
function supPose() {
  const S = st.sup;
  if (!S) return null;
  const ref = [], cur = [];
  for (const p of S.pts) if (p.ok) { ref.push(p.rx, p.ry); cur.push(p.x, p.y); }
  if (ref.length / 2 < SUP.minPose) return null;
  const r = findH(ref, cur, CFG.ransacLK, 500);
  return r && r.inliers >= SUP.minPose && r.inliers >= 0.6 * ref.length / 2 && plausible(r.H) ? r.H : null;
}

/** Пары «опорные ↔ текущие» по подтверждённым опорам, согласным с прогнозом позы. */
function supPairs(Hm) {
  const res = { ref: [], cur: [] };
  const S = st.sup;
  if (!S) return res;
  for (const p of S.pts) {
    if (!p.ok) continue;
    const q = applyH(Hm, p.rx, p.ry);
    if (Math.hypot(q[0] - p.x, q[1] - p.y) < 3) { res.ref.push([p.rx, p.ry]); res.cur.push([p.x, p.y]); }
  }
  // настоящая общая плоскость (стол, стена) даёт десятки опор; несколько штук — случайные совпадения в чужой плоскости
  if (res.ref.length < SUP.minUse) return { ref: [], cur: [] };
  return res;
}

/** Проверка опор и кандидатов по принятой позе кадра; досев кандидатов. Вызывается после отправки позы. */
function supUpkeep(Hm) {
  const S = st.sup, inv = invertH(Hm);
  if (!S || !inv) return;
  for (const p of S.pts) {
    if (!p.ok) continue;
    const q = applyH(Hm, p.rx, p.ry);
    if (Math.hypot(q[0] - p.x, q[1] - p.y) > SUP.keep) { p.bad++; continue; }
    p.bad = 0; p.n++;
    const r = applyH(inv, p.x, p.y), al = Math.max(SUP.alpha, 1 / (p.n + 1));
    p.rx += al * (r[0] - p.rx); p.ry += al * (r[1] - p.ry);
  }
  const qn = mapQuad(Hm, st.quad), qc = centroid(qn);
  for (const [id, b] of S.batches) {
    const cand = S.pts.filter((p) => !p.ok && p.b === id);
    if (!cand.length) { S.batches.delete(id); continue; }
    const G0 = mulH(Hm, b.Hinv); // кадр посева → текущий кадр, по позе холста
    b.pmax = Math.max(b.pmax, parallaxOf(G0));
    const src = [], dst = [], sel = [];
    for (const p of cand) {
      const q = applyH(G0, p.sx, p.sy);
      const far = Math.hypot(p.x - qc[0], p.y - qc[1]);
      if (Math.hypot(q[0] - p.x, q[1] - p.y) < SUP.loose + SUP.looseK * far) { sel.push(p); src.push(p.sx, p.sy); dst.push(p.x, p.y); } else p.bad += 2;
    }
    // общая гомография плоскости по кандидатам, привязанная к холсту (точки рамки идут в подгонку наравне с кандидатами)
    let G1 = G0;
    if (sel.length >= 6) {
      const q0 = mapQuad(b.H, st.quad);
      for (let i = 0; i < 4; i++) for (const k of [0, 0.5]) {
        const j = (i + 1) % 4;
        src.push(q0[i][0] + k * (q0[j][0] - q0[i][0]), q0[i][1] + k * (q0[j][1] - q0[i][1]));
        dst.push(qn[i][0] + k * (qn[j][0] - qn[i][0]), qn[i][1] + k * (qn[j][1] - qn[i][1]));
      }
      const r = findH(src, dst, SUP.tight, 300);
      if (r && q0.every((c, i) => { const m = applyH(r.H, c[0], c[1]); return Math.hypot(m[0] - qn[i][0], m[1] - qn[i][1]) < 3; })) G1 = r.H;
    }
    for (const p of sel) {
      const q = applyH(G1, p.sx, p.sy);
      if (Math.hypot(q[0] - p.x, q[1] - p.y) > SUP.tight) { p.bad++; continue; }
      p.age++;
      if (b.pmax >= SUP.parallax && p.bad === 0 && p.age >= 4) {
        p.ok = true; p.n = 0;
        const r = applyH(inv, p.x, p.y);
        p.rx = r[0]; p.ry = r[1];
      }
    }
  }
  S.pts = S.pts.filter((p) => p.bad < (p.ok ? 3 : 2));
  if (st.frame % 8 === 2 && S.pts.length <= SUP.max - 8) supSeed(Hm, inv);
}

/** Посев кандидатов: углы по ячейкам сетки всего кадра, вне холста. */
function supSeed(Hm, inv) {
  const S = st.sup;
  const mask = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(255));
  const big = polyMask(mapQuad(Hm, expandQuad(st.quad, SUP.expand)));
  cv.subtract(mask, big, mask);
  big.delete();
  const G = SUP.grid, fresh = [];
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    const rx = Math.round(8 + gx * (W - 16) / G), ry = Math.round(8 + gy * (H - 16) / G);
    const rw = Math.round(8 + (gx + 1) * (W - 16) / G) - rx, rh = Math.round(8 + (gy + 1) * (H - 16) / G) - ry;
    const ex = [];
    for (const p of S.pts) if (p.x >= rx && p.x < rx + rw && p.y >= ry && p.y < ry + rh) ex.push(p.x - rx, p.y - ry);
    const need = Math.min(SUP.perCell - ex.length / 2, SUP.max - S.pts.length - fresh.length / 2);
    if (need < 1) continue;
    const rect = new cv.Rect(rx, ry, rw, rh);
    const m = mask.roi(rect).clone();
    if (cv.countNonZero(m) > 150) {
      const g = gray.roi(rect).clone();
      const pts = detectCorners(g, m, need, ex, null);
      for (let i = 0; i < pts.length; i += 2) fresh.push(pts[i] + rx, pts[i + 1] + ry);
      g.delete();
    }
    m.delete();
  }
  mask.delete();
  if (fresh.length < 2) return;
  const id = S.nextId++;
  S.batches.set(id, { H: Hm.slice(), Hinv: inv, pmax: 0 });
  for (let i = 0; i < fresh.length; i += 2) S.pts.push({ x: fresh[i], y: fresh[i + 1], sx: fresh[i], sy: fresh[i + 1], rx: 0, ry: 0, ok: false, bad: 0, age: 0, n: 0, b: id });
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
/**
 * Допустимые пиксели кадра для ECC: не кожа (рука закрывает холст) и внутри кадра (за краем кадра после разворота
 * остаётся размазанная кромка — она давала ложную структуру). Маска кадра кэшируется на кадр.
 */
function eccValid(Hmat, box) {
  if (!st.validFrame || st.validFrame.f !== st.frame) {
    if (st.validFrame) st.validFrame.m.delete();
    const m = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(255));
    if (st.skinOn && st.skin) cv.subtract(m, st.skin, m);
    st.validFrame = { f: st.frame, m };
  }
  const out = new cv.Mat();
  cv.warpPerspective(st.validFrame.m, out, Hmat, new cv.Size(box.w, box.h), cv.INTER_NEAREST | cv.WARP_INVERSE_MAP, cv.BORDER_CONSTANT, new cv.Scalar(0));
  return out;
}

function eccRefine(Hm, Tpl, coarse, affine) {
  const e = st.tmpl && st.tmpl.ecc;
  if (!e) return null;
  const { box } = e, s = box.s;
  const Tf = [s, 0, -box.x0 * s, 0, s, -box.y0 * s, 0, 0, 1];   // опорные → координаты заплатки
  const Tfi = invertH(Tf);
  const Hmat = cv.matFromArray(3, 3, cv.CV_64F, mulH(Hm, Tfi));  // заплатка → текущий кадр
  const U = new cv.Mat();
  cv.warpPerspective(gray, U, Hmat, new cv.Size(box.w, box.h), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE);
  // на ладони (кожа — сама цель) маска не нужна и ECC ведёт себя как раньше
  const eccSkin = st.skinOn && (CFG.skinUse & 8);
  const V = eccSkin ? eccValid(Hmat, box) : new cv.Mat();
  // закрыто рукой или вне кадра больше 60% заплатки — выравнивать нечем (ECC уехал бы вместе с рукой)
  if (eccSkin && cv.countNonZero(V) < 0.4 * box.w * box.h) { Hmat.delete(); U.delete(); V.delete(); return null; }
  const C = affine ? cv.Mat.eye(2, 3, cv.CV_32F) : cv.Mat.eye(3, 3, cv.CV_32F);
  const motion = affine ? cv.MOTION_AFFINE : cv.MOTION_HOMOGRAPHY;
  if (coarse) {
    // от грубого к точному: на половинном масштабе ECC захватывает вдвое большее смещение
    const T2 = new cv.Mat(), U2 = new cv.Mat(), C2 = affine ? cv.Mat.eye(2, 3, cv.CV_32F) : cv.Mat.eye(3, 3, cv.CV_32F);
    const sz = new cv.Size(Math.max(16, box.w >> 1), Math.max(16, box.h >> 1));
    cv.resize(Tpl || e.T, T2, sz, 0, 0, cv.INTER_AREA);
    cv.resize(U, U2, sz, 0, 0, cv.INTER_AREA);
    const V2 = new cv.Mat();
    if (eccSkin) cv.resize(V, V2, sz, 0, 0, cv.INTER_NEAREST);
    let cc2 = -1;
    try { cc2 = cv.findTransformECC(T2, U2, C2, motion, new cv.TermCriteria(3, 50, 1e-3), V2, 3); } catch (err) { cc2 = -1; }
    if (cc2 > 0.3) {
      const sx = sz.width / box.w, sy = sz.height / box.h, Sf = [sx, 0, 0, 0, sy, 0, 0, 0, 1];
      const c2 = Array.from(C2.data32F);
      const Cf = mulH(invertH(Sf), mulH(c2.length === 6 ? c2.concat([0, 0, 1]) : c2, Sf));
      C.data32F.set(c2.length === 6 ? Cf.slice(0, 6) : Cf);
    }
    T2.delete(); U2.delete(); C2.delete(); V2.delete();
  }
  let cc = -1;
  try {
    cc = cv.findTransformECC(Tpl || e.T, U, C, motion, new cv.TermCriteria(3, ECC.iters, ECC.eps), V, ECC.gauss);
  } catch (err) { cc = -1; } // не сошлось
  let res = null;
  if (cc > 0) {
    const cw = Array.from(C.data32F);
    const Hn = mulH(Hm, mulH(Tfi, mulH(cw.length === 6 ? cw.concat([0, 0, 1]) : cw, Tf)));
    const k = Hn[8];
    res = { H: Hn.map((v) => v / k), cc };
  }
  Hmat.delete(); U.delete(); C.delete(); V.delete();
  return res;
}

/** Доля кожи внутри рамки холста в текущем кадре (0, если маска кожи выключена). */
function skinOnCanvas() {
  if (!st.skinOn || !st.skin) return 0;
  const inner = polyMask(mapQuad(st.H, st.quad)), t = cv.countNonZero(inner);
  cv.bitwise_and(inner, st.skin, inner);
  const r = t ? cv.countNonZero(inner) / t : 0;
  inner.delete();
  return r;
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

// Профиль края: яркость поперёк стороны на ±EPROF px, усреднённая вдоль стороны и нормированная (среднее 0, длина 1).
// У толстого предмета (блокнот, холст на подрамнике) у каждой стороны два параллельных края: «грань → торец» и «торец → стол»,
// и второй обычно контрастнее. Поиск «самого сильного перепада» перескакивал на него, и рамка уезжала с грани на торец.
// Сравнение с профилем, запомненным при захвате (нормированная корреляция), держит тот край, который выбран, и не
// зависит от яркости (блик на обложке). Приём близок к «moving edges» из ViSP (Bouthemy; Comport, Marchand, Chaumette):
// там тоже предпочитают кандидата, похожего на прошлый край, а не самого контрастного.
const EPROF = 6;
function sideProfile(q, j) {
  const { A, B, nx, ny } = edgeGeom(q, j);
  const acc = new Float64Array(2 * EPROF + 1);
  let n = 0;
  for (let k = 0; k < 20; k++) {
    const sv = 0.12 + 0.76 * k / 19;
    const x = A[0] + (B[0] - A[0]) * sv, y = A[1] + (B[1] - A[1]) * sv;
    const row = [];
    for (let t = -EPROF; t <= EPROF; t++) { const v = sample(x + nx * t, y + ny * t); if (!Number.isFinite(v)) break; row.push(v); }
    if (row.length !== acc.length) continue;
    for (let i = 0; i < row.length; i++) acc[i] += row[i];
    n++;
  }
  return n >= 8 ? normProfile(acc) : null;
}
function normProfile(a) {
  let m = 0;
  for (const v of a) m += v / a.length;
  let ss = 0;
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) { o[i] = a[i] - m; ss += o[i] * o[i]; }
  if (ss < a.length * 4) return null; // почти ровно — профиль ни о чём не говорит
  const k = 1 / Math.sqrt(ss);
  for (let i = 0; i < o.length; i++) o[i] *= k;
  return o;
}
/** Корреляция профиля e.prof с яркостью вдоль нормали: L — отсчёты с шагом 1 px, i0 — индекс отсчёта, соответствующего t − EPROF. */
function profZncc(prof, L, i0) {
  const n = prof.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += L[i0 + i];
  m /= n;
  let sp = 0, ss = 0;
  for (let i = 0; i < n; i++) { const d = L[i0 + i] - m; sp += d * prof[i]; ss += d * d; }
  return ss > n * 4 ? sp / Math.sqrt(ss) : 0;
}
/** Медленная подстройка профиля к текущему виду (ракурс меняет ширину видимого торца, свет — форму перепада). */
function adaptProfiles(Hm) {
  if (!st.edges) return;
  const q = mapQuad(Hm, st.quad);
  for (let j = 0; j < 4; j++) {
    const e = st.edges[j];
    if (!e.use || !e.prof || !(e.seenGood > 0)) continue;
    const cur = sideProfile(q, j);
    if (!cur) continue;
    let c = 0;
    for (let i = 0; i < cur.length; i++) c += cur[i] * e.prof[i];
    if (c < 0.85) continue; // сильно не похож — не учимся (рука на краю, поза неточна)
    const mix = new Float64Array(cur.length);
    for (let i = 0; i < cur.length; i++) mix[i] = 0.9 * e.prof[i] + 0.1 * cur[i];
    e.prof = normProfile(mix) || e.prof;
  }
}

// ---------- край предмета по смене оттенка ----------
// У толстого предмета или под бликом у стороны два-три параллельных перепада яркости: граница блика на обложке, ребро
// «грань → торец», низ торца на столе. Только последний разделяет разные материалы (предмет и стол) — по обе стороны
// разный оттенок; у блика и тени оттенок по обе стороны один. При захвате сторона, стоящая на чисто яркостном перепаде,
// сдвигается на ближайший параллельный край со сменой оттенка, если он рядом и явно сильнее. Белый лист на сером фоне
// (оттенки одинаковые) не трогается: там край держится на яркости, и это надёжно.
const CHR = { span: 8, gap: 3, min: 15, gain: 2.5 };
function chromaAt(x, y) {
  const c = rgbAt(x, y);
  if (!c) return null;
  const s = c[0] + c[1] + c[2] + 3;
  return [c[0] / s, c[1] / s];
}
/** Средний контраст оттенка поперёк стороны j при сдвиге стороны на t px наружу (×100). */
function chromaContrast(q, j, t) {
  const { A, B, nx, ny } = edgeGeom(q, j);
  let s = 0, n = 0;
  for (let k = 0; k < 16; k++) {
    const sv = 0.15 + 0.7 * k / 15;
    const x = A[0] + (B[0] - A[0]) * sv + nx * t, y = A[1] + (B[1] - A[1]) * sv + ny * t;
    const a = chromaAt(x - nx * CHR.gap, y - ny * CHR.gap), b = chromaAt(x + nx * CHR.gap, y + ny * CHR.gap);
    if (!a || !b) continue;
    s += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]); n++;
  }
  return n >= 8 ? 100 * s / n : 0;
}
function snapSidesToChroma(q) {
  const shift = [0, 0, 0, 0];
  let strong = 0;
  for (let j = 0; j < 4; j++) {
    const c0 = chromaContrast(q, j, 0);
    let best = c0, bt = 0;
    for (let t = -CHR.span; t <= CHR.span; t++) {
      const c = chromaContrast(q, j, t);
      if (c > best + 1e-9 || (c === best && Math.abs(t) < Math.abs(bt))) { best = c; bt = t; }
    }
    if (best >= CHR.min) strong++;
    // пик смены оттенка заметно в стороне от текущей стороны — переносим сторону туда
    if (Math.abs(bt) >= 2 && best >= CHR.min && best - c0 >= CHR.gain) shift[j] = bt;
  }
  // только у цели, отделённой от фона оттенком почти по всему контуру (иначе это блик/тень на одной стороне, а не край)
  if (strong < 3 || !shift.some((v) => v)) return q;
  // сдвинутые стороны — прямые; новые углы — их пересечения
  const lines = [0, 1, 2, 3].map((j) => {
    const { A, B, nx, ny } = edgeGeom(q, j);
    return [[A[0] + nx * shift[j], A[1] + ny * shift[j]], [B[0] + nx * shift[j], B[1] + ny * shift[j]]];
  });
  const cross = (l1, l2) => {
    const [p, p2] = l1, [r, r2] = l2;
    const d1 = [p2[0] - p[0], p2[1] - p[1]], d2 = [r2[0] - r[0], r2[1] - r[1]];
    const den = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((r[0] - p[0]) * d2[1] - (r[1] - p[1]) * d2[0]) / den;
    return [p[0] + d1[0] * t, p[1] + d1[1] * t];
  };
  const nq = [0, 1, 2, 3].map((i) => cross(lines[(i + 3) % 4], lines[i]));
  if (nq.some((p) => !p) || !convex(nq) || nq.some((p, i) => Math.hypot(p[0] - q[i][0], p[1] - q[i][1]) > 2 * CHR.span)) return q;
  st.chromaShift = shift;
  return nq;
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
    const prof = sideProfile(st.quad, j);
    st.edges.push({
      prof, // «рисунок» края поперёк стороны (нормированный профиль яркости): какой именно из параллельных краёв мы ведём
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
  // считается на уменьшенном вдвое кадре (вчетверо дешевле) и растягивается обратно: маске точность до пикселя не нужна
  const half = new cv.Mat(), rgb = new cv.Mat(), ycc = new cv.Mat(), m2 = new cv.Mat(), m = new cv.Mat();
  // (на пустой бумаге с рукой граница маски важна до пикселя — там считаем на полном кадре)
  const sd = st && st.weakTex ? 1 : 2, hw = Math.max(1, Math.round(W / sd)), hh = Math.max(1, Math.round(H / sd));
  cv.resize(rgba, half, new cv.Size(hw, hh), 0, 0, cv.INTER_NEAREST);
  cv.cvtColor(half, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, ycc, cv.COLOR_RGB2YCrCb);
  if (!skinLo || skinLo.rows !== hh || skinLo.cols !== hw) {
    if (skinLo) { skinLo.delete(); skinHi.delete(); }
    skinLo = new cv.Mat(hh, hw, cv.CV_8UC3, new cv.Scalar(40, 140, 80));
    skinHi = new cv.Mat(hh, hw, cv.CV_8UC3, new cv.Scalar(255, 178, 128));
  }
  cv.inRange(ycc, skinLo, skinHi, m2);
  // оттенки фона вокруг предмета (деревянный стол, картон) попадают в диапазон кожи — их кожей не считаем
  if (st && st.bgSkinBins) {
    const yd = ycc.data, md = m2.data, bins = st.bgSkinBins;
    for (let i = 0, n = md.length; i < n; i++) if (md[i] && bins[skinBin(yd[i * 3 + 1], yd[i * 3 + 2])]) md[i] = 0;
  }
  const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(sd === 1 ? 7 : 5, sd === 1 ? 7 : 5));
  cv.dilate(m2, m2, k);
  cv.resize(m2, m, new cv.Size(W, H), 0, 0, cv.INTER_NEAREST);
  [half, rgb, ycc, m2, k].forEach((x) => x.delete());
  return m;
}
// ячейка оттенка (Cr, Cb) в пределах диапазона кожи: 16×16
const skinBin = (cr, cb) => Math.min(15, Math.max(0, ((cr - 140) * 16 / 38) | 0)) * 16 + Math.min(15, Math.max(0, ((cb - 80) * 16 / 48) | 0));
/** При захвате: какие «телесные» оттенки — это фон вокруг предмета (стол). Рука другого оттенка останется кожей. */
function learnSkinBackground(quad) {
  st.bgSkinBins = null;
  const sd = 2, hw = Math.max(1, Math.round(W / sd)), hh = Math.max(1, Math.round(H / sd));
  const half = new cv.Mat(), rgb = new cv.Mat(), ycc = new cv.Mat();
  cv.resize(rgba, half, new cv.Size(hw, hh), 0, 0, cv.INTER_NEAREST);
  cv.cvtColor(half, rgb, cv.COLOR_RGBA2RGB);
  cv.cvtColor(rgb, ycc, cv.COLOR_RGB2YCrCb);
  const outer = polyMask(expandQuad(quad, 0.6)), inner = polyMask(quad), ring = new cv.Mat(), ringH = new cv.Mat();
  cv.subtract(outer, inner, ring);
  cv.resize(ring, ringH, new cv.Size(hw, hh), 0, 0, cv.INTER_NEAREST);
  const hist = new Uint32Array(256), yd = ycc.data, rd = ringH.data;
  let n = 0, tot = 0;
  for (let i = 0; i < rd.length; i++) {
    if (!rd[i]) continue;
    tot++;
    const Y = yd[i * 3], cr = yd[i * 3 + 1], cb = yd[i * 3 + 2];
    if (Y >= 40 && cr >= 140 && cr <= 178 && cb >= 80 && cb <= 128) { hist[skinBin(cr, cb)]++; n++; }
  }
  // заметная доля фона «телесная» — запоминаем его оттенки (ячейки, где лежит основная масса таких пикселей)
  if (tot && n > 0.25 * tot) {
    const bins = new Uint8Array(256);
    const order = Array.from(hist.keys()).sort((a, b) => hist[b] - hist[a]);
    let acc = 0;
    for (const b of order) { if (acc >= 0.97 * n || !hist[b]) break; bins[b] = 1; acc += hist[b]; }
    st.bgSkinBins = bins;
  }
  [half, rgb, ycc, outer, inner, ring, ringH].forEach((m) => m.delete());
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
/** Цвет c, приведённый по яркости к ref (блик и тень меняют яркость, а не оттенок); усиление ограничено, чтобы
 * графит не стал «бумагой». */
function gainTo(c, ref) {
  const g = Math.max(0.6, Math.min(1.6, (ref[0] + ref[1] + ref[2] + 3) / (c[0] + c[1] + c[2] + 3)));
  return [c[0] * g, c[1] * g, c[2] * g];
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
    const usePr = !!(e.prof && CFG.edgeProfile && st.chromaEdges);
    const tk = CFG.edgeTolK || 1, tolIn = tk * Math.max(38, 3 * e.sdIn), tolOut = tk * Math.max(50, 3 * e.sdOut);
    const pts = [];
    const why = self.DEBUG_PTS ? (st.dbgWhy = st.dbgWhy || {})[j] = [0, 0, 0, 0, 0] : null; // нет перепада, профиль, цвет внутри, цвет снаружи, кожа
    for (let k = 0; k < S; k++) {
      const s = 0.06 + 0.88 * k / (S - 1);
      const px = A[0] + (B[0] - A[0]) * s, py = A[1] + (B[1] - A[1]) * s;
      let best = -Infinity, bt = 0, bd = 0;
      const prof = [];
      // яркость вдоль нормали с шагом 1 px — для сравнения с профилем края
      const L = usePr ? new Float32Array(2 * (radius + EPROF) + 1) : null;
      if (usePr) for (let i = 0; i < L.length; i++) { const t = i - radius - EPROF; L[i] = sample(px + nx * t, py + ny * t); }
      const zs = usePr ? new Float32Array(2 * radius + 1) : null;
      for (let t = -radius; t <= radius; t++) {
        const d = e.pol * (sample(px + nx * (t + 1.5), py + ny * (t + 1.5)) - sample(px + nx * (t - 1.5), py + ny * (t - 1.5)));
        prof.push(d);
        if (!(d >= minD)) continue;
        let score;
        if (usePr) {
          const i0 = t + radius;
          const z = Number.isFinite(L[i0]) && Number.isFinite(L[i0 + 2 * EPROF]) ? profZncc(e.prof, L, i0) : 0;
          zs[i0] = z;
          if (z < CFG.edgeZnccMin) continue;
          score = z - 0.02 * Math.abs(t); // похожий на запомненный край — и поближе к прогнозу
        } else score = d - 0.5 * Math.abs(t);
        if (score > best) { best = score; bt = t; bd = d; }
      }
      if (best === -Infinity) { if (why) why[usePr && prof.some((d) => d >= minD) ? 1 : 0]++; continue; }
      // внутри — цвет бумаги, снаружи — цвет фона; иначе это край чего-то постороннего (пальцы, карандаш)
      {
        const ex = px + nx * bt, ey = py + ny * bt;
        const ci = rgbAt(ex - nx * 7, ey - ny * 7), co = rgbAt(ex + nx * 7, ey + ny * 7);
        if (st.skinOn && st.skin && (CFG.skinUse & 4) && (onSkin(st.skin, ex - nx * 7, ey - ny * 7) || (!e.bgSkin && onSkin(st.skin, ex + nx * 7, ey + ny * 7)))) { if (why) why[4]++; continue; } // контур пальцев
        if (!ci || colorDist(CFG.edgeGain && st.chromaEdges ? gainTo(ci, e.inC) : ci, e.inC) > tolIn) { if (why) why[2]++; continue; }
        if (e.useOut && (!co || colorDist(CFG.edgeGain && st.chromaEdges ? gainTo(co, e.outC) : co, e.outC) > tolOut)) { if (why) why[3]++; continue; }
      }
      // субпиксель: парабола по соседям (по корреляции с профилем, если ищем по нему, иначе по перепаду)
      const i = bt + radius;
      let l = prof[i - 1], r = prof[i + 1], c0 = bd;
      if (usePr && i > 0 && i < zs.length - 1 && zs[i - 1] > 0 && zs[i + 1] > 0) { l = zs[i - 1]; r = zs[i + 1]; c0 = zs[i]; }
      let off = 0;
      if (Number.isFinite(l) && Number.isFinite(r)) {
        const den = l - 2 * c0 + r;
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
      e.seenGood = inl.length >= S * 0.6 ? (e.seenGood || 0) + 1 : 0;
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
      const wi = pairs.w ? pairs.w[i] : 1;
      r.push(wi * (u - pairs.cur[i][0]), wi * (v - pairs.cur[i][1]));
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
  let chromaShiftOut;
  if (CFG.chromaSnap && !msg.noSnap) { st = { quad }; quad = snapSidesToChroma(quad); chromaShiftOut = st.chromaShift; }
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
    lastKfT: clock(),
    initialPts: 0,
    shape0: null,
    ancLow: 0,
    weakTex: true,
    Hgood: null,
  };
  // маска кожи включается, только если внутри рамки кожи нет (на ладони цель — сама кожа)
  {
    const sm = computeSkin(), inner = polyMask(quad);
    const total = cv.countNonZero(inner);
    cv.bitwise_and(sm, inner, sm);
    st.targetSkin = !(total > 0 && cv.countNonZero(sm) / total < 0.15); // цель — сама кожа (ладонь)
    st.skinOn = CFG.skin && !st.targetSkin;
    sm.delete(); inner.delete();
    if (st.skinOn && CFG.skinBg) learnSkinBackground(quad);
    st.skin = st.skinOn ? computeSkin() : null;
  }
  supReset();
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
  // Цель отделена от фона сменой оттенка хотя бы по трём сторонам (тёмный блокнот, карта на деревянном столе): её края
  // надёжны, и для неё включаются правила «края по профилю, точки потока в оптимизации, поправка цвета на блик».
  // Белый лист на сером фоне, холст на мольберте (оттенок по обе стороны почти один) ведутся как раньше — там
  // проверенный баланс источников (шаблон, ECC, окружение) держит руку и листание.
  st.chromaEdges = [0, 1, 2, 3].filter((j) => chromaContrast(st.quad, j, 0) >= CHR.min || chromaContrast(st.quad, j, 2) >= CHR.min).length >= 3;
  // у такой цели «кожа» вокруг — это стол (дерево), а не рука: маска только выкидывала бы точки и края. Пустой лист
  // (ведётся по окружению) маску сохраняет: она не пускает точки на стол, относительно которого лист могут двигать
  if (st.chromaEdges && !st.auto && st.skinOn && CFG.chromaNoSkin) {
    st.skinOn = false;
    if (st.skin) { st.skin.delete(); st.skin = null; }
  }
  st.weakTex = !!st.auto || st.initialPts < 60;
  setTemplate(gray, null);
  st.eccOk = st.tmpl.ecc.texStd >= ECC.minTex; // текстура считается один раз — по эталонному кадру (позже в заплатку может попасть рука)
  st.keyframes.push(makeKeyframe(gray, st.H, clock()));
  updateRecentEcc();
  norm.copyTo(prevNorm);
  makeSmall(); swapSmall();
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
    chromaShift: chromaShiftOut,
    chromaEdges: !!st.chromaEdges,
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
  makeSmall();
  st.frame++;
  if (st.skinOn) { if (st.skin) st.skin.delete(); st.skin = computeSkin(); }
  lap('prep');

  const Hprev = st.H;
  const wasLost = st.lost > 0;
  let pred = null, source = 'lk', lkInl = 0;
  // грубый сдвиг цели по маленькому кадру: старт для потока и независимая оценка, с которой поток сверяется
  let sbi = wasLost || !CFG.sbi ? null : coarseShift(Hprev);
  let sbiH = sbi ? mulH(sbi.A, Hprev) : null;
  const sbiMove = sbi ? quadDist(sbiH, Hprev) : 0;
  // малое движение поток берёт сам, и точнее: грубая оценка нужна только для рывков
  if (sbi && sbiMove < CFG.sbiMinMove) { sbi = null; sbiH = null; }
  st.sbi = sbi ? [+sbiMove.toFixed(1), +sbi.score.toFixed(2)] : null;
  if (!wasLost && st.cur.length) {
    // обычный поток (без подсказки) — как всегда; грубая оценка подключается, только когда он не справился или спорит с ней
    let lk = trackLK(null);
    if (lk && !(quadDist(lk.H, Hprev) < Math.max(W, H) * (sbi ? 0.6 : 0.25))) lk = null;
    // поток «не справился»: позы нет или он растерял большинство точек (смаз, сдвиг больше его досягаемости)
    const weak = !lk || lk.inliers < 0.5 * lk.tried;
    if (sbi && weak && (!lk || quadDist(lk.H, sbiH) > sbi.tol + 0.15 * sbiMove)) {
      // рывок камеры: пробуем поток ещё раз — от грубой оценки — и из двух поз берём ту, по которой цель больше
      // похожа на себя в прошлом кадре
      let lk2 = trackLK(sbi.A);
      if (lk2 && !(quadDist(lk2.H, sbiH) < sbi.tol + 0.3 * sbiMove)) lk2 = null;
      const s0 = lk ? patchScore(lk.H) : -1, s2 = lk2 ? patchScore(lk2.H) : -1, sS = patchScore(sbiH);
      st.sbi.push(+s0.toFixed(2), +s2.toFixed(2), +sS.toFixed(2));
      if (lk2 && s2 > s0 + 0.03) lk = lk2;
      else if (lk && s0 < sS - 0.1) lk = null; // слабый поток объясняет картинку заметно хуже грубой оценки
    }
    if (lk) {
      pred = lk.H;
      st.cur = Float32Array.from(lk.cur);
      st.ref = Float32Array.from(lk.ref);
      st.grp = Uint8Array.from(lk.grp);
      lkInl = lk.inliers;
    } else {
      st.cur = new Float32Array(0); st.ref = new Float32Array(0);
    }
  }
  // автоопоры: свой поток холста сорвался — поза по опорам на той же плоскости
  let supDone = false;
  const supOn = CFG.sup && !wasLost && !st.fullFrame && st.sup;
  if (!pred && supOn) {
    supTrack(null); supDone = true;
    const hs = supPose();
    if (hs && quadDist(hs, Hprev) < Math.max(W, H) * 0.6) { pred = hs; source = 'sup'; }
  }
  if (!pred) {
    if (wasLost) { pred = Hprev; source = 'hold'; }
    else if (sbiH && plausible(sbiH)) { pred = sbiH; source = 'sbi'; }
    else { pred = extrapolate(Hprev, st.prevH); source = 'motion'; }
  }
  if (supOn && !supDone) { const iv = invertH(Hprev); supTrack(source === 'lk' && iv ? mulH(pred, iv) : null); }
  lap('lk');

  // релокализация: при потере — по всему кадру; периодически — проверка дрейфа
  let reloc = null;
  // Проверка дрейфа по ORB — самая тяжёлая операция кадра (на iPhone — десятки–сотни мс, рывок в показе). Пока проверки
  // раз за разом подтверждают позу, интервал растёт (до 3× обычного); первое же расхождение возвращает его к обычному
  const relocGap = (st.fullFrame ? CFG.relocEnv : CFG.relocEvery) * Math.min(st.fullFrame ? 1 : CFG.relocStretch, 1 + 0.5 * (st.relocCalm || 0)); // (в режиме окружения — как раньше: лист могут сдвинуть)
  if (wasLost || st.frame - st.lastReloc >= relocGap) {
    st.lastReloc = st.frame;
    reloc = relocalize(gray, wasLost ? null : pred);
    if (reloc) {
      const d = quadDist(reloc.H, pred);
      if (wasLost || (d >= CFG.driftFix && reloc.inliers >= 25)) { pred = reloc.H; source = 'orb'; }
      if (d < CFG.driftFix) st.lastAgree = st.frame;
      st.relocCalm = !wasLost && d < CFG.driftFix * 0.5 ? (st.relocCalm || 0) + 1 : 0;
    } else if (!(st.relocCalm = 0) && wasLost && st.lost >= 2) { // (проверка не дала ответа — интервал к обычному)
      const sh = relocalizeByShape(Hprev);
      if (sh) { pred = sh.H; source = 'shape'; }
    }
  }
  lap('reloc');

  const lkPose0 = source === 'lk' && lkInl >= CFG.minInliersLK ? pred.slice() : null;
  // плотное выравнивание: сначала по «свежей» заплатке (держит при смене вида), затем по якорной
  // (первый кадр — без дрейфа). Нужно, когда точек потока мало (кожа, бумага) или поза потеряна.
  let ecc = null;
  // мало опорных точек шаблона (lowTex) — повод для ECC, только если и поток слаб: при сотнях точек потока (окружение,
  // автоопоры) плотное выравнивание по однотонной заплатке ничего не добавляет, а дрейфует
  // (в режиме окружения точки потока — на фоне, а не на цели: о цели они не говорят, ECC нужен как раньше)
  const eccLow = st.lowTex && (!CFG.eccLowLk || !st.chromaEdges || st.auto || st.fullFrame || source !== 'lk' || lkInl < CFG.eccSparse || st.targetSkin);
  if (st.tmpl && st.tmpl.ecc && st.eccOk && (wasLost || eccLow || st.cur.length / 2 < CFG.eccSparse || st.frame % CFG.eccEvery === 0)) {
    // поток уверенно держит позу, а плотное выравнивание с ней резко спорит (закрашенный холст, рука на заплатке) — верим потоку
    // (на ладони, где цель сама кожа, ECC нужен для снятия дрейфа потока — там это правило не действует)
    const lkPose = !st.targetSkin && source === 'lk' && lkInl >= 25 ? pred.slice() : null;
    const sane = (r) => r && plausible(r.H) && shapeOk(r.H) && quadDist(r.H, pred) < Math.max(W, H) * 0.15 &&
      (!lkPose || visDist(r.H, lkPose, CFG.eccGuardMax && st.chromaEdges) < CFG.eccVsLk); // по худшей точке: уход одного угла в среднем почти не виден
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
    if ((st.ancLow || 0) >= ECC.suspect && st.frame % 3 === 0 && !lkPose) { // поток уверен — это закрашенный холст, а не потеря: перезахват только ухудшил бы позу
      for (const Hc of [st.Hgood, I3()]) {
        if (!Hc) continue;
        const rr = eccRefine(Hc, null, true);
        // пока поток жив, перезахват должен с ним согласиться: на однотонной поверхности (тёмная обложка) заплатка
        // «сходится» и в чужом месте (было: рамка прыгала на 400+ px)
        if (rr && rr.cc >= ECC.lostCC && plausible(rr.H) && shapeOk(rr.H) && (wasLost || !CFG.relocAgree || !st.chromaEdges || ptsAgree(rr.H) >= 0.5)) {
          pred = rr.H; ecc = rr; source = 'ecc-reloc'; st.ancLow = 0; st.Hgood = rr.H.slice();
          break;
        }
      }
    }
  }
  // ECC (выравнивание по заплатке) спорит с потоком: рассудить по краям — какая поза лучше ложится на края предмета.
  // На однотонной поверхности ECC плохо определён и может растянуть рамку; края там — самое надёжное
  if (CFG.eccEdgeArb && st.chromaEdges && ecc && lkPose0 && st.edges && st.edges.some((e) => e.use) && visDist(ecc.H, lkPose0, true) > CFG.eccVsLk) {
    const sc = (es) => es.reduce((a, e) => a + e.pts.length, 0);
    const eL = sc(edgeObservations(lkPose0, CFG.edgeRadius)), eE = sc(edgeObservations(ecc.H, CFG.edgeRadius));
    if (eL > 1.2 * eE + 4) { pred = lkPose0; ecc = null; source = 'lk'; }
  }
  lap('ecc');

  // измерения без дрейфа
  // Сравнение с шаблоном — самая дорогая часть кадра. На медленном устройстве, когда поток уверенно держит позу
  // (богатая фактура), делаем его не на каждом кадре.
  const lite = !!st.lite;
  const skipTmpl = lite && !st.weakTex && source === 'lk' && lkInl >= 30 && !wasLost && !st.fail && !st.lowTex &&
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
  // поза получена по опорам/окружению из другой плоскости (своих точек у холста нет) — она может быть далеко от настоящих краёв
  if (source === 'lk' && st.ownModel && st.ownModel !== 'own') radius = Math.max(radius, 44);
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
  const sp = supOn ? supPairs(pred) : { ref: [], cur: [] };
  const good = tmplOk || !!ecc || skipTmpl || nEdges >= 3 || (nEdges >= 2 && pairs.n >= 4) ||
    (!wasLost && lkInl >= 15 && pairs.n >= 4) || sp.ref.length >= SUP.minPose;
  let state = 'lost', rms = 0, accepted = null;
  if (good) {
    // Точки потока — тоже измерения (а не только прогноз): они распределены по всей плоскости и держат форму рамки, когда
    // шаблон на однотонной поверхности почти не находит пар, а один из краёв неоднозначен (толстый предмет: грань и торец)
    const meas = { ref: pairs.ref.concat(sp.ref), cur: pairs.cur.concat(sp.cur), w: null };
    const nT = meas.ref.length;
    if (CFG.lkWeight > 0 && st.chromaEdges && source === 'lk' && st.cur.length) {
      // только собственные точки цели: фон (окружение, опоры) двигается вместе с целью не всегда — лист двигают рукой
      const n = st.cur.length / 2, stp = n > 80 ? n / 80 : 1, g = groupsOf();
      for (let k = 0; k < n; k += stp) {
        const i = Math.floor(k);
        if (g[i]) continue;
        const q = applyH(pred, st.ref[i * 2], st.ref[i * 2 + 1]);
        if (Math.hypot(q[0] - st.cur[i * 2], q[1] - st.cur[i * 2 + 1]) > 3) continue; // выброс RANSAC
        meas.ref.push([st.ref[i * 2], st.ref[i * 2 + 1]]); meas.cur.push([st.cur[i * 2], st.cur[i * 2 + 1]]);
      }
      meas.w = new Float32Array(meas.ref.length).fill(1);
      for (let i = nT; i < meas.ref.length; i++) meas.w[i] = CFG.lkWeight;
    }
    const opt = optimize(pred, pred, meas, edges);
    rms = opt.rms;
    if (plausible(opt.H) && shapeOk(opt.H) && opt.rms < 3) accepted = opt.H;
    else if (ecc && plausible(ecc.H) && shapeOk(ecc.H)) accepted = ecc.H; // оптимизация спорит с плотным выравниванием (мало точек) — верим ему
  }
  if (accepted) {
    st.prevH = wasLost ? null : Hprev;
    st.H = accepted;
    st.lost = 0; st.fail = 0;
    state = 'tracking';
  } else if (!wasLost && (st.fail || 0) < CFG.coastMax && plausible(pred) && shapeOk(pred)) {
    // кратковременный сбой (смаз, поза не сошлась): едем по инерции и пересеиваем точки, а не объявляем потерю
    st.fail = (st.fail || 0) + 1;
    st.prevH = st.fail > 1 ? null : Hprev; // экстраполяция по скорости — только первый кадр, дальше держим позу
    st.H = pred;
    state = 'tracking'; source = 'coast';
    seedPoints(st.H, false);
  }
  lap('opt');

  // Обслуживание (досев точек, шаблон, ключевые кадры) на позу этого кадра не влияет, но может занимать десятки мс.
  // Поэтому поза отправляется первой, а обслуживание идёт сразу после отправки (в тот же воркер, до следующего кадра):
  // иначе каждый «тяжёлый» кадр приходил бы на экран с опозданием и референс на миг «выстреливал».
  const finishEms = () => { // скользящее среднее полного времени кадра (вместе с обслуживанием) — для облегчённого режима
    st.ems = st.ems === undefined ? now() - tStart : st.ems * 0.95 + (now() - tStart) * 0.05;
    if (st.ems > CFG.liteMs) st.lite = true; else if (st.ems < CFG.liteMs * 0.75) st.lite = false;
  };
  const upkeep = () => {
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
    // холст закрашивают: эталон по кадру захвата больше не совпадает (якорная заплатка давно не сходится) — переучиваем
    // его по текущему виду, но не когда на холсте рука (в эталон попала бы кожа); у пустой бумаги — не переучиваем
    const repaint = !st.targetSkin && (st.ancLow || 0) > 5 && lkInl >= 25;
    if ((st.tmpl.low > 20 || repaint) && st.stable > 5 && !st.fail && !st.auto && skinOnCanvas() < 0.03) {
      updateTemplate(); st.ancLow = 0; st.tmpl.low = 0;
    }
    if (st.tmpl && st.tmpl.ecc && !st.fail && st.frame % ECC.recentEvery === 0) updateRecentEcc(); // не запоминаем позу «по инерции»
    // новый ключевой кадр: позиция стабильна и недавно подтверждена ORB
    const t = clock();
    if (st.stable > 8 && st.frame - st.lastAgree < CFG.relocEvery * 4 && t - st.lastKfT > CFG.keyframeEveryMs) { // (проверки дрейфа теперь бывают реже — окно шире)
      st.lastKfT = t;
      const kf = makeKeyframe(gray, st.H, t);
      if (kf.n >= 40) {
        st.keyframes.push(kf);
        if (st.keyframes.length > CFG.maxKeyframes) st.keyframes.splice(1, 1)[0].desc.delete(); // исходный храним всегда
      } else kf.desc.delete();
    }
    if (CFG.sup && st.sup && !st.fullFrame && !st.fail) supUpkeep(st.H);
    if (CFG.edgeProfile && st.chromaEdges && !st.fail && st.frame % 4 === 0 && nEdges >= 3) adaptProfiles(st.H);
    const tmp = prevNorm; prevNorm = norm; norm = tmp;
    swapSmall();
    finishEms();
  };
  let defer = null;
  if (state === 'tracking') defer = upkeep;
  else {
    st.lost++;
    st.stable = 0;
    st.cur = new Float32Array(0); st.ref = new Float32Array(0);
    supReset();
    const tmp = prevNorm; prevNorm = norm; norm = tmp;
    swapSmall();
  }
  if (!defer) finishEms();
  if (defer && self.DEBUG_NO_DEFER) { defer(); defer = null; }
  lap('upkeep');

  const anchorsDropped = st.anchorsDropped;
  st.anchorsDropped = false;
  const dbgMin = (self.DEBUG_MIN_MS || 0) + (self.DEBUG_JITTER_MS ? Math.random() * self.DEBUG_JITTER_MS : 0);
  while (dbgMin && now() - tStart < dbgMin) { /* тесты: имитация медленного устройства */ }
  const out = {
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
    totalMs: st.ems ? Math.round(st.ems) : undefined, // среднее полное время кадра, вместе с обслуживанием после отправки позы
    prof,
    dbgPts: self.DEBUG_PTS ? Array.from(st.cur) : undefined,
    anchors: st.anchors.length ? anchorPositions() : undefined,
    anchorsDropped: anchorsDropped || undefined,
    sbi: st.sbi || undefined, sbiRaw: st.sbiRaw,
    support: supOut(), sup: sp.ref.length,
    dbgEdgePts: self.DEBUG_PTS ? edges.map((e) => [e.j, e.pts.map((p) => [+(p[0] + 0.5).toFixed(1), +(p[1] + 0.5).toFixed(1)])]) : undefined,
    dbgLk: self.DEBUG_PTS && lkPose0 ? outQuad(mapQuad(lkPose0, st.quad)).map((p) => p.map((v) => +v.toFixed(1))) : undefined,
    dbgEdges: self.DEBUG_PTS ? [edges.map((e) => e.j), st.dbgWhy && st.dbgWhy[2], st.edges && st.edges.map((e) => [e.use, e.pol, Math.round(e.contrast)]), st.edges && st.edges[2].prof && Array.from(st.edges[2].prof, (v) => +v.toFixed(2))] : undefined,
    dbgSup: st.sup ? [st.sup.pts.length, st.sup.pts.filter((p) => p.ok).length, +Math.max(0, ...[...st.sup.batches.values()].map((b) => b.pmax)).toFixed(3)] : undefined,
    dbgEnv: [st.auto ? 1 : 0, st.envBad || 0, st.autoDropped ? 1 : 0, st.fullFrame ? 1 : 0, st.ownN, st.ownModel],
  };
  if (defer) Object.defineProperty(out, 'defer', { value: defer, enumerable: false });
  return out;
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

/**
 * Нет пересечения прямых — берём самый контрастный признак рядом с касанием (кончик тёмного пятна, угол мазка, метка):
 * максимум «угловатости» (меньшее собственное число матрицы градиентов, как в Ши–Томаси) в окне вокруг касания, с лёгким
 * предпочтением ближнего. Такая точка к тому же хорошо ведётся потоком. На гладком месте (бумага, кожа) признака нет.
 */
const FEAT = { radius: 0.04, minResp: 0.008, prox: 0.4 };
function snapFeature(tap, opt = {}) {
  const R = opt.radius || FEAT.radius * Math.max(W, H);
  const x0 = Math.max(4, Math.floor(tap[0] - R)), y0 = Math.max(4, Math.floor(tap[1] - R));
  const x1 = Math.min(W - 4, Math.ceil(tap[0] + R)), y1 = Math.min(H - 4, Math.ceil(tap[1] + R));
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  const roi = gray.roi(new cv.Rect(x0 - 3, y0 - 3, Math.min(W, x1 + 3) - (x0 - 3), Math.min(H, y1 + 3) - (y0 - 3)));
  const resp = new cv.Mat();
  cv.cornerMinEigenVal(roi, resp, 5, 3);
  const rw = resp.cols, d = resp.data32F;
  let best = null;
  for (let y = 3; y < resp.rows - 3; y++) {
    for (let x = 3; x < rw - 3; x++) {
      const gx = x0 - 3 + x, gy = y0 - 3 + y;
      const dist = Math.hypot(gx - tap[0], gy - tap[1]);
      if (dist > R) continue;
      const v = d[y * rw + x];
      if (v < (opt.minResp || FEAT.minResp)) continue;
      const score = v * (1 - FEAT.prox * (dist / R) * (dist / R));
      if (!best || score > best.score) best = { score, v, x, y, gx, gy };
    }
  }
  let out = null;
  if (best) {
    // субпиксель: параболы по 3×3 вокруг максимума
    const at = (x, y) => d[y * rw + x];
    const c = at(best.x, best.y);
    const dx = at(best.x - 1, best.y) - 2 * c + at(best.x + 1, best.y), dy = at(best.x, best.y - 1) - 2 * c + at(best.x, best.y + 1);
    const ox = dx < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (at(best.x - 1, best.y) - at(best.x + 1, best.y)) / dx)) : 0;
    const oy = dy < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (at(best.x, best.y - 1) - at(best.x, best.y + 1)) / dy)) : 0;
    out = { p: [best.gx + ox, best.gy + oy], resp: best.v, score: best.score };
  }
  roi.delete(); resp.delete();
  return out;
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
  if (!best || best.score < (opt.minScore || SNAP.minScore)) {
    // пересечения прямых нет — ближайший самый контрастный признак (только при выборе, не при ведении точки)
    if (opt.feature) {
      const f = snapFeature(tap);
      if (f) return { snapped: false, feature: true, p: f.p, score: best ? best.score : 0, resp: f.resp };
    }
    return { snapped: false, p: tap, score: best ? best.score : 0 };
  }
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

const selOut = () => sel.pts.map((pt) => ({ p: outQuad([pt.p])[0], snapped: pt.snapped, feature: !!pt.feature, lost: !!pt.lost, score: +(pt.score || 0).toFixed(2) }));

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
  const r = snapCorner(maps, tap, active.map((pt) => pt.p), { feature: true });
  sel.pts.push({ p: r.p, rays: r.rays || null, snapped: r.snapped, feature: !!r.feature, miss: 0, fail: 0, score: r.score });
  if (sel.pts.length < 4) { selSwap(); return { type: 'tapped', snapped: r.snapped, feature: !!r.feature, resp: r.resp, p: outQuad([r.p])[0], pts: selOut() }; }
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
  return { ...lockInfo, type: 'locked', tapped: true, snapped: r.snapped, feature: !!r.feature, p: outQuad([r.p])[0] };
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
    if (msg.clock !== undefined) clockT = msg.clock; // тесты: время кадра по его номеру
    if (msg.type === 'lock') res = lock(msg);
    else if (msg.type === 'frame') res = sel ? selFrame(msg) : track(msg);
    else if (msg.type === 'debugPts') { self.DEBUG_PTS = true; res = { type: 'ok' }; }
    else if (msg.type === 'debugCfg') { Object.assign(CFG, msg.cfg || {}); Object.assign(ECC, msg.ecc || {}); res = { type: 'ok' }; } // тесты: подмена параметров
    else if (msg.type === 'debugMinMs') { self.DEBUG_MIN_MS = msg.ms; res = { type: 'ok' }; }
    else if (msg.type === 'debugJitterMs') { self.DEBUG_JITTER_MS = msg.ms; res = { type: 'ok' }; }
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
    if (res) {
      // буфер кадра возвращаем обратно (он уже скопирован в Mat): главный поток использует его снова, а не выделяет
      // по мегабайту на каждый кадр — на iPhone такой мусор оборачивался паузами сборщика (фризы)
      if (msg.buf && msg.buf.byteLength) { postMessage({ ...res, id: msg.id, back: msg.buf }, [msg.buf]); }
      else postMessage({ ...res, id: msg.id });
      if (res.defer) res.defer(); // обслуживание после отправки позы (см. track)
    }
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
