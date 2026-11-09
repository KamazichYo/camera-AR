// Подготовка эталона для тренировочного видео (tests/.data/video/training.mov — локальный файл).
//  1) gt.json — грубые контуры холста на опорных кадрах (автопоиск) — только чтобы знать, куда «нажимать»;
//  2) ref.json — рамка, поставленная на первых кадрах и ведомая до конца видео. Эталон проверяется ГЛАЗАМИ:
//     после запуска посмотрите раскадровку (python3 tests/video-story.py) и крупные планы углов.
// Запуск: python3 tests/make_video.py && node tests/video-prepare.cjs
const fs = require('fs');
const path = require('path');
const { launch, DATA } = require('./common.cjs');
const { runVideo, gtAt } = require('./video-run.cjs');

const DIR = path.join(DATA, 'video');

(async () => {
  const frames = [1, 20, 40, 60, 80, 100, 140, 161];
  const { page, close, url } = await launch({ port: 8881 });
  const gt = {};
  for (const f of frames) {
    await page.goto(`${url}/t/detect-harness.html?img=/t/.data/video/f${String(f).padStart(3, '0')}.png`);
    await page.waitForFunction(() => window.result, null, { timeout: 60000 });
    const r = await page.evaluate(() => window.result);
    if (r.cands && r.cands[0]) gt[f] = r.cands[0].q;
  }
  await close();
  fs.writeFileSync(path.join(DIR, 'gt.json'), JSON.stringify(gt));

  // эталонный прогон: углы отмечаются на кадрах 1–4 без промаха
  const plan = [[1, 0], [2, 1], [3, 2], [4, 3]];
  const taps = plan.map(([f, c]) => ({ f, p: gtAt(gt, f)[c], corner: c }));
  const r = await runVideo({ taps, step: 1, port: 8882 });
  const ref = {};
  for (const row of r.rows) {
    if (row.quad) ref[row.t] = row.quad;
    else if (row.locked) ref[row.t] = row.locked.quad;
  }
  fs.writeFileSync(path.join(DIR, 'ref.json'), JSON.stringify(ref));
  fs.writeFileSync(path.join(DIR, 'ref-run.json'), JSON.stringify({ taps, rows: r.rows }));
  console.log(`gt: ${Object.keys(gt).length} кадров, ref: ${Object.keys(ref).length} кадров`);
})().catch((e) => { console.error(e); process.exit(1); });
