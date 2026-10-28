import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { serveSnap } from './context-state-fixture.mjs';

test('SNAP fixture serves manifest and launch content-addressed bodies and rejects missing hashes', async () => {
  const served = await serveSnap();
  try {
    const manifest = await (await fetch(`${served.url}/manifest.json`)).json();
    const launch = await (await fetch(`${served.url}/launch/latest.json`)).json();
    for (const [name, pointer] of [...Object.entries(manifest.artifacts), ['launch', launch]]) {
      const response = await fetch(`${served.url}/${pointer.path}`);
      assert.equal(response.status, 200, name);
      assert.match(response.headers.get('content-type'), /^application\/json\b/, name);
      const body = await response.text();
      assert.equal(createHash('sha256').update(body).digest('hex'), pointer.sha256, `${name} immutable body`);
      const parsed = JSON.parse(body);
      if (name === 'launch') assert.equal(parsed.revision, launch.revision);
    }
    for (const path of [`/v/verify/${'0'.repeat(64)}/top5.json`, `/launch/v/${'0'.repeat(64)}.json`]) {
      const response = await fetch(`${served.url}${path}`);
      assert.equal(response.status, 404, path);
      assert.match(response.headers.get('content-type'), /^application\/json\b/, 'missing body must not fall through to the Vite page');
      assert.deepEqual(await response.json(), {});
    }
  } finally {
    await served.close();
  }
});
