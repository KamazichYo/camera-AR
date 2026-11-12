"""Независимый эталон для ролика с тёмным предметом на деревянном столе (блокнот на дереве: tests/.data/clip3).
Как tests/gt_card.py, но предмет тёмный: маска — по тону (обложка серо-синяя, стол оранжевый),
стороны — прямые по контуру (без скруглённых углов), уточнение — по спаду насыщенности поперёк стороны.
Кадры, где предмет касается края кадра или контур не похож на четырёхугольник, эталона не получают.
Результат: tests/.data/<имя>/gt.json — кадр → четыре угла [TL, TR, BR, BL] (порядок сохраняется по кадрам).
Запуск: python3 tests/gt_dark.py [имя_папки]"""
import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gt_card import quad_of, refine, order  # noqa: E402

NAME = sys.argv[1] if len(sys.argv) > 1 else 'clip3'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.data', NAME)


def mask_of(img):
    # блокнот серо-синий (тон ≈ 105, насыщенность ≈ 60), стол — насыщенно-оранжевый: делим по тону, а не по яркости
    # (на обложке сильный блик: яркость меняется от 70 до 150)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.int32)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    m = ((h > 75) & (h < 145) & (s > 20) & (v < 175)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    # резинка и тонкие тёмные детали отрезаются открытием (резинка тоньше 9 px)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    return m


def score_of(img):
    # поперёк стороны ищется самый резкий спад «предметности» изнутри наружу: обложка ненасыщенная, стол насыщенный
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    return cv2.GaussianBlur(255 - hsv[..., 1], (0, 0), 0.8)


def densify(poly, step=1.0):
    """Точки вдоль выпуклой оболочки с шагом step px (подгонка прямых ждёт плотный контур)."""
    out = []
    for i in range(len(poly)):
        a, b = poly[i].astype(np.float64), poly[(i + 1) % len(poly)].astype(np.float64)
        n = max(1, int(np.linalg.norm(b - a) / step))
        for k in range(n):
            out.append(a + (b - a) * k / n)
    return np.array(out, dtype=np.float32).reshape(-1, 1, 2)


def main():
    names = sorted(n for n in os.listdir(ROOT) if n.startswith('f') and n.endswith('.png'))
    gt, prev, bad = {}, None, 0
    for k, n in enumerate(names):
        img = cv2.imread(os.path.join(ROOT, n))
        h, w = img.shape[:2]
        m = mask_of(img)
        num, lab, stats, cents = cv2.connectedComponentsWithStats(m)
        best, bs = -1, -1e18
        for i in range(1, num):
            x, y, ww, hh, a = stats[i]
            if a < 3000:
                continue
            if prev is not None:
                sc = -np.linalg.norm(cents[i] - prev.mean(0))
            else:
                sc = -np.linalg.norm(cents[i] - np.array([w / 2, h / 2])) + 0.01 * a
            if sc > bs:
                best, bs = i, sc
        q = None
        if best >= 0:
            x, y, ww, hh, a = stats[best]
            touch = x <= 2 or y <= 2 or x + ww >= w - 2 or y + hh >= h - 2
            cm = (lab == best).astype(np.uint8)
            cs, _ = cv2.findContours(cm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cnt = max(cs, key=cv2.contourArea)
            # блик на обложке выпадает из маски и выедает край — предмет выпуклый, берём выпуклую оболочку (плотно по точкам)
            hull = cv2.convexHull(cnt)
            cnt = densify(hull.reshape(-1, 2))
            # предмет у края кадра: стороны обрезаны — такой кадр не годится в эталон
            if not touch:
                q = quad_of(cnt, prev)
                if prev is not None and (q is None or np.abs(q - prev).max() > 40):
                    q = quad_of(cnt, None)
                    if q is not None:
                        d = [np.abs(np.roll(q, -s, axis=0) - prev).sum() for s in range(4)]
                        q = np.roll(q, -int(np.argmin(d)), axis=0)
            if q is not None:
                q2 = refine(q, score_of(img))
                if q2 is not None and np.abs(q2 - q).max() < 12:
                    q = q2
                # контроль: площадь четырёхугольника и площадь маски должны сходиться (скругления дают ≈ 1–3 %)
                qa = cv2.contourArea(q.astype(np.float32))
                if not (0.85 < a / max(qa, 1) < 1.06) or (q[:, 0].min() < 1 or q[:, 1].min() < 1 or q[:, 0].max() > w - 2 or q[:, 1].max() > h - 2):
                    q = None
        if q is None:
            bad += 1
            continue
        prev = q
        gt[str(k + 1)] = [[round(float(v), 2) for v in p] for p in q]
    json.dump(gt, open(os.path.join(ROOT, 'gt.json'), 'w'))
    print('кадров', len(names), 'с эталоном', len(gt), 'без', bad)
    print('кадр 1:', gt.get('1'))


if __name__ == '__main__':
    main()
