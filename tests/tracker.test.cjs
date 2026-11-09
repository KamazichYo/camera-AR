// Точность AR-трекера на синтетических сценах с известным положением листа.
// Запуск: node tests/tracker.test.cjs [сцена ...]   (по умолчанию все)
const fs = require('fs');
const path = require('path');
const { launch, check, DATA } = require('./common.cjs');

// [начало, конец, название, допуск: медиана px, максимум px] ; null — ожидается потеря
const SCENES = {
  main: [[1, 40, 'неподвижно', 1, 3], [40, 120, 'движение', 1, 3], [120, 150, 'рука', 1, 3], [150, 170, 'сдвиг', 1, 3],
    [170, 180, 'камера закрыта', null], [180, 200, 'после перекрытия', 1, 3], [200, 240, 'дорисовка', 1, 3]],
  blank: [[1, 30, 'неподвижно', 1, 3], [30, 110, 'лист крутят', 1.5, 4], [110, 150, 'руки на краях', 1.5, 4],
    [150, 176, 'лист двигают', 1.5, 4], [176, 188, 'камера закрыта', null], [190, 200, 'после перекрытия', 1.5, 4],
    [200, 240, 'двигается камера', 1.5, 4]],
  light: [[1, 100, 'экспозиция+тень', 1.5, 4], [100, 150, 'вспышка света', 1.5, 4], [150, 190, 'рывки+смаз', 2, 6],
    [190, 240, 'после рывков', 1.5, 4]],
};

async function run(scene, port) {
  const { page, errors, close, url } = await launch({ port });
  await page.goto(`${url}/t/tracker-harness.html?scene=${scene}`);
  await page.waitForFunction(() => window.result, null, { timeout: 300000 });
  const r = await page.evaluate(() => window.result);
  await close();
  console.log(`\nСцена «${scene}»`);
  if (r.error) { check(false, 'ошибка: ' + r.error); return; }
  for (const [a, z, name, medTol, maxTol] of SCENES[scene]) {
    const rs = r.rows.filter((x) => x.t >= a && x.t < z);
    const tr = rs.filter((x) => x.state === 'tracking');
    const errs = tr.map((x) => x.err).sort((p, q) => p - q);
    const med = errs[errs.length >> 1];
    const max = errs[errs.length - 1];
    const avgMs = Math.round(rs.reduce((s, x) => s + x.ms, 0) / rs.length);
    const line = `${name}: отслежено ${tr.length}/${rs.length}, ошибка мед. ${med ?? '—'} px, макс. ${max ?? '—'} px, ${avgMs} мс/кадр`;
    // при закрытой камере трекер несколько кадров едет по инерции (чтобы не мигать при смазе), затем сообщает о потере
    if (medTol === null) check(tr.length <= 8 && tr.length < rs.length, line + ' — инерция не дольше 8 кадров, затем «потерян»');
    else check(tr.length >= rs.length - 2 && med <= medTol && max <= maxTol, line);
  }
  if (scene === 'main') {
    const d = r.det;
    const dErr = d ? d.reduce((acc, p) => acc + Math.min(...r.gt0.map((g) => Math.hypot(p[0] - g[0], p[1] - g[1]))), 0) / 4 : Infinity;
    check(dErr < 4, `автопоиск холста (ошибка ${dErr.toFixed(1)} px)`);
  }
  const prof = {};
  for (const x of r.rows) for (const [k, v] of Object.entries(x.prof || {})) prof[k] = (prof[k] || 0) + v / r.rows.length;
  if (Object.keys(prof).length) console.log('  профиль, мс/кадр:', Object.entries(prof).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', '));
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors) : ''));
  fs.writeFileSync(path.join(DATA, scene, 'tracker-rows.json'), JSON.stringify(r.rows));
}

(async () => {
  const list = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENES);
  let port = 8791;
  for (const s of list) await run(s, port++);
})().catch((e) => { console.error(e); process.exit(1); });
