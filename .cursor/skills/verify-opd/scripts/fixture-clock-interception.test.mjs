import assert from 'node:assert/strict';
import test from 'node:test';
import { installOneShotClock } from './fixture-clock.mjs';

const FROZEN = 1700000000000;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('one-shot clock intercepts only its exact origin and document path at the protocol boundary', async () => {
  let registration;
  const page = {
    async route(matcher, handler, options) { registration = { matcher, handler, options }; },
    async unroute(matcher, handler) {
      assert.equal(matcher, registration.matcher);
      assert.equal(handler, registration.handler);
    },
  };
  const remove = await installOneShotClock(page, 'https://snap.example.test:8443/app.v1+(x)/?b=1&a=2#saved', FROZEN);
  const { matcher } = registration;
  assert.ok(matcher instanceof RegExp, 'function predicates become protocol-wide **/* interception in Playwright');
  for (const suffix of ['', '?a=2&b=1', '?changed=1#kept', '#kept']) {
    assert.equal(matcher.test(`https://snap.example.test:8443/app.v1+(x)/${suffix}`), true, suffix);
  }
  for (const url of [
    'https://snap.example.test:8443/src/main.ts',
    'https://snap.example.test:8443/manifest.json',
    'https://snap.example.test:8443/__opd_context_storage_bootstrap__',
    'https://snap.example.test:8443/app.v1+(x)/child',
    'https://snap.example.test:8443/app.v1+(x)',
    'https://snap.example.test:8443/appZv11x/',
    'https://snapXexample.test:8443/app.v1+(x)/',
    'https://snap.example.test/app.v1+(x)/',
    'http://snap.example.test:8443/app.v1+(x)/',
    'https://external.test/app.v1+(x)/',
    'https://external.test/?next=https://snap.example.test:8443/app.v1+(x)/',
  ]) assert.equal(matcher.test(url), false, url);
  assert.deepEqual(registration.options, { times: 1 });
  await remove();
});

test('retiring a one-shot clock waits for its in-flight fetch and fulfillment', async () => {
  const fetched = deferred();
  const fulfilling = deferred();
  const fulfilled = deferred();
  const events = [];
  let seed;
  const page = {
    async route(_matcher, handler) { seed = handler; },
    async unroute() { events.push('unroute'); },
  };
  const remove = await installOneShotClock(page, 'http://127.0.0.1:1234/?e2e', FROZEN);
  const response = { text: async () => '<!doctype html><head></head><body>ok</body>' };
  const seeding = seed({
    async fetch() { events.push('fetch'); await fetched.promise; return response; },
    async fulfill(options) {
      assert.equal(options.response, response);
      assert.match(options.body, /<head><script>/);
      assert.match(options.body, /1700000000000/);
      events.push('fulfill-start');
      fulfilling.resolve();
      await fulfilled.promise;
      events.push('fulfill-end');
    },
  });
  const removing = remove();
  await Promise.resolve();
  const whileFetching = [...events];
  fetched.resolve();
  await fulfilling.promise;
  const whileFulfilling = [...events];
  fulfilled.resolve();
  await Promise.all([seeding, removing]);
  assert.deepEqual(whileFetching, ['fetch'], 'retirement must not advance a request awaiting fetch');
  assert.deepEqual(whileFulfilling, ['fetch', 'fulfill-start'], 'retirement must not advance a request awaiting fulfill');
  assert.deepEqual(events, ['fetch', 'fulfill-start', 'fulfill-end', 'unroute']);
});

test('retiring a failed clock seed preserves the route error', async () => {
  const failure = new Error('document fetch failed');
  let seed;
  let removals = 0;
  const page = {
    async route(_matcher, handler) { seed = handler; },
    async unroute() { removals += 1; },
  };
  const remove = await installOneShotClock(page, 'http://127.0.0.1:1234/?e2e', FROZEN);
  await assert.rejects(seed({ async fetch() { throw failure; } }), (error) => error === failure);
  await assert.rejects(remove(), (error) => error === failure);
  assert.equal(removals, 0, 'a failed seed must not be treated as a fulfilled request');
});
