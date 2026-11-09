// Главный поток AR: захват уменьшенных кадров, общение с воркером, перевод координат.
import { multiply } from './geometry.js';

const CV_URLS = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  'https://unpkg.com/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
];

const PROC_LEVELS = [640, 576, 512, 448, 384, 320]; // длинная сторона кадра анализа: чем слабее телефон, тем меньше
const FRAME_BUDGET_MS = 45;                          // на кадр трекинга хотим не больше (≈ 22 к/с)

/**
 * Выбор размера кадра анализа по замеру скорости (мс на синтетическом кадре 640×360, см. воркер).
 * Полный трекинг стоит ≈ 1,3 замера; время почти пропорционально числу пикселей.
 */
export function pickProcMax(benchMs) {
  if (!(benchMs > 0)) return PROC_LEVELS[0];
  for (const L of PROC_LEVELS) if (1.3 * benchMs * (L / 640) ** 2 <= FRAME_BUDGET_MS) return L;
  return PROC_LEVELS[PROC_LEVELS.length - 1];
}

export class ArTracker {
  constructor(video) {
    this.video = video;
    this.worker = null;
    this.readyPromise = null;
    this.procMax = PROC_LEVELS[0];  // фиксируется замером при загрузке и не меняется за сессию (координаты воркера)
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.pending = new Map();
    this.seq = 0;
    this.running = false;
    this.busy = false;
    this.onPose = null;    // (H в координатах видео, info) => void
    this.onSel = null;     // (углы выбора [{ p, snapped, lost }], reset) => void
    this.stats = { fps: 0, ms: 0 };
    this._fpsT = 0; this._fpsN = 0;
  }

  get loaded() { return !!this._ready; }

  init() {
    if (this.readyPromise) return this.readyPromise;
    this.worker = new Worker(new URL('./tracker.worker.js', import.meta.url));
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Ошибка AR-воркера');
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    };
    this.readyPromise = this._call({ type: 'init', urls: CV_URLS }).then((r) => {
      this._ready = true;
      this.useBitmap = !!r.bitmap && typeof createImageBitmap === 'function';
      this.benchMs = r.bench;
      this.procMax = pickProcMax(r.bench);
      return r;
    });
    this.readyPromise.catch(() => { this.readyPromise = null; this.worker.terminate(); this.worker = null; });
    return this.readyPromise;
  }

  _call(msg, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  _onMessage(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else p.resolve(m);
  }

  /** Размер кадра анализа и точные коэффициенты «видео → кадр анализа». */
  get proc() {
    const { videoWidth: vw, videoHeight: vh } = this.video;
    const s = Math.min(1, this.procMax / Math.max(vw, vh));
    const w = Math.max(16, Math.round(vw * s)), h = Math.max(16, Math.round(vh * s));
    return { w, h, sx: w / vw, sy: h / vh };
  }

  /**
   * Уменьшенный кадр для воркера. Где можно — ImageBitmap: масштабирование делает
   * браузер (GPU), а чтение пикселей происходит в воркере, не тормозя интерфейс.
   */
  async _grab() {
    const v = this.video;
    const { w, h } = this.proc;
    if (this.useBitmap) {
      try {
        const bmp = await createImageBitmap(v, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
        return { msg: { bmp, w, h }, transfer: [bmp] };
      } catch (e) {
        console.warn('ImageBitmap недоступен, читаю пиксели в главном потоке', e);
        this.useBitmap = false;
      }
    }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.ctx.drawImage(v, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    return { msg: { buf: img.data.buffer, w, h }, transfer: [img.data.buffer] };
  }

  async _send(type, extra = {}) {
    const f = await this._grab();
    try {
      return await this._call({ type, ...f.msg, ...extra }, f.transfer);
    } catch (e) {
      // воркер не смог прочитать ImageBitmap (старый браузер) — повторяем через буфер
      if (f.msg.bmp && this.useBitmap) {
        this.useBitmap = false;
        const g = await this._grab();
        return this._call({ type, ...g.msg, ...extra }, g.transfer);
      }
      throw e;
    }
  }

  _toProc(q) { const { sx, sy } = this.proc; return q.map(([x, y]) => [x * sx, y * sy]); }
  _fromProc(q) { const { sx, sy } = this.proc; return q.map(([x, y]) => [x / sx, y / sy]); }

  /** Гомография кадра анализа → координаты видео: S⁻¹·H·S. */
  _hToVideo(Hp) {
    const { sx, sy } = this.proc;
    return multiply([1 / sx, 0, 0, 0, 1 / sy, 0, 0, 0, 1], multiply(Hp, [sx, 0, 0, 0, sy, 0, 0, 0, 1]));
  }

  /**
   * Выбор углов на живом видео. Касание ставит точку на ближайшем углу (selTap), дальше точка сама
   * ведётся по кадрам — позиции приходят в onSel. Когда отмечены 4 угла, трекинг холста стартует сам.
   */
  async selStart() {
    await this.init();
    this.running = true;
    this.busy = false;
    await this._send('selStart');
    this._loop();
  }

  /** Касание в координатах видео → { locked: false, snapped, p, pts } или { locked: true, info } (трекинг стартовал). */
  async selTap(pt, { fullFrame = false } = {}) {
    const r = await this._send('selTap', { point: this._toProc([pt])[0], fullFrame });
    if (r.type === 'locked') {
      return { locked: true, info: { ...r, quad: this._fromProc(r.quad) }, snapped: r.snapped, p: this._fromProc([r.p])[0] };
    }
    return { locked: false, snapped: r.snapped, p: this._fromProc([r.p])[0], pts: this._selPts(r.pts), badQuad: !!r.badQuad };
  }

  /** Убрать последний отмеченный угол. */
  async selBack() {
    const r = await this._call({ type: 'selBack' });
    return this._selPts(r.pts || []);
  }

  /** Точка опоры: неподвижный предмет рядом с холстом (координаты видео). Возвращает, сколько опор теперь у воркера. */
  async addAnchor(pt) {
    const r = await this._call({ type: 'addAnchor', point: this._toProc([pt])[0] });
    return r.n;
  }

  /** Убрать последнюю точку опоры (all — все). */
  async removeAnchor(all = false) {
    const r = await this._call({ type: 'removeAnchor', all });
    return r.n;
  }

  _selPts(pts) { return pts.map((pt) => ({ ...pt, p: this._fromProc([pt.p])[0] })); }

  /** Начать отслеживание. quad — холст в координатах видео (текущий кадр становится опорным). */
  async lock(quad, { fullFrame = false } = {}) {
    await this.init();
    this.running = false;
    const r = await this._send('lock', { quad: this._toProc(quad), fullFrame });
    this.running = true;
    this.busy = false;
    this._loop();
    return r;
  }

  /** Обновить область холста (в координатах опорного кадра видео). */
  setQuad(refQuad) {
    if (!this.running) return;
    this._call({ type: 'setQuad', quad: this._toProc(refQuad) }).catch(() => {});
  }

  stop() {
    this.running = false;
    if (this.worker && this._ready) this._call({ type: 'unlock' }).catch(() => {});
  }

  _loop() {
    if (!this.running) return;
    const gen = this._gen = (this._gen || 0) + 1; // новый запуск цикла останавливает старый
    const v = this.video;
    const next = () => {
      if (!this.running || gen !== this._gen) return;
      if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    const tick = (nowT, md) => {
      if (!this.running || gen !== this._gen) return;
      if (this.busy || v.readyState < 2) return next();
      this.busy = true;
      // момент показа этого кадра (та же шкала времени, что у часов показанного кадра в приложении)
      const frameTime = (md && md.presentationTime) || (typeof nowT === 'number' ? nowT : performance.now());
      this._send('frame')
        .then((r) => {
          this.busy = false;
          if (!this.running) return;
          if (r.type === 'sel') { this.onSel && this.onSel(this._selPts(r.pts), !!r.reset); return; }
          if (r.state === 'off') return;
          this._countFps(r.ms);
          this.onPose && this.onPose(this._hToVideo(r.H), r, frameTime);
        })
        .catch((err) => { this.busy = false; console.warn('AR', err); });
      next();
    };
    next();
  }

  _countFps(ms) {
    const t = performance.now();
    this._fpsN++;
    this.stats.ms = ms;
    if (t - this._fpsT > 1000) {
      this.stats.fps = Math.round((this._fpsN * 1000) / (t - this._fpsT));
      this._fpsN = 0; this._fpsT = t;
    }
  }
}

