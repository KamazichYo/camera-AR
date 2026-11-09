"""Синтетические сцены для тестов AR с известным положением листа (ground truth).

Сцены (каталог tests/.data/<сцена>/):
  main  — лист с рисунком на текстурном столе: движение/поворот/перспектива, рука,
          выход к краю, полное перекрытие камеры с «прыжком» листа, дорисовка.
  blank — ПУСТОЙ лист на текстурном столе: лист поворачивают и двигают по столу
          (фон неподвижен), руки перекрывают края, потом сдвигается сама камера.
  light — лист с рисунком при плохих условиях: автоэкспозиция (яркость скачет),
          бегающая тень от руки, смаз при быстром движении, шум.

Для каждой сцены: frames/fNNN.png, gt.json (углы листа по кадрам);
для main ещё fake.y4m (фейковая камера Chromium) и ref.png.
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 640, 360
N = 240
PW, PH = 800, 600
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.data')


def strokes(draw, n, seed):
    r = np.random.default_rng(seed)
    for _ in range(n):
        pts = []
        x, y = r.uniform(60, PW - 60), r.uniform(60, PH - 60)
        a = r.uniform(0, 2 * math.pi)
        for _k in range(r.integers(6, 14)):
            a += r.normal(0, 0.6)
            s = r.uniform(15, 45)
            x = min(PW - 30, max(30, x + math.cos(a) * s))
            y = min(PH - 30, max(30, y + math.sin(a) * s))
            pts.append((x, y))
        draw.line(pts, fill=(40, 40, 45), width=int(r.integers(2, 5)), joint='curve')


def paper(stage, blank=False):
    rng = np.random.default_rng(11)
    base = np.full((PH, PW, 3), (238, 233, 222), np.float32)
    base += rng.normal(0, 1.5, (PH, PW, 1))  # лёгкая фактура бумаги
    im = Image.fromarray(base.clip(0, 255).astype(np.uint8))
    if blank:
        return im
    d = ImageDraw.Draw(im)
    strokes(d, 14, 1)
    d.ellipse((480, 120, 640, 280), outline=(50, 50, 55), width=4)
    for i in range(12):
        d.line((120 + i * 12, 400, 180 + i * 12, 520), fill=(70, 70, 75), width=2)
    if stage >= 1:
        strokes(d, 10, 2)  # рисунок дополняется
    if stage >= 2:
        strokes(d, 10, 3)
    return im


def table(seed=7, w=W, h=H):
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w]
    bg = 110 + 25 * np.sin(xx / 9.0 + 3 * np.sin(yy / 40.0)) + rng.normal(0, 10, (h, w))
    bg = np.stack([bg * 1.0, bg * 0.75, bg * 0.5], -1).clip(0, 255).astype(np.uint8)
    return Image.fromarray(bg).filter(ImageFilter.GaussianBlur(0.8))


def homog(src, dst):
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A += [[x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]]
    A = np.array(A, float)
    h = np.linalg.solve(A[:, :8], A[:, 8])
    return np.append(h, 1).reshape(3, 3)


def quad(cx, cy, s, rot, tilt=0.0):
    hw, hh = PW * s / 2, PH * s / 2
    q = []
    for dx, dy in [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]:
        dx *= 1 + (tilt if dy < 0 else -tilt) * 0.5
        q.append((cx + dx * math.cos(rot) - dy * math.sin(rot), cy + dx * math.sin(rot) + dy * math.cos(rot)))
    return q


def warp_onto(frame, src, q):
    Hm = homog([(0, 0), (PW, 0), (PW, PH), (0, PH)], q)
    Hi = np.linalg.inv(Hm)
    Hi /= Hi[2, 2]
    coeffs = tuple(Hi.flatten()[:8])
    pim = src.transform(frame.size, Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    pm = Image.new('L', src.size, 255).transform(frame.size, Image.PERSPECTIVE, coeffs, Image.BILINEAR)
    frame.paste(pim, (0, 0), pm)


def hand(d, hx, hy, ang=0.0, color=(200, 150, 120)):
    d.ellipse((hx - 60, hy - 35, hx + 60, hy + 35), fill=color)
    ex, ey = hx + 260 * math.cos(ang), hy + 260 * math.sin(ang)
    d.line((hx, hy, ex, ey), fill=tuple(c - 10 for c in color), width=50)


# ---------------------------------------------------------------- main
def scene_main(rng):
    bg = table()
    papers = [paper(0), paper(1), paper(2)]
    for t in range(N):
        cx, cy, s, rot, tilt = 320, 180, 0.42, 0.0, 0.0
        if t < 40:
            pass
        elif t < 120:
            u = (t - 40) / 80
            cx += 60 * math.sin(u * 2 * math.pi)
            cy += 25 * math.sin(u * 4 * math.pi)
            rot = 0.25 * math.sin(u * 2 * math.pi)
            s *= 1 + 0.15 * math.sin(u * 3 * math.pi)
            tilt = 0.12 * math.sin(u * 2 * math.pi)
        elif t < 150:
            cx += 20; rot = 0.08
        elif t < 170:
            cx += 20 + 200 * (t - 150) / 20; rot = 0.08
        elif t < 200:
            cx -= 40; cy += 10; rot = -0.15; s *= 0.95  # новая позиция после перекрытия
        else:
            u = (t - 200) / 40
            cx -= 40 - 50 * u; cy += 10; rot = -0.15 + 0.1 * u; s *= 0.95
        jit = rng.normal(0, 0.4, 2)
        q = quad(cx + jit[0], cy + jit[1], s, rot, tilt)
        fr = bg.copy()
        warp_onto(fr, papers[0 if t < 205 else (1 if t < 225 else 2)], q)
        d = ImageDraw.Draw(fr)
        if 120 <= t < 150:
            u = (t - 120) / 30
            hand(d, 250 + 150 * u, 120 + 40 * math.sin(u * 6))
        covered = 170 <= t < 180
        if covered:
            d.rectangle((0, 0, W, H), fill=(20, 20, 20))
        arr = np.asarray(fr).astype(np.float32) + rng.normal(0, 2.5, (H, W, 3))
        # штрих-код номера кадра (10 бит) в левом нижнем углу — для e2e-замера задержки
        for i in range(10):
            arr[350:360, 8 * i:8 * i + 8] = 255 if (t >> i) & 1 else 0
        yield arr, q, {'covered': covered}


# ---------------------------------------------------------------- blank
def scene_blank(rng):
    # мир больше кадра: в конце двигается камера (сдвиг + поворот всего кадра)
    MW, MH = 760, 460
    bg = table(seed=3, w=MW, h=MH)
    sheet = paper(0, blank=True)
    for t in range(N):
        cx, cy, s, rot = MW / 2, MH / 2, 0.36, 0.0
        if t < 30:
            pass
        elif 176 <= t < 188:  # пока камера закрыта, лист сдвигают и поворачивают
            u = (t - 176) / 12
            rot = -0.2 * (26 / 40) - 0.12 * u; cx -= 30 * (26 / 40) + 25 * u; cy += 12 * u
        elif t < 110:  # лист поворачивают и двигают по столу
            u = (t - 30) / 80
            rot = 0.35 * math.sin(u * math.pi)
            cx += 45 * math.sin(u * 2 * math.pi)
            cy += 20 * (1 - math.cos(u * 2 * math.pi)) / 2
        elif t < 150:  # пауза, руки перекрывают края листа
            rot = 0.0
        elif t < 176:
            u = (t - 150) / 40
            rot = -0.2 * u; cx -= 30 * u
        else:
            rot = -0.2 * (26 / 40) - 0.12; cx -= 30 * (26 / 40) + 25; cy += 12
        q_world = quad(cx, cy, s, rot)
        world = bg.copy()
        warp_onto(world, sheet, q_world)
        d = ImageDraw.Draw(world)
        if 110 <= t < 150:
            u = (t - 110) / 40
            hand(d, cx - 120 + 80 * u, cy + 100, ang=1.2)          # снизу через край
            hand(d, cx + 150, cy - 80 + 60 * math.sin(u * 4), ang=-0.4)  # справа через край
        # камера: смещение/поворот кадра в мире
        cam_x, cam_y, cam_r = (MW - W) / 2, (MH - H) / 2, 0.0
        if t >= 200:
            u = (t - 200) / 40
            cam_x += 35 * math.sin(u * math.pi); cam_y -= 20 * u; cam_r = 0.08 * u
        # кадр = мир, преобразованный обратной позой камеры
        cr, sr = math.cos(cam_r), math.sin(cam_r)
        ccx, ccy = cam_x + W / 2, cam_y + H / 2

        def to_frame(p):
            x, y = p[0] - ccx, p[1] - ccy
            return (x * cr + y * sr + W / 2, -x * sr + y * cr + H / 2)

        # обратное отображение кадр → мир для PIL (аффинное)
        a, b = cr, -sr
        c = ccx - (W / 2) * cr + (H / 2) * sr
        dd, e = sr, cr
        f = ccy - (W / 2) * sr - (H / 2) * cr
        fr = world.transform((W, H), Image.AFFINE, (a, b, c, dd, e, f), Image.BICUBIC)
        q = [to_frame(p) for p in q_world]
        covered = 176 <= t < 188  # камеру закрыли, а лист в это время сдвинули
        if covered:
            ImageDraw.Draw(fr).rectangle((0, 0, W, H), fill=(25, 22, 20))
        arr = np.asarray(fr).astype(np.float32) + rng.normal(0, 2.5, (H, W, 3))
        yield arr, q, {'covered': covered}


# ---------------------------------------------------------------- light
def scene_light(rng):
    bg = table(seed=5)
    sheet = paper(1)
    yy, xx = np.mgrid[0:H, 0:W]
    prev = None
    for t in range(N):
        u = t / N
        cx = 320 + 70 * math.sin(u * 4 * math.pi)
        cy = 180 + 20 * math.sin(u * 6 * math.pi)
        rot = 0.2 * math.sin(u * 2 * math.pi)
        if 150 <= t < 190:  # резкие рывки
            cx += 60 * math.sin((t - 150) / 40 * 2 * math.pi)
        q = quad(cx, cy, 0.4, rot, 0.08 * math.sin(u * 3 * math.pi))
        fr = bg.copy()
        warp_onto(fr, sheet, q)
        arr = np.asarray(fr).astype(np.float32)
        # смаз: усредняем со сдвигом вдоль движения
        if prev is not None:
            vx, vy = cx - prev[0], cy - prev[1]
            sp = math.hypot(vx, vy)
            if sp > 2:
                img = Image.fromarray(arr.clip(0, 255).astype(np.uint8))
                acc = np.zeros_like(arr)
                k = int(min(9, sp))
                for i in range(k):
                    dx, dy = vx * (i / k - 0.5), vy * (i / k - 0.5)
                    acc += np.asarray(img.transform((W, H), Image.AFFINE, (1, 0, dx, 0, 1, dy), Image.BILINEAR), np.float32)
                arr = acc / k
        prev = (cx, cy)
        # тень руки: мягкое тёмное пятно
        sx, sy = 200 + 260 * (0.5 + 0.5 * math.sin(u * 5 * math.pi)), 150 + 80 * math.cos(u * 3 * math.pi)
        shadow = 1 - 0.55 * np.exp(-(((xx - sx) / 90) ** 2 + ((yy - sy) / 60) ** 2))
        # автоэкспозиция
        gain = 1 + 0.32 * math.sin(u * 7 * math.pi) + (0.25 if 100 <= t < 110 else 0)
        arr = arr * shadow[..., None] * gain + rng.normal(0, 4, (H, W, 3))
        yield arr, q, {}


SCENES = {'main': scene_main, 'blank': scene_blank, 'light': scene_light}


def write_y4m(path, frames):
    with open(path, 'wb') as f:
        f.write(f'YUV4MPEG2 W{W} H{H} F20:1 Ip A1:1 C420jpeg\n'.encode())
        for arr in frames:
            R, G, B = [arr[..., i].astype(np.float32) for i in range(3)]
            Y = 0.299 * R + 0.587 * G + 0.114 * B
            U = (-0.168736 * R - 0.331264 * G + 0.5 * B + 128).reshape(H // 2, 2, W // 2, 2).mean((1, 3))
            V = (0.5 * R - 0.418688 * G - 0.081312 * B + 128).reshape(H // 2, 2, W // 2, 2).mean((1, 3))
            f.write(b'FRAME\n')
            for c in (Y, U, V):
                f.write(c.clip(0, 255).astype(np.uint8).tobytes())


def generate(name):
    rng = np.random.default_rng(7)
    out = os.path.join(ROOT, name)
    os.makedirs(os.path.join(out, 'frames'), exist_ok=True)
    gt, y4m = [], []
    for t, (arr, q, extra) in enumerate(SCENES[name](rng)):
        arr = arr.clip(0, 255).astype(np.uint8)
        Image.fromarray(arr).save(os.path.join(out, 'frames', f'f{t:03d}.png'))
        gt.append({'t': t, 'q': [list(map(float, p)) for p in q], 'covered': bool(extra.get('covered'))})
        if name == 'main':
            y4m.append(arr)
    with open(os.path.join(out, 'gt.json'), 'w') as f:
        json.dump(gt, f)
    if name == 'main':
        write_y4m(os.path.join(ROOT, 'fake.y4m'), y4m)
        ref = Image.new('RGB', (400, 300), (255, 255, 255))
        d = ImageDraw.Draw(ref)
        d.ellipse((100, 50, 300, 250), outline=(0, 0, 0), width=6)
        d.line((0, 300, 400, 0), fill=(200, 0, 0), width=6)
        ref.save(os.path.join(ROOT, 'ref.png'))
    print('сцена', name, len(gt), 'кадров')


if __name__ == '__main__':
    for n in (sys.argv[1:] or list(SCENES)):
        generate(n)
