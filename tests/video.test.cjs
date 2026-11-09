// Выбор углов на ЖИВОМ видео: тренировочное видео пользователя (tests/.data/video — локально)
// прогоняется через воркер кадр за кадром, как это делает приложение. Касания — «неточным пальцем»,
// в разном порядке и в разные моменты (камера движется). Сравнение — с проверенным глазами эталоном ref.json.
const path = require('path');
const { check, DATA } = require('./common.cjs');
const { runVideo, loadRef } = require('./video-run.cjs');
const fs = require('fs');

const DIR = path.join(DATA, 'video');
const ref = loadRef();
if (!ref || !fs.existsSync(path.join(DIR, 'f001.png'))) {
  console.log('– нет tests/.data/video (python3 tests/make_video.py && node tests/video-prepare.cjs), пропуск');
  process.exit(0);
}

// [кадр касания, угол (0 TL, 1 TR, 2 BR, 3 BL), смещение «пальца» px]
const SCENARIOS = {
  'базовый (BR, TL, BL, TR)': { plan: [[6, 2, [9, -7]], [26, 0, [-8, 6]], [46, 3, [7, 9]], [66, 1, [-6, -8]]], step: 1 },
  'другой порядок': { plan: [[10, 0, [-10, -8]], [20, 1, [11, 6]], [30, 2, [-9, 9]], [40, 3, [8, -10]]], step: 1 },
  'быстро подряд': { plan: [[20, 3, [6, 6]], [28, 0, [-9, -9]], [36, 2, [10, 5]], [44, 1, [-5, 11]]], step: 1 },
  'палец 16 px': { plan: [[10, 1, [15, -8]], [40, 3, [-12, 12]], [70, 0, [10, 13]], [100, 2, [-14, -9]]], step: 1 },
  '12 к/с (слабый телефон)': { plan: [[6, 2, [9, -7]], [26, 0, [-8, 6]], [46, 3, [7, 9]], [66, 1, [-6, -8]]], step: 2 },
  'поздний старт': { plan: [[70, 1, [7, 8]], [78, 3, [-8, 6]], [88, 0, [9, -7]], [96, 2, [-6, 9]]], step: 1 },
};

const quadErr = (q, g) => q.reduce((s, p, i) => s + Math.hypot(p[0] - g[i][0], p[1] - g[i][1]), 0) / 4;

(async () => {
  let port = 8890;
  for (const [name, { plan, step }] of Object.entries(SCENARIOS)) {
    // касания считаются от эталона на момент касания (а не от грубого контура)
    const taps = plan.map(([f, c, j]) => ({ f, p: [ref[f][c][0] + j[0], ref[f][c][1] + j[1]], corner: c }));
    const r = await runVideo({ taps, step, port: port++ });
    if (r.error) { check(false, `${name}: ${r.error}`); continue; }
    const lock = r.rows.find((x) => x.locked);
    const tr = r.rows.filter((x) => x.state);
    const lost = tr.filter((x) => x.state !== 'tracking').length;
    const errs = tr.filter((x) => x.quad && ref[x.t]).map((x) => quadErr(x.quad, ref[x.t])).sort((a, b) => a - b);
    const lockErr = lock ? quadErr(lock.locked.quad, ref[lock.t]) : Infinity;
    const med = errs[errs.length >> 1], max = errs[errs.length - 1];
    const unsnapped = r.rows.filter((x) => x.tap && !x.tap.snapped).length;
    const ms = Math.round(r.rows.reduce((s, x) => s + x.dt, 0) / r.rows.length);
    check(!!lock, `${name}: после 4-го касания AR включился сам (кадр ${lock && lock.t})`);
    check(unsnapped === 0, `${name}: все касания притянулись к углам`);
    check(lockErr < 3, `${name}: рамка в момент запуска на углах холста (ошибка ${lockErr.toFixed(1)} px)`);
    check(lost === 0 && med < 2 && max < 4, `${name}: холст ведётся до конца (${tr.length} кадров, потеряно ${lost}; ошибка мед. ${med?.toFixed(1)} px, макс. ${max?.toFixed(1)} px; ${ms} мс/кадр)`);
    check(r.errors.length === 0, `${name}: без ошибок в консоли`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
