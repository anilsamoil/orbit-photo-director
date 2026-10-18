import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const includeRoots = ['test', join('src', 'map')];

export const SHARD_COUNT = 2;
export const UNSHARDED_WEBKIT_CASES = 190;
const DEFAULT_WEIGHT_SECONDS = 60;
const executedStatuses = new Set(['passed', 'failed']);

export type ShardPlan = {
  readonly files: readonly string[];
  readonly loadSeconds: number;
};

export type WebKitCount = {
  readonly cases: number;
  readonly files: readonly string[];
};

export type TimeReport = {
  readonly rssKb: number;
  readonly exit: number;
};

type JsonAssertion = {
  readonly fullName?: string;
  readonly status?: string;
};

type JsonFileResult = {
  readonly name?: string;
  readonly assertionResults?: readonly JsonAssertion[];
};

type JsonReport = {
  readonly testResults?: readonly JsonFileResult[];
};

export function discoverTestFiles(root = frontendRoot): string[] {
  const found: string[] = [];
  for (const start of includeRoots) walk(join(root, start), root, found);
  found.sort();
  return found;
}

export function loadWeights(root = frontendRoot): Readonly<Record<string, number>> {
  const raw: unknown = JSON.parse(readFileSync(join(root, 'scripts', 'frontend-shard-weights.json'), 'utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('frontend-shard-weights.json is not an object');
  }
  const weights: Record<string, number> = {};
  for (const [file, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`weight for ${file} is not a finite number`);
    }
    weights[file] = value;
  }
  return weights;
}

export function planShards(
  files: readonly string[],
  weights: Readonly<Record<string, number>>,
  shardCount = SHARD_COUNT,
  defaultWeight = DEFAULT_WEIGHT_SECONDS,
): ShardPlan[] {
  if (shardCount < 1) throw new Error('shard count must be at least 1');
  const ranked = [...files].sort((a, b) => {
    const delta = weightOf(b, weights, defaultWeight) - weightOf(a, weights, defaultWeight);
    if (delta !== 0) return delta;
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  const shards: { files: string[]; loadSeconds: number }[] = Array.from({ length: shardCount }, () => ({
    files: [],
    loadSeconds: 0,
  }));
  for (const file of ranked) {
    let chosen = 0;
    for (let index = 1; index < shards.length; index += 1) {
      const load = shards[index]?.loadSeconds ?? Number.POSITIVE_INFINITY;
      const best = shards[chosen]?.loadSeconds ?? Number.POSITIVE_INFINITY;
      if (load < best) chosen = index;
    }
    const shard = shards[chosen];
    if (!shard) throw new Error('shard plan has no bins');
    shard.files.push(file);
    shard.loadSeconds += weightOf(file, weights, defaultWeight);
  }
  return shards;
}

export function assertPartition(files: readonly string[], shards: readonly ShardPlan[]): void {
  const seen = new Set<string>();
  for (const shard of shards) {
    for (const file of shard.files) {
      if (seen.has(file)) throw new Error(`test file assigned twice: ${file}`);
      seen.add(file);
    }
  }
  const missing = files.filter((file) => !seen.has(file));
  if (missing.length > 0) throw new Error(`test files missing from shards: ${missing.join(', ')}`);
  const known = new Set(files);
  const extra = [...seen].filter((file) => !known.has(file));
  if (extra.length > 0) throw new Error(`shard assigned unknown test files: ${extra.join(', ')}`);
}

export function importsPlaywrightWebKit(file: string, root = frontendRoot): boolean {
  const source = readFileSync(join(root, file), 'utf8');
  return /import\s*\{[^}]*\bwebkit\b[^}]*\}\s*from\s*['"]playwright['"]/.test(source);
}

export function countWebKitCases(
  reports: readonly JsonReport[],
  importsWebKit: (file: string) => boolean,
): WebKitCount {
  let cases = 0;
  const files = new Set<string>();
  for (const report of reports) {
    for (const result of report.testResults ?? []) {
      const file = frontendRelative(result.name ?? '');
      files.add(file);
      if (!importsWebKit(file)) continue;
      for (const assertion of result.assertionResults ?? []) {
        if (!executedStatuses.has(assertion.status ?? '')) continue;
        if (!(assertion.fullName ?? '').includes('WebKit')) continue;
        cases += 1;
      }
    }
  }
  return { cases, files: [...files].sort() };
}

export function assertExecutedFiles(discovered: readonly string[], executed: readonly string[]): void {
  const ran = new Set(executed);
  const missing = discovered.filter((file) => !ran.has(file));
  const known = new Set(discovered);
  const extra = executed.filter((file) => !known.has(file));
  if (missing.length > 0) throw new Error(`test files not executed: ${missing.join(', ')}`);
  if (extra.length > 0) throw new Error(`executed files outside the suite: ${extra.join(', ')}`);
}

export function assertWebKitFloor(cases: number, floor = UNSHARDED_WEBKIT_CASES): void {
  if (cases < floor) {
    throw new Error(`executed WebKit cases ${cases} below unsharded count ${floor}`);
  }
}

export function readTimeReport(text: string, label: string): TimeReport {
  const rss = /Maximum resident set size \(kbytes\): (\d+)/.exec(text);
  const exit = /Exit status: (\d+)/.exec(text);
  if (!rss?.[1] || !exit?.[1]) throw new Error(`${label} time report is incomplete`);
  const code = Number(exit[1]);
  if (code === 137 || code === 143) throw new Error(`${label} was killed with exit ${code}`);
  return { rssKb: Number(rss[1]), exit: code };
}

function weightOf(file: string, weights: Readonly<Record<string, number>>, fallback: number): number {
  return weights[file] ?? fallback;
}

function walk(dir: string, root: string, found: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, root, found);
    else if (entry.name.endsWith('.test.ts')) found.push(relative(root, full).split(sep).join('/'));
  }
}

function frontendRelative(name: string): string {
  const normalized = name.replaceAll('\\', '/');
  const marker = '/frontend/';
  const at = normalized.lastIndexOf(marker);
  if (at !== -1) return normalized.slice(at + marker.length);
  if (normalized.startsWith('frontend/')) return normalized.slice('frontend/'.length);
  return normalized;
}

function unweightedFiles(files: readonly string[], weights: Readonly<Record<string, number>>): string[] {
  return files.filter((file) => weights[file] == null);
}

function readReport(path: string): JsonReport {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw !== 'object' || raw === null) throw new Error(`${path} is not a vitest json report`);
  return raw as JsonReport;
}

function collectReports(path: string): { reports: JsonReport[]; timePaths: string[] } {
  if (statSync(path).isFile()) return { reports: [readReport(path)], timePaths: [] };
  const reportPaths: string[] = [];
  const timePaths: string[] = [];
  walkArtifacts(path, reportPaths, timePaths);
  reportPaths.sort();
  timePaths.sort();
  if (reportPaths.length !== SHARD_COUNT) {
    throw new Error(`expected ${SHARD_COUNT} shard reports, found ${reportPaths.length}`);
  }
  return { reports: reportPaths.map(readReport), timePaths };
}

function walkArtifacts(dir: string, reports: string[], times: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkArtifacts(full, reports, times);
    else if (/^shard-\d+-results\.json$/.test(entry.name)) reports.push(full);
    else if (/^shard-\d+-time\.txt$/.test(entry.name)) times.push(full);
  }
}

function printCheck(root: string): void {
  const files = discoverTestFiles(root);
  const weights = loadWeights(root);
  const shards = planShards(files, weights);
  assertPartition(files, shards);
  const missing = unweightedFiles(files, weights);
  if (missing.length > 0) {
    process.stderr.write(`default weight for ${missing.length} file(s): ${missing.join(', ')}\n`);
  }
  shards.forEach((shard, index) => {
    process.stdout.write(`shard ${index + 1}: ${shard.files.length} files, ${shard.loadSeconds.toFixed(1)}s\n`);
  });
  process.stdout.write(`shard check ok: ${files.length} files, ${SHARD_COUNT} shards\n`);
}

function printShard(spec: string, root: string): void {
  const match = /^(\d+)\/(\d+)$/.exec(spec);
  if (!match?.[1] || !match[2]) throw new Error(`shard spec must look like 1/${SHARD_COUNT}`);
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count !== SHARD_COUNT || index < 1 || index > count) {
    throw new Error(`shard ${spec} does not match shard count ${SHARD_COUNT}`);
  }
  const files = discoverTestFiles(root);
  const shards = planShards(files, loadWeights(root), count);
  assertPartition(files, shards);
  const shard = shards[index - 1];
  if (!shard || shard.files.length === 0) throw new Error(`shard ${spec} is empty`);
  for (const file of shard.files) process.stdout.write(`${file}\n`);
}

function printWebKitCount(path: string, shardLog: boolean, root: string): void {
  const { reports, timePaths } = collectReports(path);
  const counted = countWebKitCases(reports, (file) => importsPlaywrightWebKit(file, root));
  process.stdout.write(`webkit cases ${counted.cases}\n`);
  if (shardLog) return;
  assertExecutedFiles(discoverTestFiles(root), counted.files);
  assertWebKitFloor(counted.cases);
  if (timePaths.length !== SHARD_COUNT) {
    throw new Error(`expected ${SHARD_COUNT} time reports, found ${timePaths.length}`);
  }
  for (const timePath of timePaths) {
    const report = readTimeReport(readFileSync(timePath, 'utf8'), timePath);
    process.stdout.write(`${timePath} rss_kb ${report.rssKb} exit ${report.exit}\n`);
  }
  process.stdout.write(`webkit floor ok: ${counted.cases} >= ${UNSHARDED_WEBKIT_CASES}\n`);
}

function main(): void {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === '--check') {
    printCheck(frontendRoot);
    return;
  }
  if (command === '--shard' && args[1]) {
    printShard(args[1], frontendRoot);
    return;
  }
  if (command === '--webkit-count' && args[1]) {
    printWebKitCount(args[1], args.includes('--shard-log'), frontendRoot);
    return;
  }
  throw new Error('usage: frontend-shards.ts --check | --shard <index>/<count> | --webkit-count <report-or-dir> [--shard-log]');
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
