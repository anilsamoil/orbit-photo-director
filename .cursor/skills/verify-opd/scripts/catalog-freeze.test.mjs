import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { catalogFreezeTime, nextPinFreeze, pollPinnedCatalog, settleCatalogFreeze } from './drive.mjs';

test('a renewed catalog is the frozen clock after the original request leaves the 250 entry buffer', () => {
  const original = 'http://127.0.0.1:41731/launch/catalog/v/c1000-50.json';
  const older = 'http://127.0.0.1:41731/launch/catalog/v/c1500-50.json';
  const accepted = 'launch/catalog/v/c2000-50.json';
  const entries = [{ name: original }, { name: older }];
  for (let index = 0; index < 249; index += 1) entries.push({ name: `http://127.0.0.1:41731/assets/${index}.js` });
  const capped = entries.slice(-250);
  assert.equal(capped.some((entry) => entry.name.includes('c1000')), false);
  assert.equal(capped.some((entry) => entry.name.includes('c1500')), true);
  assert.equal(catalogFreezeTime(capped, accepted), 2000);
  const drive = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8');
  const start = drive.indexOf("'iss-all-launches'");
  const freeze = drive.slice(start, drive.indexOf('freezeFixtureClock.toString()', start));
  assert.match(freeze, /acceptedPath/);
  assert.doesNotMatch(freeze, /getEntriesByType/);
});

test('a delayed catalog response freezes the catalog that lands, not the one already held', async () => {
  let path = 'launch/catalog/v/c1000-1.json';
  let release = () => {};
  const catalog = {
    inFlight: new Promise((resolve) => {
      release = () => {
        path = 'launch/catalog/v/c2000-1.json';
        catalog.inFlight = null;
        resolve();
      };
    }),
    acceptedPath: () => path,
    async settledPath() {
      let guard = 0;
      while (this.inFlight && guard < 4) {
        const flight = this.inFlight;
        guard += 1;
        await flight;
      }
      return this.acceptedPath();
    },
  };
  const applied = [];
  const pending = settleCatalogFreeze(catalog, (instant) => applied.push(instant));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(applied.length, 0);
  release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.frozen, 2000);
  assert.deepEqual(applied, [2000]);
  const drive = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8');
  const start = drive.indexOf("'iss-all-launches'");
  const region = drive.slice(start, drive.indexOf('iss all launches pin in frame', start));
  assert.equal(region.split('freezeAccepted()').length - 1, 2);
  assert.match(region, /settleCatalogFreeze/);
  assert.match(region, /!pin/);
});

test('a catalog that arrives after the final freeze is frozen again before the pin is accepted', async () => {
  let path = 'launch/catalog/v/c1000-1.json';
  let now = 0;
  const applied = [];
  const result = await pollPinnedCatalog({
    now: () => now,
    sleep: async (ms) => { now += ms; },
    deadlineMs: 15000,
    readStep: async (lastPath) => {
      if (now >= 400) path = 'launch/catalog/v/c2000-1.json';
      const decision = nextPinFreeze(lastPath, path);
      if (!decision.ok) return decision;
      if (decision.refroze) applied.push(decision.frozen);
      const pin = applied.at(-1) === 2000
        ? { ok: true, pin: true }
        : { pressed: true, name: 'Verify Horizon', pin: false };
      return { path: decision.path, frozen: decision.frozen, refroze: decision.refroze, pin };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.pin, true);
  assert.deepEqual(applied, [1000, 2000]);
  const drive = readFileSync(new URL('./drive.mjs', import.meta.url), 'utf8');
  const start = drive.indexOf('const pinFreeze');
  const region = drive.slice(start, drive.indexOf("'iss all launches pin in frame'", start));
  assert.match(region, /pollPinnedCatalog/);
  assert.match(region, /nextPinFreeze/);
  assert.match(region, /if \(decision\.refroze\) freezeFixtureClock\(decision\.frozen\)/);
  assert.match(region, /!pin/);
  assert.equal(region.split('freezeAccepted()').length - 1, 1);
});
