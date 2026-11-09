"""Синтетическое «закрашивание» холста на видео с картиной (tests/.data/art — кадры f001.png…, локальные).
Поверх кадров рисуется однотонная заливка, привязанная к холсту по проверенному эталону tests/.data/art/ref.json:
слева направо закрашивается пейзаж (к кадру 250 — 36% ширины холста). Результат — tests/.data/art_paint."""
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.data')
SRC, DST = os.path.join(ROOT, 'art'), os.path.join(ROOT, 'art_paint')


def homog(src, dst):
    a = []
    for (x, y), (u, v) in zip(src, dst):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y, -u])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y, -v])
    return np.linalg.svd(np.array(a, float))[2][-1].reshape(3, 3)


def ap(h, p):
    v = h @ np.array([p[0], p[1], 1.0])
    return v[0] / v[2], v[1] / v[2]


def main():
    ref = json.load(open(os.path.join(SRC, 'ref.json')))
    os.makedirs(DST, exist_ok=True)
    names = sorted(n for n in os.listdir(SRC) if n.startswith('f') and n.endswith('.png'))
    last = None
    for k, n in enumerate(names, 1):
        im = Image.open(os.path.join(SRC, n)).convert('RGB')
        q = ref.get(str(k)) or last
        last = q
        if q is None or k < 40:
            im.save(os.path.join(DST, n))
            continue
        u = min(max((k - 40) / 210, 0), 1) * 0.36
        h = homog([(0, 0), (1, 0), (1, 1), (0, 1)], q)
        mask = Image.new('L', im.size, 0)
        ImageDraw.Draw(mask).polygon([ap(h, p) for p in [(0, 0), (u, 0), (u, 1), (0, 1)]], fill=255)
        mask = mask.filter(ImageFilter.GaussianBlur(2.5))
        Image.composite(Image.new('RGB', im.size, (236, 232, 228)), im, mask).save(os.path.join(DST, n))
    print('кадров', len(names))


if __name__ == '__main__':
    main()
