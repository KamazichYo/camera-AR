// Сквозной сценарий на реальной фотографии мольберта (tests/.data/real, локально):
// камера показывает фото → AR → касания по 4 углам холста в случайном порядке и с «неточным пальцем»
// → точки садятся на углы → «Назад» убирает последнюю → после 4-й AR включается сам.
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
  check(!(await p.evaluate(() => document.querySelector('#video').paused)), 'видео не замирает во время выбора углов');
  check((await p.textContent('#ar-hint')).includes('Нажмите на углы холста'), 'подсказка — только «Нажмите на углы холста»');

  const screen = (pt) => p.evaluate((x) => window.artcam.stage.toScreen(x), pt);
  const diag = Math.hypot(cam.w, cam.h);
  // допустимы оба контура холста: границы живописи и холст с полями
  const cornerErr = (pt, i) => Math.min(Math.hypot(pt[0] - cam.paint[i][0], pt[1] - cam.paint[i][1]), Math.hypot(pt[0] - cam.gt[i][0], pt[1] - cam.gt[i][1]));
  const err = (q) => Math.min(...[0, 1, 2, 3].map((s) => q.reduce((a, pt, i) => a + cornerErr(pt, (i + s) % 4), 0) / 4));
  const waitCorners = (n) => p.waitForFunction((k) => window.artcam.ar.corners.length === k && !window.artcam.ar.pendingTap, n, { timeout: 15000 });

  // касания «неточным пальцем» (до ~12 px в кадре ≈ 14 экранных), углы — в случайном порядке: 2, 0, 3
  const jitter = [[9, -7], [-8, 10], [6, 8], [-10, -5]];
  const order = [2, 0, 3, 1];
  for (let k = 0; k < 3; k++) {
    const [sx, sy] = await screen([cam.paint[order[k]][0] + jitter[k][0], cam.paint[order[k]][1] + jitter[k][1]]);
    await p.touchscreen.tap(sx, sy);
    await waitCorners(k + 1);
    if (k === 1) {
      check((await p.evaluate(() => document.querySelectorAll('#ar-dots i.on').length)) === 2, 'счётчик показывает отмеченные углы (2 из 4)');
      await p.screenshot({ path: path.join(REAL, 'e2e-real-taps.png') });
    }
  }
  const corners = await p.evaluate(() => window.artcam.ar.corners.map((c) => ({ p: c.p, snapped: c.snapped })));
  check(corners.every((c, k) => c.snapped && cornerErr(c.p, order[k]) < 7), `три угла притянулись к углам холста (худший ${Math.max(...corners.map((c, k) => cornerErr(c.p, order[k]))).toFixed(1)} px)`);

  // «Назад»: последняя точка убирается; повторное касание ставит её заново
  await p.click('#ar-back');
  await waitCorners(2);
  check(true, '«Назад» убирает последний угол');
  const [bx, by] = await screen([cam.paint[3][0] + 5, cam.paint[3][1] + 7]);
  await p.touchscreen.tap(bx, by);
  await waitCorners(3);

  // касание на месте уже отмеченного угла не добавляет дубликат
  const [dx, dy] = await screen([cam.paint[order[0]][0], cam.paint[order[0]][1]]);
  await p.touchscreen.tap(dx, dy);
  await p.waitForTimeout(300);
  check((await p.evaluate(() => window.artcam.ar.corners.length)) === 3, 'повторное касание отмеченного угла игнорируется');

  // четвёртый угол → AR включается сам
  const [rx, ry] = await screen([cam.paint[1][0] + jitter[3][0], cam.paint[1][1] + jitter[3][1]]);
  await p.touchscreen.tap(rx, ry);
  await p.waitForFunction(() => window.artcam.ar.mode === 'tracking', null, { timeout: 15000 });
  const q = await p.evaluate(() => window.artcam.ar.refCanvas.map((pt) => [...pt]));
  await p.screenshot({ path: path.join(REAL, 'e2e-real-select.png') });
  check(err(q) / diag < 0.02, `после 4-го угла AR включился сам, рамка на холсте (ошибка ${err(q).toFixed(1)} px из ${Math.round(diag)}, ${(100 * err(q) / diag).toFixed(1)}%)`);

  await p.waitForTimeout(2500);
  const st = await p.evaluate(() => ({ state: window.artcam.ar.state, info: window.artcam.ar.info, paused: document.querySelector('#video').paused }));
  await p.screenshot({ path: path.join(REAL, 'e2e-real-tracking.png') });
  check(st.state === 'tracking', `трекинг идёт (точек ${st.info && st.info.points}, краёв ${st.info && st.info.edges}, шаблон ${st.info && st.info.refined})`);
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors.slice(0, 3)) : ''));
  await b.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(1); });
