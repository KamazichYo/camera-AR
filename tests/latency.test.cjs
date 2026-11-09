// Сквозной замер совпадения референса с холстом НА ЭКРАНЕ (с учётом задержки трекинга).
// Фейковая камера проигрывает сцену main (20 к/с); номер показанного кадра читается
// из штрих-кода, показанная рамка сравнивается с истинным положением листа в этом кадре.
const fs = require('fs');
const path = require('path');
const { launch, check, DATA, frameIndex, waitFrame } = require('./common.cjs');

const gt = JSON.parse(fs.readFileSync(path.join(DATA, 'main', 'gt.json'), 'utf8'));

async function measure(p, mode, ms) {
  // 'sync' — синхронный показ (по умолчанию); 'kalman' — запасной режим: Калман + экстраполяция на момент показанного кадра
  await p.evaluate((m) => {
    const a = window.artcam;
    if (m === 'kalman') { a.sync.stop(); document.body.classList.remove('synced'); a.resetSmoothing(); }
  }, mode);
  return p.evaluate(async ({ ms, gt }) => {
    const w = document.querySelector('#view');
    const v = w && getComputedStyle(w).visibility === 'visible' ? w : document.querySelector('#video'); // что видит пользователь
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
  await waitFrame(p, 1, 8); // выбор углов начинаем в неподвижной фазе сцены (кадры 0–40)
  await p.evaluate(() => window.artcam.arBegin());
  await p.waitForFunction(() => window.artcam.ar.mode === 'select', null, { timeout: 60000 });
  // касаемся 4 углов листа на живом видео (точно в углы) — AR включается сам
  for (let n = 0; n < 4; n++) {
    const q = gt[await frameIndex(p)].q;
    const [sx, sy] = await p.evaluate((pt) => window.artcam.stage.toScreen(pt), q[[0, 1, 2, 3][n]]);
    await p.mouse.click(sx, sy);
    if (n < 3) await p.waitForFunction((k) => window.artcam.ar.corners.length === k && !window.artcam.ar.pendingTap, n + 1, { timeout: 15000 });
  }
  await p.waitForFunction(() => window.artcam.ar.mode === 'tracking', null, { timeout: 15000 });
  // референс ровно по холсту — его рамка на экране и есть измеряемая величина
  await p.evaluate(() => { const a = window.artcam.ar; a.refOverlay = a.refCanvas.map((q) => [...q]); window.artcam.resetSmoothing(); });

  const res = {};
  for (const mode of (process.env.MODES || 'sync,kalman').split(',')) {
    const rows = await measure(p, mode, 13000);
    res[mode] = { still: stats(rows, 1, 40), move: stats(rows, 45, 120) };
  }
  const fps = await p.evaluate(() => window.artcam.tracker.stats);
  const usedBitmap = await p.evaluate(() => window.artcam.tracker.useBitmap);
  await close();
  const f = (s) => `мед. ${s.med?.toFixed(2)} px, 90% ${s.p90?.toFixed(2)} px (n=${s.n})`;
  console.log(`трекинг ${fps.fps} к/с, ${fps.ms} мс/кадр; кадры в воркер через ImageBitmap: ${usedBitmap}`);
  console.log(`  синхронный показ:        покой ${f(res.sync.still)}; движение ${f(res.sync.move)}`);
  console.log(`  запасной режим (Калман): покой ${f(res.kalman.still)}; движение ${f(res.kalman.move)}`);
  check(res.sync.still.med < 1.0, 'в покое референс совпадает с холстом (< 1 px)');
  check(res.sync.move.med < 1.0, 'при движении референс совпадает с холстом на экране (< 1 px)');
  check(res.sync.move.med <= res.kalman.move.med, 'синхронный показ точнее запасного режима при движении');
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors) : ''));
})().catch((e) => { console.error(e); process.exit(1); });
