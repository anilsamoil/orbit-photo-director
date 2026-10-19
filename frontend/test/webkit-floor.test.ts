import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverTestFiles } from '../scripts/frontend-shards';
import { BROWSER_FILE_MINIMUMS, WEBKIT_PASSED_FLOOR, evaluateWebKitReports, loadWebKitReports } from '../scripts/webkit-floor';

const root = resolve(__dirname, '..');
const webKitCases = Object.values(BROWSER_FILE_MINIMUMS).reduce((sum, count) => sum + count, 0);

const WEBKIT_DESCRIBE: Readonly<Record<string, string>> = {
  'test/map-time-skip-safe-area.test.ts': 'trusted time controls WebKit',
  'test/pass-row-fit.test.ts': 'WebKit rendered pin pass row',
  'test/map-review-targets.test.ts': 'supported review regressions WebKit',
  'test/safe-area-layout.test.ts': 'safe-area painted layout WebKit',
  'test/map-corner-lift.test.ts': 'map corner lift WebKit',
  'test/legacy-launch-card.test.ts': 'pin inspector over a legacy launch card WebKit',
  'test/map-chrome-startup.test.ts': 'supported safe-area startup WebKit',
  'test/map-repin-safe-area.test.ts': 'trusted centered re-pin WebKit',
  'test/map-chrome-idle.test.ts': 'map chrome tab lifecycle WebKit',
  'test/map-picker-inspector-safe-area.test.ts': 'picker inspector safe insets WebKit',
  'test/map-satellite-picker-safe-area.test.ts': 'trusted satellite picker WebKit',
  'test/map-bearing-retarget.test.ts': 'bearing retarget WebKit',
  'test/map-joint-panel-convergence.test.ts': 'joint panel convergence WebKit',
};

function cases(count: number, status: string, label: string): { ancestorTitles: string[]; fullName: string; status: string }[] {
  const suite = WEBKIT_DESCRIBE[label] ?? 'WebKit';
  return Array.from({ length: count }, (_, index) => ({
    ancestorTitles: [suite],
    fullName: `${suite} case ${index}`,
    status,
  }));
}

function halfMinimums(): Record<string, number> {
  return Object.fromEntries(Object.entries(BROWSER_FILE_MINIMUMS).map(([file, minimum]) => [file, Math.ceil(minimum / 2)]));
}

function duplicateAssertions(report: { testResults: { assertionResults: unknown[] }[] }): unknown {
  return {
    ...report,
    testResults: report.testResults.map((file) => ({
      ...file,
      assertionResults: [...file.assertionResults, ...file.assertionResults],
    })),
  };
}

function relativeNames(report: { testResults: { name: string }[] }): unknown {
  return {
    ...report,
    testResults: report.testResults.map((file) => ({
      ...file,
      name: file.name.replace('/workspace/frontend/', ''),
    })),
  };
}

function browserReport(statusFor: (file: string, index: number) => string, counts = BROWSER_FILE_MINIMUMS): unknown {
  return {
    numPassedTests: 2825,
    success: true,
    testResults: Object.entries(counts).map(([file, count]) => ({
      name: `/workspace/frontend/${file}`,
      numPassedTests: count,
      assertionResults: cases(count, 'passed', file).map((assertion, index) => ({ ...assertion, status: statusFor(file, index) })),
    })),
  };
}

function runCliOn(file: string): { status: number; stdout: string; stderr: string } {
  const args = process.execPath.endsWith('bun') ? [join(root, 'scripts/webkit-floor.ts'), file] : ['--experimental-strip-types', join(root, 'scripts/webkit-floor.ts'), file];
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, CI: 'true', NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failed.status ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

function runCli(report: unknown): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'webkit-floor-'));
  const file = join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(report));
  return runCliOn(file);
}

function workflowText(): string {
  return readFileSync(resolve(root, '../.github/workflows/test.yml'), 'utf8');
}

function runBlock(workflow: string, stepName: string): string {
  const nameAt = workflow.indexOf(`name: ${stepName}\n`);
  if (nameAt < 0) throw new Error(`missing step ${stepName}`);
  const runAt = workflow.indexOf('run: |\n', nameAt);
  if (runAt < 0) throw new Error(`missing run block for ${stepName}`);
  const nextAt = workflow.indexOf('\n      - ', runAt + 1);
  const end = nextAt < 0 ? workflow.length : nextAt;
  return workflow.slice(runAt + 'run: |\n'.length, end).replace(/^ {10}/gm, '').trimEnd();
}

function bash(script: string, cwd: string, env: Readonly<Record<string, string>> = {}): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        PATH: `${process.env.HOME ?? ''}/.bun/bin:${process.env.PATH ?? ''}`,
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failed.status ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

function shardShell(status: number): string {
  const script = runBlock(workflowText(), 'Test shard')
    .replaceAll('${{ matrix.shard }}', '1')
    .replaceAll('${{ strategy.job-total }}', '2');
  const vitest = /\/usr\/bin\/time -v -o "shard-1-time\.txt" \\\n\s*bun run test[\s\S]*?"\$\{files\[@\]\}"/;
  if (!vitest.test(script)) throw new Error('shard vitest command missing');
  return script.replace(vitest, [
    `printf '%s\\n' 'not json' > "shard-1-results.json"`,
    `printf '%s\\n' 'Maximum resident set size (kbytes): 10' 'Exit status: ${status}' > "shard-1-time.txt"`,
    `(exit ${status})`,
  ].join('\n'));
}

function writeShardReports(dir: string): void {
  const report = browserReport(() => 'passed') as { testResults: { name: string; assertionResults: unknown[] }[] };
  const casesByFile = new Map(report.testResults.map((file) => {
    const key = file.name.slice(file.name.indexOf('test/'));
    return [key, file.assertionResults] as const;
  }));
  const shards: { name: string; assertionResults: unknown[] }[][] = [[], []];
  discoverTestFiles().forEach((file, index) => {
    shards[index % 2]?.push({
      name: `/workspace/frontend/${file}`,
      assertionResults: casesByFile.get(file) ?? [],
    });
  });
  shards.forEach((testResults, index) => {
    const id = index + 1;
    writeFileSync(join(dir, `shard-${id}-results.json`), JSON.stringify({ testResults }));
    writeFileSync(join(dir, `shard-${id}-time.txt`), 'Maximum resident set size (kbytes): 10\nExit status: 0\n');
  });
}

function exprTrue(expression: string, shardResult: string, workflowCancelled: boolean): boolean {
  const js = expression
    .replaceAll('always()', 'true')
    .replaceAll('cancelled()', workflowCancelled ? 'true' : 'false')
    .replaceAll('needs.frontend-shard.result', JSON.stringify(shardResult));
  if (!/^[\sA-Za-z0-9_'"!=&|()!.-]+$/.test(js)) throw new Error(`unsupported workflow expression ${js}`);
  try {
    execFileSync(process.execPath, ['-e', `process.exit((${js}) ? 0 : 1)`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function frontendVerdict(shardResult: string, workflowCancelled: boolean): 'failure' | 'skipped' | 'success' {
  const job = workflowText().slice(workflowText().indexOf('\n  frontend:\n') + 1);
  const jobIf = /^    if: (.+)$/m.exec(job)?.[1]?.trim();
  if (!jobIf) throw new Error('Frontend job has no if');
  if (!exprTrue(jobIf, shardResult, workflowCancelled)) return 'skipped';
  const gate = /        if: (.+)\n        run: (?!\|)(.+)\n/.exec(job);
  if (!gate?.[1] || !gate[2]) throw new Error('missing shard fail step');
  if (!exprTrue(gate[1].trim(), shardResult, workflowCancelled)) return 'success';
  return bash(gate[2].trim(), root).status === 0 ? 'success' : 'failure';
}

describe('webkit floor', () => {
  it('rejects a name filter that skips every WebKit case while numPassedTests stays high', () => {
    const report = browserReport(() => 'skipped');
    const verdict = evaluateWebKitReports([report]);
    expect(verdict.passed).toBe(0);
    expect(verdict.skipped).toBe(webKitCases);
    expect(verdict.reasons.join('\n')).toContain(`webkit skipped ${webKitCases}`);
    expect(verdict.reasons.join('\n')).toContain(`webkit passed 0 below floor ${WEBKIT_PASSED_FLOOR}`);
    const cli = runCli(report);
    expect(cli.status).not.toBe(0);
    expect(cli.stderr).toContain(`webkit skipped ${webKitCases}`);
  });

  it('rejects a webkit-gate-only run', () => {
    const report = {
      numPassedTests: 6,
      success: true,
      testResults: [{
        name: '/workspace/frontend/test/webkit-gate.test.ts',
        assertionResults: [
          { fullName: 'throws when CI=true and WebKit cannot launch', status: 'passed' },
          { fullName: 'warns and returns when CI is unset and WebKit is missing', status: 'passed' },
          { fullName: 'stays quiet when CI=true and WebKit launches', status: 'passed' },
        ],
      }],
    };
    const verdict = evaluateWebKitReports([report]);
    expect(verdict.passed).toBe(0);
    expect(verdict.reasons.some((reason) => reason.includes('test/map-time-skip-safe-area.test.ts'))).toBe(true);
    expect(runCli(report).status).not.toBe(0);
  });

  it('rejects a single WebKit case', () => {
    const report = browserReport((file) => file === 'test/map-bearing-retarget.test.ts' ? 'passed' : 'skipped');
    const verdict = evaluateWebKitReports([report]);
    expect(verdict.passed).toBe(1);
    expect(verdict.skipped).toBe(webKitCases - 1);
    expect(verdict.reasons.join('\n')).toContain(`webkit passed 1 below floor ${WEBKIT_PASSED_FLOOR}`);
    expect(runCli(report).status).not.toBe(0);
  });

  it('rejects one skipped WebKit case inside an otherwise complete run', () => {
    const report = browserReport((file, index) => file === 'test/map-satellite-picker-safe-area.test.ts' && index === 0 ? 'skipped' : 'passed');
    const verdict = evaluateWebKitReports([report]);
    expect(verdict.passed).toBe(webKitCases - 1);
    expect(verdict.skipped).toBe(1);
    expect(verdict.reasons).toContain('webkit skipped 1');
    expect(verdict.reasons).toContain('test/map-satellite-picker-safe-area.test.ts passed 2 below minimum 3');
    expect(runCli(report).status).not.toBe(0);
  });

  it('rejects a WebKit describe removed by an engine filter', () => {
    const full = browserReport(() => 'passed') as {
      testResults: { name: string; numPassedTests: number; assertionResults: { fullName: string; status: string }[] }[];
    };
    const report = {
      numPassedTests: 2825,
      success: true,
      testResults: full.testResults.map((file) => file.name.endsWith('map-time-skip-safe-area.test.ts') || file.name.endsWith('map-satellite-picker-safe-area.test.ts')
        ? {
          ...file,
          assertionResults: file.assertionResults.map((assertion) => ({
            ...assertion,
            ancestorTitles: ['Chrome'],
            fullName: assertion.fullName.replace('WebKit', 'Chrome'),
          })),
        }
        : file),
    };
    const verdict = evaluateWebKitReports([report]);
    expect(verdict.reasons).toContain('test/map-time-skip-safe-area.test.ts passed 0 below minimum 60');
    expect(verdict.reasons).toContain('test/map-satellite-picker-safe-area.test.ts passed 0 below minimum 3');
    expect(runCli(report).status).not.toBe(0);
  });

  it('accepts the full browser set', () => {
    const report = browserReport(() => 'passed');
    const verdict = evaluateWebKitReports([report]);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.passed).toBe(webKitCases);
    expect(verdict.passed).toBe(WEBKIT_PASSED_FLOOR);
    const cli = runCli(report);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain(`webkit floor ok: ${webKitCases} passed`);
  });

  it('accepts shard reports only when every shard is present', () => {
    const report = browserReport(() => 'passed') as { testResults: { name: string }[] };
    const dir = mkdtempSync(join(tmpdir(), 'webkit-shards-'));
    writeFileSync(join(dir, 'shard-1.json'), JSON.stringify({ testResults: report.testResults.slice(0, 4) }));
    writeFileSync(join(dir, 'shard-2.json'), JSON.stringify({ testResults: report.testResults.slice(4) }));
    const verdict = evaluateWebKitReports(loadWebKitReports(dir));
    expect(verdict.reasons).toEqual([]);
    expect(verdict.passed).toBe(webKitCases);
    expect(evaluateWebKitReports(loadWebKitReports(join(dir, 'shard-1.json'))).reasons.length).toBeGreaterThan(0);
  });

  it('rejects fewer than 190 distinct cases duplicated in one report', () => {
    const distinct = Object.values(halfMinimums()).reduce((sum, count) => sum + count, 0);
    const report = duplicateAssertions(browserReport(() => 'passed', halfMinimums()) as { testResults: { assertionResults: unknown[] }[] });
    const verdict = evaluateWebKitReports([report]);
    expect(distinct).toBeLessThan(WEBKIT_PASSED_FLOOR);
    expect(verdict.passed).toBe(distinct);
    expect(verdict.reasons.some((reason) => reason.startsWith('duplicate webkit case'))).toBe(true);
    expect(runCli(report).status).not.toBe(0);
  });

  it('rejects the same cases addressed by an absolute path and a frontend-relative path', () => {
    const distinct = Object.values(halfMinimums()).reduce((sum, count) => sum + count, 0);
    const absolute = browserReport(() => 'passed', halfMinimums()) as { testResults: { name: string; assertionResults: unknown[] }[] };
    const verdict = evaluateWebKitReports([absolute, relativeNames(absolute)]);
    expect(distinct).toBeLessThan(WEBKIT_PASSED_FLOOR);
    expect(verdict.passed).toBe(distinct);
    expect(verdict.reasons.some((reason) => reason.startsWith('duplicate webkit case'))).toBe(true);
  });

  it('rejects overlapping shard reports in a directory', () => {
    const distinct = Object.values(halfMinimums()).reduce((sum, count) => sum + count, 0);
    const absolute = browserReport(() => 'passed', halfMinimums()) as { testResults: { name: string; assertionResults: unknown[] }[] };
    const dir = mkdtempSync(join(tmpdir(), 'webkit-overlap-'));
    writeFileSync(join(dir, 'shard-1.json'), JSON.stringify(absolute));
    writeFileSync(join(dir, 'shard-2.json'), JSON.stringify(relativeNames(absolute)));
    const verdict = evaluateWebKitReports(loadWebKitReports(dir));
    expect(distinct).toBeLessThan(WEBKIT_PASSED_FLOOR);
    expect(verdict.passed).toBe(distinct);
    expect(verdict.reasons.some((reason) => reason.startsWith('duplicate webkit case'))).toBe(true);
    expect(runCliOn(dir).status).not.toBe(0);
  });

  it('rejects a skipped or omitted launch-card WebKit case', () => {
    const file = 'test/legacy-launch-card.test.ts';
    const named = [
      'legacy launch card WebKit opens from a trusted tap when controls are shown in landscape',
      'legacy launch card WebKit gives the portrait scrollport a usable width and a height above the 66.5px band',
    ];
    const reportFor = (present: string[], skipped: string[]) => {
      const base = browserReport(() => 'passed') as {
        testResults: { name: string; assertionResults: { ancestorTitles: string[]; fullName: string; status: string }[] }[];
      };
      return {
        ...base,
        testResults: base.testResults.map((entry) => {
          if (!entry.name.endsWith(file)) return entry;
          const pin = 'pin inspector over a legacy launch card WebKit';
          const assertions = [
            ...Array.from({ length: 6 }, (_, index) => ({
              ancestorTitles: [pin],
              fullName: `${pin} case ${index}`,
              status: 'passed',
            })),
            ...present.map((fullName) => ({
              ancestorTitles: ['legacy launch card WebKit'],
              fullName,
              status: skipped.includes(fullName) ? 'skipped' : 'passed',
            })),
          ];
          return { ...entry, assertionResults: assertions };
        }),
      };
    };
    const complete = evaluateWebKitReports([reportFor(named, [])]);
    expect(complete.reasons).toEqual([]);
    expect(complete.passed).toBe(206);
    for (const fullName of named) {
      const skipped = evaluateWebKitReports([reportFor(named, [fullName])]);
      expect(skipped.reasons).toContain('webkit skipped 1');
      expect(skipped.reasons).toContain(`${file} passed 7 below minimum 8`);
      const omitted = evaluateWebKitReports([reportFor(named.filter((name) => name !== fullName), [])]);
      expect(omitted.passed).toBe(205);
      expect(omitted.reasons).toContain('webkit passed 205 below floor 206');
      expect(omitted.reasons).toContain(`${file} passed 7 below minimum 8`);
    }
    const source = readFileSync(join(root, 'test/legacy-launch-card.test.ts'), 'utf8');
    expect(source).toContain("describe.skipIf(!webkitReady)('legacy launch card WebKit'");
  });

  it('does not count a Chrome case whose title is WebKit', () => {
    const report = browserReport(() => 'passed') as { testResults: { name: string; assertionResults: object[] }[] };
    const withChromeTitle = {
      ...report,
      testResults: report.testResults.map((file) => file.name.endsWith('map-bearing-retarget.test.ts')
        ? {
          ...file,
          assertionResults: [...file.assertionResults, {
            ancestorTitles: ['bearing retarget Chrome'],
            fullName: 'bearing retarget Chrome WebKit',
            title: 'WebKit',
            status: 'passed',
          }],
        }
        : file),
    };
    const verdict = evaluateWebKitReports([withChromeTitle]);
    expect(verdict.passed).toBe(webKitCases);
    expect(verdict.reasons).toEqual([]);
  });

  it('prints one line when the report is missing or not json', () => {
    const missing = runCliOn(join(tmpdir(), 'missing-webkit-report.json'));
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/^webkit floor: .+\n$/);
    const dir = mkdtempSync(join(tmpdir(), 'webkit-bad-'));
    const file = join(dir, 'report.json');
    writeFileSync(file, 'not json\n');
    const malformed = runCliOn(file);
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toMatch(/^webkit floor: .+\n$/);
  });

  it('keeps vitest exit 7 when the shard report is not json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shard-step-'));
    const script = shardShell(7).replaceAll('bun scripts/frontend-shards.ts', `bun ${join(root, 'scripts/frontend-shards.ts')}`);
    try {
      expect(bash(script, dir).status).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes the aggregate shell only when both shard reports are present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shard-reports-'));
    try {
      writeShardReports(dir);
      const script = runBlock(workflowText(), 'Check shard coverage and WebKit count').replaceAll('shard-reports', dir);
      expect(bash(script, resolve(root, '..')).status).toBe(0);
      rmSync(join(dir, 'shard-2-results.json'));
      rmSync(join(dir, 'shard-2-time.txt'));
      expect(bash(script, resolve(root, '..')).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails the workflow check when a test file has no weight', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'shard-check-'));
    mkdirSync(join(fixture, 'test'));
    mkdirSync(join(fixture, 'scripts'));
    writeFileSync(join(fixture, 'test/a.test.ts'), '');
    writeFileSync(join(fixture, 'test/b.test.ts'), '');
    writeFileSync(join(fixture, 'scripts/frontend-shard-weights.json'), JSON.stringify({ 'test/a.test.ts': 1 }));
    const line = runBlock(workflowText(), 'Check shard coverage and WebKit count').split('\n').find((entry) => entry.includes('--check'));
    const result = bash(line ?? 'exit 1', resolve(root, '..'), { FRONTEND_SHARD_ROOT: fixture });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('test/b.test.ts');
  });

  it('fails the Frontend verdict when a shard is cancelled', () => {
    expect(frontendVerdict('cancelled', true)).toBe('failure');
  });

  it('fails the Frontend verdict when a shard is skipped', () => {
    expect(frontendVerdict('skipped', false)).toBe('failure');
  });

  it('fails the Frontend verdict when a retried shard fails', () => {
    expect(frontendVerdict('failure', false)).toBe('failure');
  });

  it('passes the Frontend verdict when every shard succeeded', () => {
    expect(frontendVerdict('success', false)).toBe('success');
  });
});
