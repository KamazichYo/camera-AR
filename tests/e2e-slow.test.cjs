// Слабый телефон: снимок кадра для «плавного показа» (createImageBitmap) искусственно тормозится. Приложение должно
// само уменьшать кадр показа, а если и это не помогает — вернуться к обычному видео, не теряя трекинга.
// Дополнительно: замер скорости при загрузке выбирает размер кадра анализа (чем слабее устройство, тем меньше).
const fs = require('fs');
const path = require('path');
const { launch, check, DATA, frameIndex } = require('./common.cjs');

const DIR = path.join(DATA, 'video');
if (!fs.existsSync(path.join(DIR, 'training.y4m')) || !fs.existsSync(path.join(DIR, 'ref.json'))) {
  console.log('– нет tests/.data/video/training.y4m или ref.json, пропуск');
  process.exit(0);
}
const REF = JSON.parse(fs.readFileSync(path.join(DIR, 'ref.json'), 'utf8'));
const IDX_SRC = `(() => { const w = document.querySelector('#view'); const v = (w && getComputedStyle(w).visibility === 'visible') ? w : document.querySelector('#video'); const c = window.__c || (window.__c = Object.assign(document.createElement('canvas'), { width: 80, height: 10 }));
  const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(v, 0, 350, 80, 10, 0, 0, 80, 10); const d = x.getImageData(0, 0, 80, 10).data;
  let i = 0; for (let b = 0; b < 10; b++) if (d[(5 * 80 + 8 * b + 4) * 4] > 128) i |= 1 << b; return i; })()`;

(async () => {
  const { page: p, errors, close, url } = await launch({ port: 8872, camera: true, viewport: { width: 800, height: 600 }, video: path.join(DIR, 'training.y4m') });
  await p.goto(`${url}/app/index.html`);
  await p.waitForTimeout(1500);
  if (!(await p.evaluate(() => document.body.classList.contains('running')))) await p.click('#btn-start');
  await p.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  await p.setInputFiles('#file', path.join(DATA, 'ref.png'));
  await p.waitForFunction(() => window.artcam.ref.loaded);

  // выбор размера кадра анализа по замеру
  const pick = await p.evaluate(async () => {
    const m = await import('/app/js/tracker.js');
    return { p20: m.pickProcMax(20), p40: m.pickProcMax(40), p60: m.pickProcMax(60), p400: m.pickProcMax(400), none: m.pickProcMax(0) };
  });
  check(pick.p20 === 640 && pick.p40 < 640 && pick.p60 <= pick.p40 && pick.p400 === 320 && pick.none === 640, `размер кадра анализа по замеру: 20 мс → ${pick.p20}, 40 мс → ${pick.p40}, 60 мс → ${pick.p60}, 400 мс → ${pick.p400}`);

  await p.waitForFunction(`(() => { const i = ${IDX_SRC}; return i >= 1 && i <= 6; })()`, null, { polling: 15, timeout: 30000 });
  await p.click('#btn-ar');
  await p.waitForFunction(() => window.artcam.ar.mode === 'select', null, { timeout: 60000 });
  const bench = await p.evaluate(() => ({ b: window.artcam.tracker.benchMs, pm: window.artcam.tracker.procMax }));
  check(bench.b > 0 && bench.pm >= 320 && bench.pm <= 640, `замер скорости при загрузке: ${bench.b} мс → кадр анализа ${bench.pm}px`);
  // тормозим снимки кадров ПОСЛЕ выбора размера: каждый createImageBitmap(video) занимает +70 мс
  await p.evaluate(() => {
    const orig = window.createImageBitmap.bind(window);
    window.createImageBitmap = async (src, ...rest) => {
      if (src instanceof HTMLVideoElement && rest.length && window.__slow !== false) await new Promise((r) => setTimeout(r, 70));
      return orig(src, ...rest);
    };
  });
  const order = [2, 0, 3, 1], jit = [[9, -7], [-8, 6], [7, 9], [-6, -8]];
  for (let k = 0; k < 4; k++) {
    await p.waitForFunction(`(() => { const i = ${IDX_SRC}; return i >= ${8 + 10 * k} && i <= 140; })()`, null, { polling: 10, timeout: 30000 });
    const q = REF[(await frameIndex(p)) + 1];
    const [sx, sy] = await p.evaluate((pt) => window.artcam.stage.toScreen(pt), [q[order[k]][0] + jit[k][0], q[order[k]][1] + jit[k][1]]);
    await p.mouse.click(sx, sy);
    if (k < 3) await p.waitForFunction((n) => window.artcam.ar.corners.length === n && !window.artcam.ar.pendingTap, k + 1, { timeout: 15000 });
  }
  await p.waitForFunction(() => window.artcam.ar.mode === 'tracking', null, { timeout: 15000 });
  const started = await p.evaluate(() => ({ active: window.artcam.sync.active, level: window.artcam.sync.level }));
  check(started.active, 'плавный показ включился вместе с AR');

  // пока снимки тормозят: сначала уменьшается кадр показа, потом показ выключается
  await p.waitForFunction(() => window.artcam.sync.level > 0 || !window.artcam.sync.active, null, { timeout: 60000 });
  const lvl = await p.evaluate(() => ({ level: window.artcam.sync.level, w: window.artcam.sync.bw, active: window.artcam.sync.active }));
  check(lvl.level > 0 || !lvl.active, `кадр показа уменьшился (ступень ${lvl.level}, ширина ${lvl.w}px)`);
  await p.waitForFunction(() => !window.artcam.sync.active, null, { timeout: 120000 });
  check(await p.evaluate(() => !document.body.classList.contains('synced')), 'показ выключен, снова обычное видео');
  const st = await p.evaluate(() => new Promise((res) => setTimeout(() => res({ state: window.artcam.ar.state, mode: window.artcam.ar.mode, q: window.artcam.displayQuad }), 800)));
  check(st.mode === 'tracking' && st.q && st.q.every((pt) => Number.isFinite(pt[0]) && Number.isFinite(pt[1])), 'AR продолжает работать на обычном видео (рамка рисуется)');
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors.slice(0, 3)) : ''));
  await close();
})().catch((e) => { console.error(e); process.exit(1); });
