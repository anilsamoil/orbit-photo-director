import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'src/chrome-slots.ts'), 'utf8');

const harness = `import { solveChromeSlots } from './chrome-slots.ts';
const empty = { x: 0, y: 0, w: 0, h: 0 };
function measure(over) {
  return {
    viewport: { w: 800, h: 600 },
    insets: { top: 0, right: 0, bottom: 0, left: 0 },
    topbar: 48, launch: null,
    zoom: empty, compass: empty, show: empty, showButtons: [],
    sliderChip: empty, slider: empty, timeButtons: [],
    footer: empty, shotList: empty, scrollbar: 0, pip: null,
    hide: empty, legendButton: empty, legendPanel: empty,
    legendOpen: false, legendNaturalBottom: 0, dockCorridor: 0, chromeHidden: false,
    ...over,
  };
}
function rightOf(box) { return box.x + box.w; }
function bottomOf(box) { return box.y + box.h; }
function meets(a, b) {
  return !!a && !!b && a.w >= 1 && b.w >= 1 && a.h >= 1 && b.h >= 1
    && a.x < rightOf(b) - 0.5 && rightOf(a) > b.x + 0.5
    && a.y < bottomOf(b) - 0.5 && bottomOf(a) > b.y + 0.5;
}
function fail(name) { console.error(name); process.exit(1); }
const slider = { x: 60, y: 244, w: 400, h: 44 };
const wide = solveChromeSlots(measure({
  viewport: { w: 800, h: 600 },
  insets: { top: 24, right: 0, bottom: 20, left: 47 },
  footer: { x: 0, y: 364, w: 800, h: 216 },
  slider, sliderChip: slider, dockCorridor: 43, scrollbar: 6,
  show: { x: 0, y: 0, w: 180, h: 52 },
}));
if (!wide.dock || meets(wide.dock, slider)) fail('slider');
const inset = solveChromeSlots(measure({
  viewport: { w: 390, h: 521 },
  insets: { top: 24, right: 0, bottom: 34, left: 47 },
  topbar: 72,
  footer: { x: 0, y: 450, w: 390, h: 37 },
  show: { x: 0, y: 0, w: 180, h: 52 },
}));
if (!inset.zoom || inset.zoom.x !== 55) fail('insets');
const row = solveChromeSlots(measure({
  viewport: { w: 430, h: 400 },
  insets: { top: 24, right: 0, bottom: 34, left: 47 },
  footer: { x: 0, y: 293.4, w: 430, h: 72.6 },
  show: { x: 0, y: 0, w: 180, h: 52 },
  scrollbar: 6,
}));
if (!row.zoom || !row.dock || row.dock.x < row.zoom.x + row.zoom.w + 8 || meets(row.dock, row.zoom)) fail('priority');
console.log('held');
`;

const mutants = [
  {
    name: 'drop painted-slider bounds',
    apply: (src) => src
      .replace('    measure.slider,\n    measure.sliderChip,\n', '')
      .replace('measure.launch, measure.slider, measure.sliderChip, ...measure.timeButtons', 'measure.launch, ...measure.timeButtons'),
  },
  {
    name: 'ignore safe insets',
    apply: (src) => src.replace(
      'export function solveChromeSlots(measure: ChromeMeasure): ChromeSlots {\n',
      'export function solveChromeSlots(measure: ChromeMeasure): ChromeSlots {\n  measure = { ...measure, insets: { top: 0, right: 0, bottom: 0, left: 0 } };\n',
    ),
  },
  {
    name: 'wrong priority order',
    apply: (src) => src
      .replace(
        '  const columnX = measure.viewport.w - measure.insets.right - EDGE - gutter;\n  if (columnH >= TARGET && columnX >= minX - 0.5) {',
        '  const columnX = measure.insets.left;\n  if (columnH >= TARGET) {',
      ),
  },
];

function run(src) {
  const dir = mkdtempSync(join(tmpdir(), 'opd-slot-mutant-'));
  writeFileSync(join(dir, 'chrome-slots.ts'), src);
  writeFileSync(join(dir, 'hold.ts'), harness);
  const result = spawnSync('bun', ['hold.ts'], { cwd: dir, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return result.status === 0;
}

const lines = [];
for (const mutant of mutants) {
  const next = mutant.apply(source);
  if (next === source) {
    console.error(`mutant did not apply: ${mutant.name}`);
    process.exit(1);
  }
  const killed = !run(next);
  lines.push(`${mutant.name}: ${killed ? 'red' : 'GREEN (survived)'}`);
  if (!killed) {
    console.error(lines.join('\n'));
    process.exit(1);
  }
}
if (!run(source)) {
  console.error('source harness failed');
  process.exit(1);
}
lines.push('source: green');
process.stdout.write(`${lines.join('\n')}\n`);
