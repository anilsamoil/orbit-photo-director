import { execFileSync } from 'node:child_process';

function processRows() {
  const text = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  return text.trim().split('\n').filter(Boolean).map((line) => {
    const [pid, ppid] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid) };
  });
}

function descendantsOf(root) {
  const rows = processRows();
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
  return wanted;
}

/** Pids under this process, taken before a browser launch. */
export function browserPidSnapshot() {
  return descendantsOf(process.pid);
}

/** Pids that appeared under this process after `browserPidSnapshot`. */
export function browserPidsLaunchedSince(before) {
  const now = descendantsOf(process.pid);
  return [...now].filter((pid) => !before.has(pid));
}

function expand(seeds) {
  const rows = processRows();
  const wanted = new Set(seeds);
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
  return [...wanted].filter((pid) => pid > 1 && pid !== process.pid);
}

/**
 * `browser.close()` waits until every process holding the launched stdio
 * pipes has exited. A WebKit web process can hold its pipe for the 10s
 * watchdog. Chrome children inherit those pipes too, including the `cat`
 * processes the Chrome wrapper inserts on stdout and stderr, so one child
 * that does not exit keeps the close open until Playwright's 30s kill.
 * Close leftover contexts first, and if that is still pending, kill the
 * tree recorded at launch.
 */
export async function closeBrowser(browser, rootPids, label = 'browser') {
  if (!browser) return;
  const pids = expand(rootPids ?? []);
  const started = Date.now();
  let killed = false;
  const done = (async () => {
    if (typeof browser.contexts === 'function') {
      await Promise.all(browser.contexts().map((context) => context.close().catch(() => {})));
    }
    await browser.close();
  })().then(() => 'closed', () => 'closed');
  let timer;
  const killer = new Promise((resolve) => {
    timer = setTimeout(() => {
      killed = true;
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      resolve('killed');
    }, 1000);
  });
  const result = await Promise.race([done, killer]);
  clearTimeout(timer);
  if (result !== 'closed') await done;
  console.log(`CLOSE_BROWSER ${label} ${Date.now() - started}ms${killed ? ' killed' : ''}`);
}
