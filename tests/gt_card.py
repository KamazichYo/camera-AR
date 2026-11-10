"""Независимый эталон для ролика с картой на столе (tests/.data/card/fNNN.png, локальные кадры).
Карта светлая, стол коричневый: сегментируем по насыщенности/яркости, берём контур компоненты рядом с прошлым
положением, к четырём сторонам подгоняем прямые (скруглённые углы отбрасываются) и пересекаем их.
Результат: tests/.data/card/gt.json — кадр → четыре угла [TL, TR, BR, BL] (порядок сохраняется по кадрам).
Запуск: python3 tests/gt_card.py [имя_папки]"""
import json
import os
import sys

import cv2
import numpy as np

NAME = sys.argv[1] if len(sys.argv) > 1 else 'card'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.data', NAME)


def mask_of(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    s, v = hsv[..., 1].astype(np.int32), hsv[..., 2].astype(np.int32)
    m = ((s < 70) & (v > 120)).astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    return m


def fit_line(pts):
    vx, vy, x0, y0 = cv2.fitLine(pts.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).flatten()
    return np.array([x0, y0]), np.array([vx, vy])


def cross(l1, l2):
    (p, d), (q, e) = l1, l2
    A = np.array([d, -e]).T
    t = np.linalg.solve(A, q - p)
    return p + t[0] * d


def quad_of(cnt, prev):
    """Четыре стороны: стартуем с minAreaRect/прошлого четырёхугольника, точки контура относим к ближайшей стороне
    (без четверти у каждого угла — там скругление), подгоняем прямые, повторяем."""
    pts = cnt.reshape(-1, 2).astype(np.float64)
    q = prev if prev is not None else approx4(cnt)
    if q is None:
        return None
    for it in range(5):
        lines = []
        for i in range(4):
            a, b = q[i], q[(i + 1) % 4]
            d = b - a
            L = np.linalg.norm(d)
            d /= L
            n = np.array([-d[1], d[0]])
            t = (pts - a) @ d
            dist = np.abs((pts - a) @ n)
            sel = (t > 0.22 * L) & (t < 0.78 * L) & (dist < (max(6.0, 0.12 * L) if it == 0 else max(2.5, 0.04 * L)))
            if sel.sum() < 6:
                return None
            lines.append(fit_line(pts[sel]))
        try:
            q = np.array([cross(lines[(i + 3) % 4], lines[i]) for i in range(4)])
        except np.linalg.LinAlgError:
            return None
    return q


def refine(q, score):
    """Уточнение по градиенту: у стола рядом с картой бывает блик/отражение, и граница маски уезжает наружу.
    Вдоль нормали к каждой стороне ищем самый резкий спад «карточности» (V − S) изнутри наружу, по ним — прямые."""
    h, w = score.shape
    c = q.mean(0)
    for _ in range(3):
        lines = []
        for i in range(4):
            a, b = q[i], q[(i + 1) % 4]
            d = b - a
            L = np.linalg.norm(d)
            d = d / L
            n = np.array([-d[1], d[0]])
            if (c - a) @ n > 0:
                n = -n  # наружу
            pts = []
            for t in np.linspace(0.2, 0.8, 40):
                p0 = a + d * (t * L)
                ks = np.arange(-9, 9.01, 0.5)
                xs, ys = p0[0] + n[0] * ks, p0[1] + n[1] * ks
                if xs.min() < 1 or ys.min() < 1 or xs.max() > w - 2 or ys.max() > h - 2:
                    continue
                prof = cv2.remap(score, xs.astype(np.float32).reshape(1, -1), ys.astype(np.float32).reshape(1, -1), cv2.INTER_LINEAR).flatten()
                g = prof[:-4] - prof[4:]  # спад на 2 px
                j = int(np.argmax(g))
                if g[j] < 25:
                    continue
                k = ks[j + 2]
                if 0 < j < len(g) - 1:  # субпиксель параболой
                    den = g[j - 1] - 2 * g[j] + g[j + 1]
                    if den < 0:
                        k += 0.5 * 0.5 * (g[j - 1] - g[j + 1]) / den
                pts.append(p0 + n * k)
            if len(pts) < 8:
                return None
            lines.append(fit_line(np.array(pts)))
        try:
            q = np.array([cross(lines[(i + 3) % 4], lines[i]) for i in range(4)])
        except np.linalg.LinAlgError:
            return None
    return q


def approx4(cnt):
    hull = cv2.convexHull(cnt)
    per = cv2.arcLength(hull, True)
    for e in np.linspace(0.01, 0.12, 23):
        a = cv2.approxPolyDP(hull, e * per, True)
        if len(a) == 4:
            return order(a.reshape(4, 2))
    return None


def order(box):
    box = np.array(box, dtype=np.float64)
    c = box.mean(0)
    ang = np.arctan2(box[:, 1] - c[1], box[:, 0] - c[0])
    box = box[np.argsort(ang)]  # по часовой стрелке в координатах изображения
    k = int(np.argmin(box[:, 0] + box[:, 1]))
    return np.roll(box, -k, axis=0)


def main():
    names = sorted(n for n in os.listdir(ROOT) if n.startswith('f') and n.endswith('.png'))
    gt, prev, bad = {}, None, 0
    for k, n in enumerate(names):
        img = cv2.imread(os.path.join(ROOT, n))
        m = mask_of(img)
        num, lab, stats, cents = cv2.connectedComponentsWithStats(m)
        best, bs = -1, -1
        for i in range(1, num):
            x, y, w, h, a = stats[i]
            if a < 1500:
                continue
            if prev is not None:
                sc = -np.linalg.norm(cents[i] - prev.mean(0))
            else:  # первый кадр: компонента ближе к центру, не касающаяся края
                touch = x <= 1 or y <= 1 or x + w >= img.shape[1] - 1 or y + h >= img.shape[0] - 1
                sc = -np.linalg.norm(cents[i] - np.array([img.shape[1] / 2, img.shape[0] / 2])) - (1000 if touch else 0)
            if best < 0 or sc > bs:
                best, bs = i, sc
        q = None
        if best >= 0:
            cm = (lab == best).astype(np.uint8)
            cs, _ = cv2.findContours(cm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cnt = max(cs, key=cv2.contourArea)
            q = quad_of(cnt, prev)
            if prev is not None and (q is None or np.abs(q - prev).max() > 40):
                q = quad_of(cnt, None)  # рывок: пересобрать с нуля и согласовать порядок углов
                if q is not None:
                    d = [np.abs(np.roll(q, -s, axis=0) - prev).sum() for s in range(4)]
                    q = np.roll(q, -int(np.argmin(d)), axis=0)
        if q is not None:
            hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
            q2 = refine(q, cv2.GaussianBlur(hsv[..., 2] - hsv[..., 1], (0, 0), 0.8))
            if q2 is not None and np.abs(q2 - q).max() < 25:
                q = q2
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
