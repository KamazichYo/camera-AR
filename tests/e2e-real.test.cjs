// Сквозной сценарий на реальной фотографии мольберта (tests/.data/real, локально):
// камера показывает фото → AR → «Найти» → рамка на холсте, углы доступны для захвата,
// повторное «Найти» меняет вариант → «Отслеживать» работает.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const serve = require('./serve.cjs');
const { check, DATA } = require('./common.cjs');

const REAL = path.join(DATA, 'real');
if (!fs.existsSync(path.join(REAL, 'easel.y4m'))) { console.log('– нет tests/.data/real/easel.y4m (python3 tests/make_variants.py), пропуск'); process.exit(0); }
const cam = JSON.parse(fs.readFileSync(path.join(REAL, 'variants.json'), 'utf8'))._camera;
const CV = require.resolve('@techstark/opencv-js/dist/opencv.js');

(async () => {
  const srv = await serve(8803);
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.join(REAL, 'easel.y4m')}`] });
  const ctx = await b.newContext({ viewport: { width: 414, height: 860 }, permissions: ['camera'] });
  await ctx.route(/opencv-js@[\d.]+-release\.\d+\/dist\/opencv\.js/, (r) => r.fulfill({ body: fs.readFileSync(CV), contentType: 'text/javascript' }));
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto('http://localhost:8803/app/index.html');
  await p.waitForTimeout(1500);
  if (!(await p.evaluate(() => document.body.classList.contains('running')))) await p.click('#btn-start');
  await p.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  const dims = await p.evaluate(() => [video.videoWidth, video.videoHeight]);
  check(dims[0] === cam.w && dims[1] === cam.h, `камера: ${dims.join('×')}`);

  await p.click('#btn-ar');
  await p.waitForFunction(() => window.artcam.ar.mode === 'select', null, { timeout: 60000 });
  await p.waitForTimeout(1200); // авто-поиск при входе в режим выбора
  const q1 = await p.evaluate(() => window.artcam.ar.selectQuad.map((q) => [...q]));
  const diag = Math.hypot(cam.w, cam.h);
  const err = (q, gt) => q.reduce((s, pt, i) => s + Math.hypot(pt[0] - gt[i][0], pt[1] - gt[i][1]), 0) / 4;
  const e1 = err(q1, cam.gt);
  await p.screenshot({ path: path.join(REAL, 'e2e-real-select.png') });
  check(e1 / diag < 0.03, `после входа в AR рамка уже на холсте (ошибка ${e1.toFixed(1)} px из ${Math.round(diag)}, ${(100 * e1 / diag).toFixed(1)}%)`);

  const inView = await p.evaluate(() => {
    const { stage, ar } = window.artcam;
    return ar.selectQuad.every((pt) => { const [x, y] = stage.toScreen(pt); return x >= 14 && y >= 14 && x <= stage.cw - 14 && y <= stage.ch - 14; });
  });
  check(inView, 'все 4 угла рамки в видимой области — их можно ухватить пальцем');

  await p.click('#ar-auto');
  await p.waitForTimeout(400);
  const q2 = await p.evaluate(() => window.artcam.ar.selectQuad.map((q) => [...q]));
  const e2 = err(q2, cam.gt);
  check(q2.some((pt, i) => Math.hypot(pt[0] - q1[i][0], pt[1] - q1[i][1]) > 1) || e2 < 1, 'повторное «Найти» показывает следующий вариант');
  await p.click('#ar-auto'); await p.click('#ar-auto'); await p.click('#ar-auto'); // по кругу назад к первому
  await p.waitForTimeout(300);
  const q3 = await p.evaluate(() => window.artcam.ar.selectQuad.map((q) => [...q]));
  check(err(q3, q1) < 1, 'варианты перебираются по кругу');

  await p.click('#ar-start');
  await p.waitForFunction(() => window.artcam.ar.mode === 'tracking', null, { timeout: 15000 });
  await p.waitForTimeout(2500);
  const st = await p.evaluate(() => ({ state: window.artcam.ar.state, info: window.artcam.ar.info }));
  await p.screenshot({ path: path.join(REAL, 'e2e-real-tracking.png') });
  check(st.state === 'tracking', `трекинг стартовал (точек ${st.info && st.info.points}, краёв ${st.info && st.info.edges}, шаблон ${st.info && st.info.refined})`);
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors.slice(0, 3)) : ''));
  await b.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
