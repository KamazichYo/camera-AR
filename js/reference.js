// Картинка-референс: загрузка и режимы отображения (цвет, Ч/Б, контур, инверсия, сетка).
const MAX_SIDE = 2048;

export class Reference {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ref';
    this.source = null;   // ImageBitmap | HTMLImageElement
    this.blob = null;
    this.width = 0; this.height = 0;
    this._edges = null;
  }

  get loaded() { return !!this.source; }
  get aspect() { return this.width / this.height; }

  async load(blob) {
    let src;
    try {
      src = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      src = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error('Не удалось открыть изображение'));
        img.src = URL.createObjectURL(blob);
      });
    }
    const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    this.width = Math.round(w * k); this.height = Math.round(h * k);
    this.source = src;
    this.blob = blob;
    this._edges = null;
  }

  clear() {
    if (this.source && this.source.close) this.source.close();
    this.source = null; this.blob = null; this._edges = null;
  }

  /** Перерисовать с учётом настроек { mode, lineColor, grid, gridN }. */
  render({ mode = 'color', lineColor = '#ff2d55', grid = false, gridN = 6 } = {}) {
    if (!this.source) return;
    const c = this.canvas, w = this.width, h = this.height;
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    if (mode === 'outline') {
      ctx.drawImage(this._outline(lineColor), 0, 0);
    } else if (mode !== 'none') {
      ctx.filter = mode === 'gray' ? 'grayscale(1) contrast(1.1)' : mode === 'invert' ? 'invert(1)' : 'none';
      ctx.drawImage(this.source, 0, 0, w, h);
      ctx.filter = 'none';
      if (mode === 'gray' && !('filter' in ctx)) this._grayFallback(ctx);
    }
    if (grid || mode === 'none') this._grid(ctx, lineColor, Math.max(2, gridN));
  }

  _grayFallback(ctx) {
    const d = ctx.getImageData(0, 0, this.width, this.height);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      const y = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
      p[i] = p[i + 1] = p[i + 2] = y;
    }
    ctx.putImageData(d, 0, 0);
  }

  _grid(ctx, color, n) {
    const w = this.width, h = this.height;
    const cell = w / n; // квадратные клетки: n по ширине
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(1.5, Math.max(w, h) / 500);
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const x = Math.min(w - ctx.lineWidth / 2, Math.max(ctx.lineWidth / 2, i * cell));
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
    }
    for (let y = 0, i = 0; y <= h + 0.5; y += cell, i++) {
      const yy = Math.min(h - ctx.lineWidth / 2, Math.max(ctx.lineWidth / 2, y));
      ctx.moveTo(0, yy); ctx.lineTo(w, yy);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Контур: оператор Собеля по сглаженной яркости, линии нужного цвета на прозрачном фоне. */
  _outline(color) {
    const w = this.width, h = this.height;
    if (!this._edges) {
      const t = document.createElement('canvas');
      t.width = w; t.height = h;
      const tc = t.getContext('2d', { willReadFrequently: true });
      tc.drawImage(this.source, 0, 0, w, h);
      const px = tc.getImageData(0, 0, w, h).data;
      const g = new Float32Array(w * h);
      for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      // размытие 3x3 (дважды) — убирает шум JPEG
      const b = new Float32Array(w * h);
      for (let pass = 0; pass < 2; pass++) {
        const src = pass ? b.slice() : g, dst = b;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            let s = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = y + dy; if (yy < 0 || yy >= h) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx; if (xx < 0 || xx >= w) continue;
                s += src[yy * w + xx]; n++;
              }
            }
            dst[y * w + x] = s / n;
          }
        }
      }
      const m = new Float32Array(w * h);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const gx = -b[i - w - 1] - 2 * b[i - 1] - b[i + w - 1] + b[i - w + 1] + 2 * b[i + 1] + b[i + w + 1];
          const gy = -b[i - w - 1] - 2 * b[i - w] - b[i - w + 1] + b[i + w - 1] + 2 * b[i + w] + b[i + w + 1];
          m[i] = Math.hypot(gx, gy);
        }
      }
      // нормировка по 97-му перцентилю
      const sample = [];
      for (let i = 0; i < m.length; i += 7) sample.push(m[i]);
      sample.sort((a, z) => a - z);
      const p = sample[Math.floor(sample.length * 0.97)] || 1;
      const a = new Uint8ClampedArray(w * h);
      for (let i = 0; i < m.length; i++) {
        const v = m[i] / p;
        a[i] = v < 0.18 ? 0 : Math.min(255, (v - 0.18) * 320);
      }
      this._edges = a;
    }
    const [r, gg, bb] = hexToRgb(color);
    const out = new ImageData(w, h);
    const o = out.data, a = this._edges;
    for (let i = 0, j = 0; j < a.length; i += 4, j++) { o[i] = r; o[i + 1] = gg; o[i + 2] = bb; o[i + 3] = a[j]; }
    const t = document.createElement('canvas');
    t.width = w; t.height = h;
    t.getContext('2d').putImageData(out, 0, 0);
    return t;
  }
}

function hexToRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
