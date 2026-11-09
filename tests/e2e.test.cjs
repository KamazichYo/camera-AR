// Сквозной тест интерфейса с фейковой камерой.
const path = require('path');
const { launch, check, DATA } = require('./common.cjs');

(async () => {
  const { page: p, errors, close, url } = await launch({ port: 8792, camera: true, viewport: { width: 1000, height: 640 } });
  const shot = (n) => p.screenshot({ path: path.join(DATA, `e2e-${n}.png`) });
  const start = async () => {
    await p.waitForTimeout(1500);
    if (!(await p.evaluate(() => document.body.classList.contains('running')))) await p.click('#btn-start');
    await p.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  };
  await p.goto(`${url}/app/index.html`);
  await start();
  check(true, 'камера запущена');

  await p.setInputFiles('#file', path.join(DATA, 'ref.png'));
  await p.waitForFunction(() => window.artcam.ref.loaded);
  const q = () => p.evaluate(() => window.artcam.overlayQuad.map((v) => v.map((x) => +x.toFixed(1))));
  const scr = (pt) => p.evaluate((x) => window.artcam.stage.toScreen(x), pt);
  const mid = (a) => [(a[0][0] + a[2][0]) / 2, (a[0][1] + a[2][1]) / 2];

  // жесты
  const q0 = await q();
  let c = await scr(mid(q0));
  await p.mouse.move(c[0], c[1]); await p.mouse.down(); await p.mouse.move(c[0] + 50, c[1] + 20, { steps: 5 }); await p.mouse.up();
  const q1 = await q();
  const s = await p.evaluate(() => window.artcam.stage.s);
  check(Math.abs(q1[0][0] - q0[0][0] - 50 / s) < 1 && Math.abs(q1[2][1] - q0[2][1] - 20 / s) < 1, 'перемещение референса');
  const k = await scr(q1[1]);
  await p.mouse.move(k[0], k[1]); await p.mouse.down(); await p.mouse.move(k[0] + 30, k[1] - 25, { steps: 5 }); await p.mouse.up();
  const q2 = await q();
  check(q2[1][0] > q1[1][0] && q2[0][0] === q1[0][0], 'перетаскивание угла (перспектива)');
  c = await scr(mid(q2));
  await p.mouse.move(c[0], c[1]); await p.mouse.wheel(0, 200); await p.waitForTimeout(300);
  const q3 = await q();
  check(Math.hypot(q3[1][0] - q3[0][0], q3[1][1] - q3[0][1]) < Math.hypot(q2[1][0] - q2[0][0], q2[1][1] - q2[0][1]), 'масштаб колесом');

  // режимы
  await p.click('#btn-ref-panel');
  await p.click('#mode-seg button[data-mode=outline]');
  await p.check('#grid');
  await p.click('#panel-ref .close');
  await shot('outline');
  check(await p.evaluate(() => window.artcam.S.mode === 'outline' && window.artcam.S.grid), 'режим «Контур» + сетка');

  // замок
  await p.click('#btn-pin');
  const before = JSON.stringify(await q());
  await p.mouse.move(c[0], c[1]); await p.mouse.down(); await p.mouse.move(c[0] + 80, c[1], { steps: 4 }); await p.mouse.up();
  check(before === JSON.stringify(await q()), 'закреплённый референс не двигается');
  await p.click('#btn-pin');

  // восстановление после перезагрузки
  await p.reload();
  await start();
  await p.waitForFunction(() => window.artcam.ref.loaded && window.artcam.overlayQuad);
  check(JSON.stringify(await q()) === before, 'референс и его положение восстановлены после перезагрузки');

  // AR
  await p.click('#btn-ar');
  await p.waitForFunction(() => window.artcam.ar.mode === 'select', null, { timeout: 60000 });
  await p.waitForTimeout(600);
  await shot('ar-select');
  await p.click('#ar-start');
  await p.waitForFunction(() => window.artcam.ar.mode === 'tracking', null, { timeout: 10000 });
  let tracked = 0;
  for (let i = 0; i < 10; i++) {
    await p.waitForTimeout(400);
    if (await p.evaluate(() => window.artcam.ar.state === 'tracking')) tracked++;
  }
  await shot('ar-tracking');
  const fps = await p.evaluate(() => window.artcam.tracker.stats.fps);
  check(tracked >= 7, `AR отслеживает холст (${tracked}/10 проверок, ${fps} к/с)`);

  // запись: референс не должен попадать в видео — пишется исходный трек камеры
  await p.click('#btn-record');
  await p.waitForTimeout(2500);
  await p.click('#btn-record');
  await p.waitForSelector('#modal-media:not([hidden])', { timeout: 10000 });
  const info = await p.textContent('#media-info');
  const dur = await p.evaluate(() => new Promise((res) => {
    const v = document.querySelector('#media-preview video');
    const done = () => res(v.duration);
    if (v.readyState >= 1) done(); else v.onloadedmetadata = done;
  }));
  check(/\.(mp4|webm)/.test(info) && parseFloat(info.split('·')[1]) > 0, `запись видео: ${info}`);
  await p.click('#media-delete');
  await p.waitForSelector('#modal-media', { state: 'hidden' });

  // фото
  await p.click('#btn-photo');
  await p.waitForSelector('#modal-media:not([hidden])');
  check(/\.jpg/.test(await p.textContent('#media-info')), 'снимок');
  await p.click('#media-close');

  await p.click('#btn-ar');
  check(await p.evaluate(() => window.artcam.ar.mode === 'off'), 'AR выключается');
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors) : ''));
  void dur;
  await close();
})().catch((e) => { console.error(e); process.exit(1); });
