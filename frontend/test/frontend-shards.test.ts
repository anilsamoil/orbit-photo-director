import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WEBKIT_PASSED_FLOOR } from '../scripts/webkit-floor';
import {
  SHARD_COUNT,
  UNSHARDED_WEBKIT_CASES,
  assertExecutedFiles,
  assertPartition,
  assertWebKitFloor,
  countWebKitCases,
  discoverTestFiles,
  importsPlaywrightWebKit,
  loadWeights,
  planShards,
  readTimeReport,
} from '../scripts/frontend-shards';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('frontend shards', () => {
  it('assigns every discovered test file to one shard', () => {
    const files = discoverTestFiles();
    const shards = planShards(files, loadWeights(), SHARD_COUNT);
    expect(() => assertPartition(files, shards)).not.toThrow();
    expect(shards).toHaveLength(SHARD_COUNT);
    expect(files).toContain('test/pass-row-fit.test.ts');
    expect(files).toContain('test/digits.test.ts');
    const heavy = Math.max(...shards.map((shard) => shard.loadSeconds));
    const total = shards.reduce((sum, shard) => sum + shard.loadSeconds, 0);
    expect(heavy / total).toBeLessThanOrEqual(0.55);
    expect(new Set(shards.flatMap((shard) => shard.files)).size).toBe(files.length);
  });

  it('rejects a plan that drops or repeats a file', () => {
    const files = ['test/a.test.ts', 'test/b.test.ts'];
    expect(() => assertPartition(files, [{ files: ['test/a.test.ts'], loadSeconds: 1 }])).toThrow(/missing/);
    expect(() => assertPartition(files, [{
      files: ['test/a.test.ts', 'test/a.test.ts', 'test/b.test.ts'],
      loadSeconds: 1,
    }])).toThrow(/twice/);
  });

  it('keeps the workflow matrix on the same shard count', () => {
    const yaml = readFileSync(resolve(repoRoot, '.github/workflows/test.yml'), 'utf8');
    const match = /shard:\s*\[([^\]]+)\]/.exec(yaml);
    expect(match?.[1]).toBeTruthy();
    const values = match?.[1]?.split(',').map((part) => Number(part.trim())) ?? [];
    expect(values).toEqual(Array.from({ length: SHARD_COUNT }, (_, index) => index + 1));
  });

  it('counts a passed WebKit case once and ignores failures and Chrome titles', () => {
    expect(importsPlaywrightWebKit('test/pass-row-fit.test.ts')).toBe(true);
    expect(importsPlaywrightWebKit('test/webkit-gate.test.ts')).toBe(false);
    expect(importsPlaywrightWebKit('test/digits.test.ts')).toBe(false);
    const passed = {
      ancestorTitles: ['pin pass row WebKit'],
      fullName: 'pin pass row WebKit fits',
      status: 'passed',
    };
    const imports = (file: string) => file === 'test/pass-row-fit.test.ts';
    const counted = countWebKitCases([
      {
        testResults: [
          {
            name: '/work/frontend/test/pass-row-fit.test.ts',
            assertionResults: [
              passed,
              { ancestorTitles: ['pin pass row Chrome'], fullName: 'pin pass row Chrome WebKit', status: 'passed' },
              { ancestorTitles: ['pin pass row WebKit'], fullName: 'pin pass row WebKit skipped', status: 'skipped' },
              { ancestorTitles: ['pin pass row WebKit'], fullName: 'pin pass row WebKit failed', status: 'failed' },
            ],
          },
          {
            name: '/work/frontend/test/webkit-gate.test.ts',
            assertionResults: [
              { ancestorTitles: ['gate WebKit'], fullName: 'gate WebKit throws when CI=true', status: 'passed' },
            ],
          },
        ],
      },
      {
        testResults: [{ name: 'test/pass-row-fit.test.ts', assertionResults: [passed] }],
      },
    ], imports);
    expect(counted.cases).toBe(1);
    expect(counted.files).toEqual(['test/pass-row-fit.test.ts', 'test/webkit-gate.test.ts']);
    expect(() => assertExecutedFiles(
      ['test/pass-row-fit.test.ts', 'test/webkit-gate.test.ts'],
      counted.files,
    )).not.toThrow();
    expect(() => assertExecutedFiles(['test/digits.test.ts'], counted.files)).toThrow(/not executed/);
  });

  it('keeps the WebKit floor at the current per-file sum', () => {
    expect(UNSHARDED_WEBKIT_CASES).toBe(WEBKIT_PASSED_FLOOR);
    expect(UNSHARDED_WEBKIT_CASES).toBe(207);
    expect(() => assertWebKitFloor(207)).not.toThrow();
    expect(() => assertWebKitFloor(206)).toThrow(/below unsharded count 207/);
  });

  it('reads max RSS and rejects exit 137 and 143', () => {
    const text = [
      'Maximum resident set size (kbytes): 1303140',
      'Exit status: 0',
    ].join('\n');
    expect(readTimeReport(text, 'serial')).toEqual({ rssKb: 1303140, exit: 0 });
    expect(() => readTimeReport('Maximum resident set size (kbytes): 10\nExit status: 137', 'shard')).toThrow(/137/);
    expect(() => readTimeReport('Maximum resident set size (kbytes): 10\nExit status: 143', 'shard')).toThrow(/143/);
  });
});
