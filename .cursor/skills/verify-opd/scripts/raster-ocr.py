"""Decode and stitch raster pixels before OCR; report original-pixel glyph bounds."""
import base64
import csv
import io
import json
import os
import signal
import subprocess
import sys
import tempfile

try:
    from PIL import Image, ImageDraw, ImageFont, ImageOps
except ImportError as error:
    raise SystemExit('raster OCR needs Pillow in OPD_VERIFY_OCR_PYTHON') from error


CURRENT_PROC = None


def _stop_child(signum, _frame):
    proc = CURRENT_PROC
    if proc is not None and proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, _stop_child)


def run_tesseract(png_bytes, psm, whitelist=False):
    # tesseract's stdin reader blocks until EOF while its stderr fills the pipe,
    # so the parent waits out the whole limit and the orphan keeps the next call
    # from finishing. A file has an end, and the child's session dies with it.
    # macOS /tmp is a symlink to /private/tmp, and tesseract cannot open the
    # unresolved path. realpath is the directory it can read.
    global CURRENT_PROC
    handle, path = tempfile.mkstemp(prefix='opd-ocr-', suffix='.png')
    os.close(handle)
    path = os.path.realpath(path)
    proc = None
    try:
        with open(path, 'wb') as image_file:
            image_file.write(png_bytes)
        command = [os.environ.get('OPD_VERIFY_TESSERACT', 'tesseract'), path, 'stdout', '-l', 'eng', '--psm', str(psm)]
        if whitelist:
            command.extend(['-c', 'tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZ'])
        command.append('tsv')
        proc = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            env={**os.environ, 'OMP_THREAD_LIMIT': '1'},
        )
        CURRENT_PROC = proc
        try:
            stdout, stderr = proc.communicate(timeout=float(os.environ.get('OPD_VERIFY_OCR_PASS_TIMEOUT', '60')))
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
            raise RuntimeError('tesseract timed out') from None
        if proc.returncode:
            raise RuntimeError('tesseract failed: ' + stderr.decode('utf8', 'replace')[:600])
        return stdout
    finally:
        if proc and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
        CURRENT_PROC = None
        try:
            os.remove(path)
        except OSError:
            pass


def recognize(image, psm=11):
    output = []
    profiles = [((255, 255, 255, 255), 3, False)] if psm == 6 else [((32, 35, 38, 255), 3, False), ((255, 255, 255, 255), 4, False), ((32, 35, 38, 255), 4, True)]
    for bg, scale, threshold in profiles:
        comp = Image.alpha_composite(Image.new('RGBA', image.size, bg), image.convert('RGBA')).convert('L')
        if threshold:
            comp = comp.point(lambda pixel: 0 if pixel >= 85 else 255)
        large = ImageOps.autocontrast(comp.resize((comp.width * scale, comp.height * scale), Image.Resampling.LANCZOS))
        buf = io.BytesIO()
        large.save(buf, format='PNG')
        rows = csv.DictReader(io.StringIO(run_tesseract(buf.getvalue(), psm).decode('utf8', 'replace')), delimiter='\t', quoting=csv.QUOTE_NONE)
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


def recognize_frame(image):
    comp = Image.alpha_composite(Image.new('RGBA', image.size, (24, 26, 28, 255)), image.convert('RGBA')).convert('L')
    large = ImageOps.autocontrast(comp)
    buf = io.BytesIO()
    large.save(buf, format='PNG')
    rows = csv.DictReader(io.StringIO(run_tesseract(buf.getvalue(), 11).decode('utf8', 'replace')), delimiter='\t', quoting=csv.QUOTE_NONE)
    words = []
    for row in rows:
        text = row.get('text', '').strip().upper()
        if not text or row.get('level') != '5':
            continue
        x, y, w, h = (int(row[key]) for key in ['left', 'top', 'width', 'height'])
        words.append({'text': text, 'uppercase': row['text'].strip().isupper(), 'box': [x, y, x + w, y + h]})
    return words


def emit_frame(path):
    image = Image.open(path).convert('RGBA')
    words = recognize_frame(image)
    print(json.dumps({'words': words, 'text': ' '.join(word['text'] for word in words)}))


def fail(error):
    print(error, file=sys.stderr)
    raise SystemExit(1)


try:
    if '--frame' in sys.argv:
        emit_frame(sys.argv[sys.argv.index('--frame') + 1])
    elif '--doctor' in sys.argv:
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
        data = json.load(open(sys.argv[sys.argv.index('--tiles') + 1]) if '--tiles' in sys.argv else sys.stdin)
        tiles = data['tiles']
        left = min(tile['x'] for tile in tiles)
        top = min(tile['y'] for tile in tiles)
        right = max(tile['x'] for tile in tiles) + 1
        bottom = max(tile['y'] for tile in tiles) + 1
        image = Image.new('RGBA', ((right - left) * 256, (bottom - top) * 256))
        for tile in tiles:
            decoded = Image.open(io.BytesIO(base64.b64decode(tile['bytes']))).convert('RGBA')
            if decoded.size != (256, 256):
                raise RuntimeError('unexpected raster tile dimensions: ' + str(decoded.size))
            image.paste(decoded, ((tile['x'] - left) * 256, (tile['y'] - top) * 256))
        words = recognize(image)
        for line in words:
            for word in line:
                x1, y1, x2, y2 = word['box']
                word['box'] = [x1 + left * 256, y1 + top * 256, x2 + left * 256, y2 + top * 256]
        print(json.dumps({'lines': words, 'words': [word for line in words for word in line], 'text': '\n'.join(' '.join(word['text'] for word in line) for line in words)}))
except Exception as error:
    fail(error)
