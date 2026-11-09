"""Фотометрическая метрика «рамка сидит на той же поверхности» для видео без разметки (ладонь, скетчбук):
каждый кадр с рамкой «разворачивается» в каноническую заплатку 64×64, и она сравнивается (ZNCC) с заплаткой
первого кадра. Значение близко к 1 — рамка на тех же складках/штрихах; падение — рамка сползла.
Использование: python3 tests/palm-metric.py <run.json> <каталог кадров>  → печатает сводку, пишет *.metric.json"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image

N = 64


def patch(img, quad):
    # quad (TL,TR,BR,BL) → квадрат N×N: PIL.PERSPECTIVE принимает коэффициенты ОБРАТНОГО отображения (dst→src)
    src = np.array(quad, float)
    dst = np.array([[0, 0], [N, 0], [N, N], [0, N]], float)
    A = []
    for (x, y), (u, v) in zip(dst, src):
        A += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
    b = src.reshape(-1)
    c = np.linalg.solve(np.array(A, float), b)
    g = img.convert('L').transform((N, N), Image.PERSPECTIVE, tuple(c), Image.BICUBIC)
    return np.asarray(g, np.float32)


def zncc(a, b):
    a = a - a.mean(); b = b - b.mean()
    d = math.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / d) if d > 1e-6 else 0.0


def main(run, frames_dir):
    rows = json.load(open(run))['rows']
    ref = None
    out = []
    for r in rows:
        q = r.get('quad') or (r.get('locked') or {}).get('quad')
        if not q:
            continue
        im = Image.open(os.path.join(frames_dir, f"f{r['t']:03d}.png"))
        p = patch(im, q)
        if ref is None:
            ref = p
        out.append({'t': r['t'], 'zncc': zncc(ref, p), 'state': r.get('state', 'tracking')})
    z = [o['zncc'] for o in out]
    good = [o for o in out if o['state'] == 'tracking']
    zt = [o['zncc'] for o in good]
    summary = {'frames': len(out), 'tracking': len(good), 'median': float(np.median(z)), 'min': float(min(z)),
               'below': float(np.mean([v < 0.5 for v in z]))}
    if '--json' in sys.argv:
        print(json.dumps(summary))
    else:
        print(f"кадров с рамкой {len(out)}; в состоянии «трекинг» {len(good)}; ZNCC с первой заплаткой: "
              f"мед. {summary['median']:.2f}, мин. {summary['min']:.2f}, доля < 0.5: {summary['below']:.2f}"
              f" (только «трекинг»: мед. {np.median(zt) if zt else float('nan'):.2f})")
    json.dump(out, open(run.replace('.json', '.metric.json'), 'w'))


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
