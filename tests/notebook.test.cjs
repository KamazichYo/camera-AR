// Тёмный блокнот на деревянном столе (видео пользователя, tests/.data/clip3 — локально, не коммитится): обложка почти без
// деталей, по ней гуляет блик, у блокнота толстый торец (у каждой стороны два параллельных края), камера ходит вокруг,
// поворачивается на 90°, местами сильный смаз. Подготовка: положить ролик в tests/.data/clip3/training.mov, затем
// `python3 tests/make_video.py clip3 && python3 tests/gt_dark.py clip3`.
// Эталон gt.json — внешний силуэт по тону (обложка серо-синяя, стол оранжевый); на ближних углах он берёт низ торца, а
// не верхнюю грань, поэтому абсолютная ошибка там — до 10–20 px «по определению». Тест — ограждение от регрессий:
// сколько кадров потеряно и насколько держатся дальние углы (там эталон однозначен).
const path = require('path');
const fs = require('fs');
const { check, DATA } = require('./common.cjs');
const { runVideo } = require('./video-run.cjs');

const DIR = path.join(DATA, 'clip3');
const gtFile = path.join(DIR, 'gt.json');
if (!fs.existsSync(path.join(DIR, 'f001.png')) || !fs.existsSync(gtFile)) {
  console.log('– нет tests/.data/clip3 (кадры + gt.json), пропуск');
  process.exit(0);
}
const gt = JSON.parse(fs.readFileSync(gtFile, 'utf8'));
const N = Math.max(...Object.keys(gt).map(Number));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

// [шаг, режим окружения, название, допуск потерянных кадров, допуск медианы дальних углов px]
const RUNS = [
  // (допуски — достигнутый уровень, чтобы ловить ухудшения; до «намертво» этому ролику пока далеко)
  [1, false, 'обычный режим, 30 к/с', 60, 14],
  [1, true, '«учитывать окружение», 30 к/с', 0, 15],
  [3, true, '«учитывать окружение», 10 к/с', 0, 8],
];

(async () => {
  let port = 9060;
  for (const [step, full, name, lostTol, farTol] of RUNS) {
    const taps = [0, 1, 2, 3].map((i) => ({ f: 1 + i * step, p: gt[String(1 + i * step)][i] }));
    const r = await runVideo({ taps, step, n: N, port: port++, dir: '/t/.data/clip3', full });
    if (r.error) { check(false, `блокнот, ${name}: ${r.error}`); continue; }
    const tr = r.rows.filter((x) => x.state);
    const lost = tr.filter((x) => x.state !== 'tracking' || !x.quad).length;
    const far = [], all = [], jit = [];
    let prev = null;
    for (const x of tr) {
      const g = gt[String(x.t)];
      if (!x.quad || !g) { prev = null; continue; }
      const ev = x.quad.map((p, i) => [p[0] - g[i][0], p[1] - g[i][1]]);
      far.push(Math.max(Math.hypot(...ev[0]), Math.hypot(...ev[1])));
      all.push(Math.max(...ev.map((v) => Math.hypot(v[0], v[1]))));
      if (prev) jit.push(Math.max(...ev.map((v, i) => Math.hypot(v[0] - prev[i][0], v[1] - prev[i][1]))));
      prev = ev;
    }
    check(lost <= lostTol, `блокнот, ${name}: ${tr.length} кадров, потеряно ${lost} (допуск ${lostTol})`);
    check(q(far, 0.5) <= farTol, `блокнот, ${name}: дальние углы мед. ${q(far, 0.5).toFixed(1)} px (допуск ${farTol}); все углы мед. ${q(all, 0.5).toFixed(1)} px, 90% ${q(all, 0.9).toFixed(1)} px; дрожь мед. ${q(jit, 0.5).toFixed(2)} px`);
    check(r.errors.length === 0, `блокнот, ${name}: без ошибок в консоли`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
