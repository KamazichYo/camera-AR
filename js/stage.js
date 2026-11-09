// Сцена: раскладка видео на экране, перевод координат экран ↔ видео и жесты.
import { dist, pointInQuad, similarity, centroid, isConvexQuad } from './geometry.js';

export class Stage {
  constructor(stageEl, worldEl, video) {
    Object.assign(this, { el: stageEl, world: worldEl, video });
    this.fit = 'contain';
    this.s = 1; this.ox = 0; this.oy = 0;
  }

  get vw() { return this.video.videoWidth || 1280; }
  get vh() { return this.video.videoHeight || 720; }

  layout() {
    const r = this.el.getBoundingClientRect();
    this.cw = r.width; this.ch = r.height;
    const { vw, vh } = this;
    this.s = this.fit === 'cover' ? Math.max(r.width / vw, r.height / vh) : Math.min(r.width / vw, r.height / vh);
    this.ox = (r.width - vw * this.s) / 2;
    this.oy = (r.height - vh * this.s) / 2;
    this.world.style.width = vw + 'px';
    this.world.style.height = vh + 'px';
    this.world.style.transform = `translate(${this.ox}px, ${this.oy}px) scale(${this.s})`;
  }

  toVideo([x, y]) { return [(x - this.ox) / this.s, (y - this.oy) / this.s]; }
  toScreen([x, y]) { return [x * this.s + this.ox, y * this.s + this.oy]; }

  /** Видимая часть кадра в координатах видео. */
  visibleRect() {
    const [x0, y0] = this.toVideo([0, 0]);
    const [x1, y1] = this.toVideo([this.cw, this.ch]);
    const l = Math.max(0, x0), t = Math.max(0, y0), r = Math.min(this.vw, x1), b = Math.min(this.vh, y1);
    return { x: l, y: t, w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
  }

  eventPoint(e) {
    const r = this.el.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
}

/**
 * Редактор четырёхугольника: перетаскивание углов (перспектива), перемещение,
 * щипок двумя пальцами (масштаб + поворот), колесо мыши (масштаб, Shift — поворот).
 */
export class QuadEditor {
  constructor(stage, { getQuad, setQuad, onStart, onEnd, allowPinch = true, allowCorners = true }) {
    Object.assign(this, { stage, getQuad, setQuad, onStart, onEnd, allowPinch, allowCorners });
    this.enabled = false;
    this.pointers = new Map();
    this.mode = null;
    this.activeCorner = -1;
    const el = stage.el;
    el.addEventListener('pointerdown', (e) => this._down(e));
    el.addEventListener('pointermove', (e) => this._move(e));
    el.addEventListener('pointerup', (e) => this._up(e));
    el.addEventListener('pointercancel', (e) => this._up(e));
    el.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
  }

  get active() { return this.mode !== null; }

  _hitCorner(sp) {
    const q = this.getQuad();
    if (!q || !this.allowCorners) return -1;
    let best = -1, bd = 34;
    q.forEach((p, i) => { const d = dist(this.stage.toScreen(p), sp); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  _begin(mode) {
    if (!this.mode && this.onStart) this.onStart();
    this.mode = mode;
    this.startQuad = this.getQuad().map((p) => [...p]);
    this.start = new Map([...this.pointers].map(([k, v]) => [k, [...v]]));
  }

  _down(e) {
    if (!this.enabled || !this.getQuad()) return;
    if (e.target.closest && e.target.closest('.ui-block')) return;
    const sp = this.stage.eventPoint(e);
    this.pointers.set(e.pointerId, sp);
    if (this.pointers.size === 1) {
      const c = this._hitCorner(sp);
      if (c >= 0) { this.activeCorner = c; this._begin('corner'); }
      else if (pointInQuad(this.getQuad().map((p) => this.stage.toScreen(p)), sp)) this._begin('move');
      else if (!this.allowPinch) { this.pointers.delete(e.pointerId); return; }
    } else if (this.pointers.size === 2 && this.allowPinch) {
      this._begin('pinch');
    }
    try { this.stage.el.setPointerCapture(e.pointerId); } catch { /* нет захвата */ }
    e.preventDefault();
  }

  _move(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, this.stage.eventPoint(e));
    if (!this.mode) return;
    const st = this.stage;
    if (this.mode === 'corner') {
      const p0 = st.toVideo(this.start.values().next().value);
      const p1 = st.toVideo(this.pointers.values().next().value);
      const q = this.startQuad.map((p) => [...p]);
      q[this.activeCorner] = [q[this.activeCorner][0] + p1[0] - p0[0], q[this.activeCorner][1] + p1[1] - p0[1]];
      if (isConvexQuad(q, 100)) this.setQuad(q);
    } else if (this.mode === 'move') {
      const id = [...this.pointers.keys()][0];
      const s0 = this.start.get(id);
      if (!s0) return;
      const p0 = st.toVideo(s0), p1 = st.toVideo(this.pointers.get(id));
      this.setQuad(similarity(this.startQuad, { t: [p1[0] - p0[0], p1[1] - p0[1]] }));
    } else if (this.mode === 'pinch') {
      const ids = [...this.start.keys()].filter((k) => this.pointers.has(k)).slice(0, 2);
      if (ids.length < 2) return;
      const a0 = st.toVideo(this.start.get(ids[0])), b0 = st.toVideo(this.start.get(ids[1]));
      const a1 = st.toVideo(this.pointers.get(ids[0])), b1 = st.toVideo(this.pointers.get(ids[1]));
      const d0 = dist(a0, b0), d1 = dist(a1, b1);
      if (d0 < 5) return;
      const s = d1 / d0;
      const ang = Math.atan2(b1[1] - a1[1], b1[0] - a1[0]) - Math.atan2(b0[1] - a0[1], b0[0] - a0[0]);
      const m0 = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2], m1 = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
      this.setQuad(similarity(this.startQuad, { c: m0, s, a: ang, t: [m1[0] - m0[0], m1[1] - m0[1]] }));
    }
  }

  _up(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) {
      const was = this.mode;
      this.mode = null; this.activeCorner = -1;
      if (was && this.onEnd) this.onEnd();
    } else if (this.mode === 'pinch') {
      this._begin('move'); // один палец остался — продолжаем перемещение
    }
  }

  _wheel(e) {
    if (!this.enabled || !this.allowPinch || !this.getQuad()) return;
    if (e.target.closest && e.target.closest('.ui-block')) return;
    e.preventDefault();
    const c = this.stage.toVideo(this.stage.eventPoint(e));
    const q = this.getQuad();
    if (this.onStart) this.onStart();
    if (e.shiftKey) this.setQuad(similarity(q, { c: centroid(q), a: (e.deltaY > 0 ? 1 : -1) * (Math.PI / 180) * 2 }));
    else this.setQuad(similarity(q, { c, s: Math.exp(-e.deltaY * 0.0015) }));
    clearTimeout(this._wt);
    this._wt = setTimeout(() => this.onEnd && this.onEnd(), 200);
  }
}
