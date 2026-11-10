// Карта на столе: камера ходит вокруг (повороты, наклон, приближение, смаз) — рамка должна сидеть на краях карты.
// Данные — локально (tests/.data/card, кадры 360×480 из видео пользователя; в репозиторий не кладутся):
//   положить ролик в tests/.data/card/training.mov, затем `python3 tests/make_video.py card && python3 tests/gt_card.py`.
// Эталон gt.json независим от трекера: контур светлой карты на тёмном столе, стороны — прямые по градиенту.
// Главное здесь — прогоны с пропуском кадров: так выглядит видео для трекера на медленном телефоне (или после
// заминки). Между обработанными кадрами картинка уезжает на 30–100 px со смазом; раньше поток по точкам до такого
// сдвига не дотягивался, рамка садилась на ложное место и оставалась там.
const path = require('path');
const fs = require('fs');
const { check, DATA } = require('./common.cjs');
const { runVideo } = require('./video-run.cjs');

const DIR = path.join(DATA, 'card');
const gtFile = path.join(DIR, 'gt.json');
if (!fs.existsSync(path.join(DIR, 'f001.png')) || !fs.existsSync(gtFile)) {
  console.log('– нет tests/.data/card (кадры + gt.json), пропуск');
  process.exit(0);
}
const gt = JSON.parse(fs.readFileSync(gtFile, 'utf8'));
const N = Object.keys(gt).length;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// [шаг по кадрам, название, допуск медианы px, допуск максимума px]
const RUNS = [
  [1, 'каждый кадр (30 к/с)', 2.5, 7],
  [3, 'каждый 3-й кадр (10 к/с)', 2.5, 7],
  [5, 'каждый 5-й кадр (6 к/с)', 2.5, 8],
  [8, 'каждый 8-й кадр (≈ 4 к/с)', 3, 8],
];

(async () => {
  let port = 9040;
  for (const [step, name, medTol, maxTol] of RUNS) {
    const taps = [0, 1, 2, 3].map((i) => ({ f: 1 + i * step, p: gt[String(1 + i * step)][i] }));
    const r = await runVideo({ taps, step, n: N, port: port++, dir: '/t/.data/card' });
    if (r.error) { check(false, `карта, ${name}: ${r.error}`); continue; }
    const tr = r.rows.filter((x) => x.state);
    const lost = tr.filter((x) => x.state !== 'tracking' || !x.quad).length;
    const errs = [], jit = [];
    let prev = null;
    for (const x of tr) {
      const g = gt[String(x.t)];
      if (!x.quad || !g) { prev = null; continue; }
      const ev = x.quad.map((p, i) => [p[0] - g[i][0], p[1] - g[i][1]]);
      errs.push(Math.max(...ev.map((v) => Math.hypot(v[0], v[1]))));
      if (prev) jit.push(Math.max(...ev.map((v, i) => Math.hypot(v[0] - prev[i][0], v[1] - prev[i][1]))));
      prev = ev;
    }
    const ms = Math.round(tr.reduce((s, x) => s + (x.ms || 0), 0) / Math.max(1, tr.length));
    const med = q(errs, 0.5), max = Math.max(...errs);
    check(lost === 0, `карта, ${name}: ${tr.length} кадров, потеряно ${lost}`);
    check(med <= medTol && max <= maxTol, `карта, ${name}: ошибка худшего угла мед. ${med.toFixed(2)} px, 90% ${q(errs, 0.9).toFixed(2)} px, макс. ${max.toFixed(2)} px (допуск ${medTol}/${maxTol}); ` +
      `дрожь мед. ${q(jit, 0.5).toFixed(2)} px; ${ms} мс/кадр`);
    check(r.errors.length === 0, `карта, ${name}: без ошибок в консоли`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
