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

const DIR = path.join(DATA, 'video');
if (!fs.existsSync(path.join(DIR, 'training.y4m')) || !fs.existsSync(path.join(DIR, 'ref.json'))) {
  console.log('– нет tests/.data/video/training.y4m или ref.json (python3 tests/make_video.py && node tests/video-prepare.cjs), пропуск');
  process.exit(0);
}
const REF = JSON.parse(fs.readFileSync(path.join(DIR, 'ref.json'), 'utf8'));
const IDX_SRC = `(() => { const w = document.querySelector('#view'); const v = (w && getComputedStyle(w).visibility === 'visible') ? w : document.querySelector('#video'); const c = window.__c || (window.__c = Object.assign(document.createElement('canvas'), { width: 80, height: 10 }));
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(v, 0, 350, 80, 10, 0, 0, 80, 10); const d = x.getImageData(0, 0, 80, 10).data;
  let i = 0; for (let b = 0; b < 10; b++) if (d[(5 * 80 + 8 * b + 4) * 4] > 128) i |= 1 << b; return i; })()`;

(async () => {
  const { page: p, errors, close, url, context } = await launch({ port: 8871, camera: true, viewport: { width: 800, height: 600 }, video: path.join(DIR, 'training.y4m') });
  const slowMs = +(process.env.SLOW_MS || 0);  // трекер не быстрее одного кадра за SLOW_MS (имитация слабого телефона)
  await p.goto(`${url}/app/index.html`);
  await p.waitForTimeout(1500);
  if (!(await p.evaluate(() => document.body.classList.contains('running')))) await p.click('#btn-start');
  await p.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
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
  // референс ровно по холсту: его рамка на экране и есть измеряемая величина
  await p.evaluate(() => { const a = window.artcam.ar; a.refOverlay = a.refCanvas.map((q) => [...q]); window.artcam.resetSmoothing(); });

  // запись всех отрисовок до конца ролика
  const rec = await p.evaluate(`new Promise((res) => {
    const out = []; let n = 0;
    const loop = () => {
      const i = ${IDX_SRC};
      const q = window.artcam.displayQuad;
      out.push({ t: performance.now(), i, q: q && q.map((p) => [p[0], p[1]]), s: window.artcam.ar.state });
      if (i >= 152 || ++n > 2000) return res(out);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  })`);
  const fps = await p.evaluate(() => window.artcam.tracker.stats.fps);
  const syncInfo = await p.evaluate(() => ({ on: window.artcam.sync.active, delay: Math.round(window.artcam.sync.delay), latency: Math.round(window.artcam.sync.latency), period: Math.round(window.artcam.sync.period) }));
  await close();

  fs.writeFileSync(path.join(DIR, 'smooth-rec.json'), JSON.stringify(rec));
  const rows = rec.filter((r) => r.q && REF[r.i + 1]);
  const err = (r) => r.q.reduce((s, pt, k) => s + Math.hypot(pt[0] - REF[r.i + 1][k][0], pt[1] - REF[r.i + 1][k][1]), 0) / 4;
  const e = rows.map(err).sort((a, b) => a - b);
  let slip = 0, ns = 0, jit2 = 0, nj = 0;
  for (let k = 1; k < rows.length; k++) {
    const a = rows[k - 1], b = rows[k];
    const d = b.q.reduce((s, pt, j) => s + Math.hypot(pt[0] - a.q[j][0], pt[1] - a.q[j][1]), 0) / 4;
    if (a.i === b.i) { slip += d; ns++; }
    const ea = a.q.map((pt, j) => [pt[0] - REF[a.i + 1][j][0], pt[1] - REF[a.i + 1][j][1]]);
    const eb = b.q.map((pt, j) => [pt[0] - REF[b.i + 1][j][0], pt[1] - REF[b.i + 1][j][1]]);
    jit2 += eb.reduce((s, v, j) => s + (v[0] - ea[j][0]) ** 2 + (v[1] - ea[j][1]) ** 2, 0) / 4; nj++;
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
