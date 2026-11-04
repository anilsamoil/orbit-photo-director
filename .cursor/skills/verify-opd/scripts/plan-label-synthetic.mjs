import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(root, 'fixtures');

const script = String.raw`
import os
from PIL import Image, ImageDraw, ImageFont

fixtures = os.environ['OPD_LABEL_FIXTURES']
deja = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
arabic = '/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf'
cjk = '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf'
ink = (236, 232, 220, 255)
ground = (24, 26, 28, 255)

def paint(path, width, height, size, words, second_font=None):
    image = Image.new('RGBA', (width, height), ground)
    pen = ImageDraw.Draw(image)
    body = ImageFont.truetype(deja, size)
    other = ImageFont.truetype(second_font, size) if second_font else body
    for index, (text, x, y) in enumerate(words):
        pen.text((x, y), text, font=other if index else body, fill=ink)
    image.save(path)

foreign = os.path.join(fixtures, 'plan-label-foreign')
os.makedirs(foreign, exist_ok=True)
engines = {'chromium': 14, 'webkit': 15}
replacements = {
    'main': ('KENYA', None),
    'greek': ('ΚΕΝΥΑ', None),
    'accent': ('KÉNYA', None),
    'cyrillic': ('КЕНИЯ', None),
    'arabic': ('كينيا', arabic),
    'cjk': ('肯尼亚', cjk),
}
for engine, size in engines.items():
    for name, (second, face) in replacements.items():
        words = [('KENYA', 180, 300), (second, 180, 360)]
        paint(os.path.join(foreign, f'{engine}-{name}.png'), 478, 690, size, words, face)
paint(
    os.path.join(foreign, 'webkit-two-plus-greek.png'),
    478, 690, 15,
    [('KENYA', 180, 300), ('KENYA', 180, 360), ('ΚΕΝΥΑ', 180, 420)],
)
paint(
    os.path.join(foreign, 'towns.png'),
    478, 690, 15,
    [('NAKURU', 180, 300), ('NAIROBI', 180, 340), ('NYERI', 180, 380), ('EMBU', 180, 420), ('THIKA', 180, 460)],
)

regression = os.path.join(fixtures, 'plan-label-regression')
os.makedirs(regression, exist_ok=True)
paint(os.path.join(regression, 'canada-main.png'), 492, 690, 22, [('CANADA', 180, 300)])
paint(os.path.join(regression, 'canada-duplicated.png'), 492, 690, 22, [('CANADA', 180, 300), ('CANADA', 180, 340)])
paint(os.path.join(regression, 'canada-painted-out.png'), 492, 690, 22, [])
print('wrote 17 synthetic frames')
`;

mkdirSync(fixtures, { recursive: true });
const drawn = spawnSync('python3', ['-c', script], {
  encoding: 'utf8',
  env: { ...process.env, OPD_LABEL_FIXTURES: fixtures },
});
if (drawn.status !== 0) {
  throw new Error(drawn.stderr || drawn.stdout || 'synthetic frames were not drawn');
}
console.log(drawn.stdout.trim());
