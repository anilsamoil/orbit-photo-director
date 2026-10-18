import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WEBKIT_PASSED_FLOOR = 190;

export const BROWSER_FILE_MINIMUMS: Readonly<Record<string, number>> = {
  'test/map-time-skip-safe-area.test.ts': 60,
  'test/pass-row-fit.test.ts': 54,
  'test/map-review-targets.test.ts': 28,
  'test/safe-area-layout.test.ts': 20,
  'test/map-corner-lift.test.ts': 7,
  'test/map-chrome-startup.test.ts': 6,
  'test/map-repin-safe-area.test.ts': 5,
  'test/map-chrome-idle.test.ts': 4,
  'test/map-picker-inspector-safe-area.test.ts': 4,
  'test/map-satellite-picker-safe-area.test.ts': 3,
  'test/map-bearing-retarget.test.ts': 1,
  'test/map-joint-panel-convergence.test.ts': 1,
};

export type WebKitFloorReport = {
  readonly passed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly perFile: readonly { readonly file: string; readonly passed: number; readonly minimum: number }[];
  readonly reasons: readonly string[];
};

type Assertion = { readonly fullName: string; readonly status: string };
type TestFile = { readonly name: string; readonly assertionResults: readonly Assertion[] };
type VitestReport = { readonly testResults: readonly TestFile[] };

export function evaluateWebKitReports(reports: readonly unknown[]): WebKitFloorReport {
  const passedByFile = new Map<string, number>();
  for (const file of Object.keys(BROWSER_FILE_MINIMUMS)) passedByFile.set(file, 0);
  let passed = 0;
  let skipped = 0;
  let failed = 0;
  for (const report of reports) {
    for (const testFile of vitestReport(report).testResults) {
      const file = browserFile(testFile.name);
      if (file === null) continue;
      for (const assertion of testFile.assertionResults) {
        if (!assertion.fullName.includes('WebKit')) continue;
        if (assertion.status === 'passed') {
          passed += 1;
          passedByFile.set(file, (passedByFile.get(file) ?? 0) + 1);
        } else if (assertion.status === 'failed') {
          failed += 1;
        } else {
          skipped += 1;
        }
      }
    }
  }
  const perFile = Object.entries(BROWSER_FILE_MINIMUMS).map(([file, minimum]) => ({
    file,
    passed: passedByFile.get(file) ?? 0,
    minimum,
  }));
  const reasons: string[] = [];
  if (passed < WEBKIT_PASSED_FLOOR) reasons.push(`webkit passed ${passed} below floor ${WEBKIT_PASSED_FLOOR}`);
  if (skipped !== 0) reasons.push(`webkit skipped ${skipped}`);
  if (failed !== 0) reasons.push(`webkit failed ${failed}`);
  for (const row of perFile) {
    if (row.passed < row.minimum) reasons.push(`${row.file} passed ${row.passed} below minimum ${row.minimum}`);
  }
  return { passed, skipped, failed, perFile, reasons };
}

export function loadWebKitReports(path: string): unknown[] {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    const files = readdirSync(path).filter((name) => name.endsWith('.json')).sort();
    if (files.length === 0) throw new Error(`no vitest json reports in ${path}`);
    return files.map((name) => JSON.parse(readFileSync(resolve(path, name), 'utf8')) as unknown);
  }
  return [JSON.parse(readFileSync(path, 'utf8')) as unknown];
}

function browserFile(name: string): string | null {
  const normalized = name.replaceAll('\\', '/');
  for (const file of Object.keys(BROWSER_FILE_MINIMUMS)) {
    if (normalized.endsWith(file)) return file;
  }
  return null;
}

function vitestReport(value: unknown): VitestReport {
  const report = record(value);
  const results = report?.testResults;
  if (!Array.isArray(results)) throw new Error('vitest report is missing testResults');
  return {
    testResults: results.map((entry) => {
      const testFile = record(entry);
      const name = testFile?.name;
      const assertionResults = testFile?.assertionResults;
      if (typeof name !== 'string' || !Array.isArray(assertionResults)) throw new Error('vitest report has a test result without assertionResults');
      return {
        name,
        assertionResults: assertionResults.map((assertion) => {
          const row = record(assertion);
          const fullName = row?.fullName;
          const status = row?.status;
          if (typeof fullName !== 'string' || typeof status !== 'string') throw new Error('vitest assertion is missing fullName or status');
          return { fullName, status };
        }),
      };
    }),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value));
}

function main(): void {
  const target = process.argv[2];
  if (target === undefined) {
    process.stderr.write('usage: webkit-floor.ts <vitest-json-or-directory>\n');
    process.exit(2);
  }
  const verdict = evaluateWebKitReports(loadWebKitReports(resolve(target)));
  if (verdict.reasons.length > 0) {
    for (const reason of verdict.reasons) process.stderr.write(`${reason}\n`);
    process.exit(1);
  }
  process.stdout.write(`webkit floor ok: ${verdict.passed} passed\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
