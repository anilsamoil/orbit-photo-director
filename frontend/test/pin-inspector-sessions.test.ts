import { describe, expect, it } from 'vitest';
import { openPinnedBrowsers } from '../scripts/pin-inspector-sessions.mjs';

function session(closes: { count: number }) {
  return {
    browser: { close: async () => { closes.count += 1; } },
    server: { close: async () => {} },
  };
}

describe('openPinnedBrowsers', () => {
  it('closes WebKit once when Chrome launch throws', async () => {
    const closes = { count: 0 };
    await expect(openPinnedBrowsers(
      async () => session(closes),
      async () => { throw new Error('chrome failed'); },
      async () => { throw new Error('body should not run'); },
    )).rejects.toThrow('chrome failed');
    expect(closes.count).toBe(1);
  });
});
