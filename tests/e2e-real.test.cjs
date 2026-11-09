// Сквозной сценарий на реальной фотографии мольберта (tests/.data/real, локально):
// камера показывает фото → AR → кадр замирает → касания по 4 углам холста в случайном порядке
// и с «неточным пальцем» → рамка строится сама → «Назад» → «Отслеживать».
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
  const ctx = await b.newContext({ viewport: { width: 414, height: 860 }, permissions: ['camera'], hasTouch: true });
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
  check(await p.evaluate(() => document.querySelector('#video').paused), 'кадр замер на время выбора углов');
  check((await p.textContent('#ar-hint')).includes('Нажмите на углы холста'), 'подсказка — только «Нажмите на углы холста»');
  check(await p.isDisabled('#ar-start'), '«Отслеживать» недоступно, пока углы не отмечены');

  const screen = (pt) => p.evaluate((x) => window.artcam.stage.toScreen(x), pt);
  const diag = Math.hypot(cam.w, cam.h);
  // допустимы оба контура холста: границы живописи и холст с полями
  const cornerErr = (pt, i) => Math.min(Math.hypot(pt[0] - cam.paint[i][0], pt[1] - cam.paint[i][1]), Math.hypot(pt[0] - cam.gt[i][0], pt[1] - cam.gt[i][1]));
  const err = (q) => Math.min(...[0, 1, 2, 3].map((s) => q.reduce((a, pt, i) => a + cornerErr(pt, (i + s) % 4), 0) / 4));

  // касания «неточным пальцем» (до ~12 px в кадре ≈ 14 экранных), углы — в случайном порядке: 2, 0, 3, 1
  const jitter = [[9, -6], [-7, 10], [6, 8], [-10, -5]];
  const order = [2, 0, 3, 1];
  let k = 0;
  for (const i of order) {
    const [sx, sy] = await screen([cam.paint[i][0] + jitter[k][0], cam.paint[i][1] + jitter[k][1]]);
    await p.touchscreen.tap(sx, sy);
    await p.waitForFunction((n) => window.artcam.ar.corners.length === n && window.artcam.ar.corners.every((c) => !c.pending), ++k, { timeout: 15000 });
    if (k === 2) {
      const n = await p.evaluate(() => document.querySelectorAll('#ar-dots i.on').length);
      check(n === 2, 'счётчик показывает отмеченные углы (2 из 4)');
      await p.screenshot({ path: path.join(REAL, 'e2e-real-taps.png') });
    }
  }
  await p.waitForFunction(() => !!window.artcam.ar.selectQuad, null, { timeout: 15000 });
  const q1 = await p.evaluate(() => window.artcam.ar.selectQuad.map((q) => [...q]));
  const e1 = err(q1);
  await p.screenshot({ path: path.join(REAL, 'e2e-real-select.png') });
  check(e1 / diag < 0.02, `рамка построена по касаниям (ошибка ${e1.toFixed(1)} px из ${Math.round(diag)}, ${(100 * e1 / diag).toFixed(1)}%)`);
  check((await p.textContent('#ar-hint')).includes('Всё верно'), 'после 4 углов — «Всё верно?»');
  check(!(await p.isDisabled('#ar-start')), '«Отслеживать» доступно');

  // «Назад»: рамка снимается, последний угол убирается; повторное касание достраивает её
  await p.click('#ar-back');
  check(await p.evaluate(() => !window.artcam.ar.selectQuad && window.artcam.ar.corners.length === 3), '«Назад» убирает последний угол и рамку');
  const [rx, ry] = await screen([cam.paint[1][0] + 5, cam.paint[1][1] + 7]);
  await p.touchscreen.tap(rx, ry);
  await p.waitForFunction(() => !!window.artcam.ar.selectQuad, null, { timeout: 15000 });
  const q2 = await p.evaluate(() => window.artcam.ar.selectQuad.map((q) => [...q]));
  check(err(q2) / diag < 0.02, `после повторного касания рамка снова построена (ошибка ${err(q2).toFixed(1)} px)`);

  // касание вне 4 отмеченных не добавляет пятого угла
  const before = await p.evaluate(() => window.artcam.ar.corners.length);
  await p.touchscreen.tap(60, 700);
  check((await p.evaluate(() => window.artcam.ar.corners.length)) === before, 'лишние касания после 4 углов игнорируются');

  await p.click('#ar-start');
  await p.waitForFunction(() => window.artcam.ar.mode === 'tracking', null, { timeout: 15000 });
  await p.waitForTimeout(2500);
  const st = await p.evaluate(() => ({ state: window.artcam.ar.state, info: window.artcam.ar.info, paused: document.querySelector('#video').paused }));
  await p.screenshot({ path: path.join(REAL, 'e2e-real-tracking.png') });
  check(!st.paused, 'видео снова идёт');
  check(st.state === 'tracking', `трекинг стартовал (точек ${st.info && st.info.points}, краёв ${st.info && st.info.edges}, шаблон ${st.info && st.info.refined})`);
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors.slice(0, 3)) : ''));
  await b.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
