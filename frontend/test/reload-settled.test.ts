import { expect, it, vi } from 'vitest';

import { reloadSettled } from '../../.cursor/skills/verify-opd/scripts/drive.mjs';

type EvalParams = { expression?: string; timeout?: number };

function sendFor(banner: { ok: true } | null) {
  const timeouts: Array<number | undefined> = [];
  const send = async (method: string, params: EvalParams = {}) => {
    timeouts.push(params.timeout);
    if (method === 'Page.reload') return {};
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression);
      if (expression.includes('readyState')) return { result: { value: { ok: true } } };
      return { result: { value: banner } };
    }
    throw new Error(method);
  };
  return { send, timeouts };
}

it('a never-settling reload rejects at 30s and does not send timeout 0', async () => {
  vi.useFakeTimers();
  try {
    const { send, timeouts } = sendFor(null);
    let rejected = false;
    const pending = reloadSettled(send).then(
      () => { throw new Error('reload resolved'); },
      () => { rejected = true; },
    );
    await vi.advanceTimersByTimeAsync(29_000);
    expect(rejected).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    expect(rejected).toBe(true);
    expect(timeouts).not.toContain(0);
  } finally {
    vi.useRealTimers();
  }
});

it('returns as soon as the banner leaves Loading', async () => {
  const { send, timeouts } = sendFor({ ok: true });
  await reloadSettled(send);
  expect(timeouts).not.toContain(0);
});
