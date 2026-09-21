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
});
