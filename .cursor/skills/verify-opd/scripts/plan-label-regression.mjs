import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const out = resolve(root, 'fixtures/plan-label-regression');

const script = String.raw`
import json, os
from PIL import Image, ImageDraw, ImageFont
font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
out = os.environ['OPD_LABEL_REGRESSION']
chrome = [0, 0, 70, 36]
cases = {
    'main': [('KENYA', 180, 300), ('KENYA', 180, 360)],
    'removed': [('KENYA', 180, 300)],
    'egypt': [('KENYA', 180, 300), ('EGYPT', 180, 360)],
    'three': [('KENYA', 180, 300), ('KENYA', 180, 360), ('KENYA', 180, 420)],
    'nya': [('KENYA', 180, 300), ('NYA', 180, 360)],
    'chrome': [('KENYA', 180, 300), ('KENYA', 8, 8)],
}
engines = {'chromium': 14, 'webkit': 15}
for engine, size in engines.items():
    font = ImageFont.truetype(font_path, size)
    for name, words in cases.items():
        image = Image.new('RGBA', (478, 690), (24, 26, 28, 255))
        draw = ImageDraw.Draw(image)
        for text, x, y in words:
            draw.text((x, y), text, font=font, fill=(236, 232, 220, 255))
        image.save(os.path.join(out, f'{engine}-{name}.png'))
print(json.dumps({'chrome': chrome, 'engines': list(engines), 'cases': [name for name in cases if name != 'main']}))
`;

mkdirSync(out, { recursive: true });
const drawn = spawnSync('python3', ['-c', script], {
  encoding: 'utf8',
  env: { ...process.env, OPD_LABEL_REGRESSION: out },
});
if (drawn.status !== 0) {
  throw new Error(drawn.stderr || drawn.stdout || 'regression frames were not drawn');
}
const meta = JSON.parse(drawn.stdout);
writeFileSync(resolve(out, 'manifest.json'), `${JSON.stringify({
  credit: 'DejaVu Sans, drawn locally for the name counter. These files are not Esri tiles and contain no map imagery.',
  regenerate: 'node .cursor/skills/verify-opd/scripts/plan-label-regression.mjs',
  width: 478,
  height: 690,
  ...meta,
}, null, 2)}\n`);
console.log(`wrote ${meta.engines.length * (meta.cases.length + 1)} frames`);
