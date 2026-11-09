// Общий прогон видео через воркер: node tests/video-run.cjs  (используется тестом и для раскадровки)
const fs = require('fs');
const path = require('path');
const { launch, DATA } = require('./common.cjs');

/** Приблизительная «истина»: контур холста по кадрам (авто-поиск на опорных кадрах + интерполяция). */
function loadGT() {
  const f = path.join(DATA, 'video', 'gt.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
const lerpQuad = (a, b, k) => a.map((p, i) => [p[0] + (b[i][0] - p[0]) * k, p[1] + (b[i][1] - p[1]) * k]);
function gtAt(gt, t) {
  const keys = Object.keys(gt).map(Number).sort((x, y) => x - y);
  let lo = keys[0], hi = keys[keys.length - 1];
  for (const k of keys) { if (k <= t) lo = k; if (k >= t) { hi = k; break; } }
  if (lo === hi) return gt[lo];
  return lerpQuad(gt[lo], gt[hi], (t - lo) / (hi - lo));
}

/** Проверенная глазами «истина»: рамка, поставленная на первых кадрах и ведомая до конца (по кадрам). */
function loadRef() {
  const f = path.join(DATA, 'video', 'ref.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

async function runVideo({ taps, step = 1, n = 161, port = 8830, dir }) {
  const { page, errors, close, url } = await launch({ port });
  const q = new URLSearchParams({ taps: JSON.stringify(taps), step: String(step), n: String(n) });
  if (dir) q.set('dir', dir);
  await page.goto(`${url}/t/video-harness.html?${q}`);
  await page.waitForFunction(() => window.result, null, { timeout: 600000 });
  const r = await page.evaluate(() => window.result);
  await close();
  return { ...r, errors };
}
module.exports = { runVideo, loadGT, gtAt, loadRef };
