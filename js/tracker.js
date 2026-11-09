// Главный поток AR: захват уменьшенных кадров, общение с воркером, перевод координат.
import { multiply, scaling } from './geometry.js';

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
    this.readyPromise = this._call({ type: 'init', urls: CV_URLS }).then((r) => { this._ready = true; return r; });
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

  /** Масштаб «видео → кадр анализа». */
  get scale() {
    const { videoWidth: vw, videoHeight: vh } = this.video;
    return Math.min(1, PROC_MAX / Math.max(vw, vh));
  }

  _grab() {
    const v = this.video;
    const s = this.scale;
    const w = Math.max(16, Math.round(v.videoWidth * s));
    const h = Math.max(16, Math.round(v.videoHeight * s));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.ctx.drawImage(v, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    return { buf: img.data.buffer, w, h };
  }

  _toProc(q) { const s = this.scale; return q.map(([x, y]) => [x * s, y * s]); }
  _fromProc(q) { const s = 1 / this.scale; return q.map(([x, y]) => [x * s, y * s]); }

  /** Гомография кадра анализа → координаты видео: S⁻¹·H·S. */
  _hToVideo(Hp) {
    const s = this.scale;
    return multiply(scaling(1 / s), multiply(Hp, scaling(s)));
  }

  async detectCanvas() {
    await this.init();
    const f = this._grab();
    const r = await this._call({ type: 'detect', ...f }, [f.buf]);
    return r.quad ? this._fromProc(r.quad) : null;
  }

  /** Начать отслеживание. quad — холст в координатах видео (текущий кадр становится опорным). */
  async lock(quad, { margin = 0.12, fullFrame = false } = {}) {
    await this.init();
    this.margin = margin;
    const f = this._grab();
    const r = await this._call({ type: 'lock', ...f, quad: this._toProc(quad), margin, fullFrame }, [f.buf]);
    this.running = true;
    this.busy = false;
    this._loop();
    return r;
  }

  /** Обновить область холста (в координатах опорного кадра видео). */
  setQuad(refQuad) {
    if (!this.running) return;
    this._call({ type: 'setQuad', quad: this._toProc(refQuad), margin: this.margin }).catch(() => {});
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
    const tick = () => {
      if (!this.running) return;
      if (this.busy || v.readyState < 2) return next();
      this.busy = true;
      const f = this._grab();
      this._call({ type: 'frame', ...f }, [f.buf])
        .then((r) => {
          this.busy = false;
          if (!this.running || r.state === 'off') return;
          this._countFps(r.ms);
          this.onPose && this.onPose(this._hToVideo(r.H), r);
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

