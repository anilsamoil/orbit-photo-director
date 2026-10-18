import { expect, it, vi } from 'vitest';
import config from '../vite.config';
import { enforceWebKitGate, type WebKitAvailability } from './webkit-gate';

const missing: WebKitAvailability = {
  status: 'unavailable',
  reason: 'no browser at /home/ubuntu/.cache/ms-playwright/webkit-2203/pw_run.sh',
};

const line =
  `WebKit unavailable: ${missing.reason}. From frontend/, run ./node_modules/.bin/playwright install --with-deps webkit.`;

it('throws when CI=true and WebKit cannot launch', async () => {
  const warnings: string[] = [];
  const probe = vi.fn(async () => missing);
  await expect(enforceWebKitGate({
    env: { CI: 'true' },
    probe,
    stat: () => { throw new Error('stat'); },
    warn: (entry) => warnings.push(entry),
  })).rejects.toThrow(line);
  expect(probe).toHaveBeenCalledOnce();
  expect(warnings).toEqual([]);
});

it('warns and returns when CI is unset and WebKit is missing', async () => {
  const warnings: string[] = [];
  const probe = vi.fn(async (): Promise<WebKitAvailability> => { throw new Error('launched'); });
  await enforceWebKitGate({
    env: {},
    probe,
    stat: () => missing,
    warn: (entry) => warnings.push(entry),
  });
  expect(probe).not.toHaveBeenCalled();
  expect(warnings).toEqual([line]);
});

it('treats CI=1 as a local run', async () => {
  const warnings: string[] = [];
  await enforceWebKitGate({
    env: { CI: '1' },
    probe: async () => { throw new Error('launched'); },
    stat: () => missing,
    warn: (entry) => warnings.push(entry),
  });
  expect(warnings).toEqual([line]);
});

it('stays quiet when CI=true and WebKit launches', async () => {
  const warnings: string[] = [];
  await enforceWebKitGate({
    env: { CI: 'true' },
    probe: async () => ({ status: 'launchable' }),
    stat: () => missing,
    warn: (entry) => warnings.push(entry),
  });
  expect(warnings).toEqual([]);
});

it('stays quiet when CI is unset and the binary is present', async () => {
  const warnings: string[] = [];
  const probe = vi.fn(async (): Promise<WebKitAvailability> => { throw new Error('launched'); });
  await enforceWebKitGate({
    env: {},
    probe,
    stat: () => ({ status: 'launchable' }),
    warn: (entry) => warnings.push(entry),
  });
  expect(probe).not.toHaveBeenCalled();
  expect(warnings).toEqual([]);
});

it('registers webkit-gate.ts as globalSetup', () => {
  expect(config.test?.globalSetup).toBe('test/webkit-gate.ts');
});
