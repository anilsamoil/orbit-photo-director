/** The import rules that keep the map's boundaries. These are the rules a
 *  reviewer used to have to remember, so they are a test instead.
 *
 *  Each rule is a pure function over one file's text, which lets the last
 *  describe block feed it a violating snippet and prove the rule can fail.
 *  A boundary check that cannot fail is worse than no check, because it
 *  reads like protection. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

import { PREF_KEYS } from '../src/map/map-core/prefs';

const SRC = resolve(__dirname, '../src');

export type Import = { specifier: string; dynamic: boolean };

/** Every module specifier the file imports, static and dynamic, including
 *  re-exports and `typeof import(...)` type positions. */
export function importsOf(sourceText: string): Import[] {
  const parsed = ts.createSourceFile('probe.ts', sourceText, ts.ScriptTarget.ES2022, true);
  const found: Import[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) found.push({ specifier: spec.text, dynamic: false });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteral(arg)) found.push({ specifier: arg.text, dynamic: true });
    } else if (ts.isImportTypeNode(node)) {
      const arg = node.argument;
      if (ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal)) {
        found.push({ specifier: arg.literal.text, dynamic: true });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(parsed);
  return found;
}

function isVendor(specifier: string): boolean {
  return specifier === 'maplibre-gl' || specifier.startsWith('maplibre-gl/');
}

const ADAPTER_DIR = 'map/adapters/maplibre/';
const LEGACY_MAP = 'map.ts';
const COMPOSITION_ROOT = 'map/index.ts';

/** Only the adapter names `maplibre-gl`, plus the legacy module until it is
 *  gone. Everything else reaches the map through domain types, which is what
 *  keeps the 800 KB vendor chunk reachable from exactly one place. */
function mayImportVendor(path: string): boolean {
  return path === LEGACY_MAP || path.startsWith(ADAPTER_DIR);
}

export function vendorImportViolations(path: string, sourceText: string): string[] {
  if (mayImportVendor(path)) return [];
  return importsOf(sourceText)
    .filter((entry) => isVendor(entry.specifier))
    .map((entry) => `${path} imports ${entry.specifier}`);
}

/** An adapter is wired in once, by the composition root. A feature or
 *  map-core module that imports one has reached past the facade to the
 *  vendor, and the legacy module is the composition root until it is
 *  deleted. */
export function adapterImportViolations(path: string, sourceText: string): string[] {
  if (path === LEGACY_MAP || path === COMPOSITION_ROOT || path.startsWith(ADAPTER_DIR)) return [];
  return importsOf(sourceText)
    .filter((entry) => /(^|\/)adapters\//.test(entry.specifier))
    .map((entry) => `${path} imports ${entry.specifier}`);
}

function isMapEntry(specifier: string): boolean {
  return specifier === './map' || specifier === './map/index';
}

/** `main.ts` reaches the map with `await import('./map')` so MapLibre stays
 *  out of the app shell. A static import anywhere in `src/` would fold the
 *  vendor chunk back into the entry bundle and slow first paint for the
 *  four tabs that never open the map. `typeof import('./map')` is a type
 *  position and erases, so it stays allowed. */
export function eagerMapImportViolations(path: string, sourceText: string): string[] {
  return importsOf(sourceText)
    .filter((entry) => !entry.dynamic && isMapEntry(entry.specifier))
    .map((entry) => `${path} statically imports ${entry.specifier}`);
}

/** map-core owns the instance, the catalog, the camera and the clocks. It
 *  may not know which features exist, may not reach the vendor, and may not
 *  lean on the legacy module it is replacing. */
export function mapCoreImportViolations(path: string, sourceText: string): string[] {
  if (!path.startsWith('map/map-core/')) return [];
  return importsOf(sourceText)
    .filter(
      (entry) =>
        isVendor(entry.specifier) ||
        /(^|\/)features\//.test(entry.specifier) ||
        /(^|\/)adapters\//.test(entry.specifier) ||
        /^\.\.\/\.\.\/map$/.test(entry.specifier),
    )
    .map((entry) => `${path} imports ${entry.specifier}`);
}

/** Module-level `let` and `var` are the hidden state that made map.ts hard
 *  to test: 55 of them with no teardown. Under src/map/ the only mutable
 *  module state allowed is the composition root's one `let core`. */
export function moduleStateViolations(path: string, sourceText: string): string[] {
  if (!path.startsWith('map/') || path === 'map/index.ts') return [];
  const parsed = ts.createSourceFile('probe.ts', sourceText, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  for (const statement of parsed.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const flags = statement.declarationList.flags;
    if (flags & ts.NodeFlags.Const) continue;
    for (const declaration of statement.declarationList.declarations) {
      out.push(`${path} declares module-level ${flags & ts.NodeFlags.Let ? 'let' : 'var'} ${declaration.name.getText()}`);
    }
  }
  return out;
}

const ESCAPE_HATCHES = ['as any', '@ts-ignore', '@ts-expect-error', '@ts-nocheck', 'eslint-disable', 'TODO', 'FIXME'];

/** Under src/map/ the types are the contract. An escape hatch there is a
 *  place the contract stopped holding, and a TODO is a decision deferred to
 *  a reader who will not have the context. */
export function escapeHatchViolations(path: string, sourceText: string): string[] {
  if (!path.startsWith('map/')) return [];
  return ESCAPE_HATCHES.filter((hatch) => sourceText.includes(hatch)).map((hatch) => `${path} contains ${hatch}`);
}

const PREFS = 'map/map-core/prefs.ts';
const STORAGE_OBJECTS = new Set(['localStorage', 'sessionStorage']);
const STORAGE_METHODS = new Set(['getItem', 'setItem', 'removeItem']);

function isIdentifierNamed(node: ts.Node, name: string): boolean {
  return ts.isIdentifier(node) && node.text === name;
}

function isStorage(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return STORAGE_OBJECTS.has(node.text);
  return ts.isPropertyAccessExpression(node) && isIdentifierNamed(node.expression, 'window') && STORAGE_OBJECTS.has(node.name.text);
}

/** Under src/map/ a storage key is a `PREF_KEYS` entry and nothing else, so
 *  one file lists what the map persists and two features cannot share a key
 *  by accident. The literal and the call are both flagged, because a key
 *  can reach a call through a local constant. */
export function prefKeyViolations(path: string, sourceText: string): string[] {
  if (!path.startsWith('map/') || path === PREFS) return [];
  const parsed = ts.createSourceFile('probe.ts', sourceText, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && /^opd[-_]/.test(node.text)) {
      out.push(`${path} holds the storage key literal '${node.text}'`);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isStorage(node.expression.expression) &&
      STORAGE_METHODS.has(node.expression.name.text)
    ) {
      const [key] = node.arguments;
      const fromTable = key !== undefined && ts.isPropertyAccessExpression(key) && isIdentifierNamed(key.expression, 'PREF_KEYS');
      if (!fromTable) out.push(`${path} calls ${node.expression.getText()} with a key that is not a PREF_KEYS entry`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return out;
}

/** The `PREF_KEYS` entries a file reads. */
export function prefKeyReferences(sourceText: string): string[] {
  const parsed = ts.createSourceFile('probe.ts', sourceText, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isIdentifierNamed(node.expression, 'PREF_KEYS')) out.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return out;
}

function sourceFiles(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts')) out.push({ path: relative(SRC, full), text: readFileSync(full, 'utf-8') });
    }
  };
  walk(SRC);
  return out;
}

describe('import boundaries in frontend/src', () => {
  const files = sourceFiles();

  it('finds the source tree', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('only the adapter and the legacy map module name maplibre-gl', () => {
    const violations = files.flatMap((file) => vendorImportViolations(file.path, file.text));
    expect(violations).toEqual([]);
  });

  it('the adapter directory exists and does name the vendor', () => {
    const adapter = files.filter((file) => file.path.startsWith(ADAPTER_DIR));
    expect(adapter.length).toBeGreaterThan(0);
    expect(adapter.some((file) => importsOf(file.text).some((entry) => isVendor(entry.specifier)))).toBe(true);
  });

  it('adapters are imported only by the composition root', () => {
    const violations = files.flatMap((file) => adapterImportViolations(file.path, file.text));
    expect(violations).toEqual([]);
  });

  it('nothing statically imports the map entry', () => {
    const violations = files.flatMap((file) => eagerMapImportViolations(file.path, file.text));
    expect(violations).toEqual([]);
  });

  it('main.ts still reaches the map dynamically', () => {
    const main = files.find((file) => file.path === 'main.ts');
    expect(main).toBeDefined();
    const dynamic = importsOf(main?.text ?? '').filter((entry) => entry.dynamic && isMapEntry(entry.specifier));
    expect(dynamic.length).toBeGreaterThan(0);
  });

  it('map-core imports no feature, no adapter, no vendor and not the legacy map module', () => {
    const violations = files.flatMap((file) => mapCoreImportViolations(file.path, file.text));
    expect(violations).toEqual([]);
  });

  it('nothing under src/map/ holds module-level mutable state except the composition root', () => {
    const violations = files.flatMap((file) => moduleStateViolations(file.path, file.text));
    expect(violations).toEqual([]);
  });

  it('nothing under src/map/ carries an escape hatch or a deferred decision', () => {
    const violations = files.flatMap((file) => escapeHatchViolations(file.path, file.text));
    expect(violations).toEqual([]);
  });

  it('the rules above are running against real files under src/map/', () => {
    expect(files.some((file) => file.path.startsWith('map/map-core/'))).toBe(true);
  });
});

describe('the storage key table', () => {
  const files = sourceFiles();
  const production = files.filter((file) => file.path.startsWith('map/') && !file.path.endsWith('.test.ts'));

  it('is the only place under src/map/ that names a key, and every storage call reads one from it', () => {
    const violations = files.flatMap((file) => prefKeyViolations(file.path, file.text));
    expect(violations).toEqual([]);
  });

  it('holds distinct opd- keys', () => {
    const values = Object.values(PREF_KEYS);
    expect(new Set(values).size).toBe(values.length);
    for (const value of values) expect(value).toMatch(/^opd-/);
  });

  it('has no entry that nothing under src/map/ reads', () => {
    const used = new Set(production.flatMap((file) => prefKeyReferences(file.text)));
    expect(Object.keys(PREF_KEYS).filter((key) => !used.has(key))).toEqual([]);
  });
});

describe('the boundary rules can fail', () => {
  it('flags a vendor import from a module that is not allowed one', () => {
    expect(vendorImportViolations('banner.ts', "import maplibregl from 'maplibre-gl';")).toEqual([
      'banner.ts imports maplibre-gl',
    ]);
  });

  it('flags a vendor CSS side-effect import too', () => {
    expect(vendorImportViolations('banner.ts', "import 'maplibre-gl/dist/maplibre-gl.css';")).toEqual([
      'banner.ts imports maplibre-gl/dist/maplibre-gl.css',
    ]);
  });

  it('flags a vendor import reached through a re-export', () => {
    expect(vendorImportViolations('banner.ts', "export { Map } from 'maplibre-gl';")).toEqual([
      'banner.ts imports maplibre-gl',
    ]);
  });

  it('allows the vendor import from the adapter and the legacy module', () => {
    expect(vendorImportViolations('map.ts', "import maplibregl from 'maplibre-gl';")).toEqual([]);
    expect(vendorImportViolations('map/adapters/maplibre/index.ts', "import maplibregl from 'maplibre-gl';")).toEqual([]);
  });

  it('flags an adapter import from a feature or map-core and allows it from the root', () => {
    const text = "import { createVendorMap } from '../../adapters/maplibre';";
    expect(adapterImportViolations('map/features/pin-drop/index.ts', text)).toEqual([
      'map/features/pin-drop/index.ts imports ../../adapters/maplibre',
    ]);
    expect(adapterImportViolations('map/index.ts', "import { createVendorMap } from './adapters/maplibre';")).toEqual([]);
    expect(adapterImportViolations('map.ts', "import { x } from './map/adapters/maplibre/viirs-alpha';")).toEqual([]);
    expect(adapterImportViolations('map/adapters/maplibre/index.ts', "import { x } from './viirs-alpha';")).toEqual([]);
  });

  it('flags a static import of the map entry', () => {
    expect(eagerMapImportViolations('main.ts', "import { renderMap } from './map';")).toEqual([
      'main.ts statically imports ./map',
    ]);
  });

  it('allows the dynamic import and the type-only reference', () => {
    const dynamic = "const m = await import('./map');\nlet held: typeof import('./map') | null = null;";
    expect(eagerMapImportViolations('main.ts', dynamic)).toEqual([]);
  });

  it('flags map-core reaching a feature, an adapter, the vendor, or the legacy module', () => {
    const text = [
      "import { pinDrop } from '../features/pin-drop';",
      "import { createVendorMap } from '../adapters/maplibre';",
      "import maplibregl from 'maplibre-gl';",
      "import { renderMap } from '../../map';",
    ].join('\n');
    expect(mapCoreImportViolations('map/map-core/core.ts', text)).toEqual([
      'map/map-core/core.ts imports ../features/pin-drop',
      'map/map-core/core.ts imports ../adapters/maplibre',
      'map/map-core/core.ts imports maplibre-gl',
      'map/map-core/core.ts imports ../../map',
    ]);
  });

  it('lets map-core import domain leaves and its own siblings', () => {
    const text = "import { wrapLon } from '../../geo';\nimport { LAYER_ORDER } from './catalog';";
    expect(mapCoreImportViolations('map/map-core/core.ts', text)).toEqual([]);
  });

  it('flags a module-level let or var under src/map/ and allows const', () => {
    const text = 'let map = null;\nvar bound = false;\nconst KEY = "x";\nfunction f() { let local = 1; return local; }';
    expect(moduleStateViolations('map/features/x/state.ts', text)).toEqual([
      'map/features/x/state.ts declares module-level let map',
      'map/features/x/state.ts declares module-level var bound',
    ]);
    expect(moduleStateViolations('map/index.ts', text)).toEqual([]);
    expect(moduleStateViolations('main.ts', text)).toEqual([]);
  });

  it('flags every escape hatch under src/map/ and ignores them elsewhere', () => {
    const text = 'const x = y as any; // TODO later\n// @ts-ignore\n';
    expect(escapeHatchViolations('map/map-core/core.ts', text)).toEqual([
      'map/map-core/core.ts contains as any',
      'map/map-core/core.ts contains @ts-ignore',
      'map/map-core/core.ts contains TODO',
    ]);
    expect(escapeHatchViolations('main.ts', text)).toEqual([]);
  });

  it('flags a storage key literal and an off-table storage call under src/map/, and allows the table and the rest of src/', () => {
    const text = [
      "const KEY = 'opd-map-x';",
      "localStorage.setItem(KEY, '1');",
      'window.localStorage.getItem(PREF_KEYS.x);',
      'sessionStorage.removeItem(`opd_y`);',
      'localStorage.clear();',
    ].join('\n');
    expect(prefKeyViolations('map/features/x/index.ts', text)).toEqual([
      "map/features/x/index.ts holds the storage key literal 'opd-map-x'",
      'map/features/x/index.ts calls localStorage.setItem with a key that is not a PREF_KEYS entry',
      'map/features/x/index.ts calls sessionStorage.removeItem with a key that is not a PREF_KEYS entry',
      "map/features/x/index.ts holds the storage key literal 'opd_y'",
    ]);
    expect(prefKeyViolations('map/map-core/prefs.ts', text)).toEqual([]);
    expect(prefKeyViolations('sort-pref.ts', text)).toEqual([]);
  });

  it('reads the PREF_KEYS entries a file touches', () => {
    expect(prefKeyReferences('localStorage.getItem(PREF_KEYS.a); const k = PREF_KEYS.b; other.c;')).toEqual(['a', 'b']);
  });
});
