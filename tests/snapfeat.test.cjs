// Привязка касания: сначала пересечение прямых (угол холста), а если рядом его нет — самый контрастный признак
// (край тёмного пятна, угол мазка), на гладком месте точка остаётся где нажали. Кадр — картина маслом из видео пользователя
// (tests/.data/art, локально). Проверки не требуют «истины по пикселям»: тот же кадр оценивается независимо — локальным
// контрастом (СКО яркости в окне 9×9) в точке привязки и в точке касания.
const fs = require('fs');
const path = require('path');
const { launch, check, DATA } = require('./common.cjs');

const DIR = path.join(DATA, 'art');
if (!fs.existsSync(path.join(DIR, 'f001.png'))) {
  console.log('– нет tests/.data/art (кадры + ref.json), пропуск');
  process.exit(0);
}
// углы холста на кадре 1 (проверены глазами по увеличенному кадру): левый верхний и правый нижний
const CORNERS = [[102, 71], [351, 239]];
const W = 480, H = 360, R = 0.04 * W; // радиус привязки к признаку (в воркере — доля большей стороны кадра)

// касания рядом с контрастными деталями (тёмные камни и мазки справа) / на гладком белом холсте / у угла холста
const DETAIL = [[150, 110], [240, 200], [290, 160], [270, 200], [300, 200], [310, 215], [130, 160], [245, 160], [275, 215]];
const FLAT = [[230, 215], [225, 190], [255, 100], [140, 230]];

(async () => {
  const { page, errors, close, url } = await launch({ port: 8997 });
  const run = async (taps) => {
    await page.goto(`${url}/t/snapfeat-harness.html?f=1&taps=${encodeURIComponent(JSON.stringify(taps))}`);
    await page.waitForFunction(() => window.result, null, { timeout: 120000 });
    const r = await page.evaluate(() => window.result);
    if (r.error) throw new Error(r.error);
    return r.out;
  };
  const det = await run(DETAIL), flat = await run(FLAT), corner = await run([[CORNERS[0][0] - 7, CORNERS[0][1] + 6], [CORNERS[1][0] + 8, CORNERS[1][1] - 7]]);
  // локальный контраст по тому же кадру
  const sd = await page.evaluate(async ([u, pts]) => {
    const img = new Image(); img.src = u; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
    const g = x.getImageData(0, 0, c.width, c.height).data;
    return pts.map(([px, py]) => {
      const v = []; for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const i = ((Math.round(py) + dy) * c.width + Math.round(px) + dx) * 4; v.push(0.299 * g[i] + 0.587 * g[i + 1] + 0.114 * g[i + 2]); }
      const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    });
  }, [`${url}/t/.data/art/f001.png`, det.flatMap((o) => [o.tap, o.p])]);

  const nSnap = det.filter((o) => o.snapped || o.feature).length;
  check(nSnap >= det.length - 1, `у контрастных деталей точка привязалась почти всегда (${nSnap} из ${det.length})`);
  const far = det.filter((o) => (o.snapped || o.feature) && Math.hypot(o.p[0] - o.tap[0], o.p[1] - o.tap[1]) > (o.feature ? R + 1 : 0.05 * W + 6));
  check(far.length === 0, `привязка не уходит дальше радиуса поиска (уехавших: ${far.length})`);
  let better = 0, cnt = 0;
  det.forEach((o, i) => { if (o.feature) { cnt++; if (sd[2 * i + 1] >= sd[2 * i] * 0.95 && sd[2 * i + 1] > 12) better++; } });
  check(cnt > 0 && better === cnt, `привязка к признаку попадает в место не менее контрастное, чем касание (${better} из ${cnt}, СКО ≥ 12)`);
  check(flat.every((o) => !o.snapped && !o.feature && o.p[0] === o.tap[0] && o.p[1] === o.tap[1]), 'на гладком белом холсте точка остаётся там, где нажали');
  const e = corner.map((o, i) => Math.hypot(o.p[0] - CORNERS[i][0], o.p[1] - CORNERS[i][1]));
  check(corner.every((o) => o.snapped) && e.every((v) => v < 5), `у угла холста работает пересечение прямых, а не признак (ошибка ${e.map((v) => v.toFixed(1)).join(', ')} px)`);
  check(errors.length === 0, 'без ошибок в консоли');
  await close();
})().catch((e) => { console.error(e); process.exit(1); });
