// Предмет с логотипом на гладком корпусе, камера облетает его, а точки опоры стоят на столе — это другая плоскость, чем сама
// панель. Гомография по смеси плоскостей «уезжала» (на телефоне — клин вместо рамки). Сцена синтетическая (tests/gen_parallax.py:
// панель на столе у стены, облёт ±38°), истина — проекция углов панели. Ошибка считается относительно захваченной области:
// где она должна быть на кадре t по истинной плоскости панели (так не мешает неточность касаний при старте).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { check, DATA } = require('./common.cjs');
const { runVideo } = require('./video-run.cjs');

const DIR = path.join(DATA, 'parallax');
if (!fs.existsSync(path.join(DIR, 'gt.json'))) execFileSync('python3', [path.join(__dirname, 'gen_parallax.py')], { stdio: 'inherit' });
const gt = JSON.parse(fs.readFileSync(path.join(DIR, 'gt.json'), 'utf8'));
const anc = JSON.parse(fs.readFileSync(path.join(DIR, 'anchors.json'), 'utf8'));

function homog4(src, dst) {
  const A = [], b = [];
  src.forEach(([x, y], i) => { const [u, v] = dst[i]; A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u); A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v); });
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}
const ap = (h, [x, y]) => { const k = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / k, (h[3] * x + h[4] * y + h[5]) / k]; };

async function run(withAnchors, port) {
  const taps = [0, 1, 2, 3].map((i) => ({ f: 2 + i * 2, p: gt['1'][i] }));
  const anchors = withAnchors ? [0, 1, 2, 3, 4].map((i) => ({ f: 14, p: anc['14'][i] })) : null;
  const r = await runVideo({ taps, step: 1, n: 160, port, dir: '/t/.data/parallax', noAuto: true, anchors });
  if (r.error) throw new Error(r.error);
  const lock = r.rows.find((x) => x.locked), LT = String(lock.t), lq = lock.locked.quad;
  const tr = r.rows.filter((x) => x.state);
  const e = tr.filter((x) => x.quad && gt[x.t]).map((x) => {
    const h = homog4(gt[LT], gt[x.t]), ex = lq.map((p) => ap(h, p));
    return x.quad.reduce((s, p, i) => s + Math.hypot(p[0] - ex[i][0], p[1] - ex[i][1]), 0) / 4;
  }).sort((a, b) => a - b);
  return { lost: tr.filter((x) => x.state !== 'tracking').length, n: tr.length, med: e[e.length >> 1], p90: e[Math.floor(e.length * 0.9)], max: e[e.length - 1], errors: r.errors };
}

(async () => {
  const a = await run(false, 8999), b = await run(true, 9001);
  console.log(`  без опор: ошибка мед. ${a.med.toFixed(2)} px, 90% ${a.p90.toFixed(2)} px, макс. ${a.max.toFixed(1)}`);
  console.log(`  опоры на столе: ошибка мед. ${b.med.toFixed(2)} px, 90% ${b.p90.toFixed(2)} px, макс. ${b.max.toFixed(1)}`);
  check(a.lost === 0 && a.med < 1 && a.max < 6, `панель с логотипом при облёте камеры ведётся без опор (мед. ${a.med.toFixed(2)} px)`);
  check(b.lost === 0 && b.med < 1.5 && b.p90 < 5 && b.max < 9, `опоры из другой плоскости (стол) не уводят рамку (мед. ${b.med.toFixed(2)} px, 90% ${b.p90.toFixed(2)} px)`);
  check(a.errors.length === 0 && b.errors.length === 0, 'без ошибок в консоли');
})().catch((e) => { console.error(e); process.exit(1); });
