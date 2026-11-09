"""Варианты реальной фотографии для проверки автопоиска холста (tests/.data/real/easel.png —
локальный файл, не коммитится): поворот, отдаление, альбомная ориентация, низкий контраст,
тёмная съёмка, размытие, шум. Истинные углы пересчитываются вместе с геометрией.
Результат: tests/.data/real/<имя>.png и tests/.data/real/variants.json"""
import json
import math
import os

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.data', 'real')
BASE = 'easel.png'
# углы холста (TL, TR, BR, BL) на базовом кадре
GT = [[17, 365], [698, 389], [694, 826], [50, 819]]
# видимые углы холста по границе живописи (то, что реально различимо по краям)
PAINT = [[70, 361], [700, 384], [694, 827], [49, 811]]


def affine(img, M, size, fill=None):
    """img → size по матрице M (2x3, прямое отображение src→dst).
    За краями кадра продолжается ближайший пиксель — без искусственных рамок."""
    P = 500
    a = np.pad(np.asarray(img), ((P, P), (P, P), (0, 0)), mode='edge')
    big = Image.fromarray(a)
    A = np.vstack([M, [0, 0, 1]]) @ np.array([[1, 0, -P], [0, 1, -P], [0, 0, 1]], float)
    Ai = np.linalg.inv(A)
    return big.transform(size, Image.AFFINE, tuple(Ai[:2].flatten()), Image.BICUBIC)


def apply(M, pts):
    return [[M[0][0] * x + M[0][1] * y + M[0][2], M[1][0] * x + M[1][1] * y + M[1][2]] for x, y in pts]


def noise(img, sigma, seed=1):
    a = np.asarray(img).astype(np.float32)
    a += np.random.default_rng(seed).normal(0, sigma, a.shape)
    return Image.fromarray(a.clip(0, 255).astype(np.uint8))


def main():
    base = Image.open(os.path.join(ROOT, BASE)).convert('RGB')
    w, h = base.size
    wall = (186, 181, 174)
    out = {}

    def save(name, img, gt, paint=None):
        img.save(os.path.join(ROOT, name + '.png'))
        out[name] = {'file': name + '.png', 'gt': gt, 'paint': paint, 'w': img.size[0], 'h': img.size[1]}

    save('base', base, GT, PAINT)

    # поворот на ±7° вокруг центра
    for name, deg in (('rotpos', 7), ('rotneg', -7)):
        a = math.radians(deg)
        c, s = math.cos(a), math.sin(a)
        cx, cy = w / 2, h / 2
        M = [[c, -s, cx - c * cx + s * cy], [s, c, cy - s * cx - c * cy]]
        save(name, affine(base, M, (w, h), wall), apply(M, GT), apply(M, PAINT))

    # отдаление до 70 % (холст меньше в кадре) со сдвигом
    M = [[0.7, 0, 0.18 * w], [0, 0.7, 0.2 * h]]
    save('far', affine(base, M, (w, h), wall), apply(M, GT), apply(M, PAINT))

    # приближение 1.1× к центру холста (углы остаются в кадре — по касанию за кадром не попасть)
    cxy = [sum(p[0] for p in GT) / 4, sum(p[1] for p in GT) / 4]
    k = 1.1
    M = [[k, 0, w / 2 - k * cxy[0]], [0, k, h / 2 - k * cxy[1]]]
    save('near', affine(base, M, (w, h), wall), apply(M, GT), apply(M, PAINT))

    # альбомная ориентация (поворот на 90°)
    M = [[0, -1, h], [1, 0, 0]]  # (x,y) → (h - y, x)
    save('landscape', base.rotate(-90, expand=True), apply(M, GT), apply(M, PAINT))

    # условия съёмки
    save('lowcontrast', ImageEnhance.Contrast(base).enhance(0.55), GT, PAINT)
    dark = base.point(lambda v: int(255 * (v / 255) ** 1.9 * 0.8))
    save('dark', noise(dark, 5), GT, PAINT)
    save('blur', base.filter(ImageFilter.GaussianBlur(2.2)), GT, PAINT)
    save('noise', noise(base, 14), GT, PAINT)

    # «камера» для e2e: фотография как видео 360×640 (чётные размеры для y4m)
    vw, vh = 360, 640
    fr = np.asarray(base.resize((vw, vh), Image.LANCZOS)).astype(np.float32)
    R, G, B = fr[..., 0], fr[..., 1], fr[..., 2]
    Y = 0.299 * R + 0.587 * G + 0.114 * B
    U = (-0.168736 * R - 0.331264 * G + 0.5 * B + 128).reshape(vh // 2, 2, vw // 2, 2).mean((1, 3))
    V = (0.5 * R - 0.418688 * G - 0.081312 * B + 128).reshape(vh // 2, 2, vw // 2, 2).mean((1, 3))
    rng = np.random.default_rng(3)
    with open(os.path.join(ROOT, 'easel.y4m'), 'wb') as f:
        f.write(f'YUV4MPEG2 W{vw} H{vh} F20:1 Ip A1:1 C420jpeg\n'.encode())
        for _ in range(40):
            f.write(b'FRAME\n')
            for c in (Y, U, V):
                f.write((c + rng.normal(0, 1.2, c.shape)).clip(0, 255).astype(np.uint8).tobytes())
    out['_camera'] = {'w': vw, 'h': vh, 'gt': [[x * vw / w, y * vh / h] for x, y in GT], 'paint': [[x * vw / w, y * vh / h] for x, y in PAINT]}

    with open(os.path.join(ROOT, 'variants.json'), 'w') as f:
        json.dump(out, f)
    print('варианты:', ', '.join(out))


if __name__ == '__main__':
    main()
