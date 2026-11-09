// Выбор холста касаниями: касания с ошибкой «пальца» притягиваются к настоящим углам,
// порядок касаний случайный, итоговый четырёхугольник строится сам.
const fs = require('fs');
const path = require('path');
const { launch, check, DATA } = require('./common.cjs');

// детерминированный «палец»: смещения до ~35 px относительно угла (в пикселях исходного кадра, масштаб 640)
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

const cases = [];
for (const scene of ['main', 'blank', 'light']) {
  const gt = JSON.parse(fs.readFileSync(path.join(DATA, scene, 'gt.json'), 'utf8'))[0].q;
  cases.push({ w: 640, h: 360, name: `сцена ${scene}`, url: `/t/.data/${scene}/frames/f000.png`, gt, jitter: 26, tol: 1.6, qtol: 1.2 });
}
const vfile = path.join(DATA, 'real', 'variants.json');
if (fs.existsSync(vfile)) {
  const v = JSON.parse(fs.readFileSync(vfile, 'utf8'));
  for (const [n, c] of Object.entries(v).filter(([k, c]) => !k.startsWith('_') && c.paint)) {
    // У холста на фото два допустимых контура: граница живописи (paint) и холст с полями (gt).
    // Угол засчитывается, если он — настоящий угол любого из них. Допуск — в пикселях исходного фото.
    cases.push({ w: c.w, h: c.h, name: `фото ${n}`, url: `/t/.data/real/${c.file}`, gt: c.paint, alt: c.gt, jitter: 32, tol: 60, qtol: 22, real: true });
  }
}

(async () => {
  const { page, errors, close, url } = await launch({ port: 8805 });
  let seed = 1;
  for (const c of cases) {
    for (let trial = 0; trial < 3; trial++) {
      const r = rng(seed++);
      // случайный порядок углов и случайные смещения касаний
      const order = [0, 1, 2, 3].sort(() => r() - 0.5);
      const taps = order.map((i) => {
        const a = r() * 2 * Math.PI, d = c.jitter * (0.35 + 0.65 * r());
        return [c.gt[i][0] + Math.cos(a) * d, c.gt[i][1] + Math.sin(a) * d];
      }).map(([x, y]) => [Math.min(c.w - 2, Math.max(2, x)), Math.min(c.h - 2, Math.max(2, y))]); // касание — внутри кадра
      await page.goto(`${url}/t/snap-harness.html?img=${c.url}&taps=${encodeURIComponent(JSON.stringify(taps))}`);
      await page.waitForFunction(() => window.result, null, { timeout: 120000 });
      const res = await page.evaluate(() => window.result);
      const label = `${c.name} #${trial + 1}`;
      if (res.error) { check(false, `${label}: ${res.error}`); continue; }
      // положение каждого угла в момент касания (дальше он ведётся по кадрам)
      const dErr = (p, i) => Math.min(Math.hypot(p[0] - c.gt[i][0], p[1] - c.gt[i][1]), c.alt ? Math.hypot(p[0] - c.alt[i][0], p[1] - c.alt[i][1]) : Infinity);
      const errs = res.snaps.map((s, k) => dErr(s.p, order[k]));
      const worst = Math.max(...errs);
      check(worst <= c.tol,
        `${label}: углы притянуты (худшая ошибка ${worst.toFixed(1)} px при смещении касаний ≤ ${c.jitter} px; ${Math.round(res.ms)} мс на касание)`);
      if (worst > c.tol && process.env.VERBOSE) taps.forEach((t, k) => console.log('     касание', t.map(Math.round), '→ цель', c.gt[order[k]].map(Math.round), '→ притянут', res.snaps[k].p.map(Math.round)));
      if (!res.quad) { check(false, `${label}: четырёхугольник не построен`); continue; }
      // порядок вершин итога может начинаться с любого — берём лучший циклический сдвиг
      const qe = Math.min(...[0, 1, 2, 3].map((sft) => res.quad.reduce((acc, p, i) => acc + dErr(p, (i + sft) % 4), 0) / 4));
      check(qe <= c.qtol, `${label}: итоговая рамка, с которой стартует AR (ошибка ${qe.toFixed(1)} px)`);
    }
  }
  // касание там, где углов нет (середина холста) — не должно «примагничиваться» к чему попало
  const gt = JSON.parse(fs.readFileSync(path.join(DATA, 'main', 'gt.json'), 'utf8'))[0].q;
  const mid = [(gt[0][0] + gt[2][0]) / 2, (gt[0][1] + gt[2][1]) / 2];
  await page.goto(`${url}/t/snap-harness.html?img=/t/.data/main/frames/f000.png&taps=${encodeURIComponent(JSON.stringify([mid]))}`);
  await page.waitForFunction(() => window.result, null, { timeout: 60000 });
  const res = await page.evaluate(() => window.result);
  check(!res.error && !res.snaps[0].snapped, 'касание вдали от углов: ничего не притянуто, точка остаётся где нажали');
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors.slice(0, 3)) : ''));
  await close();
})().catch((e) => { console.error(e); process.exit(1); });
