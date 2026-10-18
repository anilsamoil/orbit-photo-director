import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { closeBrowser } from './close-browser.mjs';

describe('closeBrowser', () => {
  it('unblocks a close that is waiting on a live child', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
    });
    const started = Date.now();
    try {
      await closeBrowser({ close: () => closed }, [child.pid ?? 0], 'stuck-child');
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(child.signalCode ?? child.exitCode).not.toBeNull();
    } finally {
      try {
        if (child.pid) process.kill(child.pid, 'SIGKILL');
      } catch {}
    }
  });
});
