// Рывки картинки и референса в плавном показе. Пишет на каждой отрисовке, какой видеокадр показан и как меняется задержка D:
// кадры идут по порядку без пропусков и возвратов, D не раздувается, референс не экстраполируется (поза успевает).
// Имитации неровного телефона через окружение: SLOW_MS (трекер медленнее), JIT_MS (разброс времени кадра трекера),
// GRAB_MS (разброс снимка кадра), TS_NOISE (дрожь меток времени кадров, мс), THROTTLE (замедление главного потока).
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
  const { page: p, errors, close, url, context } = await launch({ port: 8873, camera: true, viewport: { width: 800, height: 600 }, video: path.join(DIR, 'training.y4m') });
  const slowMs = +(process.env.SLOW_MS || 0);  // трекер не быстрее одного кадра за SLOW_MS (имитация слабого телефона)
  await p.goto(`${url}/app/index.html`);
  await p.waitForTimeout(1500);
  if (!(await p.evaluate(() => document.body.classList.contains('running')))) await p.click('#btn-start');
  await p.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  await p.evaluate(() => { window.artcam.sync.diag = true; });
  // замедление главного потока (CPU throttling в Chromium), как на слабом телефоне
  const THR = +(process.env.THROTTLE || 0);
  if (THR) { const cdp = await context.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THR }); }
  // дрожь меток времени кадров камеры (как на телефонах): ±TS_NOISE мс, детерминированно по номеру кадра
  const TSN = +(process.env.TS_NOISE || 0);
  if (TSN) await p.evaluate((n) => {
    const orig = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) {
      return orig.call(this, (now, md) => cb(now, { ...md, presentationTime: md.presentationTime + ((((md.presentedFrames * 2654435761) >>> 0) % 1000) / 1000 - 0.5) * 2 * n }));
    };
  }, TSN);
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

  // имитация неровного телефона: время кадра трекера и снимка кадра гуляют случайно
  const JIT = +(process.env.JIT_MS || 0), GRAB = +(process.env.GRAB_MS || 0);
  if (JIT) await p.evaluate((ms) => window.artcam.tracker.worker.postMessage({ type: 'debugJitterMs', ms }), JIT);
  if (GRAB) await p.evaluate((ms) => {
    const orig = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (src, ...rest) => { if (src instanceof HTMLVideoElement) { const b = await orig(src, ...rest); await new Promise((r) => setTimeout(r, Math.random() * ms)); return b; } return orig(src, ...rest); };
  }, GRAB);
  // запись: что показано на каждой отрисовке и как меняется задержка показа
  const rec = await p.evaluate(`new Promise((res) => {
    const out = []; let n = 0;
    const loop = () => {
      const i = ${IDX_SRC};
      out.push({ t: performance.now(), i, d: window.artcam.sync.delay, lvl: window.artcam.sync.level, a: window.artcam.sync.active });
      if (i >= 152 || ++n > 2500) return res(out);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  })`);
  const lat0 = await p.evaluate(() => (window.artcam.sync.latAll || []).slice(0, 40).join(' '));
  console.log('  задержки трекера, первые позы:', lat0);
  const info = await p.evaluate(() => ({ lat: window.artcam.sync.latency, per: window.artcam.sync.period, tgt: window.artcam.sync.target, fps: window.artcam.tracker.stats.fps }));
  const ex = await p.evaluate(() => ({ e: window.artcam.sync.extrap, d: window.artcam.sync.draws }));
  await close();
  fs.writeFileSync(path.join(DIR, 'judder-rec.json'), JSON.stringify(rec));
  const ds = rec.map((r) => r.d);
  const dmin = Math.min(...ds), dmax = Math.max(...ds);
  let dchg = 0; for (let k = 1; k < ds.length; k++) dchg += Math.abs(ds[k] - ds[k - 1]);
  const T = (rec[rec.length - 1].t - rec[0].t) / 1000;
  // смена показанного кадра: шаг по номеру и время на экране
  const ch = [];
  for (let k = 1; k < rec.length; k++) if (rec[k].i !== rec[k - 1].i) ch.push({ di: rec[k].i - rec[k - 1].i, dt: rec[k].t - rec[ch.length ? 0 : 0].t });
  let skips = 0, back = 0, holds = [], lastT = null, lastI = null;
  for (const r of rec) {
    if (lastI === null) { lastI = r.i; lastT = r.t; continue; }
    if (r.i !== lastI) {
      const di = r.i - lastI;
      if (di > 1 && di < 5) skips++;
      if (di < 0 && di > -5) back++;
      if (di > 0 && di < 5) holds.push((r.t - lastT) / di);
      lastI = r.i; lastT = r.t;
    }
  }
  holds.sort((a, b) => a - b);
  const med = holds[holds.length >> 1], p10 = holds[Math.floor(holds.length * 0.1)], p90 = holds[Math.floor(holds.length * 0.9)];
  console.log(`  отрисовок ${rec.length} за ${T.toFixed(1)} с; задержка показа ${dmin.toFixed(0)}…${dmax.toFixed(0)} мс (ср. скорость изменения ${(dchg / T).toFixed(1)} мс/с); цель ${info.tgt.toFixed(0)} (задержка трекера ${info.lat.toFixed(0)}, период ${info.per.toFixed(0)}), трекер ${info.fps} к/с`);
  const irregular = holds.filter((h) => Math.abs(h - 33.3) > 9 && Math.abs(h - 50) > 9 && Math.abs(h - 16.7) > 9).length;
  const odd = holds.filter((h) => h < 25 || h > 42).length; // 1 или 3 отрисовки вместо 2
  const gaps = []; for (let k = 1; k < rec.length; k++) gaps.push(rec[k].t - rec[k - 1].t);
  const long = gaps.filter((g) => g > 25).length, vlong = gaps.filter((g) => g > 40).length;
  console.log(`  провалов отрисовки (интервал > 25 мс): ${long}, (> 40 мс): ${vlong} из ${gaps.length}; макс. ${Math.max(...gaps).toFixed(0)} мс`);
  console.log(`  кадров, показанных 1 или 3 отрисовки вместо 2: ${odd} из ${holds.length}`);
  console.log(`  смен кадра ${holds.length}: пропусков кадров ${skips}, возвратов ${back}; время показа одного видеокадра: 10% ${p10.toFixed(0)} · медиана ${med.toFixed(0)} · 90% ${p90.toFixed(0)} мс`);
  const m = { dmin, dmax, rate: dchg / T, skips, back, p10, med, p90 };
  fs.writeFileSync(path.join(DIR, 'judder-metrics.json'), JSON.stringify(m));
  check(skips === 0 && back === 0, `кадры камеры идут по порядку, без пропусков и возвратов (пропусков ${skips}, возвратов ${back})`);
  check(dmax < 260, `задержка показа не раздувается (макс. ${dmax.toFixed(0)} мс)`);
  check(ex.e / Math.max(1, ex.d) < 0.04, `референс почти не экстраполируется (${ex.e} на ${ex.d} отрисовок; поза успевает к показу)`);
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors.slice(0, 3)) : ''));
})().catch((e) => { console.error(e); process.exit(1); });
