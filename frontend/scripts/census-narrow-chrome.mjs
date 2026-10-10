import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const placeProp = /^(position|top|right|bottom|left|inset(?:-(?:block|inline)(?:-(?:start|end))?)?|transform|translate|margin(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?|animation(?:-name)?)$/;
const effectProp = (prop) => placeProp.test(prop) || /^(?:width|height|min-width|max-width|min-height|max-height)$/.test(prop);
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
function propertyKey(node) {
  return node && (ts.isComputedPropertyName(node) ? textOf(node.expression) : textOf(node) || node.getText());
}
function property(node) {
  if (ts.isPropertyAccessExpression(node)) return { object: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node)) return { object: node.expression, name: textOf(node.argumentExpression) };
  return null;
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

function placementAnalysis(sources, css = '') {
  const parseOptions = { languageVersion: ts.ScriptTarget.Latest, setExternalModuleIndicator: (file) => { file.externalModuleIndicator = true; } };
  const files = new Map([...sources].map(([name, source]) => [resolve(name), ts.createSourceFile(resolve(name), source, parseOptions, true, ts.ScriptKind.TS)]));
  const options = { noLib: true, allowJs: true, moduleDetection: ts.ModuleDetectionKind.Force,
    moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };
  const host = {
    getSourceFile: (name) => files.get(resolve(name)), getDefaultLibFileName: () => '',
    writeFile() {}, getCurrentDirectory: () => '/', getDirectories: () => [],
    fileExists: (name) => files.has(resolve(name)), readFile: (name) => files.get(resolve(name))?.text,
    getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  const checker = ts.createProgram([...files.keys()], options, host).getTypeChecker();
  const symbolOf = (node) => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  };
  const unwrap = (node) => {
    while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    return node;
  };
  const bindings = new Map();
  const calls = [];
  const callableNames = new Set();
  const bind = (name, expression, path = []) => {
    if (!expression) return;
    if (ts.isIdentifier(name)) {
      const symbol = symbolOf(name);
      if (symbol) bindings.set(symbol, [...(bindings.get(symbol) || []), { expression, path }]);
    } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      name.elements.forEach((entry, index) => {
        if (!ts.isBindingElement(entry) || entry.dotDotDotToken) return;
        const key = ts.isArrayBindingPattern(name) ? String(index) : propertyKey(entry.propertyName) || entry.name.getText();
        bind(entry.name, expression, [...path, key]);
        if (entry.initializer) bind(entry.name, entry.initializer);
      });
    } else if (ts.isObjectLiteralExpression(name)) {
      for (const entry of name.properties) {
        if (ts.isPropertyAssignment(entry)) bind(entry.initializer, expression, [...path, propertyKey(entry.name)]);
        else if (ts.isShorthandPropertyAssignment(entry)) bind(entry.name, expression, [...path, entry.name.text]);
      }
    } else if (ts.isArrayLiteralExpression(name)) name.elements.forEach((entry, index) => bind(entry, expression, [...path, String(index)]));
  };
  for (const file of files.values()) visit(file, (node) => {
    if (ts.isFunctionLike(node) && 'name' in node && node.name) callableNames.add(propertyKey(node.name));
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isFunctionLike(unwrap(node.initializer))) callableNames.add(node.name.getText());
    if (ts.isVariableDeclaration(node)) bind(node.name, node.initializer);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) bind(unwrap(node.left), node.right);
    if (ts.isCallExpression(node)) calls.push(node);
  });
  const resolvedFunctions = new Map();
  const functionsOf = (expression) => {
    if (!expression) return [];
    if (ts.isFunctionLike(unwrap(expression))) return [unwrap(expression)];
    if (resolvedFunctions.has(expression)) return resolvedFunctions.get(expression);
    const member = property(expression);
    if (member && !callableNames.has(member.name)
      && !(ts.isIdentifier(member.object) && symbolOf(member.object)?.flags & ts.SymbolFlags.NamespaceModule)) return [];
    const symbol = symbolOf(expression);
    const functions = (symbol?.declarations || []).flatMap((declaration) => {
      if (ts.isFunctionLike(declaration)) return [declaration];
      const initial = ts.isVariableDeclaration(declaration) && unwrap(declaration.initializer);
      return initial && ts.isFunctionLike(initial) ? [initial] : [];
    });
    resolvedFunctions.set(expression, functions);
    return functions;
  };
  // Imports and parameters carry the same provenance as local aliases. A helper
  // in another source file must not become a second writer through indirection.
  for (const call of calls) for (const fn of functionsOf(call.expression)) {
    fn.parameters.forEach((parameter, index) => bind(parameter.name, call.arguments[index]));
  }
  for (const call of calls) {
    const member = property(call.expression);
    if (member && ['forEach', 'map', 'filter'].includes(member.name)) {
      for (const callback of functionsOf(call.arguments[0])) if (callback.parameters[0]) bind(callback.parameters[0].name, member.object);
    }
  }
  const originCache = new Map();
  const origins = (expression, path = [], seen = new Set()) => {
    if (seen.size) return resolveOrigins(expression, path, seen);
    let cached = originCache.get(expression);
    if (!cached) { cached = new Map(); originCache.set(expression, cached); }
    const key = JSON.stringify(path);
    if (!cached.has(key)) cached.set(key, resolveOrigins(expression, path, seen));
    return cached.get(key);
  };
  const resolveOrigins = (expression, path, seen) => {
    const node = unwrap(expression);
    if (!node || seen.has(node)) return [];
    const next = new Set(seen).add(node);
    if (ts.isIdentifier(node)) {
      const aliases = bindings.get(symbolOf(node));
      if (aliases?.length) return aliases.flatMap((alias) => origins(alias.expression, [...alias.path, ...path], next));
    }
    if (ts.isConditionalExpression(node)) return [node.whenTrue, node.whenFalse].flatMap((branch) => origins(branch, path, next));
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
      return [node.left, node.right].flatMap((branch) => origins(branch, path, next));
    }
    if (path.length && ts.isObjectLiteralExpression(node)) {
      return node.properties.flatMap((entry) => {
        if (ts.isPropertyAssignment(entry) && propertyKey(entry.name) === path[0]) return origins(entry.initializer, path.slice(1), next);
        if (ts.isShorthandPropertyAssignment(entry) && entry.name.text === path[0]) return origins(entry.name, path.slice(1), next);
        if (ts.isSpreadAssignment(entry)) return origins(entry.expression, path, next);
        return [];
      });
    }
    if (path.length && ts.isArrayLiteralExpression(node)) return origins(node.elements[Number(path[0])], path.slice(1), next);
    const member = property(node);
    if (member && member.name === null && ts.isElementAccessExpression(node)) {
      const keys = origins(node.argumentExpression, [], next).map(({ element }) => textOf(element));
      if (keys.length && keys.every((key) => key !== null)) return keys.flatMap((key) => origins(member.object, [key, ...path], next));
    }
    if (member && ['style', 'classList', 'dataset'].includes(member.name)) {
      return origins(member.object, [], next).map((origin) => ({ ...origin, [member.name]: true, method: path[0] }));
    }
    if (['style', 'classList', 'dataset'].includes(path[0])) return origins(node, [], seen).map((origin) => ({ ...origin, [path[0]]: true, method: path[1] }));
    if (path.length && ['setProperty', 'removeProperty'].includes(path[0])) {
      return origins(node, [], seen).map((origin) => ({ ...origin, method: path[0] }));
    }
    if (member?.name) {
      const projected = origins(member.object, [member.name, ...path], next);
      if (projected.some((origin) => !origin.path?.length)) return projected;
    }
    if (ts.isCallExpression(node)) {
      const returned = functionsOf(node.expression).flatMap((fn) => {
        if (!fn.body) return [];
        if (!ts.isBlock(fn.body)) return origins(fn.body, path, next);
        const values = [];
        visit(fn.body, (child) => {
          if (ts.isReturnStatement(child) && scopeOf(child) === fn) values.push(...origins(child.expression, path, next));
        });
        return values;
      });
      if (returned.length) return returned;
    }
    return [{ element: node, style: false, path }];
  };
  const relevantCache = new Map();
  const relevant = (origin) => {
    const node = origin.element;
    if (relevantCache.has(node)) return relevantCache.get(node);
    relevantCache.set(node, false);
    const member = property(node);
    const selectorCall = ts.isCallExpression(node) && /^(?:querySelector(?:All)?|getElementById|closest)$/.test(property(node.expression)?.name || '');
    const owned = selectorCall && origins(node.arguments[0]).some(({ element }) => textOf(element) !== null && selectorOwned(textOf(element)))
      || ts.isElementAccessExpression(node) && member && origins(member.object).some(relevant);
    relevantCache.set(node, !!owned);
    return !!owned;
  };
  const contents = (expression, seen = new Set()) => origins(expression).flatMap((origin) => {
    const node = origin.element;
    if (seen.has(node)) return [];
    const next = new Set(seen).add(node);
    if (!origin.style && ts.isObjectLiteralExpression(node)) return node.properties.flatMap((entry) =>
      ts.isPropertyAssignment(entry) ? contents(entry.initializer, next)
        : ts.isShorthandPropertyAssignment(entry) ? contents(entry.name, next)
          : ts.isSpreadAssignment(entry) ? contents(entry.expression, next) : []);
    if (!origin.style && ts.isArrayLiteralExpression(node)) return node.elements.flatMap((entry) =>
      contents(ts.isSpreadElement(entry) ? entry.expression : entry, next));
    return [origin];
  });
  const literals = (expression) => {
    const values = origins(expression).map((origin) => textOf(origin.element));
    return values.length && values.every((value) => value !== null) ? values : null;
  };
  const effects = rules(css.replace(/\/\*[\s\S]*?\*\//g, '')).filter((rule) =>
    rule.declarations.some(({ prop, value }) => effectProp(prop) && !reset(prop, value)));
  return { files, origins, relevant, calls, functionsOf, contents, literals, effects };
}

function filePlacementViolations(file, analysis, owner) {
  const { origins } = analysis;
  const violations = [];
  const writes = [];
  const hidden = new Map();
  const objects = new Map();
  const addWrite = (targets, prop, value, node) => {
    for (const target of targets) writes.push({ target: target.element, prop, value, node, relevant: owner || analysis.relevant(target) });
  };
  const styles = (node) => origins(node).filter((origin) => origin.style);
  visit(file, (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isObjectLiteralExpression(node.initializer)) {
        objects.set(node.name.getText() + ':' + scopeOf(node)?.pos, new Map(node.initializer.properties.flatMap((prop) => {
          if (!ts.isPropertyAssignment(prop)) return [];
          return [[textOf(prop.name) || prop.name.getText(), textOf(prop.initializer)]];
        })));
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const member = property(node.left);
      if (member?.name === 'style') addWrite(origins(member.object), 'css-text', textOf(node.right), node);
      if (member) addWrite(styles(member.object), member.name ? cssProp(member.name) : null, textOf(node.right), node);
    }
    if (ts.isCallExpression(node)) {
      const member = property(node.expression);
      if (node.expression.getText() === 'Reflect.set') addWrite(styles(node.arguments[0]), textOf(node.arguments[1]), textOf(node.arguments[2]), node);
      if (member?.name === 'setProperty') addWrite(styles(member.object), textOf(node.arguments[0]), textOf(node.arguments[1]), node);
      if (member?.name === 'setAttribute' && (analysis.literals(node.arguments[0]) === null || analysis.literals(node.arguments[0]).includes('style'))) {
        addWrite(origins(member.object), 'css-text', textOf(node.arguments[1]), node);
      }
      if (node.expression.getText() === 'Object.assign' && node.arguments[0]) {
        const assigned = styles(node.arguments[0]);
        for (const values of node.arguments.slice(1)) {
          if (!ts.isObjectLiteralExpression(values)) addWrite(assigned, null, null, node);
          else for (const value of values.properties) {
            if (ts.isPropertyAssignment(value)) addWrite(assigned, ts.isComputedPropertyName(value.name) ? textOf(value.name.expression) : cssProp(textOf(value.name) || value.name.getText()), textOf(value.initializer), node);
            else addWrite(assigned, null, null, node);
          }
        }
      }
      if (member?.name === 'call' || member?.name === 'apply') {
        for (const method of origins(member.object).filter((origin) => origin.style && origin.method === 'setProperty')) {
          const args = member.name === 'call' ? node.arguments.slice(1)
            : node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1]) ? node.arguments[1].elements : [];
          addWrite([method], textOf(args[0]), textOf(args[1]), node);
        }
      }
    }
  });
  for (const write of writes) {
    if (!ts.isCallExpression(write.target) || !/^(?:createElement|cloneNode)$/.test(property(write.target.expression)?.name || '')) continue;
    const values = hidden.get(write.target) || new Map();
    hidden.set(write.target, values);
    values.set(write.prop, write.value);
    let loop = write.node.parent;
    while (loop && !ts.isForOfStatement(loop) && loop !== scopeOf(write.node)) loop = loop.parent;
    if (write.prop === null && loop && ts.isForOfStatement(loop) && ts.isCallExpression(loop.expression)
      && loop.expression.expression.getText() === 'Object.entries') {
      const object = objects.get(loop.expression.arguments[0]?.getText() + ':' + scopeOf(write.node)?.pos);
      if (object) for (const [prop, value] of object) values.set(prop, value);
    }
  }
  let writerCount = 0;
  for (const write of writes) {
    const { prop, value, node } = write;
    const hiddenValues = hidden.get(write.target);
    if (hiddenValues?.get('visibility') === 'hidden' && hiddenValues?.get('pointer-events') === 'none') continue;
    if (prop === null && owner && scopeName(node) === 'writeSlot'
      && write.target.getText() === 'document.body'
      && node.arguments?.[0]?.getText() === 'name'
      && node.arguments?.[1]?.getText() === '`${value}px`') {
      writerCount += 1;
      if (writerCount === 1) continue;
    }
    if (prop?.startsWith('--slot-')) violations.push(`js slot variable writer: ${prop}`);
    // The owner retains its existing probe/intrinsic sizing writes; non-owners
    // cannot resize a chrome actor and silently invalidate the allocated slot.
    else if (write.relevant && (prop === null || (owner ? placeProp.test(prop) : effectProp(prop)))) {
      if (prop === null || value === null || !reset(prop, normalize(value))) violations.push(`js inline placement: ${prop || 'dynamic property'}`);
    } else if (prop === 'css-text') {
      const decls = value === null ? [] : declarations(value);
      const slotWrite = decls.some((decl) => decl.prop.startsWith('--slot-'));
      const placement = write.relevant && (value === null || decls.some((decl) => effectProp(decl.prop) && !reset(decl.prop, decl.value)));
      if (slotWrite || placement) violations.push('js cssText placement');
    }
  }
  visit(file, (node) => {
    if (ts.isFunctionDeclaration(node) && /^place(?:Zoom|Dock|Show|Hide|Legend|Footer|Time|Chrome)$/.test(node.name?.text || '')) {
      violations.push(`js second positioner: ${node.name.text}`);
    }
  });
  const chrome = (node) => analysis.contents(node).some((origin) => textOf(origin.element) === null
    && !ts.isFunctionLike(origin.element) && !(origin.dataset && origin.method) && analysis.relevant(origin));
  const keyframePlacement = (expression, seen = new Set()) => {
    const values = origins(expression);
    if (!values.length) return true;
    return values.some(({ element: node }) => {
      if (seen.has(node)) return true;
      const next = new Set(seen).add(node);
      if (ts.isArrayLiteralExpression(node)) return node.elements.some((entry) =>
        keyframePlacement(ts.isSpreadElement(entry) ? entry.expression : entry, next));
      if (!ts.isObjectLiteralExpression(node)) return true;
      return node.properties.some((entry) => {
        if (ts.isSpreadAssignment(entry)) return keyframePlacement(entry.expression, next);
        if (!ts.isPropertyAssignment(entry) && !ts.isShorthandPropertyAssignment(entry)) return true;
        if (ts.isComputedPropertyName(entry.name) && textOf(entry.name.expression) === null) return true;
        const key = propertyKey(entry.name);
        return !key || effectProp(cssProp(key)) || key.startsWith('--slot-');
      });
    });
  };
  const classEffect = (target, expression, attribute = 'class') => {
    if (owner || !chrome(target)) return;
    // Existing footer status rendering preserves its base identity and changes
    // only color/state. Pin exact module, function, target and expression; no
    // selector/name-wide exemption for arbitrary new placement modifiers.
    if (attribute === 'class' && /[/\\]src[/\\]main\.ts$/.test(file.fileName)
      && origins(target).every(({ element }) => element.getText() === "document.getElementById('status-banner')")
      && ((scopeName(expression) === 'showSessionRecovery' && expression.getText() === "'banner banner-red'")
        || (scopeName(expression) === 'setBanner' && expression.getText() === '`banner banner-${state.level}`'))
      && !analysis.effects.some((rule) => /banner-(?:red|yellow|orange|green|loading)(?![\w-])/.test(rule.selector))) return;
    const values = analysis.literals(expression);
    const matches = analysis.effects.some((rule) => splitSelectors(rule.selector).some((selector) => {
      // Only the subject receives an element's class/attribute. Ancestor names
      // must not make a harmless `.active` on a button a placement writer.
      const subject = selectorParts(selector.replace(/:(?:has|not)\((?:[^()]|\([^()]*\))*\)/g, ''), /[\s>+~]/).at(-1) || '';
      if (attribute === 'class') {
        if (/\[class(?:\s*[*~|^$]?=|\])/.test(subject)) return true;
        const names = [...subject.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
        return values === null ? names.length > 0 : values.some((value) => value.split(/\s+/).some((name) => names.includes(name)));
      }
      return subject.includes(`[${attribute}`);
    }));
    if (matches) violations.push(`js class/attribute placement: ${attribute}`);
  };
  const stylesheetPlacement = (expression) => {
    const values = analysis.literals(expression);
    if (values === null) return true;
    return values.some((value) => rules(value).some((rule) =>
      splitSelectors(rule.selector).some(selectorOwned)
      && rule.declarations.some(({ prop }) => effectProp(prop) || prop.startsWith('--slot-'))));
  };
  const styleElement = (expression) => origins(expression).some(({ element }) =>
    ts.isCallExpression(element) && property(element.expression)?.name === 'createElement' && textOf(element.arguments[0]) === 'style');
  visit(file, (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const member = property(node.left);
      if (member?.name === 'className') classEffect(member.object, node.right);
      if (member && origins(member.object).some((origin) => origin.dataset)) {
        classEffect(member.object, node.right, member.name ? `data-${cssProp(member.name)}` : 'data-');
      }
      if (!owner && member?.name === 'adoptedStyleSheets') violations.push('js stylesheet placement: adoptedStyleSheets escape');
      if (!owner && member && ['textContent', 'innerHTML', 'innerText'].includes(member.name)
        && styleElement(member.object) && stylesheetPlacement(node.right)) violations.push('js stylesheet placement: injected style');
      if (!owner && member && chrome(node.right)) violations.push('js chrome placement escape: object storage');
    }
    if (!owner && ts.isVariableStatement(node) && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      && node.declarationList.declarations.some((declaration) => chrome(declaration.initializer))) violations.push('js chrome placement escape: exported object');
    if (!owner && ts.isReturnStatement(node) && chrome(node.expression)) violations.push('js chrome placement escape: returned element/style');
    if (!owner && ts.isArrowFunction(node) && !ts.isBlock(node.body) && chrome(node.body)) violations.push('js chrome placement escape: returned element/style');
    if (!owner && ts.isNewExpression(node)) {
      if (node.expression.getText() === 'CSSStyleSheet') violations.push('js stylesheet placement: constructed stylesheet escape');
      if (node.expression.getText() === 'KeyframeEffect' && chrome(node.arguments?.[0])) violations.push('js placement animation: KeyframeEffect');
      else if (node.arguments?.some(chrome)) violations.push('js chrome placement escape: unanalysed constructor');
    }
  });
  for (const call of analysis.calls.filter((node) => node.getSourceFile() === file)) {
    const name = call.expression.getText();
    if (name === 'solveChromeSlots' && (!owner || scopeName(call) !== 'syncMapChrome')) violations.push('js second solver');
    if (name === 'writeSlot' && !['placeInPane', 'placeInView'].includes(scopeName(call))) violations.push('js second slot writer');
    const member = property(call.expression);
    if (!owner) {
      if (member && ['add', 'toggle', 'replace', 'remove'].includes(member.name)
        && origins(member.object).some((origin) => origin.classList)) {
        const args = member.name === 'toggle' ? call.arguments.slice(0, 1) : call.arguments;
        for (const arg of args) classEffect(member.object, arg);
      }
      if (member?.name === 'setAttribute') {
        const attr = analysis.literals(call.arguments[0])?.[0];
        if (attr === 'class') classEffect(member.object, call.arguments[1]);
        else if (attr?.startsWith('data-')) classEffect(member.object, call.arguments[1], attr);
      }
      if (member && ['insertRule', 'replace', 'replaceSync', 'addRule'].includes(member.name)
        && !origins(member.object).some((origin) => origin.classList)
        && (member.name !== 'replace' || origins(member.object).some(({ element }) => /(?:styleSheets|\.sheet\b|CSSStyleSheet)/.test(element.getText()))
          || analysis.literals(call.arguments[0])?.some((value) => /[{}]/.test(value)))
        && stylesheetPlacement(call.arguments[0])) violations.push(`js stylesheet placement: ${member.name}`);
      if (member?.name === 'insertAdjacentHTML' && origins(call.arguments[1]).some(({ element }) => /<style\b/i.test(element.getText())) && stylesheetPlacement(call.arguments[1])) violations.push('js stylesheet placement: injected HTML');
      if (member && ['call', 'apply', 'bind'].includes(member.name) && /(?:insertRule|replaceSync|replace)$/.test(member.object.getText())) violations.push('js stylesheet placement: indirect stylesheet escape');
      if (member && ['append', 'appendChild', 'replaceChildren', 'insertAdjacentText'].includes(member.name) && styleElement(member.object)
        && call.arguments.some(stylesheetPlacement)) violations.push('js stylesheet placement: injected style text');
      if (member?.name === 'getAnimations' && chrome(member.object)) violations.push('js placement animation: getAnimations escape');
      if (member && ['bind', 'call', 'apply'].includes(member.name)
        && [member.object, ...call.arguments].some(chrome)) violations.push(`js chrome placement escape: ${member.name}`);
      if (['Object.assign', 'Reflect.set'].includes(name) && chrome(call.arguments[0]) && !styles(call.arguments[0]).length) violations.push(`js chrome placement escape: ${name} element sink`);
      // DOM reads, events and content updates do not author placement. Mutating
      // style/class/attribute/animation APIs are checked by their dedicated rules.
      const allowedReceiverMethods = new Set([
        'querySelector', 'querySelectorAll', 'getAttribute', 'hasAttribute', 'getBoundingClientRect',
        'getClientRects', 'contains', 'closest', 'cloneNode', 'getPropertyValue', 'getPropertyPriority',
        'addEventListener', 'removeEventListener', 'dispatchEvent', 'focus', 'blur',
        'append', 'appendChild', 'replaceChildren', 'after', 'before', 'remove', 'setAttribute', 'removeAttribute',
        'setProperty', 'animate', 'getAnimations', 'add', 'toggle', 'replace', 'item', 'toString',
      ]);
      if (member && chrome(member.object) && !analysis.functionsOf(call.expression).length
        && !allowedReceiverMethods.has(member.name)
        && !(['forEach', 'map', 'filter'].includes(member.name) && analysis.functionsOf(call.arguments[0]).length)) violations.push(`js chrome placement escape: unanalysed receiver ${member.name || 'dynamic method'}`);
      if (!analysis.functionsOf(call.expression).length && call.arguments.some(chrome)
        && !['Object.assign', 'Reflect.set'].includes(name)
        && !['animate', 'setAttribute', 'setProperty', 'call', 'apply', 'bind'].includes(member?.name)) {
        violations.push(`js chrome placement escape: unanalysed call ${name}`);
      }
    }
    if (member?.name === 'animate' && (owner || origins(member.object).some(analysis.relevant))
      && keyframePlacement(call.arguments[0])) violations.push('js placement animation');
  }
  return [...new Set(violations)];
}

export function jsPlacementViolations(source, { owner = true, css = '' } = {}) {
  if (!source.trim()) return [];
  const name = resolve('chrome.ts');
  const analysis = placementAnalysis(new Map([[name, source]]), css);
  return filePlacementViolations(analysis.files.get(name), analysis, owner);
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
  return [...violations, ...jsPlacementViolations(js, { ...options, css })];
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
  { name: 'js style alias', js: 'const placement=el.style;placement.top="0px";' },
  { name: 'js destructured style alias', js: 'const {style:placement}=el;placement.top="0px";' },
  { name: 'js assigned style alias', js: 'let placement;placement=el.style;placement.top="0px";' },
  { name: 'js destructuring assignment alias', js: 'let placement;({style:placement}=el);placement.top="0px";' },
  { name: 'js alias setProperty', js: 'const placement=el.style;placement.setProperty("top","0px");' },
  { name: 'js alias Object.assign', js: 'const placement=el.style;Object.assign(placement,{top:"0px"});' },
  { name: 'js alias cssText', js: 'const placement=el.style;placement.cssText="top:0px";' },
  { name: 'js alias slot writer', js: 'const {style:placement}=document.body;placement.setProperty("--slot-time-y","80px");' },
  { name: 'js destructured style method', js: 'const {style:{setProperty:put}}=el;put.call(el.style,"top","0px");' },
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
  const sources = new Map(files.map((file) => [file, overrides.get(relative(root, file)) ?? readFileSync(file, 'utf8')]));
  const analysis = placementAnalysis(new Map([...sources].filter(([file]) => !file.endsWith('.css'))), [...sources].filter(([file]) => file.endsWith('.css')).map(([, source]) => source).join('\n'));
  return files.flatMap((file) => {
    const name = relative(root, file);
    const source = sources.get(file);
    const owner = name === 'src/map-chrome.ts';
    const errors = name.endsWith('.css') ? ownerPlacementViolations(source)
      : [...filePlacementViolations(analysis.files.get(file), analysis, owner), ...(owner ? narrowPlacementViolations('', source) : [])];
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
