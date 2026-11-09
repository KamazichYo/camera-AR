// Скетчбук с рукой: пустой лист на флисе, рука то закрывает грани, то уходит, листают страницы, смаз.
// Данные — локально (tests/.data/sketch, кадры 360×480 из видео пользователя; в репозиторий не кладутся).
// Эталон ref.json — рамки по ключевым кадрам, проверенные глазами по раскадровке и увеличенным углам.
const path = require('path');
const fs = require('fs');
const { check, DATA } = require('./common.cjs');
const { runVideo } = require('./video-run.cjs');

const DIR = path.join(DATA, 'sketch');
const refFile = path.join(DIR, 'ref.json');
if (!fs.existsSync(path.join(DIR, 'f001.png')) || !fs.existsSync(refFile)) {
  console.log('– нет tests/.data/sketch (кадры + ref.json), пропуск');
  process.exit(0);
}
const ref = JSON.parse(fs.readFileSync(refFile, 'utf8'));
const quadErr = (q, g) => q.reduce((s, p, i) => s + Math.hypot(p[0] - g[i][0], p[1] - g[i][1]), 0) / 4;
const maxErr = (q, g) => Math.max(...q.map((p, i) => Math.hypot(p[0] - g[i][0], p[1] - g[i][1])));

(async () => {
  const pts = [[95, 144], [240, 152], [240, 374], [98, 382]];
  const taps = pts.map((p, i) => ({ f: 2 + i * 2, p }));
  const r = await runVideo({ taps, step: 1, n: 920, port: 8950, dir: '/t/.data/sketch' });
  if (r.error) { check(false, `скетчбук: ${r.error}`); return; }
  const lock = r.rows.find((x) => x.locked);
  const tr = r.rows.filter((x) => x.state);
  const lost = tr.filter((x) => x.state !== 'tracking').length;
  const keys = tr.filter((x) => x.quad && ref[x.t]);
  const errs = keys.map((x) => quadErr(x.quad, ref[x.t])).sort((a, b) => a - b);
  const worst = keys.reduce((m, x) => Math.max(m, maxErr(x.quad, ref[x.t])), 0);
  const med = errs[errs.length >> 1];
  const ms = Math.round(tr.reduce((s, x) => s + (x.ms || 0), 0) / tr.length);
  check(!!lock, `скетчбук: AR включился после 4-го касания (кадр ${lock && lock.t})`);
  check(lost === 0, `скетчбук: ${tr.length} кадров, потеряно ${lost}`);
  check(med < 3 && worst < 12, `скетчбук: по ${keys.length} ключевым кадрам ошибка мед. ${med.toFixed(1)} px, худший угол ${worst.toFixed(1)} px (рука закрывает грани, листание)`);
  console.log(`  ${ms} мс/кадр`);
  check(r.errors.length === 0, 'скетчбук: без ошибок в консоли');
})().catch((e) => { console.error(e); process.exit(1); });
