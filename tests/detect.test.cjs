// Автопоиск холста: реальная фотография мольберта и её вариации (tests/.data/real — локально,
// не коммитится; см. tests/make_variants.py) + синтетические сцены.
// Сохраняет картинки с найденной рамкой в tests/.data/real/found-*.png (первый вариант — зелёным).
const fs = require('fs');
const path = require('path');
const { launch, check, DATA } = require('./common.cjs');

const cases = [];
// синтетические сцены: первый кадр, истина из gt.json
for (const scene of ['main', 'blank', 'light']) {
  const gt = JSON.parse(fs.readFileSync(path.join(DATA, scene, 'gt.json'), 'utf8'))[0].q;
  cases.push({ name: `сцена ${scene}`, url: `/t/.data/${scene}/frames/f000.png`, gt, tol: 0.012 });
}
// реальные фото
const vfile = path.join(DATA, 'real', 'variants.json');
if (fs.existsSync(vfile)) {
  const v = JSON.parse(fs.readFileSync(vfile, 'utf8'));
  // допуск 3 %: у холста на фото левое поле уходит за край кадра, видимая граница — край живописи
  for (const [n, c] of Object.entries(v).filter(([k]) => !k.startsWith('_'))) cases.push({ name: `фото ${n}`, url: `/t/.data/real/${c.file}`, gt: c.gt, tol: 0.03, real: true });
} else console.log('– реальных фото нет (tests/.data/real), проверяются только синтетические сцены');

const order = (q) => {
  const c = [q.reduce((s, p) => s + p[0], 0) / 4, q.reduce((s, p) => s + p[1], 0) / 4];
  const s = [...q].sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
  let k = 0; s.forEach((p, i) => { if (p[0] + p[1] < s[k][0] + s[k][1]) k = i; });
  return [...s.slice(k), ...s.slice(0, k)];
};
const cornerErr = (q, gt) => {
  // порядок углов может начинаться с любого — берём лучший циклический сдвиг
  const o = order(q);
  return Math.min(...[0, 1, 2, 3].map((s) => o.reduce((acc, p, i) => acc + Math.hypot(p[0] - gt[(i + s) % 4][0], p[1] - gt[(i + s) % 4][1]), 0) / 4));
};

(async () => {
  const { page, errors, close, url } = await launch({ port: 8801 });
  let n = 0;
  for (const c of cases) {
    await page.goto(`${url}/t/detect-harness.html?img=${c.url}`);
    await page.waitForFunction(() => window.result, null, { timeout: 120000 });
    const r = await page.evaluate(() => window.result);
    if (r.error) { check(false, `${c.name}: ${r.error}`); continue; }
    if (!r.quad) { check(false, `${c.name}: холст не найден`); continue; }
    const diag = Math.hypot(r.size[0], r.size[1]);
    const err = cornerErr(r.quad, c.gt);
    const alt = (r.cands || []).slice(1).some((x) => cornerErr(x.q, c.gt) / diag < c.tol);
    check(err / diag < c.tol, `${c.name}: ошибка ${err.toFixed(1)} px (${(100 * err / diag).toFixed(1)}% диагонали), ${Math.round(r.ms)} мс, вариантов ${r.cands.length}` +
      (err / diag >= c.tol && alt ? ' — верный есть среди других вариантов' : ''));
    if (c.real) fs.writeFileSync(path.join(DATA, 'real', `found-${String(n++).padStart(2, '0')}.json`), JSON.stringify({ name: c.name, url: c.url, cands: r.cands }));
  }
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors.slice(0, 3)) : ''));
  await close();
})().catch((e) => { console.error(e); process.exit(1); });
