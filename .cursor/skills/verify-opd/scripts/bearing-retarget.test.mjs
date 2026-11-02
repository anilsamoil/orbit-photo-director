import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { bearingPlan, bearingSamples, installBearingTrack } from './bearing-retarget.mjs';

test('map-bearing accepts the four standing surfaces and no other size', () => {
  assert.equal(bearingPlan('iphone-17-pro', '402x874').id, 'webkit-iphone-17-pro-402x874');
  assert.equal(bearingPlan('ipad-pro-11', '834x1210').engine, 'webkit');
  assert.equal(bearingPlan('ipad-pro-11', '1210x834').id, 'webkit-ipad-m4-1210x834');
  assert.equal(bearingPlan('chrome', '402x874').engine, 'chrome');
  assert.throws(() => bearingPlan('iphone-17-pro', '874x402'), /one surface per process/);
  assert.throws(() => bearingPlan('desktop', '1440x900'), /one surface per process/);
  assert.throws(() => bearingPlan('all', '402x874'), /one surface per process/);
  assert.throws(() => bearingPlan('', ''), /one surface per process/);
});

test('the standing track moves east so an order-0 verify polynomial is not the ease', () => {
  const { here, ahead } = bearingSamples();
  assert.ok(here && ahead);
  assert.equal(here.lat, ahead.lat);
  assert.ok(ahead.lon - here.lon > 1);
});

test('the bearing drive replaces the manifest track with matching immutable bytes', async (t) => {
  const source = JSON.stringify({ tle: { line1: 'one', line2: 'two' }, iss_polynomial: {} });
  const hash = (body) => createHash('sha256').update(body).digest('hex');
  const sourcePath = `v/verify/${hash(source)}/track.json`;
  const server = createServer((req, res) => {
    if (req.url === '/manifest.json') {
      res.end(JSON.stringify({ artifacts: { track: { path: sourcePath, sha256: hash(source), bytes: Buffer.byteLength(source) } } }));
    } else if (req.url === `/${sourcePath}`) res.end(source);
    else { res.writeHead(404); res.end('missing'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let handler;
  await installBearingTrack({ route: async (_pattern, callback) => { handler = callback; } }, origin);
  const request = async (path) => {
    let fulfilled;
    await handler({
      request: () => ({ url: () => `${origin}/${path}` }),
      fetch: () => fetch(`${origin}/${path}`),
      fulfill: async (value) => { fulfilled = value; },
      continue: async () => assert.fail(`fixture request escaped routing: ${path}`),
    });
    assert.equal(fulfilled.status, 200);
    return fulfilled.body;
  };
  const manifest = JSON.parse(await request('manifest.json'));
  const entry = manifest.artifacts.track;
  const body = await request(entry.path);
  assert.notEqual(entry.path, sourcePath);
  assert.equal(entry.path, `v/verify/${hash(body)}/track.json`);
  assert.equal(entry.sha256, hash(body));
  assert.equal(entry.bytes, Buffer.byteLength(body));
  assert.deepEqual(JSON.parse(body).tle, JSON.parse(source).tle);
  assert.deepEqual(JSON.parse(body).iss_polynomial.lon_coeffs, [0.05, 20]);
});
