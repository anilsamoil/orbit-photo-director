import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const placeProp = /^(position|top|right|bottom|left|inset(?:-(?:block|inline)(?:-(?:start|end))?)?|transform|translate|margin(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|animation(?:-name)?)$/;
const ownedName = /^(?:maplibregl-ctrl-(?:top-left|zoom(?:-in|-out)?|compass)|map-toolbar|map-command|map-controls(?:-[\w-]+)?|time-slider|time-slider-row|time-step-btn|map-control-dock|map-legend(?:-panel|-toggle)?|map-chrome-toggle|map-launch-coverage|status-banner)$/;
const slotNames = new Map([
  ['maplibregl-ctrl-top-left', 'zoom'], ['map-toolbar', 'show'], ['map-command', 'time'],
  ['map-control-dock', 'dock'], ['map-legend', 'legend-button'], ['map-legend-panel', 'legend'],
  ['map-chrome-toggle', 'hide'], ['map-launch-coverage', 'launch'], ['status-banner', 'footer'],
]);
const normalize = (value) => value.replace(/\s*!important\s*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
const zero = (value) => /^(?:0(?:px|rem|em|%)?)(?:\s+0(?:px|rem|em|%)?){0,3}$/.test(value);
const reset = (prop, value) => prop === 'position' ? value === 'static'
  : /^(?:top|right|bottom|left|inset)/.test(prop) ? /^(?:auto)(?:\s+auto){0,3}$/.test(value)
    : /^(?:transform|translate|animation)/.test(prop) ? value === 'none' || (prop === 'translate' && zero(value))
      : prop.startsWith('margin') && zero(value);

function selectorParts(selector, separator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < selector.length; i += 1) {
    if (selector[i] === '(' || selector[i] === '[') depth += 1;
    else if (selector[i] === ')' || selector[i] === ']') depth -= 1;
    else if (!depth && separator.test(selector[i])) { parts.push(selector.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(selector.slice(start).trim());
  return parts.filter(Boolean);
}
const splitSelectors = (selector) => selectorParts(selector, /,/);

function actorFor(selector) {
  // Functional pseudo-class contents select ancestors/conditions, not the subject.
  const subject = selector.replace(/:(?:has|not)\((?:[^()]|\([^()]*\))*\)/g, '');
  if (/::(?:-webkit-slider-thumb|-moz-range-thumb)/.test(subject)) return null;
  const tail = selectorParts(subject, /[\s>+~]/).at(-1) || '';
  const names = [...tail.matchAll(/[.#]([\w-]+)|\[(?:class|id)\s*[*~|^$]?=\s*["']([^"']+)["']\]/g)]
    .flatMap((match) => (match[1] || match[2]).split(/\s+/));
  const owned = names.filter((candidate) => ownedName.test(candidate));
  if (owned.length) {
    const slots = new Set(owned.map((name) => slotNames.get(name)));
    return { name: owned.join('/'), slot: slots.size === 1 ? slots.values().next().value : undefined };
  }
  if (tail === '.banner' && /view-map/.test(selector)) return { name: 'status-banner', slot: 'footer' };
  return null;
}

function declarations(body) {
  return body.split(';').flatMap((part) => {
    const colon = part.indexOf(':');
    if (colon < 0) return [];
    return [{ prop: part.slice(0, colon).trim().toLowerCase(), value: normalize(part.slice(colon + 1)) }];
  });
}

function rules(source, media = '') {
  const out = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf('{', i);
    if (open < 0) break;
    const selector = source.slice(i, open).replace(/^\s*@import[^;]*;/g, '').replace(/\s+/g, ' ').trim();
    let depth = 1;
    let j = open + 1;
    while (j < source.length && depth > 0) {
      if (source[j] === '{') depth += 1;
      else if (source[j] === '}') depth -= 1;
      j += 1;
    }
    const body = source.slice(open + 1, j - 1);
    if (/^@(media|supports|container|layer|scope)\b/.test(selector)) {
      out.push(...rules(body, media ? `${media} ${selector}` : selector));
    } else if (selector && !selector.startsWith('@')) {
      out.push({ selector, media, declarations: declarations(body) });
    }
    i = j;
  }
  return out;
}

function slotDeclaration(actor, prop, value, decls) {
  if (reset(prop, value)) return true;
  if (!actor.slot) return false;
  const variable = (axis) => `var(--slot-${actor.slot}-${axis})`;
  const top = actor.slot === 'zoom' ? `calc(${variable('y')} - var(--topbar-height))` : variable('y');
  if (prop === 'left') return value === variable('x');
  if (prop === 'top') return value === top;
  if (prop !== 'position') return false;
  // A positioned actor is legitimate only when this rule binds BOTH coordinates
  // to its own allocated slot. The class/selector spelling grants no exemption.
  return value === (['legend', 'footer'].includes(actor.slot) ? 'fixed' : 'absolute')
    && decls.some((decl) => decl.prop === 'left' && decl.value === variable('x'))
    && decls.some((decl) => decl.prop === 'top' && decl.value === top);
}

export function narrowPlacementViolations(css, js = '') {
  const violations = [];
  for (const rule of rules(css.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    if (!/max-width:\s*719px|map-chrome-reflow|map-dock-row/.test(`${rule.media} ${rule.selector}`)) continue;
    for (const selector of splitSelectors(rule.selector)) {
      const actor = actorFor(selector);
      if (!actor) continue;
      const bad = rule.declarations.filter(({ prop, value }) => placeProp.test(prop) && !slotDeclaration(actor, prop, value, rule.declarations));
      if (bad.length) violations.push(`css ${rule.media} ${selector} { ${bad.map(({ prop, value }) => `${prop}: ${value}`).join('; ')} }`);
    }
  }
  if (/map-chrome-reflow|map-dock-row/.test(js)) violations.push('map-chrome.ts still names a reflow class');
  if (/scroll(?:Left|Top)/.test(js)) violations.push('map-chrome.ts touches a scroll offset');
  return violations;
}

const cssProp = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
function textOf(node) {
  return node && (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}
function property(node) {
  if (ts.isPropertyAccessExpression(node)) return { object: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node)) return { object: node.expression, name: textOf(node.argumentExpression) };
  return null;
}
function styleTarget(node) {
  const member = property(node);
  return member?.name === 'style' ? member.object : null;
}
function scopeOf(node) {
  let scope = node.parent;
  while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  return scope;
}
function scopeName(node) {
  const scope = scopeOf(node);
  return scope && 'name' in scope ? scope.name?.getText() : undefined;
}
function visit(root, fn) {
  fn(root);
  ts.forEachChild(root, (child) => visit(child, fn));
}

export function jsPlacementViolations(source, { owner = true } = {}) {
  if (!/\bstyle\b|solveChromeSlots\s*\(|\bwriteSlot\s*\(|\bplace(?:Zoom|Dock|Show|Hide|Legend|Footer|Time|Chrome)\b|\banimate\s*\(/.test(source)) return [];
  const file = ts.createSourceFile('chrome.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];
  const targets = new Set();
  const writes = [];
  const hidden = new Map();
  const calls = [];
  const objects = new Map();
  const relevant = (node) => owner || targets.has(node.getText(file))
    || [...node.getText(file).matchAll(/["']([^"']+)["']/g)].some((match) => selectorOwned(match[1]));
  visit(file, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      if (ts.isObjectLiteralExpression(node.initializer)) {
        objects.set(node.name.text + ':' + scopeOf(node)?.pos, new Map(node.initializer.properties.flatMap((prop) => {
          if (!ts.isPropertyAssignment(prop)) return [];
          return [[textOf(prop.name) || prop.name.getText(file), textOf(prop.initializer)]];
        })));
      }
      const strings = [...node.initializer.getText(file).matchAll(/["']([^"']+)["']/g)];
      if (strings.some((match) => selectorOwned(match[1]))) targets.add(node.name.text);
      if (/\.(?:createElement|cloneNode)\(/.test(node.initializer.getText(file))) {
        hidden.set(node.name.text + ':' + scopeOf(node)?.pos, { values: new Map() });
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const member = property(node.left);
      const target = member && styleTarget(member.object);
      if (target) writes.push({ target, prop: member.name ? cssProp(member.name) : null, value: textOf(node.right), node });
    }
    if (ts.isCallExpression(node)) {
      calls.push(node);
      const member = property(node.expression);
      const target = member && styleTarget(member.object);
      if (target && member.name === 'setProperty') {
        writes.push({ target, prop: textOf(node.arguments[0]), value: textOf(node.arguments[1]), node });
      }
      if (member?.name === 'setAttribute' && textOf(node.arguments[0]) === 'style') {
        writes.push({ target: member.object, prop: 'css-text', value: textOf(node.arguments[1]), node });
      }
      if (node.expression.getText(file) === 'Object.assign' && node.arguments[0]) {
        const assigned = styleTarget(node.arguments[0]);
        if (assigned) for (const values of node.arguments.slice(1)) {
          if (!ts.isObjectLiteralExpression(values)) writes.push({ target: assigned, prop: null, value: null, node });
          else for (const value of values.properties) {
            if (ts.isPropertyAssignment(value)) writes.push({ target: assigned, prop: cssProp(textOf(value.name) || value.name.getText(file)), value: textOf(value.initializer), node });
          }
        }
      }
    }
  });
  for (const write of writes) {
    const record = hidden.get(write.target.getText(file) + ':' + scopeOf(write.node)?.pos);
    if (record) {
      record.values.set(write.prop, write.value);
      let loop = write.node.parent;
      while (loop && !ts.isForOfStatement(loop) && loop !== scopeOf(write.node)) loop = loop.parent;
      if (write.prop === null && loop && ts.isForOfStatement(loop) && ts.isCallExpression(loop.expression)
        && loop.expression.expression.getText(file) === 'Object.entries') {
        const object = objects.get(loop.expression.arguments[0]?.getText(file) + ':' + scopeOf(write.node)?.pos);
        if (object) for (const [prop, value] of object) record.values.set(prop, value);
      }
    }
  }
  const invisible = (write) => {
    const values = hidden.get(write.target.getText(file) + ':' + scopeOf(write.node)?.pos)?.values;
    return values?.get('visibility') === 'hidden' && values?.get('pointer-events') === 'none';
  };
  let writerCount = 0;
  for (const write of writes) {
    const { prop, value, node } = write;
    if (invisible(write)) continue;
    if (prop === null && owner && scopeName(node) === 'writeSlot'
      && write.target.getText(file) === 'document.body'
      && node.arguments?.[0]?.getText(file) === 'name'
      && node.arguments?.[1]?.getText(file) === '`${value}px`') {
      writerCount += 1;
      if (writerCount === 1) continue;
    }
    if (prop?.startsWith('--slot-')) violations.push(`js slot variable writer: ${prop}`);
    else if (relevant(write.target) && (prop === null || placeProp.test(prop))) {
      if (prop === null || value === null || !reset(prop, normalize(value))) violations.push(`js inline placement: ${prop || 'dynamic property'}`);
    } else if (prop === 'css-text') {
      const decls = value === null ? [] : declarations(value);
      const slotWrite = decls.some((decl) => decl.prop.startsWith('--slot-'));
      const placement = relevant(write.target) && (value === null || decls.some((decl) => placeProp.test(decl.prop) && !reset(decl.prop, decl.value)));
      if (slotWrite || placement) violations.push('js cssText placement');
    }
  }
  visit(file, (node) => {
    if (ts.isFunctionDeclaration(node) && /^place(?:Zoom|Dock|Show|Hide|Legend|Footer|Time|Chrome)$/.test(node.name?.text || '')) {
      violations.push(`js second positioner: ${node.name.text}`);
    }
  });
  for (const call of calls) {
    const name = call.expression.getText(file);
    if (name === 'solveChromeSlots') {
      if (!owner || scopeName(call) !== 'syncMapChrome') violations.push('js second solver');
    }
    if (name === 'writeSlot' && !['placeInPane', 'placeInView'].includes(scopeName(call))) violations.push('js second slot writer');
    const member = property(call.expression);
    if (member?.name === 'animate' && relevant(member.object)
      && /(?:top|left|right|bottom|inset|transform|translate|margin)\s*[:'"\]]/.test(call.arguments[0]?.getText(file) || '')) violations.push('js placement animation');
  }
  return violations;
}

function selectorOwned(selector) {
  return !!actorFor(selector) || selector.split(/[\s.#]+/).some((name) => ownedName.test(name));
}

export function ownerPlacementViolations(css, js = '', options) {
  const violations = [];
  for (const rule of rules(css.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    for (const decl of rule.declarations) {
      if (decl.prop.startsWith('--slot-')) violations.push(`css second slot writer: ${decl.prop}`);
    }
    for (const selector of splitSelectors(rule.selector)) {
      const actor = actorFor(selector);
      if (!actor) continue;
      const bad = rule.declarations.filter(({ prop, value }) => placeProp.test(prop) && !slotDeclaration(actor, prop, value, rule.declarations));
      if (bad.length) violations.push(`css ${rule.media || '(none)'} ${selector} { ${bad.map(({ prop, value }) => `${prop}: ${value}`).join('; ')} }`);
    }
  }
  return [...violations, ...jsPlacementViolations(js, options)];
}

export const REINTRODUCTION_PATTERNS = [
  { name: 'narrow media top', css: '@media (max-width: 719px) { .view-map .map-control-dock { top: 0; left: 0; } }' },
  { name: 'wide css left', css: '.view-map .map-command { left: 8px; }' },
  { name: 'css position absolute', css: '.view-map #map .maplibregl-ctrl-top-left { position: absolute; left: 8px; }' },
  { name: 'css position fixed offsets', css: '.view-map .map-chrome-toggle { position: fixed; right: 12px; bottom: 0; }' },
  { name: 'css inset', css: '.view-map .map-legend-panel { inset: 8px; }' },
  { name: 'css transform', css: '.view-map .map-command .time-slider { transform: translateY(-4px); }' },
  ...['map-controls', 'map-controls-time', 'map-controls-bearing', 'map-controls-filter', 'map-controls-overlay'].map((actor) => ({
    name: `owned ${actor}`,
    css: `body.map-slot-owned .view-map .${actor} { position:absolute!important;top:80px!important;right:16px!important; }`,
  })),
  ...['inset-block-start:80px', 'inset-inline:0 16px', 'translate:0 80px', 'margin:80px 0 0', 'margin-block-start:80px'].map((declaration) => ({
    name: `owned ${declaration.split(':')[0]}`, css: `body.map-slot-owned .view-map .map-controls { ${declaration}; }`,
  })),
  { name: 'attribute selector', css: 'body.map-slot-owned .view-map [class~="map-controls"] { top:80px; }' },
  { name: 'body slot variable', css: 'body { --slot-time-y:80px; }' },
  { name: 'mixed actor slots', css: ':is(.map-command,.map-control-dock){position:absolute;left:var(--slot-time-x);top:var(--slot-time-y)}' },
  { name: 'wrong slot variable', css: 'body.map-slot-owned .map-command { top:var(--slot-dock-y); }' },
  ...['top', 'left', 'bottom', 'right', 'translate', 'insetBlockStart', 'marginTop'].map((prop) => ({ name: `js style.${prop}`, js: `el.style.${prop} = "10px";` })),
  { name: 'second positioner', js: 'function placeDock(box) { return box; }' },
  { name: 'setProperty top', js: 'el.style.setProperty("top", "8px");' },
  { name: 'cssText top', js: 'el.style.cssText = "position:absolute;top:1px";' },
  { name: 'js slot variable', js: 'document.body.style.setProperty("--slot-time-y", "80px");' },
  { name: 'second solver', js: 'function otherLayout(measure) { return solveChromeSlots(measure); }' },
  { name: 'js style object assignment', js: 'Object.assign(el.style, { top: "80px" });' },
  { name: 'js style attribute', js: 'el.setAttribute("style", "top:80px");' },
  { name: 'js cssText slot writer', js: 'document.body.style.cssText += "--slot-time-y:80px";' },
  { name: 'js dynamic property', js: 'const property="top";el.style[property]="80px";' },
  { name: 'placement animation', js: 'el.animate([{ translate: "0 0" }, { translate: "0 80px" }], 1);' },
];

export function reintroductionMisses(patterns = REINTRODUCTION_PATTERNS) {
  return patterns.filter((pattern) => ownerPlacementViolations(pattern.css || '', pattern.js || '').length === 0).map((pattern) => pattern.name);
}

export function projectPlacementViolations(root, overrides = new Map()) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:css|[cm]?[jt]sx?)$/.test(file) && !/\.(?:test|spec|d)\.[jt]sx?$/.test(file)) files.push(file);
    }
  };
  walk(resolve(root, 'src'));
  for (const file of overrides.keys()) if (!files.includes(resolve(root, file))) files.push(resolve(root, file));
  return files.flatMap((file) => {
    const name = relative(root, file);
    const source = overrides.get(name) ?? readFileSync(file, 'utf8');
    const owner = name === 'src/map-chrome.ts';
    const errors = name.endsWith('.css') ? ownerPlacementViolations(source)
      : [...jsPlacementViolations(source, { owner }), ...(owner ? narrowPlacementViolations('', source) : [])];
    return errors.map((error) => `${name}: ${error}`);
  });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const patterns = process.argv.includes('--patterns');
  const fixture = process.argv.includes('--fixture');
  const violations = patterns ? reintroductionMisses() : fixture
    ? ownerPlacementViolations(REINTRODUCTION_PATTERNS[0].css) : projectPlacementViolations(root);
  if (fixture ? !violations.length : violations.length) {
    process.stderr.write(`${violations.join('\n') || 'fixture did not fail'}\n`);
    process.exit(1);
  }
  process.stdout.write(patterns ? `reintroduction patterns caught: ${REINTRODUCTION_PATTERNS.length}/${REINTRODUCTION_PATTERNS.length}\n`
    : fixture ? `fixture violations: ${violations.length}\n` : 'chrome placement stays with the slot owner across src CSS and JS\n');
}
