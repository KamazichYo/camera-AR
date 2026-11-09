// Плавность и точность того, что видит пользователь: на каждом кадре отрисовки сравниваем рамку референса
// на экране с эталоном для того видеокадра, который показан В ЭТОТ момент (номер кадра — штрихкод в видео).
// Метрики:
//  • ошибка — среднее расстояние углов рамки до эталона (отставание + шум);
//  • «скольжение» — смещение рамки между двумя отрисовками, пока видеокадр тот же (картинка стоит, а
//    референс ползёт — это и есть «тряска» относительно картинки);
//  • дрожь — RMS изменения ошибки от отрисовки к отрисовке.
// Видео — тренировочное, локальное (tests/.data/video).
const fs = require('fs');
const path = require('path');
const { launch, check, DATA, frameIndex } = require('./common.cjs');

const DIR = path.join(DATA, process.env.VIDEO || 'video'); // VIDEO=art — ролик с картиной и сильной тряской
const END = +(process.env.END || 152);
if (!fs.existsSync(path.join(DIR, 'training.y4m')) || !fs.existsSync(path.join(DIR, 'ref.json'))) {
  console.log('– нет tests/.data/video/training.y4m или ref.json (python3 tests/make_video.py && node tests/video-prepare.cjs), пропуск');
  process.exit(0);
}
const REF = JSON.parse(fs.readFileSync(path.join(DIR, 'ref.json'), 'utf8'));
const IDX_SRC = `(() => { const w = document.querySelector('#view'); const v = (w && getComputedStyle(w).visibility === 'visible') ? w : document.querySelector('#video'); const c = window.__c || (window.__c = Object.assign(document.createElement('canvas'), { width: 80, height: 10 }));
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(v, 0, 350, 80, 10, 0, 0, 80, 10); const d = x.getImageData(0, 0, 80, 10).data;
  let i = 0; for (let b = 0; b < 10; b++) if (d[(5 * 80 + 8 * b + 4) * 4] > 128) i |= 1 << b; return i; })()`;

// Метрики считаются по сетке точек холста, видимых в кадре (углы за кадром — а на тряске они уходят далеко — дают огромные,
// но неважные цифры). Размер кадра берём из ролика.
function homog(q) {
  const A = [], b = [];
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([x, y], i) => {
    const [u, v] = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  });
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}
const ap = (h, [x, y]) => { const k = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / k, (h[3] * x + h[4] * y + h[5]) / k]; };
const GRID = []; for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) GRID.push([i / 4, j / 4]);
const FW = +(process.env.FW || 640), FH = +(process.env.FH || 360);
/** Вектора ошибки (экран − эталон) в видимых точках сетки: { k: индекс точки, v: [dx, dy] } */
function gridVecs(q, r) {
  const hq = homog(q), hr = homog(r), out = [];
  GRID.forEach((g, k) => {
    const a = ap(hr, g);
    if (a[0] >= 0 && a[1] >= 0 && a[0] < FW && a[1] < FH) { const b = ap(hq, g); out.push({ k, v: [b[0] - a[0], b[1] - a[1]] }); }
  });
  return out;
}

(async () => {
  const { page: p, errors, close, url, context } = await launch({ port: 8871, camera: true, viewport: { width: 800, height: 600 }, video: path.join(DIR, 'training.y4m') });
  const slowMs = +(process.env.SLOW_MS || 0);  // трекер не быстрее одного кадра за SLOW_MS (имитация слабого телефона)
  await p.goto(`${url}/app/index.html`);
  await p.waitForTimeout(1500);
  if (!(await p.evaluate(() => document.body.classList.contains('running')))) await p.click('#btn-start');
  await p.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  await p.evaluate(() => { window.artcam.sync.diag = true; });
  await p.setInputFiles('#file', path.join(DATA, 'ref.png'));
  await p.waitForFunction(() => window.artcam.ref.loaded);

  // AR: касания по углам в начале ролика
  await p.waitForFunction(`(() => { const i = ${IDX_SRC}; return i >= 1 && i <= 6; })()`, null, { polling: 15, timeout: 30000 });
  await p.click('#btn-ar');
  await p.waitForFunction(() => window.artcam.ar.mode === 'select', null, { timeout: 60000 });
  const order = [2, 0, 3, 1], jit = [[9, -7], [-8, 6], [7, 9], [-6, -8]];
  for (let k = 0; k < 4; k++) {
    await p.waitForFunction(`(() => { const i = ${IDX_SRC}; return i >= ${8 + 10 * k} && i <= 140; })()`, null, { polling: 10, timeout: 30000 });
    const q = REF[(await frameIndex(p)) + 1];
    const [sx, sy] = await p.evaluate((pt) => window.artcam.stage.toScreen(pt), [q[order[k]][0] + jit[k][0], q[order[k]][1] + jit[k][1]]);
    await p.mouse.click(sx, sy);
    if (k < 3) await p.waitForFunction((n) => window.artcam.ar.corners.length === n && !window.artcam.ar.pendingTap, k + 1, { timeout: 15000 });
  }
  await p.waitForFunction(() => window.artcam.ar.mode === 'tracking', null, { timeout: 15000 });
  if (slowMs) await p.evaluate((ms) => window.artcam.tracker.worker.postMessage({ type: 'debugMinMs', ms }), slowMs);
  // имитация неровного телефона: время кадра трекера и снимка кадра гуляют случайно
  const JIT = +(process.env.JIT_MS || 0), GRAB = +(process.env.GRAB_MS || 0);
  if (JIT) await p.evaluate((ms) => window.artcam.tracker.worker.postMessage({ type: 'debugJitterMs', ms }), JIT);
  if (GRAB) await p.evaluate((ms) => {
    const orig = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (src, ...rest) => { if (src instanceof HTMLVideoElement) { const b = await orig(src, ...rest); await new Promise((r) => setTimeout(r, Math.random() * ms)); return b; } return orig(src, ...rest); };
  }, GRAB);
  // референс ровно по холсту: его рамка на экране и есть измеряемая величина
  await p.evaluate(() => { const a = window.artcam.ar; a.refOverlay = a.refCanvas.map((q) => [...q]); window.artcam.resetSmoothing(); });

  // запись всех отрисовок до конца ролика
  const rec = await p.evaluate(`new Promise((res) => {
    const out = []; let n = 0;
    const loop = () => {
      const i = ${IDX_SRC};
      const q = window.artcam.displayQuad;
      out.push({ t: performance.now(), i, q: q && q.map((p) => [p[0], p[1]]), s: window.artcam.ar.state, src: window.artcam.ar.info && window.artcam.ar.info.source });
      if (i >= ${END} || ++n > 2000) return res(out);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  })`);
  const fps = await p.evaluate(() => window.artcam.tracker.stats.fps);
  const ex = await p.evaluate(() => ({ e: window.artcam.sync.extrap, d: window.artcam.sync.draws }));
  const la = await p.evaluate(() => window.artcam.sync.latAll || []);
  const las = la.slice().sort((a, b) => a - b);
  console.log(`  задержка трекера по позам: мед. ${las[las.length >> 1]}, 90% ${las[Math.floor(las.length * 0.9)]}, 99% ${las[Math.floor(las.length * 0.99)]}, макс. ${las[las.length - 1]} мс (поз ${las.length})`);
  console.log(`  экстраполяций референса: ${ex.e} на ${ex.d} отрисовок`);
  const syncInfo = await p.evaluate(() => ({ on: window.artcam.sync.active, delay: Math.round(window.artcam.sync.delay), latency: Math.round(window.artcam.sync.latency), period: Math.round(window.artcam.sync.period) }));
  await close();

  fs.writeFileSync(path.join(DIR, 'smooth-rec.json'), JSON.stringify(rec));
  const rows = rec.filter((r) => r.q && REF[r.i + 1]);
  const vec = new Map(); rows.forEach((r) => vec.set(r, gridVecs(r.q, REF[r.i + 1])));
  const err = (r) => { const g = vec.get(r); return g.length ? g.reduce((s, x) => s + Math.hypot(x.v[0], x.v[1]), 0) / g.length : null; };
  const e = rows.map(err).filter((v) => v !== null).sort((a, b) => a - b);
  let slip = 0, ns = 0, jit2 = 0, nj = 0;
  for (let k = 1; k < rows.length; k++) {
    const a = rows[k - 1], b = rows[k];
    const ga = vec.get(a), gb = vec.get(b), ma = new Map(ga.map((x) => [x.k, x.v]));
    const pairs = gb.filter((x) => ma.has(x.k));
    if (!pairs.length) continue;
    const d = pairs.reduce((s, x) => { const pa = ap(homog(a.q), GRID[x.k]), pb = ap(homog(b.q), GRID[x.k]); return s + Math.hypot(pb[0] - pa[0], pb[1] - pa[1]); }, 0) / pairs.length;
    if (a.i === b.i) { slip += d; ns++; }
    jit2 += pairs.reduce((s, x) => { const v0 = ma.get(x.k); return s + (x.v[0] - v0[0]) ** 2 + (x.v[1] - v0[1]) ** 2; }, 0) / pairs.length; nj++;
  }
  const lost = rec.filter((r) => r.s !== 'tracking').length;
  const m = {
    n: rows.length, fps,
    err: e.reduce((s, v) => s + v, 0) / e.length, p95: e[Math.floor(e.length * 0.95)], max: e[e.length - 1],
    slip: slip / Math.max(1, ns), jitter: Math.sqrt(jit2 / Math.max(1, nj)), lost,
  };
  console.log(`  отрисовок ${m.n}, трекер ${m.fps} к/с; ошибка ср. ${m.err.toFixed(2)} px, 95% ${m.p95.toFixed(2)} px, макс. ${m.max.toFixed(2)} px; ` +
    `скольжение ${m.slip.toFixed(2)} px/отрисовку; дрожь ${m.jitter.toFixed(2)} px; кадров «потерян» ${m.lost}; синхр. показ: ${syncInfo.on ? 'вкл, задержка ' + syncInfo.delay + ' мс (трекер: задержка ' + syncInfo.latency + ', период ' + syncInfo.period + ' мс)' : 'выкл'}`);
  fs.writeFileSync(path.join(DIR, 'smooth-metrics.json'), JSON.stringify(m));
  check(m.n > 100, 'записано достаточно отрисовок');
  check(m.lost === 0, 'холст не терялся');
  check(m.err < 1.2 && m.p95 < 3, `рамка на экране близка к эталону (ср. ${m.err.toFixed(2)} px, 95% ${m.p95.toFixed(2)} px)`);
  check(m.slip < 0.2, `референс не ползёт относительно картинки (скольжение ${m.slip.toFixed(2)} px)`);
  check(m.jitter < 1.2, `дрожь мала (${m.jitter.toFixed(2)} px)`);
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors.slice(0, 3)) : ''));
})().catch((e) => { console.error(e); process.exit(1); });
