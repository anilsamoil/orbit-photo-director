import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium, webkit } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { closeBrowser, launchTracked } from './close-browser.mjs';

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function dead(pid: number | undefined, child?: ChildProcess): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < 500) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) return true;
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return child ? child.exitCode !== null || child.signalCode !== null : !alive(pid);
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

function browserOf(close: () => Promise<unknown>, kill: () => Promise<unknown>) {
  return { close, server: { close, kill } };
}

describe('closeBrowser', () => {
  it('kills a stuck child within the hook budget', async () => {
    const child = track(detached('sleep', ['30']));
    let killed = false;
    const started = Date.now();
    let returned = false;
    try {
      await Promise.race([
        closeBrowser(browserOf(() => new Promise<void>(() => {}), async () => {
          killed = true;
          killGroup(child.pid);
        }), 'stuck-child').then(() => {
          returned = true;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 9_000)),
      ]);
      const elapsed = Date.now() - started;
      expect(returned).toBe(true);
      expect(killed).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(1_000);
      expect(elapsed).toBeLessThan(10_000);
      expect(await dead(child.pid, child)).toBe(true);
    } finally {
      killGroup(child.pid);
    }
  }, 12_000);

  it('leaves an unrelated sibling alive', async () => {
    const sibling = track(detached('sleep', ['30']));
    const root = track(detached('sleep', ['30']));
    try {
      await closeBrowser(browserOf(() => new Promise<void>(() => {}), async () => {
        killGroup(root.pid);
      }), 'sibling');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(sibling.exitCode).toBeNull();
      expect(sibling.signalCode).toBeNull();
      expect(alive(sibling.pid)).toBe(true);
      expect(await dead(root.pid, root)).toBe(true);
    } finally {
      killGroup(sibling.pid);
      killGroup(root.pid);
    }
  }, 12_000);

  it('kills a child whose leader has already exited', async () => {
    const root = track(detached('bash', ['-c', 'sleep 30 & echo $!; wait'], 'pipe'));
    const line = await new Promise<string>((resolve) => {
      root.stdout?.once('data', (buf) => resolve(buf.toString().trim()));
    });
    const child = Number(line);
    let returned = false;
    try {
      await Promise.race([
        closeBrowser({
          close: async () => {
            try { process.kill(root.pid!, 'SIGKILL'); } catch {}
            await new Promise<void>(() => {});
          },
          server: {
            close: async () => {
              try { process.kill(root.pid!, 'SIGKILL'); } catch {}
              await new Promise<void>(() => {});
            },
            kill: async () => {
              killGroup(root.pid);
            },
            process: () => ({ pid: root.pid }),
          },
        }, 'exited-leader').then(() => {
          returned = true;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 9_000)),
      ]);
      expect(returned).toBe(true);
      expect(await dead(root.pid, root)).toBe(true);
      expect(await dead(child)).toBe(true);
    } finally {
      killGroup(root.pid);
      killGroup(child);
    }
  }, 12_000);

  it('does not kill the process when close returns inside the grace period', async () => {
    const root = track(detached('sleep', ['30']));
    let killed = false;
    const started = Date.now();
    try {
      await closeBrowser(browserOf(async () => {}, async () => {
        killed = true;
        killGroup(root.pid);
      }), 'early');
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(killed).toBe(false);
      expect(alive(root.pid)).toBe(true);
    } finally {
      killGroup(root.pid);
    }
  });

  it('stops a failed launch cleanup at its deadline', async () => {
    const started = Date.now();
    let settled = false;
    let error: unknown;
    await Promise.race([
      launchTracked({
        async launchServer() {
          return {
            wsEndpoint: () => 'ws://127.0.0.1/failed',
            process: () => ({ pid: undefined }),
            close: () => new Promise<void>(() => {}),
            kill: async () => {},
          };
        },
        async connect() {
          throw new Error('connect failed');
        },
      } as never, {}).then(() => {
        settled = true;
      }, (caught) => {
        settled = true;
        error = caught;
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 4_000)),
    ]);
    expect(settled).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 12_000);

  it('binds the browser server to loopback', async () => {
    let host: string | undefined;
    await launchTracked({
      async launchServer(options: { host?: string }) {
        host = options?.host;
        return {
          wsEndpoint: () => 'ws://127.0.0.1/loopback',
          process: () => ({ pid: undefined }),
          close: async () => {},
          kill: async () => {},
        };
      },
      async connect() {
        throw new Error('stop after launch');
      },
    } as never, { headless: true }).catch(() => {});
    expect(host).toBe('127.0.0.1');
  });
});

const chromePath = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find((path) => existsSync(path));
const engines = [
  chromePath ? { name: 'chrome', type: chromium, options: { headless: true, executablePath: chromePath } } : undefined,
  existsSync(webkit.executablePath()) ? { name: 'webkit', type: webkit, options: { headless: true } } : undefined,
].filter((engine) => engine !== undefined);

describe('launched browsers', () => {
  for (const engine of engines) {
    it(`kills a stopped ${engine.name} process within the hook budget`, async () => {
      const sibling = track(detached('sleep', ['30']));
      const session = await launchTracked(engine.type, engine.options);
      const leader = session.server.process().pid;
      process.kill(leader!, 'SIGSTOP');
      const started = Date.now();
      try {
        await closeBrowser(session, `stopped-${engine.name}`);
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(await dead(leader)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(sibling.exitCode).toBeNull();
        expect(sibling.signalCode).toBeNull();
      } finally {
        killGroup(sibling.pid);
        try { await session.server.kill(); } catch {}
      }
    }, 30_000);
  }
});
