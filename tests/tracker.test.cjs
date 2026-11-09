// Точность AR-трекера на синтетической сцене с известными положениями листа.
const fs = require('fs');
const path = require('path');
const { launch, check, DATA } = require('./common.cjs');

(async () => {
  const { page, errors, close, url } = await launch({ port: 8791 });
  await page.goto(`${url}/t/tracker-harness.html`);
  await page.waitForFunction(() => window.result, null, { timeout: 240000 });
  const r = await page.evaluate(() => window.result);
  await close();

  const segs = [[1, 40, 'неподвижно'], [40, 120, 'движение'], [120, 150, 'рука'], [150, 170, 'сдвиг'],
    [170, 180, 'камера закрыта'], [180, 200, 'после перекрытия'], [200, 240, 'дорисовка']];
  for (const [a, z, name] of segs) {
    const rs = r.rows.filter((x) => x.t >= a && x.t < z);
    const tr = rs.filter((x) => x.state === 'tracking');
    const errs = tr.map((x) => x.err).sort((p, q) => p - q);
    const med = errs[errs.length >> 1];
    const avgMs = Math.round(rs.reduce((s, x) => s + x.ms, 0) / rs.length);
    console.log(`  ${name.padEnd(18)} отслежено ${tr.length}/${rs.length}  ошибка мед. ${med ?? '—'} px, макс. ${errs[errs.length - 1] ?? '—'} px, ${avgMs} мс/кадр`);
    if (name === 'камера закрыта') check(tr.length === 0, 'при закрытой камере трекер сообщает о потере');
    else {
      check(tr.length >= rs.length - 2, `${name}: трекинг держится`);
      check(med < 1.5 && errs[errs.length - 1] < 4, `${name}: точность (медиана < 1.5 px, максимум < 4 px)`);
    }
  }
  const d = r.det;
  const dErr = d ? Math.min(...[0, 1, 2, 3].map((s) => d.reduce((acc, p, i) => acc + Math.hypot(p[0] - r.gt0[(i + s) % 4][0], p[1] - r.gt0[(i + s) % 4][1]), 0) / 4)) : Infinity;
  // автопоиск может вернуть углы в другом порядке — сравниваем без учёта порядка
  const dErrAny = d ? d.reduce((acc, p) => acc + Math.min(...r.gt0.map((g) => Math.hypot(p[0] - g[0], p[1] - g[1]))), 0) / 4 : Infinity;
  check(Math.min(dErr, dErrAny) < 4, `автопоиск холста (ошибка ${Math.min(dErr, dErrAny).toFixed(1)} px)`);
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors) : ''));
  fs.writeFileSync(path.join(DATA, 'tracker-rows.json'), JSON.stringify(r.rows));
})().catch((e) => { console.error(e); process.exit(1); });
