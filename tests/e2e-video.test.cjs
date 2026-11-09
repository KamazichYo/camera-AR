// Сквозной сценарий на тренировочном видео пользователя (tests/.data/video — локально, не коммитится):
// камера идёт (с рук, холст движется), пользователь НА ЖИВОМ ВИДЕО нажимает на 4 угла в случайном
// порядке «неточным пальцем» → точки садятся на углы и едут вместе с ними → после 4-й AR включается сам
// и рамка холста держится на холсте.
// Запуск раскадровки для глаз: tests/.data/video/e2e-*.png
const fs = require('fs');
const path = require('path');
const { launch, check, DATA, frameIndex, waitFrame } = require('./common.cjs');

const DIR = path.join(DATA, 'video');
if (!fs.existsSync(path.join(DIR, 'training.y4m')) || !fs.existsSync(path.join(DIR, 'ref.json'))) {
  console.log('– нет tests/.data/video/training.y4m или ref.json (python3 tests/make_video.py), пропуск');
  process.exit(0);
}
const REF = JSON.parse(fs.readFileSync(path.join(DIR, 'ref.json'), 'utf8')); // кадр (1-based) → рамка холста

(async () => {
  const { page: p, errors, close, url } = await launch({ port: 8870, camera: true, viewport: { width: 800, height: 600 },
    video: path.join(DIR, 'training.y4m') });
  const shot = (n) => p.screenshot({ path: path.join(DIR, `e2e-${n}.png`) });
  await p.goto(`${url}/app/index.html`);
  await p.waitForTimeout(1500);
  if (!(await p.evaluate(() => document.body.classList.contains('running')))) await p.click('#btn-start');
  await p.waitForFunction(() => document.querySelector('#video').videoWidth > 0, null, { timeout: 20000 });
  await p.setInputFiles('#file', path.join(DATA, 'ref.png'));
  await p.waitForFunction(() => window.artcam.ref.loaded);
  await p.evaluate(() => { window.artcam.S.opacity = 0.45; });

  // AR запускаем в начале видео: пока грузится модуль, оно уже идёт; на 4 касания нужно ~1 с
  await waitFrame(p, 1, 6);
  await p.click('#btn-ar');
  await p.waitForFunction(() => window.artcam.ar.mode === 'select', null, { timeout: 60000 });
  check(!(await p.evaluate(() => document.querySelector('#video').paused)), 'видео не замирает во время выбора углов');
  check((await p.textContent('#ar-hint')).includes('Нажмите на углы холста'), 'подсказка — «Нажмите на углы холста»');
  {
    // никакой плашки сверху: центр верхней трети экрана отдан камере, кнопки выбора — круглые и внизу
    const ui = await p.evaluate(() => {
      const vh = innerHeight, vw = innerWidth;
      const top = document.elementFromPoint(vw / 2, vh * 0.2);
      const rect = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { t: r.top, h: r.height, w: r.width }; };
      return {
        vh, topOk: !!top && !top.closest('.ui-block'), bar: getComputedStyle(document.querySelector('#ar-select-bar')).pointerEvents,
        back: rect('#ar-back'), cancel: rect('#ar-cancel'), hint: rect('#ar-hint'),
        plate: !!document.querySelector('.sel-pill'),
      };
    });
    check(ui.topOk && !ui.plate, 'сверху нет плашки: верхняя часть экрана свободна под камеру');
    check(ui.back.t > ui.vh * 0.6 && ui.cancel.t > ui.vh * 0.6 && Math.abs(ui.back.w - ui.back.h) < 1, 'кнопки «назад» и «отмена» — круглые и внизу');
    check(ui.bar === 'none', 'блок выбора пропускает касания (углы можно отмечать и под ним)');
  }

  // касания: углы 2,0,3,1 (BR, TL, BL, TR), «палец» промахивается на 7–12 px
  const jit = [[9, -7], [-8, 6], [7, 9], [-6, -8]];
  const order = [2, 0, 3, 1];
  const taps = [];
  for (let k = 0; k < 4; k++) {
    // подождать, пока в кадре есть опорная рамка (кадры ≥ 6) и ещё не конец ролика
    await p.waitForFunction(`(() => { const c = document.createElement('canvas'); c.width = 80; c.height = 10; const x = c.getContext('2d'); x.drawImage(document.querySelector('#video'), 0, 350, 80, 10, 0, 0, 80, 10); const d = x.getImageData(0, 0, 80, 10).data; let i = 0; for (let b = 0; b < 10; b++) if (d[(5 * 80 + 8 * b + 4) * 4] > 128) i |= 1 << b; return i >= ${8 + 14 * k} && i <= 150; })()`, null, { polling: 10, timeout: 30000 });
    const idx = await frameIndex(p);       // 0-based
    const q = REF[idx + 1];
    const tp = [q[order[k]][0] + jit[k][0], q[order[k]][1] + jit[k][1]];
    const [sx, sy] = await p.evaluate((pt) => window.artcam.stage.toScreen(pt), tp);
    await p.mouse.click(sx, sy);
    taps.push({ idx, corner: order[k] });
    if (k < 3) {
      await p.waitForFunction((n) => window.artcam.ar.corners.length === n && !window.artcam.ar.pendingTap, k + 1, { timeout: 15000 });
      if (k === 1) await shot('2-two-points');
    }
  }
  await p.waitForFunction(() => window.artcam.ar.mode === 'tracking', null, { timeout: 15000 });
  const lockIdx = await frameIndex(p);
  await shot('3-locked');
  check(true, `касания на кадрах ${taps.map((t) => t.idx).join(', ')} — AR включился сам после 4-го (кадр ${lockIdx})`);

  // рамка холста сразу после запуска совпадает с эталоном
  const e0 = await p.evaluate(() => window.artcam.ar.refCanvas);
  const errAt = (q, idx) => q.reduce((s, pt, i) => s + Math.hypot(pt[0] - REF[idx + 1][i][0], pt[1] - REF[idx + 1][i][1]), 0) / 4;
  const lockErr = Math.min(...[-3, -2, -1, 0, 1, 2].map((d) => errAt(e0, Math.min(160, Math.max(3, lockIdx + d)))));
  check(lockErr < 6, `рамка в момент запуска на углах холста (ошибка ≤ ${lockErr.toFixed(1)} px)`);

  // слежение: сравниваем рамку на экране с эталоном на том же кадре (кадр читаем из штрихкода)
  const errs = []; let lost = 0, n = 0, shots = 0;
  for (let i = 0; i < 40; i++) {
    await p.waitForTimeout(60);
    const s = await p.evaluate(() => ({ st: window.artcam.ar.state, q: window.artcam.ar.refCanvas.map((pt) => window.artcam.stage ? pt : pt), H: window.artcam.ar.H }));
    const idx = await frameIndex(p);
    if (idx + 1 > 159 || idx < lockIdx) break; // дошли до конца ролика (дальше он перематывается)
    n++; if (s.st !== 'tracking') { lost++; continue; }
    const cur = s.q.map(([x, y]) => { const k = s.H[6] * x + s.H[7] * y + s.H[8]; return [(s.H[0] * x + s.H[1] * y + s.H[2]) / k, (s.H[3] * x + s.H[4] * y + s.H[5]) / k]; });
    // кадр на экране может опережать/отставать от позы на 1–2 кадра
    errs.push(Math.min(...[-2, -1, 0, 1, 2].map((d) => errAt(cur, Math.min(160, Math.max(3, idx + d))))));
    if (i % 12 === 5 && shots < 3) await shot(`4-track-${++shots}`);
  }
  errs.sort((a, b) => a - b);
  const med = errs[errs.length >> 1], max = errs[errs.length - 1];
  check(n >= 12 && lost <= 1, `трекинг держится на ${n - lost} из ${n} проверок`);
  check(med < 4 && max < 9, `рамка остаётся на холсте при движении камеры (ошибка мед. ${med?.toFixed(1)} px, макс. ${max?.toFixed(1)} px)`);
  // точки опоры: кнопка → касания по сцене → маркеры; «готово» закрывает режим, метки остаются
  await p.click('#btn-anchor');
  check(await p.evaluate(() => document.body.classList.contains('anchoring') && !document.querySelector('#ar-select-bar').hidden), 'режим точек опоры включился (кнопка вверху, управление внизу)');
  const [ax, ay] = await p.evaluate(() => { const s = window.artcam.stage; return s.toScreen([s.vw * 0.12, s.vh * 0.85]); });
  await p.mouse.click(ax, ay);
  await p.waitForFunction(() => window.artcam.ar.anchors.length === 1, null, { timeout: 5000 });
  await p.waitForTimeout(300);
  check(await p.evaluate(() => document.querySelectorAll('#ui-layer .anchor-ring').length === 1), 'точка опоры отмечена и нарисована');
  await shot('5-anchor');
  await p.click('#ar-back');
  check(await p.evaluate(() => window.artcam.ar.anchors.length === 0), '«Назад» убирает последнюю точку опоры');
  await p.mouse.click(ax, ay);
  await p.waitForFunction(() => window.artcam.ar.anchors.length === 1, null, { timeout: 5000 });
  await p.click('#ar-cancel');
  check(await p.evaluate(() => !document.body.classList.contains('anchoring') && document.querySelector('#ar-select-bar').hidden && window.artcam.ar.anchors.length === 1), '«Готово» закрывает режим, точка остаётся');
  await p.waitForTimeout(400);
  check(await p.evaluate(() => window.artcam.ar.state === 'tracking'), 'трекинг идёт и с точкой опоры');
  check(errors.length === 0, 'без ошибок в консоли ' + (errors.length ? JSON.stringify(errors.slice(0, 3)) : ''));
  await close();
})().catch((e) => { console.error(e); process.exit(1); });
