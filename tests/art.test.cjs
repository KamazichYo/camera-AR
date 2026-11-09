// Картина маслом (кадры tests/.data/art из видео пользователя, локально): камера движется и приближается, холст местами
// уходит за кадр, рука с кистью закрывает холст и край. Эталон ref.json — рамки, проверенные глазами по раскадровке.
// Вторая часть — «закрашивание»: поверх холста рисуется однотонная заливка (tests/make_paint.py), опорные точки пейзажа
// пропадают, и трекер должен переехать на соседние (незакрашенные камни, края, окружение), не теряя рамки.
// Ошибка считается по сетке точек холста, которые видны в кадре (углы за кадром дают огромные, но неважные цифры).
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { check, DATA } = require('./common.cjs');
const { runVideo } = require('./video-run.cjs');

const DIR = path.join(DATA, 'art');
if (!fs.existsSync(path.join(DIR, 'f001.png')) || !fs.existsSync(path.join(DIR, 'ref.json'))) {
  console.log('– нет tests/.data/art (кадры + ref.json), пропуск');
  process.exit(0);
}
const ref = JSON.parse(fs.readFileSync(path.join(DIR, 'ref.json'), 'utf8'));
const N = fs.readdirSync(DIR).filter((f) => /^f\d+\.png$/.test(f)).length;
const W = 480, H = 360;

// гомография единичного квадрата → четырёхугольник (DLT через решение 8×8)
function homog(q) {
  const A = [], b = [];
  [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([x, y], i) => {
    const [u, v] = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  });
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h = b.map((v, i) => v / A[i][i]);
  return [...h, 1];
}
const ap = (h, [x, y]) => { const k = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / k, (h[3] * x + h[4] * y + h[5]) / k]; };

function gridErr(qa, qb) {
  const ha = homog(qa), hb = homog(qb);
  let s = 0, n = 0;
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
    const g = [i / 6, j / 6], a = ap(ha, g);
    if (!(a[0] >= 0 && a[1] >= 0 && a[0] < W && a[1] < H)) continue;
    const b = ap(hb, g);
    s += Math.hypot(a[0] - b[0], a[1] - b[1]); n++;
  }
  return n >= 6 ? s / n : null;
}

async function run(dir, port) {
  const pts = [[100, 72], [335, 80], [350, 238], [92, 230]];
  const taps = pts.map((p, i) => ({ f: 2 + i * 2, p }));
  const r = await runVideo({ taps, step: 1, n: N, port, dir });
  if (r.error) throw new Error(r.error);
  const tr = r.rows.filter((x) => x.state);
  const errs = tr.filter((x) => x.quad && ref[x.t]).map((x) => ({ t: x.t, e: gridErr(ref[x.t], x.quad) })).filter((x) => x.e !== null);
  const sorted = errs.map((x) => x.e).sort((a, b) => a - b);
  return {
    lost: tr.filter((x) => x.state !== 'tracking').length, n: tr.length,
    med: sorted[sorted.length >> 1], good: errs.filter((x) => x.e < 8).length / errs.length,
    ms: Math.round(tr.reduce((s, x) => s + (x.ms || 0), 0) / tr.length), errors: r.errors,
  };
}

(async () => {
  const a = await run('/t/.data/art', 8991);
  check(a.lost === 0, `картина: ${a.n} кадров, потеряно ${a.lost}`);
  check(a.med < 1 && a.good > 0.97, `картина: ошибка по видимой сетке мед. ${a.med.toFixed(2)} px, кадров точнее 8 px: ${(a.good * 100).toFixed(0)}% (рука на холсте, холст за кадром); ${a.ms} мс/кадр`);
  check(a.errors.length === 0, 'картина: без ошибок в консоли');

  const paint = path.join(DATA, 'art_paint');
  if (!fs.existsSync(path.join(paint, 'f001.png'))) execFileSync('python3', [path.join(__dirname, 'make_paint.py')]);
  const b = await run('/t/.data/art_paint', 8992);
  check(b.lost === 0, `закрашивание: ${b.n} кадров, потеряно ${b.lost}`);
  // в кадрах 295–365 камера вплотную, а заливка привязана к эталону с его собственной погрешностью — там край заливки «плывёт»
  check(b.med < 3 && b.good > 0.8, `закрашивание: ошибка мед. ${b.med.toFixed(2)} px, кадров точнее 8 px: ${(b.good * 100).toFixed(0)}% (опорные точки пейзажа закрашены — трекер переезжает на соседние); ${b.ms} мс/кадр`);
  check(b.errors.length === 0, 'закрашивание: без ошибок в консоли');
})().catch((e) => { console.error(e); process.exit(1); });
