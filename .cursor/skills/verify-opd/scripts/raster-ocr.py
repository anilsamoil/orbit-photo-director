"""Decode and stitch raster pixels before OCR; report original-pixel glyph bounds."""
import base64
import csv
import io
import json
import os
import subprocess
import sys

try:
    from PIL import Image, ImageDraw, ImageFont, ImageOps
except ImportError as error:
    raise SystemExit('raster OCR needs Pillow in OPD_VERIFY_OCR_PYTHON') from error


def recognize(image, psm=11):
    output = []
    for bg, scale, threshold in [((32, 35, 38, 255), 3, False), ((255, 255, 255, 255), 4, False), ((32, 35, 38, 255), 4, True)]:
        comp = Image.alpha_composite(Image.new('RGBA', image.size, bg), image.convert('RGBA')).convert('L')
        if threshold:
            comp = comp.point(lambda pixel: 0 if pixel >= 85 else 255)
        large = ImageOps.autocontrast(comp.resize((comp.width * scale, comp.height * scale), Image.Resampling.LANCZOS))
        buf = io.BytesIO()
        large.save(buf, format='PNG')
        result = subprocess.run([os.environ.get('OPD_VERIFY_TESSERACT', 'tesseract'), 'stdin', 'stdout', '-l', 'eng', '--psm', str(psm), 'tsv'], input=buf.getvalue(), capture_output=True, timeout=60, env={**os.environ, 'OMP_THREAD_LIMIT': '1'})
        if result.returncode:
            raise RuntimeError('tesseract failed: ' + result.stderr.decode('utf8', 'replace')[:600])
        rows = csv.DictReader(io.StringIO(result.stdout.decode('utf8', 'replace')), delimiter='\t', quoting=csv.QUOTE_NONE)
        lines = {}
        for row in rows:
            text = row.get('text', '').strip().upper()
            if not text or row.get('level') != '5':
                continue
            x, y, w, h = (int(row[key]) / scale for key in ['left', 'top', 'width', 'height'])
            key = (row['block_num'], row['par_num'], row['line_num'])
            lines.setdefault(key, []).append({'text': text, 'uppercase': row['text'].strip().isupper(), 'box': [x, y, x+w, y+h]})
        for line in lines.values():
            for word in line:
                word['line'] = len(output)
            output.append(line)
    return output


if '--doctor' in sys.argv:
    image = Image.new('RGBA', (500, 100), 'white')
    font = None
    for path in ['/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:
        try:
            font = ImageFont.truetype(path, 28)
            break
        except OSError:
            pass
    if font is None:
        font = ImageFont.load_default()
    ImageDraw.Draw(image).text((12, 20), 'AUSTRALIA NIGERIA KENYA', font=font, fill='black')
    words = recognize(image, 6)
    text = ' '.join(row['text'] for line in words for row in line)
    if not all(name in text.split() for name in ['AUSTRALIA', 'NIGERIA', 'KENYA']):
        raise RuntimeError('known-text OCR probe did not read AUSTRALIA NIGERIA KENYA: ' + text)
    print(json.dumps({'ok': True, 'python': sys.executable, 'probe': text}))
else:
    data = json.load(sys.stdin)
    tiles = data['tiles']
    left = min(tile['x'] for tile in tiles)
    top = min(tile['y'] for tile in tiles)
    right = max(tile['x'] for tile in tiles) + 1
    bottom = max(tile['y'] for tile in tiles) + 1
    image = Image.new('RGBA', ((right-left)*256, (bottom-top)*256))
    for tile in tiles:
        decoded = Image.open(io.BytesIO(base64.b64decode(tile['bytes']))).convert('RGBA')
        if decoded.size != (256, 256):
            raise RuntimeError('unexpected raster tile dimensions: ' + str(decoded.size))
        image.paste(decoded, ((tile['x']-left)*256, (tile['y']-top)*256))
    words = recognize(image)
    for line in words:
        for word in line:
            x1, y1, x2, y2 = word['box']
            word['box'] = [x1+left*256, y1+top*256, x2+left*256, y2+top*256]
    print(json.dumps({'lines': words, 'words': [word for line in words for word in line], 'text': '\n'.join(' '.join(word['text'] for word in line) for line in words)}))
