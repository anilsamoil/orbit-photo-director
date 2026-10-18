import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const GRACE_MS = 1000;
const CLOSE_DEADLINE_MS = 1000;

function identity(pid) {
  let text;
  try {
    text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const end = text.lastIndexOf(')');
  if (end < 0) return null;
  const fields = text.slice(end + 2).trim().split(/\s+/);
  const pgid = Number(fields[2]);
  const startTicks = Number(fields[19]);
  if (!Number.isInteger(pgid) || !Number.isInteger(startTicks)) return null;
  return { pgid, startTicks };
}

export function trackProcess(pid) {
  const found = identity(pid);
  if (!found || found.pgid !== pid || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    throw new Error(`pid ${pid} is not a process-group leader this process can own`);
  }
  return { pid, pgid: found.pgid, startTicks: found.startTicks };
}

function descendantPids(root) {
  let text;
  try {
    text = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const rows = text.trim().split('\n').filter(Boolean).map((line) => {
    const [pid, ppid] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid) };
  });
  const wanted = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (wanted.has(row.ppid) && !wanted.has(row.pid)) {
        wanted.add(row.pid);
        grew = true;
      }
    }
  }
  wanted.delete(root);
  return [...wanted].filter((pid) => pid > 1 && pid !== process.pid);
}

function signal(pid, group) {
  try {
    process.kill(group ? -pid : pid, 'SIGKILL');
  } catch {}
}

function killOwned(tracked) {
  if (!tracked || tracked.pgid !== tracked.pid || tracked.pid <= 1 || tracked.pid === process.pid) return false;
  const found = identity(tracked.pid);
  if (!found || found.pgid !== tracked.pgid || found.startTicks !== tracked.startTicks) return false;
  const descendants = descendantPids(tracked.pid);
  const again = identity(tracked.pid);
  if (!again || again.pgid !== tracked.pgid || again.startTicks !== tracked.startTicks) return false;
  signal(tracked.pgid, true);
  for (const pid of descendants) signal(pid, false);
  return true;
}

/**
 * `Browser` has no `process()`. `launchServer` exposes the spawned browser,
 * which Playwright already starts as its own process-group leader.
 */
export async function launchTracked(browserType, options) {
  const server = await browserType.launchServer(options);
  try {
    const tracked = trackProcess(server.process().pid);
    const browser = await browserType.connect(server.wsEndpoint());
    return { browser, server, tracked };
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
}

async function shutdown(session) {
  const browser = session.browser;
  if (browser && typeof browser.contexts === 'function') {
    await Promise.all(browser.contexts().map((context) => context.close().catch(() => {})));
  }
  if (browser) await browser.close().catch(() => {});
  if (session.server) await session.server.close();
  else if (typeof session.close === 'function') await session.close();
}

export async function closeBrowser(session, label = 'browser') {
  if (!session) return;
  const started = Date.now();
  let killed = false;
  const done = shutdown(session).then(() => 'closed', () => 'failed');
  let timer;
  const killer = new Promise((resolve) => {
    timer = setTimeout(() => {
      killed = killOwned(session.tracked);
      resolve('killed');
    }, GRACE_MS);
  });
  const result = await Promise.race([done, killer]);
  clearTimeout(timer);
  if (result !== 'closed') {
    if (!killed) killed = killOwned(session.tracked);
    await Promise.race([
      done,
      new Promise((resolve) => setTimeout(resolve, CLOSE_DEADLINE_MS)),
    ]);
  }
  console.log(`CLOSE_BROWSER ${label} ${Date.now() - started}ms${killed ? ' killed' : ''}`);
}
