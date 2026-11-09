// Трекинг по малоконтрастной нежёсткой поверхности — ладони (tests/.data/palm — локальное видео, не коммитится;
// подготовка: положить ролик в tests/.data/palm/training.mov и `python3 tests/make_video.py palm`).
// У ладони нет углов и ровных краёв: четыре точки ставятся «как нажали» и ведутся потоком, затем трекинг холста
// держится по плотному выравниванию (ECC). Истины по кадрам нет, поэтому качество меряется фотометрически:
// рамка, «развёрнутая» в заплатку 64×64, сравнивается с заплаткой первого кадра (tests/palm-metric.py).
// Подробности — раскадровка: tests/palm-story (см. README).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, DATA } = require('./common.cjs');
const { runVideo } = require('./video-run.cjs');

const DIR = path.join(DATA, 'palm');
if (!fs.existsSync(path.join(DIR, 'f001.png'))) {
  console.log('– нет tests/.data/palm (ролик с ладонью + `python3 tests/make_video.py palm`), пропуск');
  process.exit(0);
}
const N = fs.readdirSync(DIR).filter((f) => /^f\d+\.png$/.test(f)).length;

// область на центре ладони (кадр 360×480); четыре касания подряд
const CENTER = [[95, 295], [165, 255], [190, 315], [135, 372]];
const SCENARIOS = [
  { name: 'центр ладони, 25–30 к/с', taps: CENTER, step: 1, minMedian: 0.8, maxLost: 4 },
  { name: 'центр ладони, 15 к/с', taps: CENTER, step: 2, minMedian: 0.75, maxLost: 8 },
  { name: 'центр ладони, 10 к/с (слабый телефон)', taps: CENTER, step: 3, minMedian: 0.7, maxLost: 10 },
];

(async () => {
  let port = 8920;
  for (const sc of SCENARIOS) {
    const taps = sc.taps.map((p, i) => ({ f: 1 + i * 3, p }));
    const r = await runVideo({ taps, step: sc.step, n: N, port: port++, dir: '/t/.data/palm' });
    if (r.error) { check(false, `${sc.name}: ${r.error}`); continue; }
    const run = path.join(DIR, 'run.json');
    fs.writeFileSync(run, JSON.stringify({ taps, rows: r.rows }));
    const m = JSON.parse(execFileSync('python3', [path.join(__dirname, 'palm-metric.py'), run, DIR, '--json']).toString());
    const lock = r.rows.find((x) => x.locked);
    const tr = r.rows.filter((x) => x.state);
    const lost = tr.filter((x) => x.state !== 'tracking').length;
    const ms = Math.round(tr.reduce((s, x) => s + (x.ms || 0), 0) / Math.max(1, tr.length));
    check(!!lock, `${sc.name}: после 4-го касания трекинг стартовал сам (кадр ${lock && lock.t}, точек потока ${lock && lock.locked.points})`);
    check(lost <= sc.maxLost, `${sc.name}: потеряно кадров ${lost} из ${tr.length} (допуск ${sc.maxLost})`);
    check(m.median >= sc.minMedian, `${sc.name}: рамка сидит на той же коже (ZNCC с первой заплаткой: мед. ${m.median.toFixed(2)}, мин. ${m.min.toFixed(2)}; допуск мед. ≥ ${sc.minMedian}; ${ms} мс/кадр)`);
    check(r.errors.length === 0, `${sc.name}: без ошибок в консоли`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
