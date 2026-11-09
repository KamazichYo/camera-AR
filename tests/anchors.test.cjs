// Точки опоры: у пустого листа своих признаков нет, поэтому без окружения рамка уезжает, когда рука закрывает грани.
// Пользователь отмечает неподвижные предметы рядом (лента, провод, ткань) — их точки входят в общую гомографию.
// Автоокружение здесь выключено (noAuto), чтобы проверить именно ручные опоры. Видео — локальное (tests/.data/sketch).
const path = require('path');
const fs = require('fs');
const { check, DATA } = require('./common.cjs');
const { runVideo } = require('./video-run.cjs');

const DIR = path.join(DATA, 'sketch');
if (!fs.existsSync(path.join(DIR, 'f001.png')) || !fs.existsSync(path.join(DIR, 'ref.json'))) {
  console.log('– нет tests/.data/sketch, пропуск');
  process.exit(0);
}
const ref = JSON.parse(fs.readFileSync(path.join(DIR, 'ref.json'), 'utf8'));
const quadErr = (q, g) => q.reduce((s, p, i) => s + Math.hypot(p[0] - g[i][0], p[1] - g[i][1]), 0) / 4;
const N = 300; // до того, как камера уходит от опор

async function run(anchors, port) {
  const pts = [[95, 144], [240, 152], [240, 374], [98, 382]];
  const taps = pts.map((p, i) => ({ f: 2 + i * 2, p }));
  const r = await runVideo({ taps, step: 1, n: N, port, dir: '/t/.data/sketch', noAuto: true, anchors });
  if (r.error) throw new Error(r.error);
  const tr = r.rows.filter((x) => x.state);
  const errs = tr.filter((x) => x.quad && ref[x.t]).map((x) => quadErr(x.quad, ref[x.t])).sort((a, b) => a - b);
  return {
    lost: tr.filter((x) => x.state !== 'tracking').length,
    mean: errs.reduce((s, v) => s + v, 0) / errs.length,
    max: errs[errs.length - 1],
    kept: r.rows.filter((x) => x.anchors).length,
    errors: r.errors,
    ms: Math.round(tr.reduce((s, x) => s + (x.ms || 0), 0) / tr.length),
  };
}

(async () => {
  const anchors = [[65, 268], [235, 415], [40, 120], [290, 420], [160, 430]].map((p) => ({ f: 12, p }));
  const a = await run(null, 8970);
  const b = await run(anchors, 8971);
  console.log(`  без опор: ошибка в среднем ${a.mean.toFixed(1)} px, макс. ${a.max.toFixed(1)} px, потеряно ${a.lost}`);
  console.log(`  5 опор:   ошибка в среднем ${b.mean.toFixed(1)} px, макс. ${b.max.toFixed(1)} px, потеряно ${b.lost}, ${b.ms} мс/кадр`);
  check(b.kept > 100, 'опоры живут весь отрезок и отдаются приложению для показа');
  check(b.mean < a.mean * 0.85, 'с опорами рамка в среднем точнее, чем без них (листание и рука на гранях)');
  check(b.max <= a.max + 2 && b.lost === 0, 'с опорами худший кадр не хуже, чем без них, потерь нет');
  check(a.errors.length === 0 && b.errors.length === 0, 'без ошибок в консоли');
})().catch((e) => { console.error(e); process.exit(1); });
