# 계급 아이콘 정리: public/images/ranks/original/ 의 원본을 여백만 잘라 96px 정사각형으로 줄여서
# public/images/ranks/ 에 같은 이름(.webp)으로 저장. 원본은 손대지 않음.
#   사용법: python scripts/trim-rank-icons.py   (Pillow 필요: pip install pillow)
#   새 이미지를 넣을 때는 original/ 에 lv1.png 처럼 넣고 다시 실행
import os
import re
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), '..', 'public', 'images', 'ranks')
SRC = os.path.join(ROOT, 'original')
SIZE = 96      # 화면에는 16px 로 나오지만 고해상도 화면을 위해 넉넉하게
MARGIN = 0.04  # 그림 둘레에 남길 여백 비율

for f in sorted(os.listdir(SRC)):
    m = re.match(r'^(lv\d+|admin)\.(webp|png|gif|jpg|jpeg)$', f, re.I)
    if not m:
        continue
    im = Image.open(os.path.join(SRC, f)).convert('RGBA')
    alpha = im.getchannel('A').point(lambda v: 255 if v > 24 else 0)
    box = alpha.getbbox() or (0, 0, im.width, im.height)
    w, h = box[2] - box[0], box[3] - box[1]
    side = int(max(w, h) * (1 + MARGIN * 2))
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(im.crop(box), ((side - w) // 2, (side - h) // 2))
    out = canvas.resize((SIZE, SIZE), Image.LANCZOS)
    name = m.group(1).lower() + '.webp'
    out.save(os.path.join(ROOT, name), 'WEBP', quality=92, method=6)
    print(f, '->', name, os.path.getsize(os.path.join(ROOT, name)), 'bytes')
