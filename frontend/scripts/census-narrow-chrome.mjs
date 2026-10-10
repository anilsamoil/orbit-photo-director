import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const placeProp = /^(position|top|right|bottom|left|width|height|max-height|max-width|min-height|min-width|overflow-x|overflow-y|flex-direction)$/;

const actors = [
  ['zoom', /maplibregl-ctrl-top-left|maplibregl-ctrl-zoom|maplibregl-ctrl-compass/],
  ['dock', /map-control-dock/],
  ['legend', /map-legend-panel|map-legend-toggle|(?:^|[\s>+~])\.map-legend\b/],
  ['slider', /map-command|time-slider|time-step-btn/],
  ['footer', /status-banner|shotlist-bar|map-banner-clearance|map-shotlist-block/],
  ['ir', /map-imagery-date|map-legend-warning/],
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
      out.push({ selector, media, props });
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
    if (narrow || reflow) {
      violations.push(`${actor[0]}: ${rule.media || '(none)'} ${rule.selector} { ${rule.props.join(', ')} }`);
    }
  }
  if (/map-chrome-reflow|map-dock-row/.test(js)) violations.push('map-chrome.ts still names a reflow class');
  if (/scroll(?:Left|Top)/.test(js)) violations.push('map-chrome.ts touches a scroll offset');
  return violations;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const fixture = process.argv.includes('--fixture');
  const css = fixture
    ? '@media (max-width: 719px) { .view-map .map-control-dock { top: 0; left: 0; } }'
    : readFileSync(resolve(root, 'src/style.css'), 'utf8');
  const js = fixture ? '' : readFileSync(resolve(root, 'src/map-chrome.ts'), 'utf8');
  const violations = narrowPlacementViolations(css, js);
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
