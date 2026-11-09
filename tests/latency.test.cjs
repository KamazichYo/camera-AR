// Сквозной замер совпадения референса с холстом НА ЭКРАНЕ (с учётом задержки трекинга).
// Фейковая камера проигрывает сцену main (20 к/с); номер показанного кадра читается
// из штрих-кода, показанная рамка сравнивается с истинным положением листа в этом кадре.
const fs = require('fs');
const path = require('path');
const { launch, check, DATA } = require('./common.cjs');

const gt = JSON.parse(fs.readFileSync(path.join(DATA, 'main', 'gt.json'), 'utf8'));

async function measure(p, predict, ms) {
  await p.evaluate((v) => { window.artcam.DEBUG.predict = v; }, predict);
  return p.evaluate(async ({ ms, gt }) => {
    const v = document.querySelector('#video');
    const c = document.createElement('canvas'); c.width = 80; c.height = 10;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const out = [];
    const t0 = performance.now();
    await new Promise((done) => {
      const step = () => {
        if (performance.now() - t0 > ms) return done();
        ctx.drawImage(v, 0, 350, 80, 10, 0, 0, 80, 10);
        const d = ctx.getImageData(0, 0, 80, 10).data;
        let idx = 0;
        for (let i = 0; i < 10; i++) if (d[(5 * 80 + 8 * i + 4) * 4] > 128) idx |= 1 << i;
        const a = window.artcam.ar;
        const q = window.artcam.displayQuad;
        if (q && idx < gt.length && a.state === 'tracking') {
          const g = gt[idx].q;
          const e = q.reduce((s, p, i) => s + Math.hypot(p[0] - g[i][0], p[1] - g[i][1]), 0) / 4;
          out.push({ idx, e });
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    return out;
  }, { ms, gt });
}

function stats(rows, a, z) {
  const e = rows.filter((r) => r.idx >= a && r.idx < z).map((r) => r.e).sort((x, y) => x - y);
  return { n: e.length, med: e[e.length >> 1], p90: e[Math.floor(e.length * 0.9)] };
}

(async () => {
  const { page: p, errors, close, url } = await launch({ port: 8793, camera: true, viewport: { width: 640, height: 360 } });
  await p.goto(`${url}/app/index.html`);
  await p.waitForTimeout(1500);
  if (!(await p.evaluate(() => document.body.classList.contains('running')))) await p.click('#btn-start');
  await p.waitForFunction(() => document.querySelector('#video').videoWidth > 0);
  await p.setInputFiles('#file', path.join(DATA, 'ref.png'));
  await p.waitForFunction(() => window.artcam.ref.loaded);
  await p.evaluate(() => window.artcam.arBegin());
  await p.waitForFunction(() => window.artcam.ar.mode === 'select', null, { timeout: 60000 });
  // захват в неподвижной фазе сцены (кадры 5–30): рамка = истинное положение листа
  await p.waitForFunction((g) => {
    const v = document.querySelector('#video');
    const c = document.createElement('canvas'); c.width = 80; c.height = 10;
    const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 350, 80, 10, 0, 0, 80, 10);
    const d = ctx.getImageData(0, 0, 80, 10).data;
    let idx = 0;
    for (let i = 0; i < 10; i++) if (d[(5 * 80 + 8 * i + 4) * 4] > 128) idx |= 1 << i;
    if (idx < 5 || idx > 25) return false;
    window.artcam.ar.selectQuad = g[idx].q;
    return true;
  }, gt, { timeout: 30000, polling: 20 });
  await p.evaluate(() => window.artcam.arStart());
  await p.waitForFunction(() => window.artcam.ar.mode === 'tracking');
  // референс ровно по холсту — его рамка на экране и есть измеряемая величина
  await p.evaluate(() => { const a = window.artcam.ar; a.refOverlay = a.refCanvas.map((q) => [...q]); });

  const res = {};
  for (const predict of [false, true]) {
    const rows = await measure(p, predict, 13000);
    res[predict] = { still: stats(rows, 1, 40), move: stats(rows, 45, 120), all: stats(rows, 1, 170) };
  }
  const fps = await p.evaluate(() => window.artcam.tracker.stats);
  const usedBitmap = await p.evaluate(() => window.artcam.tracker.useBitmap);
  await close();
  const f = (s) => `мед. ${s.med?.toFixed(2)} px, 90% ${s.p90?.toFixed(2)} px (n=${s.n})`;
  console.log(`трекинг ${fps.fps} к/с, ${fps.ms} мс/кадр; кадры в воркер через ImageBitmap: ${usedBitmap}`);
  console.log(`  без прогноза: покой ${f(res.false.still)}; движение ${f(res.false.move)}`);
  console.log(`  с прогнозом:  покой ${f(res.true.still)}; движение ${f(res.true.move)}`);
  check(res.true.still.med < 1.5, 'в покое референс совпадает с холстом (< 1.5 px)');
  check(res.true.move.med <= res.false.move.med, 'прогноз уменьшает отставание при движении');
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors) : ''));
})().catch((e) => { console.error(e); process.exit(1); });
