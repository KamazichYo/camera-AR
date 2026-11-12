// Ориентация закреплена на время AR: телефон поворачивают — поток камеры становится альбомным (картинка в нём повёрнута),
// интерфейс Safari поворачивается. Рамка должна остаться на холсте, AR — не сбрасываться, экран — не переворачиваться.
// Камера подменяется холстом (canvas.captureStream) с кадром из ролика с картой; «поворот телефона» = поток другой формы
// с повёрнутой картинкой + другой угол экрана + повёрнутое окно. Кадры: tests/.data/card (локально), иначе пропуск.
const fs = require('fs');
const path = require('path');
const { launch, check, DATA } = require('./common.cjs');

const IMG = path.join(DATA, 'card', 'f001.png');
const GT = path.join(DATA, 'card', 'gt.json');
if (!fs.existsSync(IMG) || !fs.existsSync(GT)) { console.log('– нет tests/.data/card, пропуск'); process.exit(0); }
const K = 2; // кадр 360×480 растягиваем до 720×960 («камера» телефона в книжной ориентации)
const CARD = JSON.parse(fs.readFileSync(GT, 'utf8'))['1'].map(([x, y]) => [x * K, y * K]);
const png = 'data:image/png;base64,' + fs.readFileSync(IMG).toString('base64');

// поддельная камера: холст, в который раз в 33 мс рисуется кадр; window.__rot — как повёрнут поток (по часовой: 0/90/270)
const FAKE = `(() => {
  const img = new Image(); img.src = ${JSON.stringify(png)};
  const c = document.createElement('canvas'); c.width = 720; c.height = 960;
  const x = c.getContext('2d');
  window.__rot = 0; let t = 0;
  const draw = () => {
    t++;
    const r = window.__rot, W = 720, Hh = 960;
    const w = r % 180 ? Hh : W, h = r % 180 ? W : Hh;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    x.save();
    // поток «по интерфейсу»: экран повернули против часовой на r — картинка в потоке повёрнута на r против часовой
    if (r === 90) { x.translate(0, h); x.rotate(-Math.PI / 2); }
    else if (r === 270) { x.translate(w, 0); x.rotate(Math.PI / 2); }
    // лёгкое дрожание руки: сдвиг на долю пикселя (иначе кадры одинаковы и проверять нечего)
    const dx = Math.sin(t * 0.2) * 0.6, dy = Math.cos(t * 0.17) * 0.6;
    if (img.complete) x.drawImage(img, dx, dy, W, Hh);
    x.restore();
  };
  setInterval(draw, 33);
  const stream = c.captureStream(30);
  navigator.mediaDevices.getUserMedia = async () => { draw(); return stream; };
  navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'fake', label: 'fake' }];
})();`;

(async () => {
  const { page: p, errors, close, url, context } = await launch({ port: 8960, viewport: { width: 420, height: 760 } });
  await context.addInitScript(FAKE);
  await p.goto(`${url}/app/index.html?uiangle=0`);
  await p.waitForTimeout(800);
  if (!(await p.evaluate(() => document.body.classList.contains('running')))) await p.click('#btn-start');
  await p.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  await p.evaluate(() => window.artcam.arBegin());
  await p.waitForFunction(() => window.artcam.ar.mode === 'select', null, { timeout: 60000 });
  await p.waitForTimeout(500);
  for (const c of CARD) {
    await p.evaluate((v) => window.artcam.onCornerTap(window.artcam.stage.toScreen(v)), c);
    await p.waitForTimeout(250);
  }
  await p.waitForFunction(() => window.artcam.ar.mode === 'tracking', null, { timeout: 20000 });
  await p.waitForTimeout(1500);
  const quad = () => p.evaluate(() => {
    const a = window.artcam.ar, H = a.H;
    const ap = ([x, y]) => { const k = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / k, (H[3] * x + H[4] * y + H[5]) / k]; };
    return { q: a.refCanvas.map(ap), mode: a.mode, state: a.state, rot: window.artcam.orient.rot, ui: window.artcam.orient.ui,
      vw: window.artcam.stage.vw, vh: window.artcam.stage.vh, cls: document.body.className };
  });
  const dq = (a, b) => Math.max(...a.map((pt, i) => Math.hypot(pt[0] - b[i][0], pt[1] - b[i][1])));
  const q0 = await quad();
  check(q0.state === 'tracking' && dq(q0.q, CARD) < 6, `AR включён, рамка на карте (отклонение ${dq(q0.q, CARD).toFixed(1)} px)`);
  await p.screenshot({ path: path.join(DATA, 'orient-0.png') });

  // «повернули телефон против часовой»: поток альбомный, картинка в нём повёрнута; экран и окно — альбомные
  const turn = async (rot, uiAngle, vp) => {
    await p.evaluate(([r, a]) => { window.__rot = r; window.artcam.orient.forceUi = a; }, [rot, uiAngle]);
    await p.setViewportSize(vp);
    await p.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await p.waitForTimeout(1800);
    return quad();
  };
  const q1 = await turn(90, 90, { width: 760, height: 420 });
  check(q1.mode === 'tracking', `телефон повернули (альбомная): AR не сбросился (${q1.mode})`);
  check(q1.rot === 90 && q1.ui === 90 && q1.cls.includes('ui-rot-90'), `кадр повёрнут обратно на ${q1.rot}°, интерфейс — навстречу экрану (${q1.ui}°)`);
  check(q1.vw === q0.vw && q1.vh === q0.vh, `кадр в закреплённой ориентации тех же размеров (${q1.vw}×${q1.vh})`);
  check(q1.state === 'tracking' && dq(q1.q, q0.q) < 3, `рамка осталась на карте (сдвиг ${dq(q1.q, q0.q).toFixed(1)} px)`);
  await p.screenshot({ path: path.join(DATA, 'orient-90.png') });
  // на экране картинка стоит как до поворота: верх страницы смотрит в ту же сторону телефона
  const vis = await p.evaluate(() => {
    const r = document.querySelector('#stage').getBoundingClientRect();
    return { w: r.width, h: r.height, iw: innerWidth, ih: innerHeight };
  });
  check(Math.abs(vis.w - vis.iw) < 2 && Math.abs(vis.h - vis.ih) < 2, `повёрнутая страница занимает весь экран (${vis.w}×${vis.h})`);

  // обратно в книжную
  const q2 = await turn(0, 0, { width: 420, height: 760 });
  check(q2.mode === 'tracking' && q2.rot === 0 && !q2.cls.includes('ui-rot') && dq(q2.q, q0.q) < 3, `вернули в книжную: всё на месте (сдвиг ${dq(q2.q, q0.q).toFixed(1)} px)`);

  // повернули по часовой, а угол экрана сообщён неверно (90 вместо 270): направление поворота потока определяется по картинке
  const q3 = await turn(270, 90, { width: 760, height: 420 });
  check(q3.rot === 270, `направление поворота потока определено по картинке (${q3.rot}°, угол экрана говорил 90°)`);
  check(q3.mode === 'tracking' && q3.state === 'tracking' && dq(q3.q, q0.q) < 3, `рамка на карте (сдвиг ${dq(q3.q, q0.q).toFixed(1)} px)`);

  // касание в повёрнутой странице попадает в ту же точку кадра (кнопки и углы работают)
  const tp = await p.evaluate(() => {
    const st = window.artcam.stage, o = window.artcam.orient;
    const v = [300, 400], sp = st.toScreen(v); // точка в координатах страницы
    // где она на экране (обратное к toUi)
    const iw = innerWidth, ih = innerHeight;
    const cl = o.ui === 90 ? [sp[1], ih - sp[0]] : o.ui === 270 ? [iw - sp[1], sp[0]] : sp;
    const back = st.eventPoint({ clientX: cl[0], clientY: cl[1] });
    return Math.hypot(back[0] - sp[0], back[1] - sp[1]);
  });
  check(tp < 0.5, 'касание по экрану переводится в координаты повёрнутой страницы');

  await p.evaluate(() => window.artcam.arStop(true));
  await p.waitForTimeout(400);
  const off = await p.evaluate(() => ({ cls: document.body.className, rot: window.artcam.orient.rot, tf: document.body.style.transform }));
  check(!off.cls.includes('ui-rot') && off.rot === 0 && !off.tf, 'AR выключили — страница и кадр в обычной ориентации');
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors.slice(0, 3)) : ''));
  await close();
})().catch((e) => { console.error(e); process.exit(1); });
