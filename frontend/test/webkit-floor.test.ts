import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROWSER_FILE_MINIMUMS, WEBKIT_PASSED_FLOOR, evaluateWebKitReports, loadWebKitReports } from '../scripts/webkit-floor';

const root = resolve(__dirname, '..');

function cases(count: number, status: string, label: string): { fullName: string; status: string }[] {
  return Array.from({ length: count }, (_, index) => ({ fullName: `${label} WebKit case ${index}`, status }));
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

function runCli(report: unknown): { status: number; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'webkit-floor-'));
  const file = join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(report));
  const args = process.execPath.endsWith('bun') ? [join(root, 'scripts/webkit-floor.ts'), file] : ['--experimental-strip-types', join(root, 'scripts/webkit-floor.ts'), file];
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failed.status ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

describe('webkit floor', () => {
  it('rejects a name filter that skips every WebKit case while numPassedTests stays high', () => {
    const report = browserReport(() => 'skipped');
    const verdict = evaluateWebKitReports([report]);
    expect(verdict.passed).toBe(0);
    expect(verdict.skipped).toBe(193);
    expect(verdict.reasons.join('\n')).toContain('webkit skipped 193');
    expect(verdict.reasons.join('\n')).toContain(`webkit passed 0 below floor ${WEBKIT_PASSED_FLOOR}`);
    const cli = runCli(report);
    expect(cli.status).not.toBe(0);
    expect(cli.stderr).toContain('webkit skipped 193');
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
    expect(verdict.skipped).toBe(192);
    expect(verdict.reasons.join('\n')).toContain('webkit passed 1 below floor 190');
    expect(runCli(report).status).not.toBe(0);
  });

  it('rejects one skipped WebKit case inside an otherwise complete run', () => {
    const report = browserReport((file, index) => file === 'test/map-satellite-picker-safe-area.test.ts' && index === 0 ? 'skipped' : 'passed');
    const verdict = evaluateWebKitReports([report]);
    expect(verdict.passed).toBe(192);
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
        ? { ...file, assertionResults: file.assertionResults.map((assertion) => ({ ...assertion, fullName: assertion.fullName.replace('WebKit', 'Chrome') })) }
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
    expect(verdict.passed).toBe(193);
    expect(verdict.passed).toBeGreaterThanOrEqual(WEBKIT_PASSED_FLOOR);
    const cli = runCli(report);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain('webkit floor ok: 193 passed');
  });

  it('accepts shard reports only when every shard is present', () => {
    const report = browserReport(() => 'passed') as { testResults: { name: string }[] };
    const dir = mkdtempSync(join(tmpdir(), 'webkit-shards-'));
    writeFileSync(join(dir, 'shard-1.json'), JSON.stringify({ testResults: report.testResults.slice(0, 4) }));
    writeFileSync(join(dir, 'shard-2.json'), JSON.stringify({ testResults: report.testResults.slice(4) }));
    expect(evaluateWebKitReports(loadWebKitReports(dir)).reasons).toEqual([]);
    expect(evaluateWebKitReports(loadWebKitReports(join(dir, 'shard-1.json'))).reasons.length).toBeGreaterThan(0);
  });

  it('wires the Frontend job to the validator with a 60 minute timeout', () => {
    const workflow = readFileSync(resolve(root, '../.github/workflows/test.yml'), 'utf8');
    expect(workflow).toContain('timeout-minutes: 60');
    expect(workflow).toContain('bun scripts/webkit-floor.ts webkit-report.json');
    expect(workflow).toContain('--outputFile.json=webkit-report.json');
  });
});
