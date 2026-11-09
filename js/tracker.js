// Главный поток AR: захват уменьшенных кадров, общение с воркером, перевод координат.
import { multiply } from './geometry.js';

const CV_URLS = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  'https://unpkg.com/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
];

const PROC_MAX = 640; // длинная сторона кадра для анализа

export class ArTracker {
  constructor(video) {
    this.video = video;
    this.worker = null;
    this.readyPromise = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.pending = new Map();
    this.seq = 0;
    this.running = false;
    this.busy = false;
    this.onPose = null;    // (H в координатах видео, info) => void
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
    const s = Math.min(1, PROC_MAX / Math.max(vw, vh));
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

  /** Притянуть касание к ближайшему настоящему углу (там, где сходятся два длинных края). */
  async snapCorner(pt, others = []) {
    await this.init();
    const r = await this._send('snap', { point: this._toProc([pt])[0], others: this._toProc(others) });
    return { snapped: r.snapped, score: r.score, p: this._fromProc([r.p])[0] };
  }

  /**
   * 4 касания (в любом порядке) + их первичные притяжения → упорядоченный четырёхугольник,
   * уточнённый по краям (quad === null — точки не образуют четырёхугольник).
   */
  async buildQuad(taps, snapped) {
    await this.init();
    const r = await this._send('quad', { taps: this._toProc(taps), snapped: this._toProc(snapped) });
    return { quad: r.quad ? this._fromProc(r.quad) : null, refined: r.refined };
  }

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
    const v = this.video;
    const next = () => {
      if (!this.running) return;
      if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    const tick = (nowT) => {
      if (!this.running) return;
      if (this.busy || v.readyState < 2) return next();
      this.busy = true;
      // момент, когда этот кадр показан на экране, — от него считается задержка позы
      const frameTime = typeof nowT === 'number' ? nowT : performance.now();
      this._send('frame')
        .then((r) => {
          this.busy = false;
          if (!this.running || r.state === 'off') return;
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

