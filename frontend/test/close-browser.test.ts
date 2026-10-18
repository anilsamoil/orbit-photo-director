import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { browserPidSnapshot, browserPidsLaunchedSince, closeBrowser } from './close-browser.mjs';

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function detached(command: string, args: string[], stdio: 'ignore' | 'pipe' = 'ignore'): ChildProcess {
  return spawn(command, args, { detached: true, stdio: stdio === 'pipe' ? ['ignore', 'pipe', 'ignore'] : 'ignore' });
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch {}
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

const groups: number[] = [];

function track(child: ChildProcess): ChildProcess {
  if (child.pid) groups.push(child.pid);
  return child;
}

afterEach(() => {
  for (const pid of groups) killGroup(pid);
  groups.length = 0;
});

describe('closeBrowser', () => {
  it('unblocks a close that is waiting on a live child', async () => {
    const child = track(detached('sleep', ['30']));
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
    });
    const started = Date.now();
    try {
      await closeBrowser({ close: () => closed }, [child.pid ?? 0], 'stuck-child');
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1000);
      expect(elapsed).toBeLessThan(5_000);
      expect(alive(child.pid)).toBe(false);
    } finally {
      killGroup(child.pid);
    }
  });

  it('leaves an unrelated sibling alive', async () => {
    const before = browserPidSnapshot();
    const sibling = track(detached('sleep', ['30']));
    const root = track(detached('sleep', ['30']));
    const launched = browserPidsLaunchedSince(before);
    try {
      expect(launched).toEqual(expect.arrayContaining([sibling.pid, root.pid]));
      const closed = new Promise<void>((resolve) => {
        root.once('close', () => resolve());
      });
      await closeBrowser({ close: () => closed }, launched, 'sibling');
      expect(alive(sibling.pid)).toBe(true);
      expect(alive(root.pid)).toBe(false);
    } finally {
      killGroup(sibling.pid);
      killGroup(root.pid);
    }
  });

  it('kills a grandchild that is already running', async () => {
    const root = track(detached('bash', ['-c', 'sleep 30 & echo $!; wait'], 'pipe'));
    const line = await new Promise<string>((resolve) => {
      root.stdout?.once('data', (buf) => resolve(buf.toString().trim()));
    });
    const grandchild = Number(line);
    const closed = new Promise<void>((resolve) => {
      root.once('close', () => resolve());
    });
    try {
      const started = Date.now();
      await closeBrowser({ close: () => closed }, [root.pid ?? 0], 'grandchild');
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
      expect(alive(root.pid)).toBe(false);
      expect(alive(grandchild)).toBe(false);
    } finally {
      killGroup(root.pid);
      killGroup(grandchild);
    }
  });

  it('kills a child spawned during the grace period', async () => {
    const marker = `/tmp/opd-late-${process.pid}-${Date.now()}`;
    const root = track(detached('bash', ['-c', `sleep 0.4; sleep 30 & echo $! > ${marker}; wait`]));
    const closed = new Promise<void>((resolve) => {
      root.once('close', () => resolve());
    });
    let returned = false;
    try {
      await Promise.race([
        closeBrowser({ close: () => closed }, [root.pid ?? 0], 'late-child').then(() => {
          returned = true;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
      ]);
      const late = Number(readFileSync(marker, 'utf8').trim());
      expect(returned).toBe(true);
      expect(alive(root.pid)).toBe(false);
      expect(late).toBeGreaterThan(1);
      expect(alive(late)).toBe(false);
    } finally {
      killGroup(root.pid);
      try { unlinkSync(marker); } catch {}
    }
  });

  it('returns when close stays pending after the tree is killed', async () => {
    const root = track(detached('sleep', ['30']));
    const started = Date.now();
    let returned = false;
    try {
      await Promise.race([
        closeBrowser({ close: () => new Promise<void>(() => {}) }, [root.pid ?? 0], 'deadline').then(() => {
          returned = true;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
      ]);
      expect(returned).toBe(true);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(1000);
      expect(elapsed).toBeLessThan(5_000);
      expect(alive(root.pid)).toBe(false);
    } finally {
      killGroup(root.pid);
    }
  });

  it('does not kill the process when close returns inside the grace period', async () => {
    const root = track(detached('sleep', ['30']));
    const started = Date.now();
    try {
      await closeBrowser({ close: async () => {} }, [root.pid ?? 0], 'early');
      expect(Date.now() - started).toBeLessThan(1000);
      expect(alive(root.pid)).toBe(true);
    } finally {
      killGroup(root.pid);
    }
  });
});
