import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FIXTURE_COOKIE } from './fixtures.mjs';
import { closeFixtureBrowsers } from './fixture-session.mjs';
import { driveQueueLightning, installLightningPasses, LIGHTNING_CASES, lightningFailures, lightningPlan } from './queue-lightning.mjs';

const require = createRequire(new URL('../../../../frontend/package.json', import.meta.url));
const { webkit } = require('playwright');

function card(id, chip, extra = {}) {
  const item = LIGHTNING_CASES.find((entry) => entry.id === id);
  return {
    id,
    name: item.name,
    rendered: true,
    text: chip ? `⚡ ${chip}` : '',
    clip: false,
    overlap: '',
    inside: true,
    ...extra,
  };
}

function sample(overrides = {}) {
  return {
    view: 'view-queue',
    cards: LIGHTNING_CASES.map((item) => card(item.id, item.chip)),
    ...overrides,
  };
}

function writeFixture(dir) {
  const reef = {
    target_id: 'verify-reef',
    target_name: 'Verify Reef',
    closest_approach: '2026-11-01T12:20:00Z',
    nadir_distance_km: 180,
    score: 86,
  };
  const top5 = JSON.stringify([reef, { ...reef, target_id: 'verify-delta', target_name: 'Verify Delta' }]);
  writeFileSync(join(dir, 'top5.json'), top5);
  writeFileSync(join(dir, 'passes.json'), '[]');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    artifacts: { top5: { sha256: 'old', bytes: 1, path: 'v/verify/old/top5.json' } },
  }));
  writeFileSync(join(dir, 'drive-clock.json'), JSON.stringify({ start: Date.parse('2026-11-01T12:00:00Z'), startOffset: 0 }));
}

test('queue-lightning accepts the three WebKit sizes', () => {
  assert.equal(lightningPlan('iphone-17-pro', '402x874').id, 'webkit-iphone-17-pro-402x874');
  assert.equal(lightningPlan('ipad-pro-11', '1210x834').id, 'webkit-ipad-m4-1210x834');
  assert.equal(lightningPlan('desktop', '1440x900').id, 'webkit-desktop-1440x900');
  assert.equal(lightningPlan('desktop', '1440x900').desktop, true);
  assert.throws(() => lightningPlan('iphone-17-pro', '874x402'), /one WebKit process per surface/);
  assert.throws(() => lightningPlan('ipad-pro-11', '834x1210'), /one WebKit process per surface/);
  assert.throws(() => lightningPlan('desktop', '1280x800'), /one WebKit process per surface/);
  assert.throws(() => lightningPlan('iphone-13', '390x844'), /one WebKit process per surface/);
  assert.throws(() => lightningPlan('', ''), /one WebKit process per surface/);
});

test('queue-lightning requires the chip text and a card that does not clip', () => {
  assert.deepEqual(lightningFailures(sample()), []);
  assert.deepEqual(lightningFailures(null), ['queue lightning sample missing']);
  assert.match(lightningFailures(sample({ view: 'view-map' })).join('\n'), /view view-map/);
  assert.match(lightningFailures(sample({
    cards: sample().cards.map((entry) => entry.id === 'verify-glm-2m' ? { ...entry, text: '⚡ lightning forecast' } : entry),
  })).join('\n'), /verify-glm-2m chip/);
  assert.match(lightningFailures(sample({
    cards: sample().cards.map((entry) => entry.id === 'verify-glm-nodata' ? { ...entry, text: '⚡ lightning forecast' } : entry),
  })).join('\n'), /verify-glm-nodata chip/);
  assert.match(lightningFailures(sample({
    cards: sample().cards.map((entry) => entry.id === 'verify-potential-floor' ? { ...entry, text: '⚡ observed lightning flashes' } : entry),
  })).join('\n'), /verify-potential-floor chip/);
  assert.match(lightningFailures(sample({
    cards: sample().cards.map((entry) => entry.id === 'verify-glm-45m' ? { ...entry, clip: true } : entry),
  })).join('\n'), /verify-glm-45m clips/);
  assert.match(lightningFailures(sample({
    cards: sample().cards.map((entry) => entry.id === 'verify-gfs-cape' ? { ...entry, overlap: 'tag regime-day' } : entry),
  })).join('\n'), /verify-gfs-cape overlaps/);
  assert.match(lightningFailures(sample({
    cards: sample().cards.map((entry) => entry.id === 'verify-glm-quiet' ? { ...entry, inside: false } : entry),
  })).join('\n'), /verify-glm-quiet leaves the card/);
  assert.match(lightningFailures(sample({
    cards: sample().cards.filter((entry) => entry.id !== 'verify-potential-zero'),
  })).join('\n'), /verify-potential-zero missing/);
  assert.match(lightningFailures(sample({
    cards: sample().cards.map((entry) => entry.id === 'verify-glm-nodata' ? { ...entry, rendered: false } : entry),
  })).join('\n'), /verify-glm-nodata did not render/);
});

test('installLightningPasses stamps the private top5 and leaves passes.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opd-queue-lightning-'));
  try {
    writeFixture(dir);
    const installed = installLightningPasses(dir);
    const top5 = JSON.parse(readFileSync(join(dir, 'top5.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const text = readFileSync(join(dir, 'top5.json'));
    assert.equal(readFileSync(join(dir, 'passes.json'), 'utf8'), '[]');
    assert.equal(top5.length, installed.count);
    assert.equal(top5.some((pass) => pass.target_id === 'verify-reef'), false);
    const fresh = top5.find((pass) => pass.target_id === 'verify-glm-2m');
    const cape = top5.find((pass) => pass.target_id === 'verify-gfs-cape');
    const quiet = top5.find((pass) => pass.target_id === 'verify-glm-quiet');
    const zero = top5.find((pass) => pass.target_id === 'verify-potential-zero');
    const nodata = top5.find((pass) => pass.target_id === 'verify-glm-nodata');
    const stale = top5.find((pass) => pass.target_id === 'verify-glm-45m');
    const floor = top5.find((pass) => pass.target_id === 'verify-potential-floor');
    assert.equal(fresh.lightning_source, 'glm-2m');
    assert.equal(fresh.flash_rate_per_min, 4);
    assert.ok(fresh.lightning_potential > 0.05);
    assert.equal(cape.lightning_source, 'gfs-cape');
    assert.equal(cape.flash_rate_per_min, 0);
    assert.equal(quiet.lightning_source, 'glm-5m');
    assert.equal(quiet.flash_rate_per_min, 0);
    assert.equal(zero.lightning_potential, 0);
    assert.equal(nodata.lightning_source, 'glm-no-data');
    assert.equal(nodata.lightning_potential, 0);
    assert.equal(stale.lightning_source, 'glm-45m');
    assert.ok(stale.flash_rate_per_min > 0);
    assert.equal(floor.lightning_potential, 0.05);
    assert.ok(Date.parse(fresh.closest_approach) > Date.parse('2026-11-01T12:00:00Z'));
    assert.ok(Date.parse(floor.closest_approach) < Date.parse('2026-11-01T13:30:00Z'));
    assert.equal(manifest.artifacts.top5.sha256, createHash('sha256').update(text).digest('hex'));
    assert.equal(manifest.artifacts.top5.path, `v/verify/${manifest.artifacts.top5.sha256}/top5.json`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drive queue-lightning pins its private fixture cookie before creating a page', async (t) => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'opd-queue-lightning-drive-'));
  const fixtureDir = mkdtempSync(join(tmpdir(), 'opd-queue-lightning-fx-'));
  writeFixture(fixtureDir);
  t.after(() => {
    rmSync(evidenceDir, { recursive: true, force: true });
    rmSync(fixtureDir, { recursive: true, force: true });
  });
  const prior = { surface: process.env.OPD_VERIFY_SURFACE, viewport: process.env.OPD_VERIFY_VIEWPORT };
  process.env.OPD_VERIFY_SURFACE = 'iphone-17-pro';
  process.env.OPD_VERIFY_VIEWPORT = '402x874';
  t.after(() => {
    for (const [key, value] of Object.entries({ OPD_VERIFY_SURFACE: prior.surface, OPD_VERIFY_VIEWPORT: prior.viewport })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const baseUrl = 'http://127.0.0.1:12345';
  const fixtureToken = 'test-private-fixture';
  const stopped = new Error('browser boundary reached');
  const jar = [];
  const context = {
    async addCookies(cookies) { jar.push(...cookies); },
    async addInitScript() {},
    async newPage() {
      assert.equal(jar.some((cookie) => cookie.name === FIXTURE_COOKIE && cookie.value === fixtureToken && cookie.url === baseUrl), true);
      const top5 = JSON.parse(readFileSync(join(fixtureDir, 'top5.json'), 'utf8'));
      assert.equal(top5.some((pass) => pass.target_id === 'verify-glm-2m'), true);
      throw stopped;
    },
    async close() {},
  };
  const browser = { async newContext() { return context; }, async close() {} };
  t.mock.method(webkit, 'launch', async () => browser);
  await assert.rejects(
    driveQueueLightning({ baseUrl, evidenceDir, fixtureDir, fixtureToken, startOffset: 0 }),
    (error) => error === stopped,
  );
  await closeFixtureBrowsers();
});
