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
// Кадры снимаются на каждом видеокадре (requestVideoFrameCallback) и рисуются в canvas; сам <video> продолжает
// идти (и запись идёт по его треку — запись задержки не имеет). Основной путь — WebGL (glframes.js): кадр синхронно
// загружается в текстуру, и из неё же берётся уменьшенный кадр для трекера, поэтому поза и картинка относятся к
// одному кадру по построению. Запасной путь (нет WebGL или самопроверка не прошла) — createImageBitmap и 2D-canvas.
import { applyQuad } from './geometry.js';
import { GlFrames, checkAgainst2d } from './glframes.js';

const MAX_RING = 24;      // кадров в буфере (≈ 0,8 с)
const MAX_POSES = 40;
const MAX_EXTRAP = 70;    // мс: дальше последней позы экстраполируем не больше (при простое трекера)
const EXTRAP_GAIN = 0.7;  // и не на всю скорость: рывок камеры обычно сменяется торможением, полная скорость «выстреливает»
const WIDTHS = [1280, 960, 720, 540]; // ширина кадра показа; на слабом телефоне идём вниз по лесенке
const GRAB_SLOW_MS = 22;  // createImageBitmap дольше этого (в среднем) — телефон не успевает: уменьшаем кадр
const GL_UP_SLOW_MS = 10;   // путь WebGL: загрузка кадра камеры в текстуру дольше этого (в среднем) — тяжело
const GL_READ_SLOW_MS = 14; // путь WebGL: чтение уменьшенного кадра для трекера дольше этого — тяжело
const DRAW_SLOW_MS = 9;   // отрисовка кадра в canvas дольше этого — то же

export class SyncView {
  constructor(video, canvas, { gl = true } = {}) {
    this.video = video;
    this.canvas = canvas;
    this.wantGl = gl;     // пробовать WebGL (false — сразу запасной путь)
    this.glf = null;      // GlFrames, когда работает путь WebGL
    this.ctx = null;      // 2D-контекст запасного пути
    this.showing = false; // идёт показ (трекинг); до него на пути WebGL кадры снимаются только для трекера
    this.onFrame = null;  // (кадр) => void — сразу после снимка нового кадра (путь WebGL): трекер берёт его в работу
    this.glChecks = 0;    // сколько раз самопроверка WebGL была неопределённой
    this.glOk = false;
    this.active = false;
    this.gen = 0;
    this.ring = [];       // { T, bmp }
    this.poses = [];      // { T, H }
    this.delay = 90;      // фактическая задержка, мс (плавно идёт к target)
    this.target = 90;
    this.latency = 40;    // EMA: от показа кадра до прихода его позы
    this.period = 40;     // EMA: интервал между позами
    this.fp = 0;          // период кадров камеры (мс), 0 — ещё не оценён
    this.ft0 = 0;         // фаза сетки кадров камеры
    this.latHist = [];    // последние задержки трекера и интервалы между позами — для высокого перцентиля
    this.perHist = [];
    this.extrap = 0;      // сколько раз референс пришлось экстраполировать (поза не успела) — диагностика
    this.draws = 0;
    this.latDev = 10;     // EMA: разброс задержки трекера (среднее модуля отклонения)
    this.perDev = 10;     // EMA: разброс интервала между позами
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
    return 'requestVideoFrameCallback' in this.video && (this.wantGl || typeof createImageBitmap === 'function');
  }

  _setWidth(maxWidth) {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const k = Math.min(1, maxWidth / Math.max(vw, vh)); // ограничиваем длинную сторону
    this.bw = Math.round(vw * k); this.bh = Math.round(vh * k);
    this._dropRing();
    if (this.glf) this.glf.resize(this.bw, this.bh);
    else { this.canvas.width = this.bw; this.canvas.height = this.bh; }
    this.shown = null; // canvas очищен — следующий кадр нарисуется заново
  }

  _free(f) { if (f.bmp) f.bmp.close && f.bmp.close(); else if (this.glf) this.glf.release(f.slot); }
  _dropRing() {
    if (this.shown && !this.ring.includes(this.shown)) this._free(this.shown);
    for (const f of this.ring) this._free(f);
    this.ring = []; this.shown = null;
  }

  /** Выбор пути: WebGL, если получается; иначе 2D. Вызывается при запуске. */
  _initBackend() {
    if (this.glf || this.ctx) return;
    if (this.wantGl) {
      try { this.glf = new GlFrames(this.canvas, MAX_RING + 2); return; } catch (e) { console.warn('WebGL-показ недоступен, запасной путь', e); this.glf = null; }
      // у canvas, с которого уже просили WebGL, 2D-контекст не получить — берём свежий
      this._freshCanvas();
    }
    this.ctx = this.canvas.getContext('2d', { alpha: false });
  }

  _freshCanvas() {
    const c = this.canvas.cloneNode(false);
    this.canvas.replaceWith(c);
    this.canvas = c;
  }

  /** WebGL снял не то, что показывает обычное видео (или контекст потерян): переходим на запасной путь. */
  _glFallback() {
    console.warn('WebGL-показ не прошёл самопроверку, запасной путь');
    this._dropRing();
    try { this.glf.dispose(); } catch { /* контекст мог быть потерян */ }
    this.glf = null; this.wantGl = false; this.shown = null;
    this._freshCanvas();
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.canvas.width = this.bw; this.canvas.height = this.bh;
  }

  /** Кадры для трекера берутся отсюда (путь WebGL работает). */
  get feeds() { return this.active && !!this.glf && !this.glf.lost; }
  latest() { return this.ring.length ? this.ring[this.ring.length - 1] : null; }
  /** Уменьшенный кадр (RGBA, w×h) из хранимого кадра — для трекера. */
  readFrame(f, w, h) { return this.glf && f && f.slot !== undefined ? this.glf.read(f.slot, w, h) : null; }

  start(maxWidth = WIDTHS[0]) {
    if (!this.supported || this.active) return this.active;
    if (!this.video.videoWidth) return false;
    this.level = Math.max(0, WIDTHS.findIndex((w) => w <= maxWidth));
    this.failed = false; this.fails = 0; this.inflight = 0; this.grabMs = 0; this.drawMs = 0; this.slowChecks = 0;
    this._initBackend();
    this._setWidth(WIDTHS[this.level]);
    this.active = true;
    this.showing = false;
    this._resetTiming();
    const gen = ++this.gen;
    const cb = (now, md) => {
      if (!this.active || gen !== this.gen) return;
      this._grab(this._regUpdate((md && md.presentationTime) || now));
      this.video.requestVideoFrameCallback(cb);
    };
    this.video.requestVideoFrameCallback(cb);
    return true;
  }

  _resetTiming() {
    this.poses = []; this.shown = null; this.nPoses = 0;
    this.delay = this.target = 90; this.latency = 40; this.period = 40; this.latDev = 10; this.perDev = 10; this.latHist = []; this.perHist = []; this.extrap = 0; this.draws = 0;
  }

  /** Трекинг начался: с этого момента картинка показывается из хранимых кадров. */
  show() {
    if (!this.active) return;
    this._resetTiming();
    this.showing = true;
  }

  stop() {
    this.active = false;
    this.showing = false;
    this.gen++;
    this._dropRing();
    this.poses = []; this.shown = null;
  }

  /**
   * Метки времени кадров камеры дрожат на несколько мс (особенно на телефонах). Выбор кадра «последний, чья метка не позже
   * момента показа» из-за этого иногда держит кадр 1, а иногда 3 отрисовки подряд — картинка идёт рывками. Поэтому метки
   * приводятся к ровной сетке (период и фаза оцениваются на лету); если кадры идут нерегулярно — метка остаётся как есть.
   */
  _regUpdate(T) {
    if (!this.fpLast) { this.fpLast = T; return T; }
    const dt = T - this.fpLast;
    this.fpLast = T;
    if (dt < 8 || dt > 90) { this.fp = 0; return T; }          // пауза/смена частоты — оценка заново
    if (!this.fp) { this.fp = dt; this.ft0 = T; return T; }
    const n = Math.max(1, Math.round(dt / this.fp));
    const per = dt / n;
    if (Math.abs(per - this.fp) < 0.25 * this.fp) this.fp += 0.04 * (per - this.fp);
    return this._reg(T, true);
  }

  _reg(T, learn = false) {
    if (!this.fp) return T;
    const k = Math.round((T - this.ft0) / this.fp);
    const g = this.ft0 + k * this.fp, r = T - g;
    if (Math.abs(r) > 0.3 * this.fp) { if (learn) this.ft0 = T; return T; } // кадр не на сетке — не трогаем
    if (learn) this.ft0 += 0.08 * r; // фаза плавно следует за камерой
    return g;
  }

  /** Путь WebGL: синхронный снимок кадра в текстуру; трекер сразу получает этот же кадр. */
  _grabGl(T) {
    const glf = this.glf, ring = this.ring;
    if (glf.lost) { this._glFallback(); return; }
    // место для нового кадра: самый старый не показанный уходит
    while (ring.length >= MAX_RING) { const k = ring[0] === this.shown ? 1 : 0; this._free(ring[k]); ring.splice(k, 1); }
    const t0 = performance.now();
    let slot = -1;
    try { slot = glf.capture(this.video); } catch (e) { slot = -1; }
    if (slot < 0) { if (++this.fails >= 6) this._glFallback(); return; }
    this.fails = 0;
    // самопроверка на первых кадрах: то ли сняли, что показывает обычное видео
    if (!this.glOk) {
      let ok = null;
      try { ok = checkAgainst2d(glf, slot, this.video); } catch (e) { ok = false; }
      if (ok === false) { this._glFallback(); return; }
      if (ok === true || ++this.glChecks >= 20) this.glOk = true;
    }
    const f = { T, slot };
    ring.push(f);
    if (this.onFrame) { try { this.onFrame(f); } catch (e) { console.warn(e); } }
    this.grabMs += 0.1 * ((performance.now() - t0) - this.grabMs); // снимок + уменьшенный кадр для трекера
  }

  /**
   * Метки времени кадров камеры дрожат на несколько мс (особенно на телефонах). Выбор кадра «последний, чья метка не позже
   * момента показа» из-за этого иногда держит кадр 1, а иногда 3 отрисовки подряд — картинка идёт рывками. Поэтому метки
   * приводятся к ровной сетке (период и фаза оцениваются на лету); если кадры идут нерегулярно — метка остаётся как есть.
   */
  _regUpdate(T) {
    if (!this.fpLast) { this.fpLast = T; return T; }
    const dt = T - this.fpLast;
    this.fpLast = T;
    if (dt < 8 || dt > 90) { this.fp = 0; return T; }          // пауза/смена частоты — оценка заново
    if (!this.fp) { this.fp = dt; this.ft0 = T; return T; }
    const n = Math.max(1, Math.round(dt / this.fp));
    const per = dt / n;
    if (Math.abs(per - this.fp) < 0.25 * this.fp) this.fp += 0.04 * (per - this.fp);
    return this._reg(T, true);
  }

  _reg(T, learn = false) {
    if (!this.fp) return T;
    const k = Math.round((T - this.ft0) / this.fp);
    const g = this.ft0 + k * this.fp, r = T - g;
    if (Math.abs(r) > 0.3 * this.fp) { if (learn) this.ft0 = T; return T; } // кадр не на сетке — не трогаем
    if (learn) this.ft0 += 0.08 * r; // фаза плавно следует за камерой
    return g;
  }

  async _grab(T) {
    if (this.glf) return this._grabGl(T);
    if (!this.showing) return; // запасной путь снимает кадры только для показа
    // не копим очередь снимков: на слабом телефоне она растёт быстрее, чем разбирается
    if (this.inflight >= 5) return;
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
    T = this._reg(T);
    const poses = this.poses;
    if (poses.length) {
      const dt = T - poses[poses.length - 1].T;
      if (dt <= 0) return;
      const dtc = Math.min(dt, 250);
      this.perDev += 0.1 * (Math.abs(dtc - this.period) - this.perDev);
      this.period += 0.1 * (dtc - this.period);
    }
    const lat = Math.max(0, now - T);
    this.latDev += 0.1 * (Math.abs(lat - this.latency) - this.latDev);
    this.latency += 0.1 * (lat - this.latency);
    poses.push({ T, H });
    if (poses.length > MAX_POSES) poses.shift();
    // нужна задержка не меньше «задержка трекера + период между позами» плюс запас на их разброс (иначе поза
    // иногда опаздывает и референс экстраполируется) и на снимок кадра (иначе кадр не успевает попасть в буфер)
    // Берём высокий перцентиль, а не среднее: поза «с плюсом» (шаг ECC, перезахват ORB, сборка мусора) приходит позже
    // обычного, и если задержки не хватило, референс на эти кадры экстраполируется и на 3–4 отрисовки «выстреливает».
    const lh = this.latHist, ph = this.perHist;
    // первые позы (прогрев воркера, первая позиция) в статистику не берём: одна долгая поза иначе задрала бы задержку на долго
    if (this.nPoses >= 3) { lh.push(lat); if (lh.length > 60) lh.shift(); }
    if (this.diag) (this.latAll || (this.latAll = [])).push(Math.round(lat)); // только для тестов
    if (this.nPoses >= 3 && poses.length > 1) { ph.push(Math.min(T - poses[poses.length - 2].T, 250)); if (ph.length > 60) ph.shift(); }
    const pct = (arr, f) => { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * f))]; };
    const need = Math.max(this.latency + 1.5 * this.latDev + this.period + this.perDev, lh.length >= 15 ? pct(lh, 0.95) + pct(ph, 0.9) : 0) + 6;
    this.target = Math.min(this.maxDelay, Math.max(this.minDelay, need, 2 * this.grabMs + 30));
    this.nPoses++;
  }

  /**
   * Самонастройка под слабый телефон: если снимок кадра или его отрисовка стабильно долгие, уменьшаем кадр показа;
   * на самой нижней ступени и всё ещё тяжело — сообщаем приложению (failed), оно вернётся к обычному видео.
   */
  _governor() {
    const slow = this.glf ? (this.glf.upMs > GL_UP_SLOW_MS || this.glf.readMs > GL_READ_SLOW_MS) : this.grabMs > GRAB_SLOW_MS;
    if (slow || this.drawMs > DRAW_SLOW_MS) this.slowChecks++; else this.slowChecks = Math.max(0, this.slowChecks - 1);
    if (this.slowChecks < 45) return;
    this.slowChecks = 0;
    if (this.level < WIDTHS.length - 1) {
      this.level++;
      this.grabMs = this.drawMs = 0;
      if (this.glf) this.glf.upMs = this.glf.readMs = 0;
      this._setWidth(WIDTHS[this.level]);
    } else if (this.glf && typeof createImageBitmap === 'function') {
      // WebGL на этом устройстве медленный (чтение из видеопамяти) — пробуем запасной путь, прежде чем сдаться
      this.level = 0; this.grabMs = this.drawMs = 0;
      this._glFallback();
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
      this.extrap++;
      const qa = q(last);
      if (poses.length < 2) return qa;
      const prev = poses[poses.length - 2], qb = q(prev);
      const dt = last.T - prev.T;
      const lead = Math.min(MAX_EXTRAP, T - last.T) * EXTRAP_GAIN;
      return qa.map((p, i) => [p[0] + (p[0] - qb[i][0]) / dt * lead, p[1] + (p[1] - qb[i][1]) / dt * lead]);
    }
    let i = poses.length - 1;
    while (i > 0 && poses[i - 1].T > T) i--;
    const a = poses[i - 1], b = poses[i];
    const k = (T - a.T) / (b.T - a.T);
    const qa = q(a), qb = q(b);
    // Кубический Эрмит по соседним позам: между редкими позами (слабый телефон, 8–10 к/с) рука движется по кривой, а
    // линейная интерполяция даёт «ломаную» — референс отстаёт от холста посреди интервала и догоняет к следующей позе.
    const h = b.T - a.T;
    const pa = i >= 2 ? poses[i - 2] : null, pb = i + 1 < poses.length ? poses[i + 1] : null;
    const qpa = pa ? q(pa) : null, qpb = pb ? q(pb) : null;
    const k2 = k * k, k3 = k2 * k;
    const h00 = 2 * k3 - 3 * k2 + 1, h10 = k3 - 2 * k2 + k, h01 = -2 * k3 + 3 * k2, h11 = k3 - k2;
    return qa.map((p, j) => {
      const out = [0, 0];
      for (let c = 0; c < 2; c++) {
        const slope = (qb[j][c] - p[c]) / h;
        // касательные: по соседям (центральная разность), на краю — по самому интервалу
        const ma = qpa ? (qb[j][c] - qpa[j][c]) / (b.T - pa.T) : slope;
        const mb = qpb ? (qpb[j][c] - p[c]) / (pb.T - a.T) : slope;
        // не даём касательной уйти против движения на интервале (иначе петли от шума)
        const ca = ma * slope < 0 ? 0 : ma, cb = mb * slope < 0 ? 0 : mb;
        out[c] = h00 * p[c] + h10 * h * ca + h01 * qb[j][c] + h11 * h * cb;
      }
      return out;
    });
  }

  /**
   * Вызывается на каждой отрисовке экрана. Выбирает кадр для показа (задержка this.delay), рисует его
   * в canvas и возвращает его время T. null — кадров пока нет.
   */
  frame(now) {
    if (!this.active || !this.ring.length) return null;
    this.draws++;
    // Задержка почти постоянна: любое её изменение — это ускорение/замедление картинки (рывок). Поэтому растёт только
    // когда не хватает (быстро, иначе не хватает поз), а убывает лишь когда запас стал большим (30 мс) — и очень медленно.
    const d = this.target - this.delay;
    // (в первые секунды после включения — быстрее, но всё равно медленнее хода времени: скачок задержки назад показал бы
    // прежний кадр, то есть картинка дёрнулась бы вспять)
    if (d > 0) this.delay += Math.min(this.nPoses <= 15 ? 8 : 1.2, d);
    else if (d < -30) this.delay -= Math.min(0.3, Math.max(0.1, (-d - 30) * 0.01)); // 0,1–0,3 мс за отрисовку: ≤ 2% скорости картинки
    const Td = now - this.delay;
    let f = null;
    for (const r of this.ring) { if (r.T <= Td) f = r; else break; }
    if (!f) f = this.ring[0];
    if (f !== this.shown) {
      const d0 = performance.now();
      const old = this.shown;
      if (this.glf) this.glf.draw(f.slot); else this.ctx.drawImage(f.bmp, 0, 0, this.bw, this.bh);
      this.drawMs += 0.1 * ((performance.now() - d0) - this.drawMs);
      this.shown = f;
      if (old && !this.ring.includes(old)) this._free(old); // прежний показанный кадр уже вытеснен из буфера
      this._governor();
    }
    // кадры старше показанного больше не нужны
    while (this.ring.length > 2 && this.ring[0].T < f.T - 100) { const o = this.ring.shift(); if (o !== this.shown) this._free(o); }
    return f.T;
  }
}
