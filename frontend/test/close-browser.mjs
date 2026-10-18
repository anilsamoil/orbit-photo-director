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

async function graceful(session) {
  const browser = session.browser;
  if (browser && typeof browser.contexts === 'function') {
    await Promise.all(browser.contexts().map((context) => context.close().catch(() => {})));
  }
  const closing = [];
  if (browser && typeof browser.close === 'function') closing.push(browser.close().catch(() => {}));
  if (session.server) closing.push(session.server.close());
  else if (typeof session.close === 'function') closing.push(session.close());
  await Promise.all(closing);
}

export async function closeBrowser(session, label = 'browser') {
  if (!session) return;
  const started = Date.now();
  let killed = false;
  const grace = delay(GRACE_MS);
  const done = graceful(session).then(() => 'closed', () => 'failed');
  const result = await Promise.race([done, grace.promise.then(() => 'grace')]);
  grace.cancel();
  if (result !== 'closed') {
    killed = true;
    const kill = session.server?.kill ?? session.kill;
    if (kill) await within(() => kill.call(session.server ?? session), KILL_DEADLINE_MS);
  }
  console.log(`CLOSE_BROWSER ${label} ${Date.now() - started}ms${killed ? ' killed' : ''}`);
}
