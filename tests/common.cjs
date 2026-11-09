const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const serve = require('./serve.cjs');

const DATA = path.join(__dirname, '.data');
const CV_LOCAL = require.resolve('@techstark/opencv-js/dist/opencv.js');

/** Браузер с фейковой камерой; OpenCV.js с CDN подменяется локальной копией из node_modules. */
async function launch({ port, viewport = { width: 420, height: 860 }, camera = false }) {
  const srv = await serve(port);
  const args = camera ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${path.join(DATA, 'fake.y4m')}`] : [];
  const browser = await chromium.launch({ args });
  const ctx = await browser.newContext({ viewport, permissions: camera ? ['camera'] : [] });
  const cv = fs.readFileSync(CV_LOCAL);
  await ctx.route(/opencv-js@[\d.]+-release\.\d+\/dist\/opencv\.js/, (r) => r.fulfill({ body: cv, contentType: 'text/javascript' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  const close = async () => { await browser.close(); srv.close(); };
  return { page, errors, close, url: `http://localhost:${port}` };
}

function check(cond, msg) {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) process.exitCode = 1;
}

if (!fs.existsSync(path.join(DATA, 'main', 'gt.json'))) {
  console.error('Нет тестовых данных: сначала запустите `python3 tests/gen_scene.py`');
  process.exit(1);
}

/** Номер кадра сцены main, зашитый штрихкодом (10 бит) в левый нижний угол видео 640×360. */
const IDX_SRC = `(() => {
  const v = document.querySelector('#video');
  const c = document.createElement('canvas'); c.width = 80; c.height = 10;
  const ctx = c.getContext('2d'); ctx.drawImage(v, 0, 350, 80, 10, 0, 0, 80, 10);
  const d = ctx.getImageData(0, 0, 80, 10).data;
  let idx = 0;
  for (let i = 0; i < 10; i++) if (d[(5 * 80 + 8 * i + 4) * 4] > 128) idx |= 1 << i;
  return idx;
})()`;
const frameIndex = (page) => page.evaluate(IDX_SRC);
/** Дождаться, пока сцена окажется в «чистой» фазе (кадры a..b): выбор углов начинаем оттуда. */
const waitFrame = (page, a, b) => page.waitForFunction(`(() => { const i = ${IDX_SRC}; return i >= ${a} && i <= ${b}; })()`, null, { polling: 15, timeout: 30000 });

module.exports = { launch, check, DATA, frameIndex, waitFrame };
