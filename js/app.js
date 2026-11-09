// ArtCam — камера художника: запись процесса, референс поверх холста, AR-привязка.
import {
  IDENTITY, apply, applyQuad, invert, cssMatrix3d, fitRect, fitIntoQuad, centroid, similarity,
  isConvexQuad, QuadKalman, orderQuad, dist,
} from './geometry.js';
import { Stage, QuadEditor } from './stage.js';
import { Camera } from './camera.js';
import { Recorder, findOrphans, removeRecordingFile, stamp } from './recorder.js';
import { Reference } from './reference.js';
import { ArTracker } from './tracker.js';
import { SyncView } from './syncview.js';
import { idbGet, idbSet, idbDel, loadSettings, saveSettings } from './storage.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const DEFAULTS = {
  opacity: 0.5, visible: true, pinned: false,
  mode: 'color', lineColor: '#ff2d55', grid: false, gridN: 6,
  resolution: '1080', deviceId: null, facing: 'environment', fit: 'contain',
  mic: false, bitrate: 6_000_000,
  showCanvasFrame: true, surroundings: false, smoothing: 0.5,
  wakeLock: true, stats: false, syncView: true,
  quadN: null,
};
const S = loadSettings(DEFAULTS);
const DEBUG = { predict: true }; // переключатели для автотестов
const persist = () => saveSettings(S);

// ---------- объекты ----------
const video = $('#video');
const stage = new Stage($('#stage'), $('#world'), video);
const camera = new Camera(video);
const recorder = new Recorder();
const ref = new Reference();
const tracker = new ArTracker(video);
const sync = new SyncView(video, $('#view'));
$('#world').appendChild(ref.canvas);

let overlayQuad = null;            // рамка референса в координатах видео (без AR)
const ar = {
  mode: 'off',                     // off | loading | select | tracking
  state: 'tracking',               // tracking | lost
  H: IDENTITY,                     // опорный кадр → текущий (координаты видео)
  corners: [],                     // отмеченные углы (их ведёт воркер): { p, snapped, lost }
  anchors: [],                     // точки опоры (неподвижные предметы), в координатах опорного кадра
  anchorMode: false,               // идёт отметка точек опоры
  pendingTap: null,                // касание, которое ещё притягивается к углу: [x, y]
  refCanvas: null,                 // холст в опорном кадре
  refOverlay: null,                // референс в опорном кадре
  lostSince: 0,
  info: null,
};
// Сглаживание поз: фильтр Калмана на каждый угол; показ — на времени показанного видеокадра
const kfRef = new QuadKalman();     // рамка референса
const kfCanvas = new QuadKalman();  // рамка холста (зелёная)
const resetSmoothing = () => { kfRef.reset(); kfCanvas.reset(); sync.clearPoses(); };
let editing = false;
let displayQuad = null;

// ---------- утилиты UI ----------
let toastTimer;
function toast(text, { action, onAction, ms = 3500 } = {}) {
  const el = $('#toast');
  el.innerHTML = '';
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (action) {
    const b = document.createElement('button');
    b.textContent = action;
    b.onclick = () => { el.classList.remove('show'); onAction(); };
    el.appendChild(b);
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? Math.max(ms, 8000) : ms);
}

function setFilterSmoothing() {
  // 0 — отзывчиво (дрожит), 1 — максимально плавно. Параметры заданы для кадра шириной 480 px
  // и масштабируются под размер видео.
  const k = S.smoothing, sc = (video.videoWidth || 480) / 480;
  for (const f of [kfRef, kfCanvas]) {
    f.accel = 2400 * (1 - 0.8 * k) * sc;   // насколько резко может меняться движение
    f.meas = 0.5 * sc;                      // шум измерения позы
    f.gate = 40 * sc;                       // больший скачок — это перепривязка, а не шум
  }
}

const fmtTime = (ms) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
};

// ---------- запуск камеры ----------
async function startCamera(opts = {}) {
  if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('nomedia'), { name: 'NoMedia' });
  const wasAr = ar.mode === 'tracking' || ar.mode === 'select';
  if (wasAr) arStop(true);
  const prev = { w: video.videoWidth, h: video.videoHeight };
  await camera.start({ deviceId: S.deviceId, resolution: S.resolution, facing: S.facing, ...opts });
  S.deviceId = camera.deviceId; persist();
  stage.layout();
  // сохранить положение референса при смене разрешения
  if (overlayQuad && prev.w && (prev.w !== video.videoWidth || prev.h !== video.videoHeight)) {
    const kx = video.videoWidth / prev.w, ky = video.videoHeight / prev.h;
    overlayQuad = overlayQuad.map(([x, y]) => [x * kx, y * ky]);
  }
  if (ref.loaded && (!overlayQuad || !prev.w)) restoreQuad();
  lastDims = { w: video.videoWidth, h: video.videoHeight };
  startShownClock();
  setFilterSmoothing();
  updateCameraControls();
  requestWakeLock();
  if (wasAr) toast('Камера изменена — включите AR заново');
}

function cameraError(e) {
  const map = {
    NotAllowedError: 'Доступ к камере запрещён. Разрешите его в настройках браузера и обновите страницу.',
    NotFoundError: 'Камера не найдена.',
    NotReadableError: 'Камера занята другим приложением.',
    InsecureContext: 'Камера работает только по HTTPS (или на localhost).',
    NoMedia: 'Этот браузер не поддерживает доступ к камере.',
    OverconstrainedError: 'Камера не поддерживает выбранные параметры.',
  };
  return map[e.name] || `Не удалось включить камеру: ${e.message || e.name}`;
}

async function boot() {
  $('#start-error').textContent = '';
  $('#btn-start').disabled = true;
  try {
    await startCamera();
    $('#start-screen').hidden = true;
    document.body.classList.add('running');
    checkOrphans();
  } catch (e) {
    console.error(e);
    $('#start-error').textContent = cameraError(e);
  } finally {
    $('#btn-start').disabled = false;
  }
}

// ---------- референс ----------
function defaultQuad() {
  const r = stage.visibleRect();
  return fitRect(ref.width, ref.height, r.cx, r.cy, r.w * 0.8, r.h * 0.8);
}

function restoreQuad() {
  const q = S.quadN && S.quadN.map(([x, y]) => [x * stage.vw, y * stage.vh]);
  overlayQuad = q && isConvexQuad(q) ? q : defaultQuad();
}

function saveQuad() {
  if (ar.mode === 'tracking' || !overlayQuad) return;
  S.quadN = overlayQuad.map(([x, y]) => [x / stage.vw, y / stage.vh]);
  persist();
}

function renderReference() {
  ref.render({ mode: S.mode, lineColor: S.lineColor, grid: S.grid, gridN: S.gridN });
}

async function loadReference(blob, { fresh = true } = {}) {
  try {
    await ref.load(blob);
  } catch (e) {
    toast(e.message || 'Не удалось открыть изображение');
    return;
  }
  renderReference();
  if (fresh) {
    const cq = currentCanvasQuad();
    const q = cq ? fitIntoQuad(ref.aspect, cq) : defaultQuad();
    setOverlayQuad(q);
    saveQuad();
    idbSet('reference', blob);
    S.visible = true; persist();
  } else restoreQuad();
  updateRefControls();
}

function removeReference() {
  ref.clear();
  overlayQuad = null; ar.refOverlay = null;
  S.quadN = null; persist();
  idbDel('reference');
  updateRefControls();
}

/** Текущая рамка холста (если AR активен). */
function currentCanvasQuad() {
  if (ar.mode === 'tracking' && ar.refCanvas) return applyQuad(ar.H, ar.refCanvas);
  return null;
}

function setOverlayQuad(q) {
  overlayQuad = q;
  if (ar.mode === 'tracking') {
    const inv = invert(ar.H);
    if (inv) ar.refOverlay = applyQuad(inv, q);
  }
}

const overlayEditor = new QuadEditor(stage, {
  getQuad: () => (ref.loaded ? displayQuad || overlayQuad : null),
  setQuad: (q) => setOverlayQuad(q),
  onStart: () => { editing = true; overlayQuad = displayQuad || overlayQuad; },
  onEnd: () => { editing = false; resetSmoothing(); saveQuad(); },
});

function updateEditors() {
  overlayEditor.enabled = ar.mode !== 'select' && !ar.anchorMode && ref.loaded && !S.pinned && S.visible;
}

// ---------- AR ----------
async function arBegin() {
  if (ar.mode !== 'off') return;
  ar.mode = 'loading';
  updateArUi();
  try {
    if (!tracker.loaded) toast('Загружаю AR-модуль (≈10 МБ, только в первый раз)…', { ms: 15000 });
    await tracker.init();
    if (ar.mode !== 'loading') return;
    ar.corners = []; ar.pendingTap = null;
    $('#toast').classList.remove('show'); // «Загружаю AR-модуль…» больше не нужна
    ar.mode = 'select';
    updateArUi();
    await tracker.selStart(); // камера идёт как обычно; точки, отмеченные касанием, ведутся по кадрам
  } catch (e) {
    console.error(e);
    ar.mode = 'off';
    updateArUi();
    toast('Не удалось загрузить AR-модуль. Проверьте подключение к интернету.');
  }
}

// ---------- выбор холста касаниями на живой камере ----------
// Касание по углу холста ставит точку прямо на углу, и она сразу ведётся вместе с картинкой.
// Углы отмечаются в любом порядке; после четвёртого рамка строится и AR стартует сам.
let tapBusy = false;
let lostWarned = false;
let noCornerHinted = false;

tracker.onSel = (pts, reset) => {
  if (ar.mode !== 'select' || tapBusy) return;
  const n = ar.corners.length;
  ar.corners = pts;
  if (reset) toast('Ориентация изменилась — отметьте углы заново');
  if (pts.some((c) => c.lost) && !lostWarned) {
    lostWarned = true;
    toast('Угол потерялся. «Назад» — и отметьте его заново.', { ms: 4000 });
  }
  if (pts.length !== n) updateArUi();
};

async function onCornerTap(sp) {
  if (ar.mode !== 'select' || tapBusy || ar.corners.filter((c) => !c.lost).length >= 4) return;
  const v = stage.toVideo(sp);
  if (v[0] < 0 || v[1] < 0 || v[0] > stage.vw || v[1] > stage.vh) return;
  if (ar.corners.some((c) => dist(stage.toScreen(c.p), sp) < 26)) { toast('Этот угол уже отмечен', { ms: 1500 }); return; }
  tapBusy = true;
  ar.pendingTap = v; // сразу показываем, что касание принято
  try {
    const r = await tracker.selTap(v, { fullFrame: S.surroundings });
    if (ar.mode !== 'select') return; // успели выйти
    if (r.locked) { onLocked(r.info); return; }
    ar.corners = r.pts;
    if (r.badQuad) toast('Эти точки не складываются в четырёхугольник. «Назад» — и отметьте угол заново.', { ms: 4500 });
    else if (!r.snapped && !noCornerHinted) {
      noCornerHinted = true; // один раз за выбор: на ладони или гладкой бумаге углов нет, и так задумано
      toast('Угла рядом нет — точка остаётся там, где нажали. Для ладони и гладкой бумаги так и надо.', { ms: 3500 });
    }
  } catch (e) {
    console.error(e);
    toast('Не удалось отметить угол: ' + e.message);
  } finally {
    ar.pendingTap = null;
    tapBusy = false;
    updateArUi();
  }
}

/** «Назад»: убрать последний отмеченный угол. */
async function selectBack() {
  if (ar.mode !== 'select' || tapBusy) return;
  tapBusy = true;
  try { ar.corners = await tracker.selBack(); lostWarned = false; } catch { /* не критично */ }
  tapBusy = false;
  updateArUi();
}

// ---------- точки опоры ----------
// Неподвижные предметы рядом с холстом (стол, подставка, лента, провод): их точки ведутся потоком вместе с холстом и
// держат позу, когда сам холст закрыт рукой или у него нет деталей. Точки хранятся в опорных координатах.
async function onAnchorTap(sp) {
  if (ar.mode !== 'tracking' || !ar.anchorMode) return;
  const v = stage.toVideo(sp);
  if (v[0] < 0 || v[1] < 0 || v[0] > stage.vw || v[1] > stage.vh) return;
  const inv = invert(ar.H);
  if (!inv) return;
  if (ar.anchors.length >= 8) { toast('Достаточно: до 8 точек опоры', { ms: 1800 }); return; }
  if (ar.anchors.some((a) => dist(stage.toScreen(apply(ar.H, a)), sp) < 30)) { toast('Здесь точка уже есть', { ms: 1200 }); return; }
  ar.anchors.push(apply(inv, v));
  updateArUi();
  try { await tracker.addAnchor(v); } catch (e) { console.error(e); ar.anchors.pop(); updateArUi(); }
}

async function anchorBack() {
  if (!ar.anchors.length) return;
  ar.anchors.pop();
  updateArUi();
  try { await tracker.removeAnchor(false); } catch { /* не критично */ }
}

function setAnchorMode(on) {
  if (on && ar.mode !== 'tracking') return;
  ar.anchorMode = on;
  updateArUi();
}

// одиночное касание по сцене = отметка угла (перетаскивание и щипок касанием не считаются)
const tap = { id: null, x: 0, y: 0, t: 0 };
function bindTaps() {
  const el = stage.el;
  el.addEventListener('pointerdown', (e) => {
    if (!(ar.mode === 'select' || (ar.mode === 'tracking' && ar.anchorMode)) || (e.target.closest && e.target.closest('.ui-block'))) return;
    if (tap.id !== null) { tap.id = null; return; } // второй палец — не касание
    Object.assign(tap, { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() });
  });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerId !== tap.id) return;
    const ok = Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 14 && performance.now() - tap.t < 800;
    tap.id = null;
    if (ok) (ar.mode === 'select' ? onCornerTap : onAnchorTap)(stage.eventPoint(e));
  });
  el.addEventListener('pointercancel', () => { tap.id = null; });
}

/** Четвёртый угол отмечен: воркер построил рамку и уже ведёт холст — включаем AR. */
function onLocked(info) {
  const q = info.quad;
  ar.refCanvas = q;
  ar.H = IDENTITY;
  ar.state = 'tracking';
  ar.lostSince = 0;
  ar.corners = [];
  ar.anchors = []; ar.anchorMode = false;
  // референс сразу ложится на холст (его потом можно подвинуть)
  if (ref.loaded) { overlayQuad = fitIntoQuad(ref.aspect, q); S.visible = true; }
  ar.refOverlay = overlayQuad ? overlayQuad.map((p) => [...p]) : null;
  resetSmoothing();
  setFilterSmoothing();
  if (S.syncView) sync.start();
  ar.mode = 'tracking';
  updateArUi();
  if (info.weak) {
    toast('Холст почти не отличается от фона и на нём нет деталей — трекинг будет неустойчивым. Подложите под холст контрастный фон, наклейте метки (малярный скотч) или включите «Учитывать окружение».', { ms: 8000 });
  } else toast('AR включён — рамка привязана к холсту. Встала не так? Нажмите AR и отметьте углы заново.', { ms: 4500 });
}

function arStop(silent = false) {
  if (ar.mode === 'tracking' && displayQuad) overlayQuad = displayQuad.map((p) => [...p]);
  tracker.stop();
  sync.stop();
  document.body.classList.remove('synced');
  ar.mode = 'off';
  ar.refCanvas = null; ar.refOverlay = null; ar.corners = []; ar.pendingTap = null; lostWarned = false; noCornerHinted = false;
  ar.anchors = []; ar.anchorMode = false;
  ar.H = IDENTITY;
  saveQuad();
  updateArUi();
  if (!silent) toast('AR выключен — референс зафиксирован на экране');
}

tracker.onPose = (H, info, frameTime) => {
  if (ar.mode !== 'tracking') return;
  ar.info = info;
  if (info.anchorsDropped && ar.anchors.length) {
    ar.anchors = [];
    toast('Точки опоры не согласуются с холстом (его двигают отдельно от окружения) — отключил. Отметьте их заново, если холст снова неподвижен.', { ms: 6000 });
    updateArUi();
  }
  if (info.state === 'tracking') {
    if (ar.state !== 'tracking') resetSmoothing(); // после потери поза могла «прыгнуть»
    // поза относится к кадру, показанному в момент frameTime — в фильтр она идёт с этим временем
    if (ar.refOverlay) kfRef.update(applyQuad(H, ar.refOverlay), frameTime);
    if (ar.refCanvas) kfCanvas.update(applyQuad(H, ar.refCanvas), frameTime);
    if (sync.active) sync.addPose(frameTime, H);
    ar.poseT = frameTime;
    ar.H = H;
    ar.lostSince = 0;
  } else if (!ar.lostSince) ar.lostSince = performance.now();
  if (ar.state !== info.state) { ar.state = info.state; updateArUi(); }
};

// Часы показанного видеокадра: референс рисуется на момент ЭТОГО кадра, поэтому между видеокадрами он
// стоит на месте вместе с картинкой (а не «ползёт» с частотой отрисовки экрана).
function startShownClock() {
  if (!('requestVideoFrameCallback' in video) || startShownClock.on) return;
  startShownClock.on = true;
  const cb = (now, md) => { ar.shownT = (md && md.presentationTime) || now; video.requestVideoFrameCallback(cb); };
  video.requestVideoFrameCallback(cb);
}

function updateArUi() {
  const pill = $('#ar-pill');
  const btn = $('#btn-ar');
  btn.classList.toggle('on', ar.mode === 'tracking' || ar.mode === 'select');
  btn.classList.toggle('busy', ar.mode === 'loading');
  const anchoring = ar.mode === 'tracking' && ar.anchorMode;
  $('#ar-select-bar').hidden = !(ar.mode === 'select' || anchoring);
  document.body.classList.toggle('selecting', ar.mode === 'select');
  document.body.classList.toggle('anchoring', anchoring);
  if (ar.mode === 'select') {
    const n = ar.corners.length;
    $$('#ar-dots i').forEach((d, i) => d.classList.toggle('on', i < n));
    $('#ar-back').disabled = n === 0;
    $('#ar-back').title = 'Назад — убрать последний угол';
    $('#ar-cancel').title = 'Отмена';
    $('#ar-hint').textContent = 'Нажмите на углы холста';
  } else if (anchoring) {
    const n = ar.anchors.length;
    $('#ar-back').disabled = n === 0;
    $('#ar-back').title = 'Назад — убрать последнюю точку опоры';
    $('#ar-cancel').title = 'Готово';
    $('#ar-hint').textContent = n ? 'Точек опоры: ' + n + '. Ещё — нажмите на неподвижный предмет' : 'Нажмите на неподвижные предметы рядом: стол, провод. Не руки и не карандаш';
  }
  const btnAnchor = $('#btn-anchor');
  btnAnchor.hidden = ar.mode !== 'tracking';
  btnAnchor.classList.toggle('on', anchoring);
  $('.toolbar').classList.toggle('dimmed', ar.mode === 'select' || anchoring);
  pill.hidden = ar.mode === 'off';
  pill.className = 'pill';
  if (ar.mode === 'loading') { pill.textContent = 'AR: загрузка…'; }
  else if (ar.mode === 'select') { pill.textContent = 'AR: углы ' + ar.corners.length + '/4'; }
  else if (ar.mode === 'tracking') {
    const lost = ar.state !== 'tracking';
    pill.textContent = lost ? 'AR: холст потерян' : 'AR: отслеживание';
    pill.classList.add(lost ? 'warn' : 'ok');
  }
  $('#btn-fit-canvas').disabled = ar.mode !== 'tracking' || !ref.loaded;
  updateEditors();
}

// ---------- кадр отрисовки ----------
let lastCss = '', lastSvg = '';
function frame(t) {
  requestAnimationFrame(frame);
  if (!video.videoWidth) return;

  // Синхронный показ: выбираем кадр с небольшой задержкой и интерполируем позу между соседними обработанными
  // кадрами — картинка и референс двигаются жёстко вместе. Без поддержки — фильтр Калмана на момент показанного кадра.
  let syncT = null;
  if (sync.active && sync.failed) {
    // телефон не успевает снимать кадры для показа (или браузер не умеет) — обычное видео и фильтр Калмана
    sync.stop();
    document.body.classList.remove('synced');
    toast('Плавный показ выключен: устройство не успевает. Рамка ведётся по обычному видео.', { ms: 5000 });
  }
  if (sync.active && ar.mode === 'tracking') {
    syncT = sync.frame(t);
    if (syncT !== null && !document.body.classList.contains('synced')) document.body.classList.add('synced');
  }

  // рамка референса
  let canvasQuad = null;
  if (ar.mode === 'tracking' && ar.refOverlay) {
    if (editing) displayQuad = overlayQuad;
    else {
      if (syncT !== null) {
        displayQuad = sync.quadAt(syncT, ar.refOverlay) || applyQuad(ar.H, ar.refOverlay);
        canvasQuad = ar.refCanvas && sync.quadAt(syncT, ar.refCanvas);
      } else {
        displayQuad = kfRef.predict(ar.shownT || t, DEBUG.predict) || applyQuad(ar.H, ar.refOverlay);
      }
      overlayQuad = displayQuad;
    }
  } else displayQuad = overlayQuad;

  const showRef = ref.loaded && S.visible && displayQuad && isConvexQuad(displayQuad);
  let css = 'none';
  if (showRef) css = cssMatrix3d(ref.width, ref.height, displayQuad) || 'none';
  if (css !== lastCss) { ref.canvas.style.transform = css; lastCss = css; }
  let op = showRef ? S.opacity : 0;
  if (ar.mode === 'tracking' && ar.state === 'lost' && ar.lostSince && t - ar.lostSince > 800) op *= 0.4;
  ref.canvas.style.opacity = op;
  ref.canvas.style.visibility = showRef ? 'visible' : 'hidden';

  // интерфейсный слой (в экранных координатах)
  let svg = '';
  const pts = (q) => q.map((p) => stage.toScreen(p).map((v) => v.toFixed(1)).join(',')).join(' ');
  if (ar.mode === 'select') {
    // отмеченные углы (они движутся вместе с картинкой); с трёх точек показываем контур будущей рамки
    const cs = ar.corners.filter((c) => !c.lost);
    if (cs.length >= 2) {
      const poly = cs.length >= 3 ? orderQuad(cs.map((c) => c.p)) : cs.map((c) => c.p);
      svg += `<polyline class="sel-prev" points="${pts(cs.length >= 3 ? [...poly, poly[0]] : poly)}"/>`;
    }
    ar.corners.forEach((c, i) => {
      const [x, y] = stage.toScreen(c.p);
      svg += c.lost
        ? `<circle class="mark lost" cx="${x}" cy="${y}" r="13"/>`
        : `<circle class="mark ${c.snapped ? 'snap' : 'free'}" cx="${x}" cy="${y}" r="13"/><text class="hlabel" x="${x}" y="${y + 5}">${i + 1}</text>`;
    });
    if (ar.pendingTap) {
      const [x, y] = stage.toScreen(ar.pendingTap);
      svg += `<circle class="mark pend" cx="${x}" cy="${y}" r="14"/>`;
    }
  }
  if (ar.mode === 'tracking' && ar.anchors.length) {
    // точки опоры стоят на предметах: позиция — на момент показанного кадра, как и у рамок
    const qa = (syncT !== null && sync.quadAt(syncT, ar.anchors)) || applyQuad(ar.H, ar.anchors);
    for (const p of qa) {
      const [x, y] = stage.toScreen(p);
      svg += '<circle class="anchor-ring" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="10"/><circle class="anchor-dot" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.5"/>';
    }
  }
  if (ar.mode === 'tracking' && S.showCanvasFrame && ar.refCanvas) {
    const q = canvasQuad || kfCanvas.predict(ar.shownT || t, DEBUG.predict) || applyQuad(ar.H, ar.refCanvas);
    if (isConvexQuad(q)) svg += `<polygon class="canvas-frame ${ar.state}" points="${pts(q)}"/>`;
  }
  if (showRef && overlayEditor.enabled) {
    svg += `<polygon class="ref-frame${editing ? ' active' : ''}" points="${pts(displayQuad)}"/>`;
    displayQuad.forEach((p) => {
      const [x, y] = stage.toScreen(p);
      svg += `<circle class="handle" cx="${x}" cy="${y}" r="11"/>`;
    });
  }
  if (svg !== lastSvg) { $('#ui-layer').innerHTML = svg; lastSvg = svg; }

  // статистика
  if (S.stats && ar.mode === 'tracking' && ar.info) {
    const i = ar.info;
    $('#stats').textContent = `${tracker.stats.fps} к/с · ${i.ms} мс · точек ${i.points} · inl ${i.inliers} · kf ${i.keyframes} · ${i.source}${sync.active ? ' · показ с задержкой ' + Math.round(sync.delay) + ' мс, кадр ' + sync.bw + '×' + sync.bh + ' (' + sync.grabMs.toFixed(0) + '+' + sync.drawMs.toFixed(0) + ' мс)' : ''} · анализ ${tracker.procMax}px`;
  } else $('#stats').textContent = '';

  // таймер записи
  if (recorder.state !== 'inactive') $('#rec-time').textContent = fmtTime(recorder.elapsed);
}

// ---------- запись и фото ----------
async function toggleRecord() {
  const btn = $('#btn-record');
  if (recorder.state === 'inactive') {
    try {
      btn.disabled = true;
      await recorder.start(camera.track, { audio: S.mic, bitrate: S.bitrate });
      document.body.classList.add('recording');
      $('#rec-indicator').hidden = false;
      $('#btn-pause').hidden = false;
      updateCameraControls();
      requestWakeLock();
    } catch (e) {
      console.error(e);
      toast('Не удалось начать запись: ' + e.message);
    } finally { btn.disabled = false; }
  } else {
    btn.disabled = true;
    const res = await recorder.stop().catch((e) => { toast('Ошибка записи: ' + e.message); return null; });
    btn.disabled = false;
    document.body.classList.remove('recording', 'paused');
    $('#rec-indicator').hidden = true;
    $('#btn-pause').hidden = true;
    updateCameraControls();
    if (res) showMedia({ kind: 'video', blob: res.blob, name: res.name, storedName: res.storedName, duration: res.duration });
  }
}

function togglePause() {
  if (recorder.state === 'recording') { recorder.pause(); document.body.classList.add('paused'); }
  else if (recorder.state === 'paused') { recorder.resume(); document.body.classList.remove('paused'); }
}

async function takePhoto() {
  const blob = await camera.snapshot();
  if (!blob) return;
  $('#flash').classList.remove('go'); void $('#flash').offsetWidth; $('#flash').classList.add('go');
  showMedia({ kind: 'photo', blob, name: `art-${stamp()}.jpg` });
}

let media = null;
function showMedia(m) {
  closeMedia(true);
  media = { ...m, url: URL.createObjectURL(m.blob) };
  const prev = $('#media-preview');
  prev.innerHTML = '';
  const el = document.createElement(m.kind === 'photo' ? 'img' : 'video');
  el.src = media.url;
  if (m.kind !== 'photo') { el.controls = true; el.playsInline = true; }
  prev.appendChild(el);
  const mb = (m.blob.size / 1048576).toFixed(1);
  $('#media-title').textContent = m.kind === 'photo' ? 'Снимок' : `Запись${m.duration ? ' · ' + fmtTime(m.duration) : ''}`;
  $('#media-info').textContent = `${m.name} · ${mb} МБ`;
  const file = new File([m.blob], m.name, { type: m.blob.type });
  $('#media-share').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
  $('#modal-media').hidden = false;
}

function closeMedia(keepFile = false) {
  if (!media) return;
  $('#modal-media').hidden = true;
  $('#media-preview').innerHTML = '';
  URL.revokeObjectURL(media.url);
  if (!keepFile && media.storedName && media.saved) removeRecordingFile(media.storedName);
  media = null;
}

function saveMedia() {
  const a = document.createElement('a');
  a.href = media.url;
  a.download = media.name;
  document.body.appendChild(a); a.click(); a.remove();
  media.saved = true;
  toast('Файл сохранён в «Загрузки»');
}

async function shareMedia() {
  try {
    const file = new File([media.blob], media.name, { type: media.blob.type });
    await navigator.share({ files: [file], title: media.name });
    media.saved = true;
  } catch (e) { if (e.name !== 'AbortError') toast('Не удалось поделиться: ' + e.message); }
}

async function deleteMedia() {
  if (media.kind === 'video' && !confirm('Удалить эту запись без сохранения?')) return;
  const name = media.storedName;
  closeMedia(true);
  if (name) await removeRecordingFile(name);
}

async function checkOrphans() {
  const list = await findOrphans().catch(() => []);
  if (!list.length) return;
  const o = list.sort((a, b) => b.file.lastModified - a.file.lastModified)[0];
  toast(`Есть несохранённая запись (${(o.file.size / 1048576).toFixed(0)} МБ)`, {
    action: 'Открыть',
    onAction: () => showMedia({ kind: 'video', blob: o.file.slice(0, o.file.size, o.name.includes('.mp4') ? 'video/mp4' : 'video/webm'), name: o.name.replace(/\.part$/, ''), storedName: o.name }),
  });
}

// ---------- экран не гаснет ----------
let wakeLock = null;
async function requestWakeLock() {
  if (!S.wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    if (!wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch { /* не критично */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWakeLock(); });

// ---------- элементы управления ----------
function openPanel(id) {
  const p = $(id);
  const open = p.hidden;
  $$('.sheet').forEach((s) => { s.hidden = true; });
  p.hidden = !open;
}

function updateRefControls() {
  $('#opacity').value = Math.round(S.opacity * 100);
  $('#opacity-val').textContent = Math.round(S.opacity * 100) + '%';
  $('#btn-eye').classList.toggle('off', !S.visible);
  $('#btn-pin').classList.toggle('on', S.pinned);
  $$('#mode-seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
  $('#line-color').value = S.lineColor;
  $('#grid').checked = S.grid;
  $('#grid-n').value = S.gridN;
  $('#grid-n-val').textContent = S.gridN;
  document.body.classList.toggle('has-ref', ref.loaded);
  $('#btn-fit-canvas').disabled = ar.mode !== 'tracking' || !ref.loaded;
  updateEditors();
}

async function updateCameraControls() {
  const rec = recorder.state !== 'inactive';
  const sel = $('#camera-select');
  try {
    const devs = await camera.devices();
    sel.innerHTML = devs.map((d, i) => `<option value="${d.deviceId}">${escapeHtml(d.label || 'Камера ' + (i + 1))}</option>`).join('');
    sel.value = camera.deviceId || '';
    $('#btn-flip-cam').hidden = devs.length < 2;
  } catch { /* ignore */ }
  sel.disabled = rec;
  $('#resolution').value = S.resolution;
  $('#resolution').disabled = rec;
  $('#btn-flip-cam').disabled = rec;
  const caps = camera.capabilities();
  const zoomRow = $('#zoom-row');
  if (caps.zoom && caps.zoom.max > caps.zoom.min) {
    zoomRow.hidden = false;
    const z = $('#zoom');
    z.min = caps.zoom.min; z.max = caps.zoom.max; z.step = caps.zoom.step || 0.1;
    z.value = (camera.track.getSettings().zoom) || caps.zoom.min;
  } else zoomRow.hidden = true;
  $('#torch-row').hidden = !caps.torch;
  const st = camera.track ? camera.track.getSettings() : {};
  $('#cam-info').textContent = st.width ? `${st.width}×${st.height}${st.frameRate ? ' · ' + Math.round(st.frameRate) + ' к/с' : ''}` : '';
  $('#fit').value = S.fit;
  $('#mic').checked = S.mic;
  $('#bitrate').value = String(S.bitrate);
  $('#show-canvas').checked = S.showCanvasFrame;
  $('#surroundings').checked = S.surroundings;
  $('#smoothing').value = Math.round(S.smoothing * 100);
  $('#wake').checked = S.wakeLock;
  $('#stats-toggle').checked = S.stats;
  $('#sync-view').checked = S.syncView;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function bind() {
  bindTaps();
  $('#btn-start').onclick = boot;
  $('#btn-image').onclick = () => $('#file').click();
  $('#btn-load-image').onclick = () => $('#file').click();
  $('#file').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadReference(f);
    e.target.value = '';
  };
  $('#btn-eye').onclick = () => { S.visible = !S.visible; persist(); updateRefControls(); };
  $('#btn-pin').onclick = () => {
    S.pinned = !S.pinned; persist(); updateRefControls();
    toast(S.pinned ? 'Положение референса закреплено' : 'Референс можно двигать');
  };
  $('#opacity').oninput = (e) => {
    S.opacity = e.target.value / 100;
    $('#opacity-val').textContent = e.target.value + '%';
    if (!S.visible) { S.visible = true; updateRefControls(); }
  };
  $('#opacity').onchange = persist;
  $('#btn-ref-panel').onclick = () => openPanel('#panel-ref');
  $('#btn-settings').onclick = () => { updateCameraControls(); openPanel('#panel-settings'); };
  $$('.sheet .close').forEach((b) => { b.onclick = () => { b.closest('.sheet').hidden = true; }; });

  // режимы референса
  $$('#mode-seg button').forEach((b) => {
    b.onclick = () => { S.mode = b.dataset.mode; persist(); renderReference(); updateRefControls(); };
  });
  $('#line-color').oninput = (e) => { S.lineColor = e.target.value; renderReference(); };
  $('#line-color').onchange = persist;
  $('#grid').onchange = (e) => { S.grid = e.target.checked; persist(); renderReference(); };
  $('#grid-n').oninput = (e) => { S.gridN = +e.target.value; $('#grid-n-val').textContent = S.gridN; renderReference(); };
  $('#grid-n').onchange = persist;

  const editQuad = (fn) => {
    const q = displayQuad || overlayQuad;
    if (!q) return;
    setOverlayQuad(fn(q));
    resetSmoothing();
    saveQuad();
  };
  $('#btn-flip-h').onclick = () => editQuad((q) => [q[1], q[0], q[3], q[2]]);
  $('#btn-flip-v').onclick = () => editQuad((q) => [q[3], q[2], q[1], q[0]]);
  $('#btn-rotate').onclick = () => editQuad((q) => similarity(q, { c: centroid(q), a: Math.PI / 2 }));
  $('#btn-fit-screen').onclick = () => editQuad(() => defaultQuad());
  $('#btn-fit-canvas').onclick = () => { const cq = currentCanvasQuad(); if (cq) editQuad(() => fitIntoQuad(ref.aspect, cq)); };
  $('#btn-straighten').onclick = () => editQuad((q) => {
    // убрать перспективу: прямоугольник с тем же центром, средней шириной и поворотом
    const c = centroid(q);
    const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
    const ang = Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0]);
    const h = w / ref.aspect;
    return similarity([[c[0] - w / 2, c[1] - h / 2], [c[0] + w / 2, c[1] - h / 2], [c[0] + w / 2, c[1] + h / 2], [c[0] - w / 2, c[1] + h / 2]], { c, a: ang });
  });
  $('#btn-remove-ref').onclick = () => { removeReference(); $('#panel-ref').hidden = true; };

  // запись / фото / AR
  $('#btn-record').onclick = toggleRecord;
  $('#btn-pause').onclick = togglePause;
  $('#btn-photo').onclick = takePhoto;
  $('#btn-ar').onclick = () => (ar.mode === 'off' ? arBegin() : ar.mode === 'select' || ar.mode === 'tracking' ? arStop() : null);
  $('#ar-back').onclick = () => (ar.mode === 'tracking' ? anchorBack() : selectBack());
  $('#ar-cancel').onclick = () => (ar.mode === 'tracking' ? setAnchorMode(false) : arStop(true));
  $('#btn-anchor').onclick = () => setAnchorMode(!ar.anchorMode);

  $('#media-save').onclick = saveMedia;
  $('#media-share').onclick = shareMedia;
  $('#media-delete').onclick = deleteMedia;
  $('#media-close').onclick = () => {
    if (media && media.kind === 'video' && !media.saved) {
      if (media.storedName) toast('Запись осталась в хранилище браузера — её можно будет открыть при следующем запуске');
      else if (!confirm('Закрыть без сохранения? Запись будет потеряна.')) return;
    }
    closeMedia(false);
  };

  // настройки камеры
  $('#camera-select').onchange = async (e) => {
    S.deviceId = e.target.value; persist();
    try { await startCamera({ deviceId: S.deviceId }); } catch (err) { toast(cameraError(err)); }
  };
  $('#btn-flip-cam').onclick = async () => {
    const devs = await camera.devices();
    const i = devs.findIndex((d) => d.deviceId === camera.deviceId);
    const next = devs[(i + 1) % devs.length];
    if (next) {
      S.deviceId = next.deviceId; persist();
      try { await startCamera({ deviceId: S.deviceId }); } catch (err) { toast(cameraError(err)); }
    }
  };
  $('#resolution').onchange = async (e) => {
    S.resolution = e.target.value; persist();
    try { await startCamera(); } catch (err) { toast(cameraError(err)); }
  };
  $('#zoom').oninput = (e) => camera.setZoom(+e.target.value);
  $('#torch').onchange = (e) => camera.setTorch(e.target.checked);
  $('#fit').onchange = (e) => { S.fit = e.target.value; persist(); stage.layout(); };
  $('#mic').onchange = (e) => { S.mic = e.target.checked; persist(); };
  $('#bitrate').onchange = (e) => { S.bitrate = +e.target.value; persist(); };
  $('#show-canvas').onchange = (e) => { S.showCanvasFrame = e.target.checked; persist(); };
  $('#surroundings').onchange = (e) => {
    S.surroundings = e.target.checked; persist();
    if (ar.mode === 'tracking') toast('Применится при следующем включении AR');
  };
  $('#smoothing').oninput = (e) => { S.smoothing = e.target.value / 100; setFilterSmoothing(); };
  $('#smoothing').onchange = persist;
  $('#wake').onchange = (e) => {
    S.wakeLock = e.target.checked; persist();
    if (S.wakeLock) requestWakeLock(); else if (wakeLock) wakeLock.release();
  };
  $('#stats-toggle').onchange = (e) => { S.stats = e.target.checked; persist(); };
  $('#sync-view').onchange = (e) => {
    S.syncView = e.target.checked; persist();
    if (ar.mode !== 'tracking') return;
    if (S.syncView) sync.start();
    else { sync.stop(); document.body.classList.remove('synced'); }
    resetSmoothing();
  };
  $('#btn-fullscreen').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)?.call(document.documentElement).catch?.(() => {});
  };
  if (!document.documentElement.requestFullscreen && !document.documentElement.webkitRequestFullscreen) $('#btn-fullscreen').hidden = true;
  $('#btn-help').onclick = () => { $$('.sheet').forEach((s) => { s.hidden = true; }); $('#modal-help').hidden = false; };
  $('#help-close').onclick = () => { $('#modal-help').hidden = true; };

  // перетаскивание файла (на компьютере)
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) loadReference(f);
  });
  // вставка из буфера обмена
  window.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadReference(item.getAsFile());
  });

  // горячие клавиши
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'r') { e.preventDefault(); if (document.body.classList.contains('running')) toggleRecord(); }
    else if (k === 'h') $('#btn-eye').click();
    else if (k === 'l') $('#btn-pin').click();
    else if (k === 'a') $('#btn-ar').click();
    else if (k === 'p') takePhoto();
    else if (k === 'o') $('#btn-image').click();
    else if (k === 'escape') { $$('.sheet').forEach((s) => { s.hidden = true; }); if (ar.mode === 'select') arStop(true); }
    else if (k === 'arrowup' || k === 'arrowdown') {
      S.opacity = Math.min(1, Math.max(0, S.opacity + (k === 'arrowup' ? 0.05 : -0.05)));
      updateRefControls(); persist();
    }
  });

  new ResizeObserver(() => stage.layout()).observe(stage.el);
  video.addEventListener('resize', onVideoResize);
  window.addEventListener('beforeunload', (e) => {
    if (recorder.state !== 'inactive') { e.preventDefault(); e.returnValue = ''; }
  });
}

// Поворот телефона меняет размеры кадра: переносим рамку референса пропорционально,
// AR приходится перезапускать (опорный кадр больше не совпадает).
let lastDims = null;
function onVideoResize() {
  const d = { w: video.videoWidth, h: video.videoHeight };
  if (!d.w) return;
  if (lastDims && (lastDims.w !== d.w || lastDims.h !== d.h)) {
    if (ar.mode === 'tracking' || ar.mode === 'select') {
      arStop(true);
      toast('Ориентация изменилась — включите AR заново');
    }
    if (overlayQuad) {
      const kx = d.w / lastDims.w, ky = d.h / lastDims.h;
      overlayQuad = overlayQuad.map(([x, y]) => [x * kx, y * ky]);
      saveQuad();
    }
  }
  lastDims = d;
  stage.layout();
}

// ---------- старт ----------
async function init() {
  bind();
  setFilterSmoothing();
  stage.fit = S.fit;
  stage.layout();
  updateRefControls();
  updateArUi();
  requestAnimationFrame(frame);

  const saved = await idbGet('reference');
  if (saved) await loadReference(saved, { fresh: false });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // если доступ к камере уже выдан — стартуем сразу
  try {
    const p = await navigator.permissions.query({ name: 'camera' });
    if (p.state === 'granted') boot();
  } catch { /* Safari/Firefox могут не поддерживать */ }
}

// для отладки и автотестов
window.artcam = { S, ar, DEBUG, sync, onCornerTap, resetSmoothing, stage, tracker, camera, recorder, ref, get overlayQuad() { return overlayQuad; }, get displayQuad() { return displayQuad; }, arBegin, arStop, loadReference };

init();
