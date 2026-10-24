import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WEBKIT_PASSED_FLOOR = 249;

/** Vitest's fullName joins an empty file suite in front, so report names are trimmed before comparison. */
export const CORNER_LIFT_WEBKIT_CASES = [
  'map corner lift WebKit keeps Hide in the same place across five show/hide cycles at 402x874',
  'map corner lift WebKit lifts Hide for the wrapped banner before the next read on return to 402x874',
  'map corner lift WebKit keeps Hide still under a trusted tap that returns to 402x874 before any resize event',
  'map corner lift WebKit updates the corner lift when a late footer wraps and a trusted tap leaves Hide still',
  'map corner lift WebKit keeps Hide still when footer height changes and the trusted tap does not wait for a frame',
  'map corner lift WebKit keeps a fully scrolled Layers dock and a coordinate picker click through sync ticks at 1280x800',
  'map corner lift WebKit clears the corner lift in the same frame when the footer is removed',
  'map corner lift WebKit follows a replacement footer and ignores the detached one',
  'map corner lift WebKit schedules one sync when the detached footer is edited in the same task',
  'map corner lift WebKit does not publish the sync counter on a production page',
  'map corner lift WebKit schedules one sync for a footer mutation batch',
  'map corner lift WebKit drops the corner-lift observers on pagehide so a mutation writes nothing',
  'map corner lift WebKit lifts the corners again after a persisted pageshow',
  'map corner lift WebKit schedules one sync when footer style and text change in the same turn',
  'map corner lift WebKit schedules no sync for a text change on a footer that is not the watched one',
  'map corner lift WebKit keeps T+90 inside the 390x520 viewport when the time strip is visible',
] as const;

export const BROWSER_FILE_MINIMUMS: Readonly<Record<string, number>> = {
  'test/map-time-skip-safe-area.test.ts': 60,
  'test/pass-row-fit.test.ts': 54,
  'test/map-review-targets.test.ts': 28,
  'test/safe-area-layout.test.ts': 21,
  'test/map-corner-lift.test.ts': CORNER_LIFT_WEBKIT_CASES.length,
  'test/map-gesture-hold.test.ts': 15,
  'test/legacy-launch-card.test.ts': 10,
  'test/map-chrome-startup.test.ts': 6,
  'test/map-north-follow.test.ts': 7,
  'test/map-repin-safe-area.test.ts': 5,
  'test/map-chrome-idle.test.ts': 4,
  'test/map-picker-inspector-safe-area.test.ts': 4,
  'test/map-satellite-picker-safe-area.test.ts': 3,
  'test/map-bearing-retarget.test.ts': 2,
  'test/map-joint-panel-convergence.test.ts': 1,
  'test/close-browser.test.ts': 2,
  'test/cold-session-recovery.test.ts': 11,
};

export type WebKitFloorReport = {
  readonly passed: number;
  readonly skipped: number;
  readonly failed: number;
  readonly perFile: readonly { readonly file: string; readonly passed: number; readonly minimum: number }[];
  readonly reasons: readonly string[];
};

type Assertion = {
  readonly fullName: string;
  readonly status: string;
  readonly ancestorTitles: readonly string[];
};
type TestFile = { readonly name: string; readonly assertionResults: readonly Assertion[] };
type VitestReport = { readonly testResults: readonly TestFile[] };

const frontendRoot = import.meta.url.startsWith('file:')
  ? resolve(fileURLToPath(import.meta.url), '..', '..')
  : process.cwd();

const CORNER_LIFT_FILE = 'test/map-corner-lift.test.ts';

export function cornerLiftWebKitNameReason(names: readonly string[]): string | null {
  const expected = new Set<string>(CORNER_LIFT_WEBKIT_CASES);
  const actual = new Set(names.map((name) => name.trim()));
  if (actual.size === expected.size && [...expected].every((name) => actual.has(name))) return null;
  const missing = [...expected].filter((name) => !actual.has(name)).sort();
  const extra = [...actual].filter((name) => !expected.has(name)).sort();
  return `${CORNER_LIFT_FILE} webkit names missing ${missing.join(', ') || 'none'} extra ${extra.join(', ') || 'none'}`;
}

export function evaluateWebKitReports(reports: readonly unknown[]): WebKitFloorReport {
  const passedByFile = new Map<string, number>();
  for (const file of Object.keys(BROWSER_FILE_MINIMUMS)) passedByFile.set(file, 0);
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const cornerNames: string[] = [];
  let cornerSeen = false;
  let passed = 0;
  let skipped = 0;
  let failed = 0;
  for (const report of reports) {
    for (const testFile of vitestReport(report).testResults) {
      if (browserFile(testFile.name) === CORNER_LIFT_FILE) cornerSeen = true;
      for (const assertion of testFile.assertionResults) {
        const id = webKitCaseId(testFile.name, assertion);
        if (id === null) continue;
        const file = id.slice(0, id.indexOf('\0'));
        if (seen.has(id)) {
          duplicates.push(`duplicate webkit case ${file} ${assertion.fullName}`);
          continue;
        }
        seen.add(id);
        if (assertion.status === 'passed') {
          passed += 1;
          passedByFile.set(file, (passedByFile.get(file) ?? 0) + 1);
          if (file === CORNER_LIFT_FILE) cornerNames.push(assertion.fullName);
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
  reasons.push(...duplicates);
  if (cornerSeen) {
    const names = cornerLiftWebKitNameReason(cornerNames);
    if (names) reasons.push(names);
  }
  return { passed, skipped, failed, perFile, reasons };
}

export function loadWebKitReports(path: string): unknown[] {
  const stats = statSync(path);
  if (!stats.isDirectory()) return [JSON.parse(readFileSync(path, 'utf8')) as unknown];
  const files = jsonFiles(path);
  if (files.length === 0) throw new Error(`no vitest json reports in ${path}`);
  return files.map((file) => JSON.parse(readFileSync(file, 'utf8')) as unknown);
}

function jsonFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsonFiles(full));
    else if (entry.name.endsWith('.json')) found.push(full);
  }
  found.sort();
  return found;
}

function browserFile(name: string): string | null {
  const normalized = name.replaceAll('\\', '/');
  const candidates = [normalized];
  if (!normalized.startsWith('/')) {
    candidates.push(relative(frontendRoot, resolve(frontendRoot, normalized)).replaceAll('\\', '/'));
  }
  for (const candidate of candidates) {
    for (const file of Object.keys(BROWSER_FILE_MINIMUMS)) {
      if (candidate === file || candidate.endsWith(`/${file}`)) return file;
    }
  }
  return null;
}

export function webKitCaseId(fileName: string, assertion: Pick<Assertion, 'ancestorTitles' | 'fullName'>): string | null {
  const file = browserFile(fileName);
  if (file === null) return null;
  if (!assertion.ancestorTitles.some((title) => /(?:^|\s)WebKit(?:$|\s)/.test(title))) return null;
  return `${file}\0${assertion.fullName}`;
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
          const ancestorTitles = Array.isArray(row?.ancestorTitles)
            ? row.ancestorTitles.filter((title): title is string => typeof title === 'string')
            : [];
          return { fullName, status, ancestorTitles };
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
  let verdict: WebKitFloorReport;
  try {
    verdict = evaluateWebKitReports(loadWebKitReports(resolve(target)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`webkit floor: ${message.replace(/\s+/g, ' ').trim()}\n`);
    process.exit(1);
  }
  if (verdict.reasons.length > 0) {
    for (const reason of verdict.reasons) process.stderr.write(`${reason}\n`);
    process.exit(1);
  }
  process.stdout.write(`webkit floor ok: ${verdict.passed} passed\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
