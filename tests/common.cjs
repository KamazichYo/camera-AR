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

if (!fs.existsSync(path.join(DATA, 'gt.json'))) {
  console.error('Нет тестовых данных: сначала запустите `python3 tests/gen_scene.py`');
  process.exit(1);
}

module.exports = { launch, check, DATA };
