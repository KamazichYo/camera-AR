"""Сцена с параллаксом: белая панель стоит на столе (как диспенсер для салфеток), камера облетает её.
Опоры «на столе» лежат в другой плоскости, чем сама панель — гомография по смеси плоскостей уезжает.
Результат: tests/.data/parallax/f001.png…, gt.json (кадр → четыре угла панели), anchors.json (точки на столе, по кадрам).
Запуск: python3 tests/gen_parallax.py [blank]   (blank — панель без логотипа, только края)"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.data', 'parallax')
W, H, F = 640, 360, 520.0
N = 160
PPM = 700  # пикселей текстуры на метр
BLANK = len(sys.argv) > 1 and sys.argv[1] == 'blank'
rng = np.random.default_rng(7)


def noise_tex(w, h, base, amp, scale, seed):
    r = np.random.default_rng(seed)
    a = r.normal(0, 1, (h // scale + 2, w // scale + 2))
    img = Image.fromarray(((a - a.min()) / (a.max() - a.min()) * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
    t = np.asarray(img).astype(np.float32) / 255.0 - 0.5
    return np.clip(base + amp * t * 2, 0, 255)


def make_table():
    w = h = int(4.4 * PPM)
    g = noise_tex(w, h, 228, 10, 24, 1) + noise_tex(w, h, 0, 6, 5, 2)
    im = Image.fromarray(np.clip(g, 0, 255).astype(np.uint8)).convert('RGB')
    d = ImageDraw.Draw(im)
    for _ in range(90):  # крошки и пятна
        x, y = rng.integers(0, w), rng.integers(0, h)
        r = int(rng.integers(2, 7)); c = int(rng.integers(150, 190))
        d.ellipse((x - r, y - r, x + r, y + r), fill=(c, c, c - 6))
    return im


def make_wall():
    w, h = int(4.4 * PPM), int(1.6 * PPM)
    g = noise_tex(w, h, 196, 12, 30, 3) + noise_tex(w, h, 0, 5, 4, 4)
    return Image.fromarray(np.clip(g, 0, 255).astype(np.uint8)).convert('RGB')


def make_panel():
    w, h = int(0.34 * PPM), int(0.24 * PPM)
    g = noise_tex(w, h, 196, 3, 40, 5)  # панель серее стола (228) и светлее стены (180): края видны, но слабо
    im = Image.fromarray(np.clip(g, 0, 255).astype(np.uint8)).convert('RGB')
    if not BLANK:
        d = ImageDraw.Draw(im)
        d.rectangle((int(0.06 * w), int(0.3 * h), int(0.94 * w), int(0.62 * h)), outline=(40, 50, 140), width=3)
        d.text((int(0.12 * w), int(0.38 * h)), 'ECCA', fill=(30, 40, 150))
        d.line((int(0.1 * w), int(0.7 * h), int(0.9 * w), int(0.74 * h)), fill=(60, 60, 70), width=3)
        for k in range(7):
            x = int(w * (0.12 + 0.12 * k)); d.ellipse((x - 4, int(0.12 * h) - 4, x + 4, int(0.12 * h) + 4), fill=(90, 90, 100))
    return im


def cam(t):
    """Положение камеры: облёт вокруг панели ±38° с покачиванием, лёгкое приближение."""
    az = math.radians(38 * math.sin(2 * math.pi * t / N * 1.0) + 4 * math.sin(2 * math.pi * t / 17))
    el = math.radians(26 + 5 * math.sin(2 * math.pi * t / 41))
    r = 0.78 - 0.08 * math.sin(2 * math.pi * t / N)
    target = np.array([0.0, 0.11, 0.0])
    pos = target + r * np.array([math.sin(az) * math.cos(el), math.sin(el), math.cos(az) * math.cos(el)])
    f = (target - pos); f /= np.linalg.norm(f)
    right = np.cross(f, np.array([0, 1.0, 0])); right /= np.linalg.norm(right)
    up = np.cross(right, f)
    R = np.stack([right, -up, f])  # строки: x вправо, y вниз, z вперёд
    return R, -R @ pos


K = np.array([[F, 0, W / 2], [0, F, H / 2], [0, 0, 1.0]])


def plane_h(R, tv, origin, eu, ev):
    """Гомография: координаты плоскости (u, v, 1) → пиксели."""
    cols = [R @ eu, R @ ev, R @ origin + tv]
    return K @ np.stack(cols, 1)


def project(R, tv, X):
    p = K @ (R @ np.asarray(X) + tv)
    return p[:2] / p[2]


def render_plane(img, Hp, origin_px, size):
    """Накладывает текстуру плоскости: texel (px,py) = (u*PPM, v*PPM) + origin_px."""
    S = np.array([[PPM, 0, origin_px[0]], [0, PPM, origin_px[1]], [0, 0, 1.0]])
    Ht = Hp @ np.linalg.inv(S)  # texel → пиксель
    return Ht


def warp(tex, Ht, out_size=(W, H)):
    Hi = np.linalg.inv(Ht); Hi /= Hi[2, 2]
    c = tuple(Hi.flatten()[:8])
    return tex.transform(out_size, Image.PERSPECTIVE, c, Image.BICUBIC)


def main():
    os.makedirs(OUT, exist_ok=True)
    table, wall, panel = make_table(), make_wall(), make_panel()
    pw, ph = panel.size
    mask_p = Image.new('L', panel.size, 255)
    panel_corners3 = [(-0.17, 0.24, 0), (0.17, 0.24, 0), (0.17, 0.0, 0), (-0.17, 0.0, 0)]  # TL, TR, BR, BL (y вверх)
    anchors3 = [(-0.32, 0, 0.18), (0.30, 0, 0.22), (-0.1, 0, 0.34), (0.12, 0, 0.12), (-0.28, 0, -0.1)]  # точки на столе
    gt, anc = {}, {}
    for t in range(N):
        R, tv = cam(t)
        # стол: плоскость y=0, u=x, v=z; начало текстуры — центр
        Hp = plane_h(R, tv, np.array([-2.2, 0, -2.2]), np.array([1.0, 0, 0]), np.array([0, 0, 1.0]))
        frame = warp(table, render_plane(table, Hp, (0, 0), None))
        # стена: плоскость z=-0.45, u=x, v=-y (вниз)
        Hw = plane_h(R, tv, np.array([-2.2, 1.2, -0.45]), np.array([1.0, 0, 0]), np.array([0, -1.0, 0]))
        wallim = warp(wall, render_plane(wall, Hw, (0, 0), None))
        wmask = warp(Image.new('L', wall.size, 255), render_plane(wall, Hw, (0, 0), None))
        # стена позади стола: рисуем сначала стену, затем стол поверх там, где стол «ближе» — упрощённо: стена, потом стол по маске
        tmask = warp(Image.new('L', table.size, 255), render_plane(table, Hp, (0, 0), None))
        base = Image.composite(frame, wallim, tmask)
        # панель: плоскость z=0, u=x, v=-y, начало (−0.17, 0.24)
        Hq = plane_h(R, tv, np.array([-0.17, 0.24, 0]), np.array([1.0, 0, 0]), np.array([0, -1.0, 0]))
        pimg = warp(panel, render_plane(panel, Hq, (0, 0), None))
        pm = warp(mask_p, render_plane(panel, Hq, (0, 0), None))
        # панель видна, только если смотрим на неё спереди (камера по +z): всегда так при |az|<90°
        out = Image.composite(pimg, base, pm).filter(ImageFilter.GaussianBlur(0.6))
        a = np.asarray(out).astype(np.float32)
        a += np.random.default_rng(100 + t).normal(0, 1.2, a.shape)  # шум камеры
        Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(os.path.join(OUT, f'f{t + 1:03d}.png'))
        gt[str(t + 1)] = [project(R, tv, c).tolist() for c in panel_corners3]
        anc[str(t + 1)] = [project(R, tv, c).tolist() for c in anchors3]
    json.dump(gt, open(os.path.join(OUT, 'gt.json'), 'w'))
    json.dump(anc, open(os.path.join(OUT, 'anchors.json'), 'w'))
    print('кадров', N, 'панель кадр 1:', [[round(v, 1) for v in p] for p in gt['1']])


if __name__ == '__main__':
    main()
