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

/** The only modules allowed to name `maplibre-gl`. Everything else reaches
 *  the map through the module's exports, which is what keeps the 800 KB
 *  vendor chunk reachable from exactly one place. */
const VENDOR_IMPORTERS = ['map.ts', 'viirs-alpha-protocol.ts'];

export function vendorImportViolations(path: string, sourceText: string): string[] {
  if (VENDOR_IMPORTERS.includes(path)) return [];
  return importsOf(sourceText)
    .filter((entry) => isVendor(entry.specifier))
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

  it('only the map and the tile protocol name maplibre-gl', () => {
    const violations = files.flatMap((file) => vendorImportViolations(file.path, file.text));
    expect(violations).toEqual([]);
  });

  it('every allowed vendor importer still exists', () => {
    const present = files.map((file) => file.path);
    for (const allowed of VENDOR_IMPORTERS) expect(present).toContain(allowed);
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

  it('allows the vendor import from the modules on the list', () => {
    expect(vendorImportViolations('map.ts', "import maplibregl from 'maplibre-gl';")).toEqual([]);
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
});
