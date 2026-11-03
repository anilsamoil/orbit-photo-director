import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { catalogFreezeTime } from './drive.mjs';

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
  const freeze = drive.slice(drive.indexOf("'iss-all-launches'"), drive.indexOf('freezeFixtureClock.toString()'));
  assert.match(freeze, /acceptedPath/);
  assert.doesNotMatch(freeze, /getEntriesByType/);
});
