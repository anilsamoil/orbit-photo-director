import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'src/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const js = readFileSync(resolve(root, 'src/map-chrome.ts'), 'utf8');

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

const parsed = rules(css);
const lines = [];
lines.push('premise: a body class can correct a narrow chrome slot that CSS tokens already placed');
lines.push('placement rules (position, insets, size, overflow, flex-direction):');

const counts = {};
for (const [name, pattern] of actors) {
  const matched = parsed.filter((rule) => pattern.test(rule.selector));
  const reflow = matched.filter((rule) => /map-chrome-reflow|map-dock-row/.test(rule.selector));
  const props = matched.reduce((sum, rule) => sum + rule.props.length, 0);
  counts[name] = { rules: matched.length, reflow: reflow.length, props };
  lines.push(`  ${name}: ${matched.length} rules, ${reflow.length} under reflow classes, ${props} placement declarations`);
}

const classRules = parsed.filter((rule) => /map-chrome-reflow|map-dock-row/.test(rule.selector));
lines.push(`reflow class rules: ${classRules.length}`);
const medias = [...new Set(classRules.map((rule) => rule.media).filter(Boolean))];
lines.push(`reflow class media: ${medias.join(' | ') || '(none)'}`);

const tokenReads = [...js.matchAll(/--map-[a-z0-9-]+|--topbar-height/g)].map((match) => match[0]);
const uniqueTokens = [...new Set(tokenReads)];
lines.push(`map-chrome.ts token reads: ${uniqueTokens.join(', ')}`);
lines.push(`map-chrome.ts painted reads: ${js.includes('.time-step-btn') ? 'time-step button centers' : 'none'}`);
lines.push(`map-chrome.ts strips reflow classes before measure: ${/classList\.remove\('map-chrome-reflow', 'map-dock-row'\)/.test(js)}`);
const missing = ['zoom', 'footer', 'time-slider', 'scrollbar', 'map-legend-panel'].filter((name) => !js.includes(name));
lines.push(`map-chrome.ts does not name: ${missing.join(', ')}`);

const dual = ['dock', 'legend', 'slider'].filter((name) => counts[name].reflow > 0 && counts[name].rules > counts[name].reflow);
lines.push(`actors placed by both tokens and a reflow class: ${dual.join(', ')}`);
lines.push('unmeasured neighbors of those actors: zoom lane, painted slider chip, footer, shot list, scrollbar');
lines.push('plan: one owner slots zoom, dock, legend, slider, and footer from painted boxes; narrow CSS stops placing them too');

const text = `${lines.join('\n')}\n`;
process.stdout.write(text);

const skewed = dual.length >= 3 && missing.length >= 4 && /classList\.remove\('map-chrome-reflow'/.test(js);
if (!skewed) {
  process.stderr.write('census shape changed; re-read the owners before the next layout edit\n');
  process.exit(2);
}
