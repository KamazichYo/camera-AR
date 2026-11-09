/* AR-трекер холста. Работает в Web Worker, использует OpenCV.js (WASM).
 *
 * Идея:
 *  - при «захвате» запоминаем опорный кадр и область холста (четырёхугольник);
 *  - каждый кадр отслеживаем точки-углы оптическим потоком Лукаса–Канаде
 *    (с проверкой вперёд-назад) и по ним RANSAC-ом считаем гомографию
 *    «опорный кадр → текущий кадр»;
 *  - периодически (и при потере) делаем релокализацию по ORB-дескрипторам
 *    против набора ключевых кадров — это убирает накопленный дрейф и
 *    восстанавливает трекинг после того, как холст закрыли рукой / ушли из кадра;
 *  - ключевые кадры обновляются по ходу рисования, т.к. содержимое холста меняется.
 * Все координаты здесь — в пикселях уменьшенного кадра, который присылает главный поток.
 */
/* global cv */
'use strict';

const CFG = {
  maxCorners: 350,
  minCorners: 30,
  cornerQuality: 0.008,
  cornerMinDist: 7,
  lkWin: 21,
  lkLevels: 3,
  fbMaxErr: 1.5,          // px — допустимая ошибка проверки вперёд-назад
  tmplCorners: 400,       // точек в шаблоне для уточнения позы
  ransacRefine: 2.0,      // px
  minRefine: 12,
  ransacLK: 2.5,          // px
  ransacORB: 4.0,         // px
  orbFeatures: 900,
  ratio: 0.78,            // тест Лоу
  minInliersLK: 10,
  minInliersORB: 16,
  relocEvery: 20,         // кадров между проверками дрейфа (ORB)
  driftFix: 5,            // px — если ORB и LK расходятся больше, доверяем ORB
  keyframeEveryMs: 2500,
  maxKeyframes: 6,
  margin: 0.12,           // расширение области холста для поиска точек
};

let ready = false;
let W = 0, H = 0;
let rgba = null, gray = null, prevGray = null;
let orb = null, matcher = null;
let st = null; // состояние трекинга

const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];

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

// ---------- утилиты ----------
function ensureBuffers(w, h) {
  if (w === W && h === H && gray) return;
  [rgba, gray, prevGray].forEach((m) => m && m.delete());
  W = w; H = h;
  rgba = new cv.Mat(h, w, cv.CV_8UC4);
  gray = new cv.Mat(h, w, cv.CV_8UC1);
  prevGray = new cv.Mat(h, w, cv.CV_8UC1);
}

function loadFrame(buf, w, h) {
  ensureBuffers(w, h);
  rgba.data.set(new Uint8Array(buf));
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
}

function applyH(Hm, x, y) {
  const w = Hm[6] * x + Hm[7] * y + Hm[8];
  return [(Hm[0] * x + Hm[1] * y + Hm[2]) / w, (Hm[3] * x + Hm[4] * y + Hm[5]) / w];
}

function invertH(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

function expandQuad(q, m) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  return q.map(([x, y]) => [cx + (x - cx) * (1 + m), cy + (y - cy) * (1 + m)]);
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

/** Проверка правдоподобия гомографии: холст остаётся выпуклым, без отражения и разумного размера. */
function plausible(Hm) {
  if (!Hm || Hm.some((v) => !Number.isFinite(v))) return false;
  const q = st.quad.map(([x, y]) => applyH(Hm, x, y));
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
  if (st.fullFrame) {
    const m = new cv.Mat(H, W, cv.CV_8UC1, new cv.Scalar(255));
    return m;
  }
  return polyMask(st.searchQuad.map(([x, y]) => applyH(Hm, x, y)));
}

function detectCorners(img, mask, max, exclude) {
  const m = mask.clone();
  if (exclude && exclude.length) {
    for (let i = 0; i < exclude.length; i += 2)
      cv.circle(m, new cv.Point(Math.round(exclude[i]), Math.round(exclude[i + 1])), CFG.cornerMinDist, new cv.Scalar(0), -1);
  }
  const corners = new cv.Mat();
  cv.goodFeaturesToTrack(img, corners, max, CFG.cornerQuality, CFG.cornerMinDist, m, 5, false, 0.04);
  const out = Array.from(corners.data32F);
  corners.delete(); m.delete();
  return out;
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

function findH(src, dst, thr) {
  const n = src.length / 2;
  if (n < 4) return null;
  const s = cv.matFromArray(n, 1, cv.CV_32FC2, src);
  const d = cv.matFromArray(n, 1, cv.CV_32FC2, dst);
  const mask = new cv.Mat();
  const Hm = cv.findHomography(s, d, cv.RANSAC, thr, mask, 2000, 0.995);
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

function dropKeyframes() {
  if (!st) return;
  st.keyframes.forEach((k) => k.desc.delete());
  if (st.tmpl) st.tmpl.img.delete();
  st.tmpl = null;
}

/** Сопоставление ORB текущего кадра с ключевыми кадрами. Возвращает лучшую гомографию. */
function relocalize(img, Hguess) {
  const mask = Hguess ? currentMask(Hguess) : new cv.Mat();
  const cur = orbDetect(img, mask);
  mask.delete();
  let best = null;
  if (cur.n >= CFG.minInliersORB) {
    // новейшие ключевые кадры первыми
    const order = st.keyframes.slice().reverse();
    for (const kf of order) {
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
        if (!best || r.inliers > best.inliers) best = { H: r.H, inliers: r.inliers, kf };
        if (r.inliers > 60) break; // достаточно уверенно
      }
    }
  }
  cur.desc.delete();
  return best;
}

/** Засеять точки для оптического потока в текущем кадре по позе Hm. */
function seedPoints(img, Hm, keep) {
  const mask = currentMask(Hm);
  const curPts = keep ? Array.from(st.cur) : [];
  const refPts = keep ? Array.from(st.ref) : [];
  const need = CFG.maxCorners - curPts.length / 2;
  if (need > 10) {
    const fresh = detectCorners(img, mask, need, curPts);
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

/** Пирамидальный LK с проверкой вперёд-назад. Возвращает индексы и новые координаты надёжных точек. */
function lkPairs(imgA, imgB, ptsA, win, levels) {
  const n = ptsA.length / 2;
  const idx = [], out = [];
  if (n < 1) return { idx, out };
  const p0 = cv.matFromArray(n, 1, cv.CV_32FC2, ptsA);
  const p1 = new cv.Mat(), pb = new cv.Mat();
  const s1 = new cv.Mat(), s2 = new cv.Mat(), e1 = new cv.Mat(), e2 = new cv.Mat();
  const size = new cv.Size(win, win);
  const crit = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 20, 0.03);
  cv.calcOpticalFlowPyrLK(imgA, imgB, p0, p1, s1, e1, size, levels, crit);
  cv.calcOpticalFlowPyrLK(imgB, imgA, p1, pb, s2, e2, size, levels, crit);
  const a = p0.data32F, b = p1.data32F, c = pb.data32F;
  for (let i = 0; i < n; i++) {
    if (!s1.data[i] || !s2.data[i]) continue;
    const x = b[i * 2], y = b[i * 2 + 1];
    if (!(x >= 0 && y >= 0 && x < W && y < H)) continue;
    if (Math.hypot(a[i * 2] - c[i * 2], a[i * 2 + 1] - c[i * 2 + 1]) > CFG.fbMaxErr) continue;
    idx.push(i); out.push(x, y);
  }
  [p0, p1, pb, s1, s2, e1, e2].forEach((m) => m.delete());
  return { idx, out };
}

/** Межкадровый трекинг: быстрый прогноз позы. */
function trackLK() {
  const { idx, out } = lkPairs(prevGray, gray, st.cur, CFG.lkWin, CFG.lkLevels);
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

/** Шаблон (вид холста в опорных координатах) + его точки. */
function setTemplate(img, validMask) {
  if (st.tmpl) st.tmpl.img.delete();
  const mask = polyMask(st.fullFrame ? [[0, 0], [W, 0], [W, H], [0, H]] : st.searchQuad);
  if (validMask) cv.bitwise_and(mask, validMask, mask);
  const pts = detectCorners(img, mask, CFG.tmplCorners);
  mask.delete();
  st.tmpl = { img: img.clone(), pts: Float32Array.from(pts), n: pts.length / 2, low: 0 };
}

/**
 * Уточнение позы без дрейфа: текущий кадр «разворачивается» в опорные координаты
 * по текущей оценке H и сравнивается с шаблоном. Остаточный сдвиг точек даёт
 * поправку C, итоговая поза H·C.
 */
function refine(Hm) {
  const t = st.tmpl;
  if (!t || t.n < CFG.minRefine) return null;
  const Hmat = cv.matFromArray(3, 3, cv.CV_64F, Hm);
  const warped = new cv.Mat();
  cv.warpPerspective(gray, warped, Hmat, new cv.Size(W, H), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP,
    cv.BORDER_CONSTANT, new cv.Scalar(0));
  Hmat.delete();
  const { idx, out } = lkPairs(t.img, warped, t.pts, 15, 2);
  let res = null;
  if (idx.length >= CFG.minRefine) {
    const src = [];
    for (const i of idx) src.push(t.pts[i * 2], t.pts[i * 2 + 1]);
    const r = findH(src, out, CFG.ransacRefine);
    if (r && r.inliers >= CFG.minRefine) {
      const s = r.H[8];
      const C = r.H.map((v) => v / s);
      // H·C
      const Hn = new Array(9);
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
          Hn[i * 3 + j] = Hm[i * 3] * C[j] + Hm[i * 3 + 1] * C[3 + j] + Hm[i * 3 + 2] * C[6 + j];
      if (plausible(Hn) && quadDist(Hn, Hm) < Math.max(W, H) * 0.05) {
        res = { H: Hn, inliers: r.inliers, ratio: r.inliers / t.n };
      }
    }
  }
  res = res || { H: null, inliers: 0, ratio: 0 };
  res.warped = warped;
  return res;
}

function updateTemplate() {
  const Hmat = cv.matFromArray(3, 3, cv.CV_64F, st.H);
  const warped = new cv.Mat(), valid = new cv.Mat();
  cv.warpPerspective(gray, warped, Hmat, new cv.Size(W, H), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP,
    cv.BORDER_CONSTANT, new cv.Scalar(0));
  cv.threshold(warped, valid, 0, 255, cv.THRESH_BINARY);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  cv.erode(valid, valid, k);
  setTemplate(warped, valid);
  [Hmat, warped, valid, k].forEach((m) => m.delete());
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

// ---------- обработчики сообщений ----------
function lock({ buf, w, h, quad, margin, fullFrame }) {
  loadFrame(buf, w, h);
  dropKeyframes();
  st = {
    quad,
    searchQuad: expandQuad(quad, margin ?? CFG.margin),
    fullFrame: !!fullFrame,
    H: I3(),
    cur: new Float32Array(0),
    ref: new Float32Array(0),
    keyframes: [],
    tmpl: null,
    frame: 0,
    lastReloc: 0,
    lost: 0,
    stable: 0,
    lastAgree: -1e9,
    lastKfT: performance.now(),
    initialPts: 0,
  };
  seedPoints(gray, st.H, false);
  st.initialPts = st.cur.length / 2;
  setTemplate(gray, null);
  st.keyframes.push(makeKeyframe(gray, st.H, performance.now()));
  gray.copyTo(prevGray);
  const kf = st.keyframes[0];
  return {
    type: 'locked',
    points: st.initialPts,
    features: kf.n,
    weak: st.initialPts < CFG.minCorners || kf.n < 40,
  };
}

function track({ buf, w, h }) {
  if (!st) return { type: 'pose', state: 'off' };
  if (w !== W || h !== H) return { type: 'pose', state: 'lost', H: st.H };
  const t0 = performance.now();
  loadFrame(buf, w, h);
  st.frame++;
  let state = 'tracking';
  let inliers = 0;
  let source = 'lk';

  const lk = st.lost === 0 ? trackLK() : null;
  if (lk) {
    // ограничиваем «прыжки» — резкое изменение за кадр почти всегда ошибка
    const jump = quadDist(lk.H, st.H);
    if (jump > Math.max(W, H) * 0.25) {
      st.lost = 1;
    } else {
      st.H = lk.H;
      st.cur = Float32Array.from(lk.cur);
      st.ref = Float32Array.from(lk.ref);
      inliers = lk.inliers;
      st.stable = jump < 1.5 ? st.stable + 1 : 0;
    }
  } else {
    st.lost++;
    st.stable = 0;
  }

  const fewPoints = st.cur.length / 2 < Math.max(CFG.minCorners, st.initialPts * 0.35);
  const needReloc = st.lost > 0 || st.frame - st.lastReloc >= CFG.relocEvery;
  let reseeded = false;
  if (needReloc) {
    st.lastReloc = st.frame;
    // при потере — ищем по всему кадру; иначе — в окрестности текущей позы
    const r = relocalize(gray, st.lost > 0 ? null : st.H);
    if (r) {
      if (st.lost > 0) {
        st.H = r.H; st.lost = 0; source = 'orb';
        seedPoints(gray, st.H, false); reseeded = true;
        inliers = r.inliers;
      } else {
        const d = quadDist(r.H, st.H);
        if (d < CFG.driftFix) st.lastAgree = st.frame;
        else if (r.inliers >= 25) {
          st.H = r.H; source = 'orb';
          seedPoints(gray, st.H, false); reseeded = true;
          st.lastAgree = st.frame;
        }
      }
    }
  }
  if (st.lost > 0) state = 'lost';

  let refined = 0;
  if (state === 'tracking') {
    const rf = refine(st.H);
    if (rf.H) {
      st.H = rf.H;
      reanchor(st.H);
      refined = rf.inliers;
    }
    // содержимое холста сильно изменилось (дорисовали) — обновляем шаблон
    st.tmpl.low = rf.ratio < 0.4 ? st.tmpl.low + 1 : 0;
    if (st.tmpl.low > 20 && st.stable > 5) updateTemplate();
    rf.warped.delete();
  }

  if (state === 'tracking' && !reseeded && fewPoints) seedPoints(gray, st.H, true);

  // новый ключевой кадр: позиция стабильна и недавно подтверждена ORB
  const now = performance.now();
  if (state === 'tracking' && st.stable > 8 && st.frame - st.lastAgree < CFG.relocEvery * 2 &&
      now - st.lastKfT > CFG.keyframeEveryMs) {
    st.lastKfT = now;
    const kf = makeKeyframe(gray, st.H, now);
    if (kf.n >= 40) {
      st.keyframes.push(kf);
      if (st.keyframes.length > CFG.maxKeyframes) {
        const old = st.keyframes.splice(1, 1)[0]; // первый (исходный) кадр храним всегда
        old.desc.delete();
      }
    } else kf.desc.delete();
  }

  const tmp = prevGray; prevGray = gray; gray = tmp;
  return {
    type: 'pose',
    state,
    H: st.H,
    inliers,
    refined,
    points: st.cur.length / 2,
    keyframes: st.keyframes.length,
    source,
    ms: Math.round(performance.now() - t0),
  };
}

/** Автопоиск холста/листа: самый большой выпуклый четырёхугольник в кадре. */
function detect({ buf, w, h }) {
  loadFrame(buf, w, h);
  const cands = [];
  const blur = new cv.Mat(), edges = new cv.Mat(), bin = new cv.Mat();
  cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
  cv.Canny(blur, edges, 40, 120);
  const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  cv.dilate(edges, edges, k);
  cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
  for (const img of [edges, bin]) {
    const contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(img, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > W * H * 0.08 && area < W * H * 0.97) {
        const hull = new cv.Mat(), approx = new cv.Mat();
        cv.convexHull(c, hull);
        const peri = cv.arcLength(hull, true);
        for (const eps of [0.02, 0.035, 0.05]) {
          cv.approxPolyDP(hull, approx, eps * peri, true);
          if (approx.rows === 4) {
            const d = approx.data32S;
            cands.push({ area: cv.contourArea(approx), q: [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]] });
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
  cands.sort((a, b) => b.area - a.area);
  return { type: 'detected', quad: cands.length ? cands[0].q : null };
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      if (ready) return postMessage({ type: 'ready', id: msg.id });
      const url = await loadCv(msg.urls);
      orb = new cv.ORB(CFG.orbFeatures);
      matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
      ready = true;
      postMessage({ type: 'ready', url, id: msg.id });
      return;
    }
    if (!ready) throw new Error('OpenCV ещё не загружен');
    let res;
    if (msg.type === 'lock') res = lock(msg);
    else if (msg.type === 'frame') res = track(msg);
    else if (msg.type === 'detect') res = detect(msg);
    else if (msg.type === 'setQuad') {
      // пользователь поправил рамку холста во время трекинга (в опорных координатах)
      if (st) { st.quad = msg.quad; st.searchQuad = expandQuad(msg.quad, msg.margin ?? CFG.margin); }
      res = { type: 'ok' };
    } else if (msg.type === 'unlock') {
      dropKeyframes(); st = null; res = { type: 'unlocked' };
    }
    if (res) postMessage({ ...res, id: msg.id });
  } catch (err) {
    let message = String((err && err.message) || err);
    // исключения OpenCV приходят как указатель на C++-объект
    if (typeof err === 'number' && self.cv && cv.exceptionFromPtr) {
      try { message = cv.exceptionFromPtr(err).msg; } catch { /* оставить как есть */ }
    }
    postMessage({ type: 'error', id: msg.id, message });
  }
};
