const GRACE_MS = 1000;
const KILL_DEADLINE_MS = 1000;

function delay(ms) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel() { clearTimeout(timer); } };
}

async function within(work, ms) {
  const timer = delay(ms);
  try {
    return await Promise.race([
      Promise.resolve(work()).then(() => 'done', () => 'done'),
      timer.promise.then(() => 'timeout'),
    ]);
  } finally {
    timer.cancel();
  }
}

export async function launchTracked(browserType, options = {}) {
  const server = await browserType.launchServer({ ...options, host: '127.0.0.1' });
  try {
    const browser = await browserType.connect(server.wsEndpoint());
    return { browser, server };
  } catch (error) {
    await within(() => server.close(), GRACE_MS);
    if (typeof server.kill === 'function') await within(() => server.kill(), KILL_DEADLINE_MS);
    throw error;
  }
}

function whenExited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve('exited');
  return new Promise((resolve) => {
    child.once('exit', () => resolve('exited'));
  });
}

function releaseStdio(child) {
  for (const stream of child.stdio ?? []) stream?.destroy?.();
}

function begin(work) {
  Promise.resolve().then(work).catch(() => {});
}

function beginClientClose(browser) {
  if (!browser) return Promise.resolve();
  const work = [];
  if (typeof browser.contexts === 'function') {
    for (const context of browser.contexts()) work.push(Promise.resolve().then(() => context.close()).catch(() => {}));
  }
  if (typeof browser.close === 'function') work.push(Promise.resolve().then(() => browser.close()).catch(() => {}));
  return Promise.all(work);
}

async function graceful(session) {
  const client = beginClientClose(session.browser);
  const server = session.server;
  const child = server?.process?.();
  if (child) {
    if (typeof server.close === 'function') begin(() => server.close());
    const status = await whenExited(child);
    releaseStdio(child);
    return status;
  }
  if (server && typeof server.close === 'function') {
    await Promise.all([client, Promise.resolve().then(() => server.close())]);
    return 'closed';
  }
  if (typeof session.close === 'function') {
    await Promise.all([client, Promise.resolve().then(() => session.close())]);
    return 'closed';
  }
  await client;
  return 'closed';
}

export async function closeBrowser(session, label = 'browser') {
  if (!session) return;
  const started = Date.now();
  let killed = false;
  const grace = delay(GRACE_MS);
  const done = graceful(session).then((status) => status, () => 'failed');
  const result = await Promise.race([done, grace.promise.then(() => 'grace')]);
  grace.cancel();
  if (result !== 'closed' && result !== 'exited') {
    killed = true;
    const kill = session.server?.kill ?? session.kill;
    if (kill) await within(() => kill.call(session.server ?? session), KILL_DEADLINE_MS);
  }
  const elapsedMs = Date.now() - started;
  console.log(`CLOSE_BROWSER ${label} ${elapsedMs}ms${killed ? ' killed' : ''}`);
  return { killed, elapsedMs };
}
