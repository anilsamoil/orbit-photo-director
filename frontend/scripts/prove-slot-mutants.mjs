import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ownerPlacementViolations, projectPlacementViolations, REINTRODUCTION_PATTERNS } from './census-narrow-chrome.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'src/chrome-slots.ts'), 'utf8');

const harness = `import { solveChromeSlots } from './chrome-slots.ts';
const empty = { x: 0, y: 0, w: 0, h: 0 };
function measure(over) {
  return {
    timeNeed: 0,
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
const longInput = measure({
  viewport: { w: 800, h: 600 },
  insets: { top: 24, right: 0, bottom: 20, left: 47 },
  topbar: 84, show: { x: 55, y: 89, w: 180, h: 52 },
  footer: { x: 47, y: 480, w: 753, h: 100 },
  pip: { x: 566, y: 89, w: 222, h: 144 },
  legendOpen: true, legendPanel: { x: 0, y: 0, w: 176, h: 1000 },
});
const long = solveChromeSlots(longInput);
if (!long.legend || long.legend.h >= longInput.legendPanel.h || bottomOf(long.legend) > 480) fail('legend-cap');
if (meets(long.legend, longInput.pip)) fail('legend-horizon');
if (meets(long.legend, long.time)) fail('legend-time');
if (meets(long.legend, long.footer)) fail('legend-footer');
const readout = { x: 100, y: 220, w: 600, h: 40 };
const withReadout = solveChromeSlots({ ...longInput, timeReadout: readout });
if (!withReadout.legend || meets(withReadout.legend, readout)) fail('legend-readout');
console.log('held');
`;

const mutants = [
  {
    name: 'drop painted-slider bounds',
    failure: 'slider',
    apply: (src) => src
      .replace('    measure.slider,\n    measure.sliderChip,\n', '')
      .replace('measure.launch, measure.slider, measure.sliderChip, ...measure.timeButtons', 'measure.launch, ...measure.timeButtons'),
  },
  {
    name: 'ignore safe insets',
    failure: 'insets',
    apply: (src) => src.replace(
      'export function solveChromeSlots(measure: ChromeMeasure): ChromeSlots {\n',
      'export function solveChromeSlots(measure: ChromeMeasure): ChromeSlots {\n  measure = { ...measure, insets: { top: 0, right: 0, bottom: 0, left: 0 } };\n',
    ),
  },
  {
    name: 'wrong priority order',
    failure: 'priority',
    apply: (src) => src
      .replace(
        '  const columnX = measure.viewport.w - measure.insets.right - EDGE - gutter;\n  if (columnH >= TARGET && columnX >= minX - 0.5) {',
        '  const columnX = measure.insets.left;\n  if (columnH >= TARGET) {',
      ),
  },
  {
    name: 'drop Legend horizon obstacle',
    failure: 'legend-horizon',
    apply: (src) => src.replace('    measure.pip,\n    time, ...timePaint(measure, time),', '    time, ...timePaint(measure, time),'),
  },
  {
    name: 'drop Legend whole time-strip obstacles',
    failure: 'legend-time',
    apply: (src) => src.replace('    time, ...timePaint(measure, time),\n', ''),
  },
  {
    name: 'drop Legend readout obstacle',
    failure: 'legend-readout',
    apply: (src) => src.replace('const parts = [measure.timeReadout, measure.sliderChip, measure.slider, ...measure.timeButtons].filter(present);', 'const parts = [measure.sliderChip, measure.slider, ...measure.timeButtons].filter(present);'),
  },
  {
    name: 'use intrinsic instead of allocated Legend height',
    failure: 'legend-cap',
    apply: (src) => src.replace('const height = Math.min(intrinsic, lo - low);', 'const height = intrinsic;'),
  },
];

function run(src) {
  const scratch = resolve(root, '.slot-mutants');
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, 'run-'));
  writeFileSync(join(dir, 'chrome-slots.ts'), src);
  writeFileSync(join(dir, 'hold.ts'), harness);
  const result = spawnSync('bun', ['hold.ts'], { cwd: dir, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { passed: result.status === 0, failure: result.stderr.trim() };
}

const lines = [];
const baseline = projectPlacementViolations(root);
if (baseline.length || !run(source).passed) {
  console.error(['source harness failed', ...baseline].join('\n'));
  process.exit(1);
}
for (const mutant of mutants) {
  const next = mutant.apply(source);
  if (next === source) {
    console.error(`mutant did not apply: ${mutant.name}`);
    process.exit(1);
  }
  const result = run(next);
  const killed = !result.passed && result.failure === mutant.failure;
  lines.push(`${mutant.name}: ${killed ? 'red' : 'GREEN (survived)'}`);
  if (!killed) {
    console.error([...lines, result.failure].join('\n'));
    process.exit(1);
  }
}
const css = readFileSync(resolve(root, 'src/style.css'), 'utf8');
const js = readFileSync(resolve(root, 'src/map-chrome.ts'), 'utf8');
for (const mutant of REINTRODUCTION_PATTERNS) {
  const caught = ownerPlacementViolations(`${css}\n${mutant.css || ''}`, `${js}\n${mutant.js || ''}`);
  if (!caught.length) {
    console.error(`${mutant.name}: GREEN (survived)`);
    process.exit(1);
  }
  lines.push(`${mutant.name}: red`);
}
const main = readFileSync(resolve(root, 'src/main.ts'), 'utf8');
const importedMutants = [
  ['imported CSS placement', 'src/slot-mutant.css', 'body.map-slot-owned .view-map .map-controls{position:absolute!important;top:80px!important;right:16px!important}'],
  ['imported JS placement', 'src/slot-mutant.ts', 'const dock=document.querySelector(".map-control-dock");dock.style.translate="0 80px";'],
  ['imported second slot writer', 'src/slot-mutant.ts', 'document.body.style.setProperty("--slot-time-y", "80px");'],
  ['imported called style alias', 'src/slot-mutant.ts', 'export function displace(){const dock=document.querySelector(".map-control-dock");const placement=dock.style;placement.top="0px";}', 'displace()'],
  ['imported called destructured style', 'src/slot-mutant.ts', 'export function displace(){const {style:placement}=document.querySelector(".map-control-dock");placement.top="0px";}', 'displace()'],
  ['imported called assigned style alias', 'src/slot-mutant.ts', 'export function displace(){let dock;dock=document.querySelector(".map-control-dock");let placement;placement=dock.style;placement.top="0px";}', 'displace()'],
  ['imported called destructuring assignment', 'src/slot-mutant.ts', 'export function displace(){let placement;({style:placement}=document.querySelector(".map-control-dock"));placement.setProperty("top","0px");}', 'displace()'],
  ['imported called element parameter', 'src/slot-mutant.ts', 'export function displace(dock){const {style:placement}=dock;placement.top="0px";}', 'displace(document.querySelector(".map-control-dock"))'],
  ['imported called style parameter', 'src/slot-mutant.ts', 'export function displace(placement){placement.setProperty("top","0px");}', 'displace(document.querySelector(".map-control-dock").style)'],
].map(([name, path, content, importedCall = ''], index) => ({
  name, path: path.replace('slot-mutant', `slot-mutant-${index}`), content, importedCall, index,
}));
const importedOverrides = new Map(importedMutants.map(({ path, content }) => [path, content]));
importedOverrides.set('src/main.ts', `${main}\n${importedMutants.map(({ path, importedCall, index }) => importedCall
  ? `import { displace as displace${index} } from './${path.slice(4)}';${importedCall.replace('displace(', `displace${index}(`)};`
  : `import './${path.slice(4)}';`).join('\n')}`);
const importedErrors = projectPlacementViolations(root, importedOverrides);
for (const { name, path } of importedMutants) {
  if (!importedErrors.some((error) => error.startsWith(`${path}:`))) {
    console.error(`${name}: GREEN (survived)`);
    process.exit(1);
  }
  lines.push(`${name}: red`);
}
lines.push('source: green');
process.stdout.write(`${lines.join('\n')}\n`);
