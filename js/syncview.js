// Синхронный показ: картинка камеры и референс на ней двигаются жёстко вместе.
//
// Проблема живого видео: кадр уже на экране, а его поза приходит через ~30–50 мс. Пока позы нет, референс
// стоит по экстраполяции, а ручная съёмка дрожит так, что её не предсказать, — потом он «подпрыгивает»
// на точное место. Это и есть «тряска». Фильтры тут бессильны.
//
// Решение, как в AR-приложениях: картинка показывается с небольшой задержкой D (≈ задержка трекера +
// период между позами), а положение референса для каждого показанного кадра ИНТЕРПОЛИРУЕТСЯ между двумя
// соседними обработанными кадрами. Тогда экстраполяции нет, и ошибка — только шум самого трекера.
// D подстраивается по измеренным задержке и частоте поз и меняется плавно (иначе картинка «плывёт»).
//
// Кадры снимаются createImageBitmap(video) на каждом видеокадре (requestVideoFrameCallback) и рисуются
// в canvas; сам <video> продолжает идти (и запись идёт по его треку — запись задержки не имеет).
import { applyQuad } from './geometry.js';

const MAX_RING = 24;      // кадров в буфере (≈ 0,8 с)
const MAX_POSES = 40;
const MAX_EXTRAP = 120;   // мс: дальше последней позы экстраполируем не больше (при простое трекера)
const WIDTHS = [1280, 960, 720, 540]; // ширина кадра показа; на слабом телефоне идём вниз по лесенке
const GRAB_SLOW_MS = 22;  // createImageBitmap дольше этого (в среднем) — телефон не успевает: уменьшаем кадр
const DRAW_SLOW_MS = 9;   // отрисовка кадра в canvas дольше этого — то же

export class SyncView {
  constructor(video, canvas) {
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.active = false;
    this.gen = 0;
    this.ring = [];       // { T, bmp }
    this.poses = [];      // { T, H }
    this.delay = 90;      // фактическая задержка, мс (плавно идёт к target)
    this.target = 90;
    this.latency = 40;    // EMA: от показа кадра до прихода его позы
    this.period = 40;     // EMA: интервал между позами
    this.shown = null;    // кадр, нарисованный в canvas
    this.minDelay = 30;
    this.maxDelay = 320;
    this.level = 0;       // индекс в WIDTHS
    this.grabMs = 0;      // EMA: сколько ждём createImageBitmap
    this.drawMs = 0;      // EMA: сколько рисуем кадр в canvas
    this.inflight = 0;    // запущенные, но ещё не готовые снимки кадров
    this.fails = 0;       // подряд неудачных снимков
    this.failed = false;  // показ невозможен/слишком тяжёл — приложение возвращается к обычному видео
    this.noOpts = false;  // браузер не понимает параметры createImageBitmap (старый iOS) — снимаем целиком
    this.slowChecks = 0;
  }

  get supported() {
    return 'requestVideoFrameCallback' in this.video && typeof createImageBitmap === 'function';
  }

  _setWidth(maxWidth) {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const k = Math.min(1, maxWidth / Math.max(vw, vh)); // ограничиваем длинную сторону
    this.bw = Math.round(vw * k); this.bh = Math.round(vh * k);
    this.canvas.width = this.bw; this.canvas.height = this.bh;
    this.shown = null; // canvas очищен — следующий кадр нарисуется заново
  }

  start(maxWidth = WIDTHS[0]) {
    if (!this.supported || this.active) return this.active;
    if (!this.video.videoWidth) return false;
    this.level = Math.max(0, WIDTHS.findIndex((w) => w <= maxWidth));
    this.failed = false; this.fails = 0; this.inflight = 0; this.grabMs = 0; this.drawMs = 0; this.slowChecks = 0;
    this._setWidth(WIDTHS[this.level]);
    this.active = true;
    this.ring = []; this.poses = []; this.shown = null; this.nPoses = 0;
    this.delay = this.target = 90; this.latency = 40; this.period = 40;
    const gen = ++this.gen;
    const cb = (now, md) => {
      if (!this.active || gen !== this.gen) return;
      this._grab((md && md.presentationTime) || now);
      this.video.requestVideoFrameCallback(cb);
    };
    this.video.requestVideoFrameCallback(cb);
    return true;
  }

  stop() {
    this.active = false;
    this.gen++;
    for (const f of this.ring) f.bmp.close && f.bmp.close();
    this.ring = []; this.poses = []; this.shown = null;
  }

  async _grab(T) {
    // не копим очередь снимков: на слабом телефоне она растёт быстрее, чем разбирается
    if (this.inflight >= 2) return;
    this.inflight++;
    const t0 = performance.now();
    let bmp;
    try {
      bmp = this.noOpts
        ? await createImageBitmap(this.video)
        : await createImageBitmap(this.video, { resizeWidth: this.bw, resizeHeight: this.bh, resizeQuality: 'low' });
      this.fails = 0;
    } catch {
      this.inflight--;
      // старый браузер не знает параметров — пробуем снимать целиком; не выходит совсем — показ невозможен
      if (!this.noOpts && this.fails === 0) this.noOpts = true;
      if (++this.fails >= 6) this.failed = true;
      return;
    }
    this.inflight--;
    this.grabMs += 0.1 * ((performance.now() - t0) - this.grabMs);
    if (!this.active) { bmp.close && bmp.close(); return; }
    const ring = this.ring;
    let i = ring.length;
    while (i > 0 && ring[i - 1].T > T) i--; // асинхронное завершение может нарушить порядок
    ring.splice(i, 0, { T, bmp });
    while (ring.length > MAX_RING) { const f = ring.shift(); if (f !== this.shown) f.bmp.close && f.bmp.close(); }
  }

  /** Поза кадра, показанного в момент T (H — в координатах видео). */
  addPose(T, H) {
    const now = performance.now();
    const poses = this.poses;
    if (poses.length) {
      const dt = T - poses[poses.length - 1].T;
      if (dt <= 0) return;
      this.period += 0.1 * (Math.min(dt, 250) - this.period);
    }
    this.latency += 0.1 * (Math.max(0, now - T) - this.latency);
    poses.push({ T, H });
    if (poses.length > MAX_POSES) poses.shift();
    // нужна задержка не меньше «задержка трекера + период между позами»
    this.target = Math.min(this.maxDelay, Math.max(this.minDelay, this.latency + this.period + 6));
    // первые позы: задержка выставляется сразу (одноразовый скачок при включении AR), дальше — плавно
    if (++this.nPoses <= 6) this.delay = this.target;
  }

  /**
   * Самонастройка под слабый телефон: если снимок кадра или его отрисовка стабильно долгие, уменьшаем кадр показа;
   * на самой нижней ступени и всё ещё тяжело — сообщаем приложению (failed), оно вернётся к обычному видео.
   */
  _governor() {
    if (this.grabMs > GRAB_SLOW_MS || this.drawMs > DRAW_SLOW_MS) this.slowChecks++; else this.slowChecks = Math.max(0, this.slowChecks - 1);
    if (this.slowChecks < 45) return;
    this.slowChecks = 0;
    if (this.level < WIDTHS.length - 1) {
      this.level++;
      this.grabMs = this.drawMs = 0;
      this._setWidth(WIDTHS[this.level]);
    } else this.failed = true;
  }

  /** После правки рамок референса — позы хранятся как H, поэтому пересчёт не нужен; метод нужен для сброса. */
  clearPoses() { this.poses = []; }

  /** Положение рамки refQuad (в координатах первого кадра) на кадре в момент T. */
  quadAt(T, refQuad) {
    const poses = this.poses;
    if (!poses.length || !refQuad) return null;
    const q = (p) => applyQuad(p.H, refQuad);
    if (T <= poses[0].T) return q(poses[0]);
    const last = poses[poses.length - 1];
    if (T >= last.T) {
      // позы ещё нет — продолжаем по скорости последних двух (недолго)
      const qa = q(last);
      if (poses.length < 2) return qa;
      const prev = poses[poses.length - 2], qb = q(prev);
      const dt = last.T - prev.T;
      const lead = Math.min(MAX_EXTRAP, T - last.T);
      return qa.map((p, i) => [p[0] + (p[0] - qb[i][0]) / dt * lead, p[1] + (p[1] - qb[i][1]) / dt * lead]);
    }
    let i = poses.length - 1;
    while (i > 0 && poses[i - 1].T > T) i--;
    const a = poses[i - 1], b = poses[i];
    const k = (T - a.T) / (b.T - a.T);
    const qa = q(a), qb = q(b);
    return qa.map((p, j) => [p[0] + (qb[j][0] - p[0]) * k, p[1] + (qb[j][1] - p[1]) * k]);
  }

  /**
   * Вызывается на каждой отрисовке экрана. Выбирает кадр для показа (задержка this.delay), рисует его
   * в canvas и возвращает его время T. null — кадров пока нет.
   */
  frame(now) {
    if (!this.active || !this.ring.length) return null;
    // плавная подстройка задержки (резкая смена задержки выглядела бы как ускорение/замедление картинки)
    // вверх быстрее (иначе не хватает поз), вниз медленнее
    const d = this.target - this.delay;
    this.delay += Math.max(-0.4, Math.min(1.2, d));
    const Td = now - this.delay;
    let f = null;
    for (const r of this.ring) { if (r.T <= Td) f = r; else break; }
    if (!f) f = this.ring[0];
    if (f !== this.shown) {
      const d0 = performance.now();
      this.ctx.drawImage(f.bmp, 0, 0, this.bw, this.bh);
      this.drawMs += 0.1 * ((performance.now() - d0) - this.drawMs);
      this.shown = f;
      this._governor();
    }
    // кадры старше показанного больше не нужны
    while (this.ring.length > 2 && this.ring[0].T < f.T - 100) { const o = this.ring.shift(); if (o !== this.shown) o.bmp.close && o.bmp.close(); }
    return f.T;
  }
}
