"""Раскадровка прогона видео для проверки глазами (после node tests/video-prepare.cjs):
  tests/.data/video/story.png — несколько кадров с отмеченными точками/рамкой холста;
  tests/.data/video/zoom.png  — крупные планы четырёх углов на тех же кадрах (перекрестие — где алгоритм считает угол).
Использование: python3 tests/video-story.py [кадры через запятую]"""
import json
import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.data', 'video')
COLS = [(255, 60, 60), (60, 255, 60), (80, 160, 255), (255, 230, 0)]


def rows_by_frame():
    d = json.load(open(os.path.join(ROOT, 'ref-run.json')))
    return {r['t']: r for r in d['rows']}


def quad_of(r):
    if r.get('quad'):
        return r['quad']
    if r.get('locked'):
        return r['locked']['quad']
    return None


def story(frames, rows):
    tiles = []
    for t in frames:
        im = Image.open(os.path.join(ROOT, f'f{t:03d}.png')).convert('RGB')
        dr = ImageDraw.Draw(im)
        r = rows.get(t, {})
        for i, pt in enumerate(r.get('pts') or []):  # точки выбора (до запуска трекинга)
            x, y = pt['p']
            c = COLS[i % 4] if not pt['lost'] else (150, 150, 150)
            dr.ellipse((x - 5, y - 5, x + 5, y + 5), outline=c, width=2)
            dr.line((x - 9, y, x + 9, y), fill=c)
            dr.line((x, y - 9, x, y + 9), fill=c)
        q = quad_of(r)
        if q:
            pts = [tuple(p) for p in q]
            dr.line(pts + [pts[0]], fill=(0, 255, 120), width=2)
            for i, p in enumerate(pts):
                dr.ellipse((p[0] - 4, p[1] - 4, p[0] + 4, p[1] + 4), outline=COLS[i], width=2)
        dr.text((6, 6), f'frame {t}', fill=(255, 255, 255))
        tiles.append(im)
    w, h = tiles[0].size
    cols = 3
    sheet = Image.new('RGB', (w * cols, h * ((len(tiles) + cols - 1) // cols)))
    for k, im in enumerate(tiles):
        sheet.paste(im, ((k % cols) * w, (k // cols) * h))
    sheet.save(os.path.join(ROOT, 'story.png'))


def zoom(frames, rows, half=20, z=3):
    size = 2 * half * z
    sheet = Image.new('RGB', (len(frames) * size, 4 * size))
    for ci, t in enumerate(frames):
        q = quad_of(rows.get(t, {}))
        if not q:
            continue
        im = Image.open(os.path.join(ROOT, f'f{t:03d}.png')).convert('RGB')
        for ri in range(4):
            x, y = q[ri]
            tile = im.crop((int(x) - half, int(y) - half, int(x) + half, int(y) + half)).resize((size, size), Image.LANCZOS)
            d = ImageDraw.Draw(tile)
            cx, cy = (x - int(x) + half) * z, (y - int(y) + half) * z
            for a, b, c2, e in ((cx - 14, cy, cx - 4, cy), (cx + 4, cy, cx + 14, cy), (cx, cy - 14, cx, cy - 4), (cx, cy + 4, cx, cy + 14)):
                d.line((a, b, c2, e), fill=(255, 0, 60), width=2)
            sheet.paste(tile, (ci * size, ri * size))
    sheet.save(os.path.join(ROOT, 'zoom.png'))


if __name__ == '__main__':
    rows = rows_by_frame()
    frames = [int(x) for x in (sys.argv[1].split(',') if len(sys.argv) > 1 else '10,30,50,70,110,150'.split(','))]
    story(frames, rows)
    zoom(frames, rows)
    print('готово: story.png, zoom.png в tests/.data/video')
