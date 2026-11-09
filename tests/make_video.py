"""Тренировочное видео пользователя (tests/.data/video/training.mov — локальный файл, не коммитится):
 1) раскладывает на кадры f001.png… (ffmpeg),
 2) собирает training.y4m для «фейковой камеры» Chromium: в левый нижний угол вшит номер кадра
    (10 бит, как в синтетических сценах), чтобы e2e-тест знал, какой кадр сейчас на экране."""
import os
import subprocess
import sys

import numpy as np
from PIL import Image

NAME = sys.argv[1] if len(sys.argv) > 1 else 'video'   # 'video' — холст, 'palm' — ладонь
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.data', NAME)
MOV = os.path.join(ROOT, 'training.mov')


def main():
    if not os.path.exists(MOV):
        print('нет tests/.data/video/training.mov — пропуск')
        return
    if not os.path.exists(os.path.join(ROOT, 'f001.png')):
        subprocess.check_call(['ffmpeg', '-v', 'error', '-y', '-i', MOV, '-vsync', '0', os.path.join(ROOT, 'f%03d.png')])
    names = sorted(n for n in os.listdir(ROOT) if n.startswith('f') and n.endswith('.png'))
    if NAME != 'video':  # для e2e с фейковой камерой (штрихкод кадра) нужен только ролик с холстом
        print('кадров', len(names))
        return
    first = np.asarray(Image.open(os.path.join(ROOT, names[0])).convert('RGB'))
    h, w, _ = first.shape
    with open(os.path.join(ROOT, 'training.y4m'), 'wb') as f:
        f.write(f'YUV4MPEG2 W{w} H{h} F25:1 Ip A1:1 C420jpeg\n'.encode())
        for k, n in enumerate(names):
            a = np.asarray(Image.open(os.path.join(ROOT, n)).convert('RGB')).astype(np.float32).copy()
            for i in range(10):  # номер кадра (0-based) штрихкодом
                a[h - 10:h, 8 * i:8 * i + 8] = 255 if (k >> i) & 1 else 0
            R, G, B = a[..., 0], a[..., 1], a[..., 2]
            Y = 0.299 * R + 0.587 * G + 0.114 * B
            U = (-0.168736 * R - 0.331264 * G + 0.5 * B + 128).reshape(h // 2, 2, w // 2, 2).mean((1, 3))
            V = (0.5 * R - 0.418688 * G - 0.081312 * B + 128).reshape(h // 2, 2, w // 2, 2).mean((1, 3))
            f.write(b'FRAME\n')
            for c in (Y, U, V):
                f.write(c.clip(0, 255).astype(np.uint8).tobytes())
    print('кадров', len(names), f'{w}x{h}')


if __name__ == '__main__':
    main()
