import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const placeProp = /^(position|top|right|bottom|left|inset|inset-block|inset-inline|transform)$/;

const actors = [
  ['zoom', /maplibregl-ctrl-top-left|maplibregl-ctrl-zoom|maplibregl-ctrl-compass/],
  ['dock', /map-control-dock/],
  ['legend', /map-legend-panel|map-legend-toggle|(?:^|[\s>+~])\.map-legend\b/],
  ['slider', /map-command|time-slider|time-step-btn/],
  ['footer', /status-banner|shotlist-bar|map-banner-clearance|map-shotlist-block/],
  ['ir', /map-imagery-date|map-legend-warning/],
];

const ownedSelector = /maplibregl-ctrl-top-left|maplibregl-ctrl-zoom|maplibregl-ctrl-compass|map-toolbar|map-command|map-controls|time-slider(?![-a-z])|map-control-dock|(?:^|[\s>+~.#])\.map-legend(?![-a-z])|map-legend-panel|map-legend-toggle|map-chrome-toggle|map-launch-coverage|(?:^|[\s>+~])#status-banner\b|view-map\)\s*>\s*\.banner/;

const jsPlacement = [
  ['inline style.top', /(?<!probe)\.style\.top\s*=/],
  ['inline style.left', /(?<!probe)\.style\.left\s*=/],
  ['inline style.bottom', /(?<!probe)\.style\.bottom\s*=/],
  ['inline style.right', /(?<!probe)\.style\.right\s*=/],
  ['setProperty top', /setProperty\(\s*['"]top['"]/],
  ['setProperty left', /setProperty\(\s*['"]left['"]/],
  ['cssText top', /cssText\s*=\s*['"][^'"]*\btop\s*:/],
  ['second positioner', /function\s+place(?:Zoom|Dock|Show|Hide|Legend|Footer|Time|Chrome)\b/],
];

export const REINTRODUCTION_PATTERNS = [
  { name: 'narrow media top', css: '@media (max-width: 719px) { .view-map .map-control-dock { top: 0; left: 0; } }', js: '' },
  { name: 'wide css left', css: '.view-map .map-command { left: 8px; }', js: '' },
  { name: 'css position absolute', css: '.view-map #map .maplibregl-ctrl-top-left { position: absolute; left: 8px; }', js: '' },
  { name: 'css position fixed offsets', css: '.view-map .map-chrome-toggle { position: fixed; right: 12px; bottom: 0; }', js: '' },
  { name: 'css inset', css: '.view-map .map-legend-panel { inset: 8px; }', js: '' },
  { name: 'css transform', css: '.view-map .map-command .time-slider { transform: translateY(-4px); }', js: '' },
  { name: 'js style.top', css: '', js: 'el.style.top = "10px";' },
  { name: 'js style.left', css: '', js: 'el.style.left = "4px";' },
  { name: 'js style.bottom', css: '', js: 'el.style.bottom = "0px";' },
  { name: 'js style.right', css: '', js: 'el.style.right = "12px";' },
  { name: 'second positioner', css: '', js: 'function placeDock(box) { return box; }' },
  { name: 'setProperty top', css: '', js: 'el.style.setProperty("top", "8px");' },
  { name: 'cssText top', css: '', js: 'el.style.cssText = "position:absolute;top:1px";' },
];

function rules(source, media = '') {
  const out = [];
  let i = 0;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i += 1;
    const open = source.indexOf('{', i);
    if (open < 0) break;
    const selector = source.slice(i, open).replace(/\s+/g, ' ').trim();
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth += 1;
      else if (source[j] === '}') depth -= 1;
      j += 1;
    }
    const body = source.slice(open + 1, j - 1);
    if (selector.startsWith('@media') || selector.startsWith('@supports') || selector.startsWith('@container')) {
      out.push(...rules(body, media ? `${media} ${selector}` : selector));
    } else if (selector && !selector.startsWith('@')) {
      const props = body
        .split(';')
        .map((part) => part.split(':')[0].trim())
        .filter((name) => placeProp.test(name));
      out.push({ selector, media, props, body, start: i, open, end: j });
    }
    i = j;
  }
  return out;
}

export function narrowPlacementViolations(css, js = '') {
  const parsed = rules(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const violations = [];
  for (const rule of parsed) {
    if (!rule.props.length) continue;
    const actor = actors.find(([, pattern]) => pattern.test(rule.selector));
    if (!actor) continue;
    const narrow = /max-width:\s*719px/.test(rule.media);
    const reflow = /map-chrome-reflow|map-dock-row/.test(rule.selector) || /map-chrome-reflow|map-dock-row/.test(rule.media);
    if (narrow || reflow) violations.push(`${actor[0]}: ${rule.media || '(none)'} ${rule.selector} { ${rule.props.join(', ')} }`);
  }
  if (/map-chrome-reflow|map-dock-row/.test(js)) violations.push('map-chrome.ts still names a reflow class');
  if (/scroll(?:Left|Top)/.test(js)) violations.push('map-chrome.ts touches a scroll offset');
  return violations;
}

export function ownerPlacementViolations(css, js = '') {
  const parsed = rules(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const violations = [];
  for (const rule of parsed) {
    if (!rule.props.length) continue;
    if (!ownedSelector.test(rule.selector)) continue;
    if (rule.selector.includes('map-slot-owned')) continue;
    violations.push(`css ${rule.media || '(none)'} ${rule.selector} { ${rule.props.join(', ')} }`);
  }
  for (const [name, pattern] of jsPlacement) {
    if (pattern.test(js)) violations.push(`js ${name}`);
  }
  return violations;
}

export function reintroductionMisses(patterns = REINTRODUCTION_PATTERNS) {
  return patterns.filter((pattern) => ownerPlacementViolations(pattern.css, pattern.js).length === 0).map((pattern) => pattern.name);
}

function stripOwnedPlacement(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  const parsed = rules(clean);
  let next = css;
  const cuts = [];
  for (const rule of parsed) {
    if (!rule.props.length) continue;
    if (!ownedSelector.test(rule.selector)) continue;
    if (rule.selector.includes('map-slot-owned')) continue;
    cuts.push(rule);
  }
  cuts.sort((a, b) => b.start - a.start);
  for (const rule of cuts) {
    const body = next.slice(rule.open + 1, rule.end - 1);
    const kept = body
      .split(';')
      .filter((part) => {
        const name = part.split(':')[0].trim();
        return name && !placeProp.test(name);
      });
    const replacement = kept.length ? `${kept.join(';')};` : '';
    next = next.slice(0, rule.open + 1) + replacement + next.slice(rule.end - 1);
  }
  return next;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (process.argv.includes('--patterns')) {
    const misses = reintroductionMisses();
    if (misses.length) {
      process.stderr.write(`missed reintroduction patterns: ${misses.join(', ')}\n`);
      process.exit(1);
    }
    process.stdout.write(`reintroduction patterns caught: ${REINTRODUCTION_PATTERNS.length}/${REINTRODUCTION_PATTERNS.length}\n`);
    process.exit(0);
  }
  if (process.argv.includes('--strip')) {
    const file = resolve(root, 'src/style.css');
    const before = readFileSync(file, 'utf8');
    const after = stripOwnedPlacement(before);
    writeFileSync(file, after);
    const left = ownerPlacementViolations(after, '');
    process.stdout.write(`stripped. remaining css violations: ${left.length}\n`);
    process.exit(left.length ? 1 : 0);
  }
  const fixture = process.argv.includes('--fixture');
  const css = fixture
    ? '@media (max-width: 719px) { .view-map .map-control-dock { top: 0; left: 0; } }'
    : readFileSync(resolve(root, 'src/style.css'), 'utf8');
  const js = fixture ? '' : readFileSync(resolve(root, 'src/map-chrome.ts'), 'utf8');
  const violations = [
    ...narrowPlacementViolations(css, js),
    ...(fixture ? [] : ownerPlacementViolations(css, js)),
  ];
  if (fixture) {
    if (!violations.length) {
      process.stderr.write('fixture did not fail\n');
      process.exit(1);
    }
    process.stdout.write(`fixture violations: ${violations.length}\n`);
    process.exit(0);
  }
  if (violations.length) {
    process.stderr.write(`${violations.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('narrow chrome placement stays with the slot owner\n');
}
