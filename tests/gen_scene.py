"""Синтетическая сцена для тестов AR: лист с рисунком на текстурном столе,
движение/поворот/перспектива, рука, выход из кадра, перекрытие камеры, дорисовка.
Сохраняет кадры PNG, видео .y4m для фейковой камеры Chromium и истинные углы листа."""
import numpy as np, json, math, os, sys
from PIL import Image, ImageDraw, ImageFilter
rng = np.random.default_rng(7)
W, H = 640, 360
N = 240
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.data')
out = os.path.join(ROOT, 'frames')
PW, PH = 800, 600

def strokes(draw, n, seed):
    r = np.random.default_rng(seed)
    for _ in range(n):
        pts = []
        x, y = r.uniform(60, PW-60), r.uniform(60, PH-60)
        a = r.uniform(0, 2*math.pi)
        for k in range(r.integers(6, 14)):
            a += r.normal(0, 0.6); s = r.uniform(15, 45)
            x = min(PW-30, max(30, x + math.cos(a)*s)); y = min(PH-30, max(30, y + math.sin(a)*s))
            pts.append((x, y))
        draw.line(pts, fill=(40, 40, 45), width=int(r.integers(2, 5)), joint='curve')

def paper(stage):
    im = Image.new('RGB', (PW, PH), (238, 233, 222))
    d = ImageDraw.Draw(im)
    strokes(d, 14, 1)
    d.ellipse((480, 120, 640, 280), outline=(50, 50, 55), width=4)
    for i in range(12):
        d.line((120 + i*12, 400, 180 + i*12, 520), fill=(70, 70, 75), width=2)
    if stage >= 1: strokes(d, 10, 2)  # рисунок дополняется
    if stage >= 2: strokes(d, 10, 3)
    return im

# фон: стол с текстурой
yy, xx = np.mgrid[0:H, 0:W]
bg = 110 + 25*np.sin(xx/9.0 + 3*np.sin(yy/40.0)) + rng.normal(0, 10, (H, W))
bg = np.stack([bg*1.0, bg*0.75, bg*0.5], -1).clip(0, 255).astype(np.uint8)
bgim = Image.fromarray(bg).filter(ImageFilter.GaussianBlur(0.8))

def homog(src, dst):
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A += [[x, y, 1, 0, 0, 0, -u*x, -u*y, u], [0, 0, 0, x, y, 1, -v*x, -v*y, v]]
    A = np.array(A, float)
    h = np.linalg.solve(A[:, :8], A[:, 8])
    return np.append(h, 1).reshape(3, 3)

def pose(t):
    cx, cy, s, rot, tilt = 320, 180, 0.42, 0.0, 0.0
    jit = rng.normal(0, 0.4, 2)
    if t < 40: pass
    elif t < 120:
        u = (t-40)/80
        cx += 60*math.sin(u*2*math.pi); cy += 25*math.sin(u*4*math.pi)
        rot = 0.25*math.sin(u*2*math.pi); s *= 1 + 0.15*math.sin(u*3*math.pi); tilt = 0.12*math.sin(u*2*math.pi)
    elif t < 150:
        cx += 20; rot = 0.08
    elif t < 170:
        u = (t-150)/20
        cx += 20 + 200*u; rot = 0.08
    elif t < 200:
        cx -= 40; cy += 10; rot = -0.15; s *= 0.95  # новая позиция после перекрытия
    else:
        u = (t-200)/40
        cx -= 40 - 50*u; cy += 10; rot = -0.15 + 0.1*u; s *= 0.95
    cx += jit[0]; cy += jit[1]
    hw, hh = PW*s/2, PH*s/2
    q = []
    for i, (dx, dy) in enumerate([(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]):
        k = 1 + (tilt if dy < 0 else -tilt) * 0.5
        dx *= k
        x = cx + dx*math.cos(rot) - dy*math.sin(rot)
        y = cy + dx*math.sin(rot) + dy*math.cos(rot)
        q.append((x, y))
    return q

os.makedirs(out, exist_ok=True)
gt = []
papers = [paper(0), paper(1), paper(2)]
mask = Image.new('L', (PW, PH), 255)
y4m = open(os.path.join(ROOT, 'fake.y4m'), 'wb')
y4m.write(f'YUV4MPEG2 W{W} H{H} F20:1 Ip A1:1 C420jpeg\n'.encode())
for t in range(N):
    q = pose(t)
    Hm = homog([(0, 0), (PW, 0), (PW, PH), (0, PH)], q)
    Hi = np.linalg.inv(Hm); Hi /= Hi[2, 2]
    coeffs = tuple(Hi.flatten()[:8])
    stage = 0 if t < 205 else (1 if t < 225 else 2)
    pim = papers[stage].transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    pm = mask.transform((W, H), Image.PERSPECTIVE, coeffs, Image.BILINEAR)
    fr = bgim.copy(); fr.paste(pim, (0, 0), pm)
    d = ImageDraw.Draw(fr)
    if 120 <= t < 150:  # рука
        u = (t-120)/30
        hx, hy = 250 + 150*u, 120 + 40*math.sin(u*6)
        d.ellipse((hx-60, hy-35, hx+60, hy+35), fill=(200, 150, 120))
        d.rectangle((hx+30, hy-25, hx+260, hy+25), fill=(190, 140, 110))
    if 170 <= t < 180:  # камера закрыта
        d.rectangle((0, 0, W, H), fill=(20, 20, 20))
    arr = np.asarray(fr).astype(np.float32) + rng.normal(0, 2.5, (H, W, 3))
    arr = arr.clip(0, 255).astype(np.uint8)
    Image.fromarray(arr).save(f'{out}/f{t:03d}.png')
    gt.append({'t': t, 'q': [list(map(float, p)) for p in q], 'covered': 170 <= t < 180})
    # y4m
    R, G, B = [arr[..., i].astype(np.float32) for i in range(3)]
    Y = 0.299*R + 0.587*G + 0.114*B
    U = -0.168736*R - 0.331264*G + 0.5*B + 128
    V = 0.5*R - 0.418688*G - 0.081312*B + 128
    U = U.reshape(H//2, 2, W//2, 2).mean((1, 3)); V = V.reshape(H//2, 2, W//2, 2).mean((1, 3))
    y4m.write(b'FRAME\n')
    for c in (Y, U, V): y4m.write(c.clip(0, 255).astype(np.uint8).tobytes())
y4m.close()
json.dump(gt, open(os.path.join(ROOT, 'gt.json'), 'w'))
# референс-картинка для тестов
ref = Image.new('RGB', (400, 300), (255, 255, 255)); d = ImageDraw.Draw(ref)
d.ellipse((100, 50, 300, 250), outline=(0, 0, 0), width=6); d.line((0, 300, 400, 0), fill=(200, 0, 0), width=6)
ref.save(os.path.join(ROOT, 'ref.png'))
print('ok', N)
