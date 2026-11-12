// Ориентация в режиме AR: выбирается перед запуском и дальше не меняется, как бы ни крутили телефон.
//
// Веб-страница не может запретить iOS поворачивать интерфейс (screen.orientation.lock в Safari нет), а камера в Safari
// отдаёт кадры «по интерфейсу»: повернули телефон — поток стал альбомным, и картинка в нём повёрнута. Раньше AR от этого
// сбрасывался. Теперь:
//  • кадр камеры поворачивается обратно к ориентации, закреплённой при запуске AR (поворот на 0/90/180/270° — в захвате
//    кадра: в шейдере WebGL или в 2D-canvas), и трекер с показом всегда видят кадры одной ориентации;
//  • весь интерфейс поворачивается CSS-трансформацией навстречу повороту экрана, так что на телефоне всё остаётся на
//    своих местах, как при заблокированном повороте экрана.
// Направление поворота кадра берётся из угла экрана и проверяется по самой картинке: при смене ориентации новый кадр,
// повёрнутый одним и другим способом, сравнивается с последним кадром до смены (нормированная корреляция миниатюр).

const norm360 = (a) => ((Math.round(a / 90) * 90) % 360 + 360) % 360;

/** Угол интерфейса (0/90/180/270): на сколько градусов против часовой повёрнут телефон относительно «книжной». */
export function screenAngle() {
  const so = typeof screen !== 'undefined' && screen.orientation;
  if (so && typeof so.angle === 'number') return norm360(so.angle);
  if (typeof window.orientation === 'number') return norm360(window.orientation);
  return 0;
}

/** Нарисовать источник (sw×sh) в ctx размером ow×oh, повернув на rot° по часовой. */
export function drawRotated(ctx, src, sw, sh, rot, ow, oh) {
  ctx.save();
  if (rot === 90) { ctx.translate(ow, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(src, 0, 0, sw, sh, 0, 0, oh, ow); }
  else if (rot === 180) { ctx.translate(ow, oh); ctx.rotate(Math.PI); ctx.drawImage(src, 0, 0, sw, sh, 0, 0, ow, oh); }
  else if (rot === 270) { ctx.translate(0, oh); ctx.rotate(-Math.PI / 2); ctx.drawImage(src, 0, 0, sw, sh, 0, 0, oh, ow); }
  else ctx.drawImage(src, 0, 0, sw, sh, 0, 0, ow, oh);
  ctx.restore();
}

const TH = 24; // сторона миниатюры для проверки направления поворота

export class Orient {
  constructor(video) {
    this.video = video;
    this.rot = 0;            // поворот кадра камеры (по часовой) к закреплённой ориентации
    this.ui = 0;             // поворот интерфейса (против часовой — навстречу повороту экрана)
    this.locked = false;
    this.lockAngle = 0;      // угол интерфейса, закреплённый при запуске AR
    this.lockW = 0; this.lockH = 0; // размеры кадра в закреплённой ориентации
    this.onChange = null;    // (rotChanged, ok) => void; ok = false — поток уже не сводится к закреплённому кадру
    this.thumb = null;       // миниатюра последнего кадра (в закреплённой ориентации) — для проверки направления
    this._tc = null;
    this.forceUi = null;     // тесты: подменить угол интерфейса
    const self = this;
    // объект с размерами «как у видео» для сцены и трекера: размеры кадра в закреплённой ориентации
    this.view = {
      get videoWidth() { return self.w; },
      get videoHeight() { return self.h; },
    };
    const upd = () => this.update();
    if (typeof screen !== 'undefined' && screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', upd);
    window.addEventListener('orientationchange', upd);
    window.addEventListener('resize', upd);
    video.addEventListener('resize', upd);
  }

  get srcW() { return this.video.videoWidth; }
  get srcH() { return this.video.videoHeight; }
  /** Размеры кадра в закреплённой ориентации. */
  get w() { return this.rot % 180 ? this.srcH : this.srcW; }
  get h() { return this.rot % 180 ? this.srcW : this.srcH; }

  angle() { return this.forceUi !== null ? this.forceUi : screenAngle(); }

  /**
   * Закрепить ориентацию. mode: 'auto' — как держат телефон сейчас; 'portrait' / 'landscape' — заданная.
   */
  lock(mode = 'auto') {
    const a = this.angle();
    let la = a;
    if (mode === 'portrait' && a % 180) la = 0;
    else if (mode === 'landscape' && !(a % 180)) la = 90;
    this.locked = true;
    this.lockAngle = la;
    this.rot = norm360(a - la);
    this.lockW = this.w; this.lockH = this.h;
    this._applyUi(norm360(a - la));
    this._applyVideo();
    this.snapThumb();
  }

  unlock() {
    this.locked = false;
    this.rot = 0;
    this._applyUi(0);
    this._applyVideo();
  }

  /** Экран или поток повернулись: пересчитать поворот кадра и интерфейса. */
  update() {
    if (!this.locked) return;
    const a = this.angle();
    const d = norm360(a - this.lockAngle);
    this._applyUi(d);
    const sw = this.srcW, sh = this.srcH;
    if (!sw || !sh) return;
    // какой поворот вообще возможен по размерам потока
    const swapped = (sw > sh) !== (this.lockW > this.lockH) && sw !== sh;
    const cands = swapped ? [90, 270] : [0, 180];
    let rot = this.rot;
    if (!cands.includes(rot)) {
      // ближайший к углу экрана; при равенстве — проверка по картинке решит
      const dist = (r) => Math.min(Math.abs(r - d), 360 - Math.abs(r - d));
      rot = dist(cands[0]) <= dist(cands[1]) ? cands[0] : cands[1];
      const byImg = this._pickByImage(cands);
      if (byImg !== null) rot = byImg;
    }
    const changed = rot !== this.rot;
    this.rot = rot;
    const ok = Math.abs(this.w * this.lockH - this.h * this.lockW) <= 0.02 * this.lockW * this.lockH; // пропорции кадра те же
    this._applyVideo();
    if (changed || !ok) { if (this.onChange) this.onChange(changed, ok); }
  }

  /** Миниатюра текущего кадра в закреплённой ориентации (серое, TH×TH) — вызывается время от времени при трекинге. */
  snapThumb() {
    if (this.w !== this.lockW || this.h !== this.lockH) return; // поток уже сменился, а update ещё не пришёл
    const t = this._thumbOf(this.rot);
    if (t) this.thumb = t;
  }

  _thumbOf(rot) {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return null;
    if (!this._tc) { this._tc = document.createElement('canvas'); this._tc.width = this._tc.height = TH; this._tx = this._tc.getContext('2d', { willReadFrequently: true }); }
    try { drawRotated(this._tx, v, v.videoWidth, v.videoHeight, rot, TH, TH); } catch { return null; }
    const d = this._tx.getImageData(0, 0, TH, TH).data, g = new Float32Array(TH * TH);
    for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    return g;
  }

  /** Какой из двух поворотов делает новый кадр похожим на последний кадр до смены. null — не ясно. */
  _pickByImage(cands) {
    if (!this.thumb) return null;
    const ncc = (a, b) => {
      let ma = 0, mb = 0;
      for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
      ma /= a.length; mb /= b.length;
      let sab = 0, saa = 0, sbb = 0;
      for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
      return saa > 1 && sbb > 1 ? sab / Math.sqrt(saa * sbb) : 0;
    };
    const s = cands.map((r) => { const t = this._thumbOf(r); return t ? ncc(t, this.thumb) : -2; });
    if (Math.abs(s[0] - s[1]) < 0.15 || Math.max(...s) < 0.3) return null;
    return s[0] > s[1] ? cands[0] : cands[1];
  }

  /** Живой <video> (когда не идёт показ из буфера кадров) — тоже в закреплённой ориентации. */
  _applyVideo() {
    const v = this.video, st = v.style;
    if (!this.rot) { st.width = st.height = st.left = st.top = st.transform = st.inset = ''; return; }
    const sw = this.srcW, sh = this.srcH, w = this.w, h = this.h;
    st.inset = 'auto';
    st.width = sw + 'px'; st.height = sh + 'px';
    st.left = (w - sw) / 2 + 'px'; st.top = (h - sh) / 2 + 'px';
    st.transform = `rotate(${this.rot}deg)`;
  }

  /**
   * Интерфейс: экран повернулся на d° против часовой — поворачиваем всю страницу на d° по часовой… точнее, навстречу:
   * содержимое, повёрнутое на −d (против часовой в координатах экрана), стоит на телефоне так же, как до поворота.
   */
  _applyUi(d) {
    const b = document.body;
    this.ui = d;
    b.classList.remove('ui-rot', 'ui-rot-90', 'ui-rot-180', 'ui-rot-270');
    const bs = b.style;
    if (!d) { bs.width = bs.height = bs.transform = ''; return; }
    const iw = window.innerWidth, ih = window.innerHeight;
    b.classList.add('ui-rot', 'ui-rot-' + d);
    if (d === 180) { bs.width = iw + 'px'; bs.height = ih + 'px'; bs.transform = `translate(${iw}px, ${ih}px) rotate(180deg)`; }
    else if (d === 90) { bs.width = ih + 'px'; bs.height = iw + 'px'; bs.transform = `translateY(${ih}px) rotate(-90deg)`; }
    else { bs.width = ih + 'px'; bs.height = iw + 'px'; bs.transform = `translateX(${iw}px) rotate(90deg)`; }
  }

  /** Точка касания (clientX/clientY) → координаты в повёрнутой странице. */
  toUi(cx, cy) {
    const iw = window.innerWidth, ih = window.innerHeight;
    if (this.ui === 90) return [ih - cy, cx];
    if (this.ui === 270) return [cy, iw - cx];
    if (this.ui === 180) return [iw - cx, ih - cy];
    return [cx, cy];
  }
}
