import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const satellite = require(resolve(repoRoot, 'frontend/node_modules/satellite.js'));

const FALLBACK_TLE = {
  line1: '1 25544U 98067A   26270.17419514  .00009528  00000+0  18291-3 0  9996',
  line2: '2 25544  51.6315 155.3455 0007168 193.0559 167.0244 15.48664528587569',
};

export const BOSTON_NADIR_EPOCH_MS = 1791309600000;

const BOSTON_NADIR_TLE = {
  line1: '1 25544U 98067A   26279.75000000  .00000000  00000-0  00000-0 0  9998',
  line2: '2 25544  51.6400  80.5900 0001000   0.0000 120.6800 15.48880433000002',
};

export function bostonTrackText(fixtureDir) {
  const track = JSON.parse(readFileSync(resolve(fixtureDir, 'track.json'), 'utf8'));
  const epoch = new Date(BOSTON_NADIR_EPOCH_MS).toISOString();
  track.tle = { line1: BOSTON_NADIR_TLE.line1, line2: BOSTON_NADIR_TLE.line2 };
  track.tle_epoch = epoch;
  track.tle_age_hours = 0;
  track.tle_freshness_factor = 1;
  track.iss_polynomial = {
    start: epoch,
    duration_seconds: 7200,
    lat_coeffs: [42.3604],
    lon_coeffs: [-71.0573],
    polynomial_order: 0,
  };
  return JSON.stringify(track);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function launchIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const QUEUE_HORIZON_MS = 90 * 60_000;
export const QUEUE_REEF_OFFSET_MS = 20 * 60_000;
export const QUEUE_DELTA_OFFSET_MS = 50 * 60_000;
export const CATALOG_NET_OFFSET_MS = 2 * 60 * 60_000;

const ZONED_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function fractionalMs(fraction) {
  if (!fraction) return 0;
  const digits = fraction.slice(1, 4).padEnd(3, '0');
  const ms = Number(digits);
  return Number.isInteger(ms) ? ms : Number.NaN;
}

function zonedEpoch(text) {
  const match = ZONED_STAMP.exec(text);
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const ms = fractionalMs(match[7]);
  const zone = match[8];
  if (!Number.isInteger(ms) || ms < 0 || ms > 999) return Number.NaN;
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second
    || check.getUTCMilliseconds() !== ms) {
    return Number.NaN;
  }
  if (zone === 'Z') return utc;
  const sign = zone.startsWith('-') ? -1 : 1;
  const zoneHour = Number(zone.slice(1, 3));
  const zoneMinute = Number(zone.slice(4, 6));
  if (zoneHour > 23 || zoneMinute > 59) return Number.NaN;
  return utc - sign * (zoneHour * 60 + zoneMinute) * 60_000;
}

export function driveStartMs(raw, wallMs) {
  const text = String(raw ?? '').trim();
  if (!text) return wallMs;
  if (!ZONED_STAMP.test(text)) {
    throw new Error(`OPD_VERIFY_DRIVE_START must be a zoned timestamp: ${text}`);
  }
  const parsed = zonedEpoch(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`OPD_VERIFY_DRIVE_START is not a valid date: ${text}`);
  }
  if (parsed + QUEUE_REEF_OFFSET_MS <= wallMs) {
    throw new Error(`OPD_VERIFY_DRIVE_START ${text} is expired at ${new Date(wallMs).toISOString()}`);
  }
  if (parsed + QUEUE_DELTA_OFFSET_MS >= wallMs + QUEUE_HORIZON_MS) {
    throw new Error(`OPD_VERIFY_DRIVE_START ${text} is outside the 90-minute horizon at ${new Date(wallMs).toISOString()}`);
  }
  return parsed;
}

export const FIXTURE_COOKIE = 'opd-verify-fixtures';

export function copyFixtureFiles(sourceDir, destDir) {
  const root = liveFixtureRoot(sourceDir);
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(root)) {
    if (name.startsWith('.')) continue;
    const from = join(root, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    copyFileSync(from, join(destDir, name));
  }
}

export function discardDriveFixtures(dir) {
  if (!dir) return;
  const parent = dirname(dir);
  const base = basename(dir);
  rmSync(dir, { recursive: true, force: true });
  if (!existsSync(parent)) return;
  for (const name of readdirSync(parent)) {
    if (name === base || name.startsWith(`${base}.`)) rmSync(join(parent, name), { recursive: true, force: true });
  }
}

export function publishDriveFixtures(sourceDir, eventStart, wallMs = Date.now()) {
  const dir = mkdtempSync(join(tmpdir(), 'opd-drive-fixtures-'));
  try {
    copyFixtureFiles(sourceDir, dir);
    stampEventTimes(dir, eventStart, wallMs);
    const launchValidUntil = refreshLaunchClock(dir, effectiveNowMs(dir, wallMs));
    return { dir, launchValidUntil };
  } catch (error) {
    discardDriveFixtures(dir);
    throw error;
  }
}

function eventInstants(start) {
  const launchBase = start + CATALOG_NET_OFFSET_MS;
  return {
    reef: launchIso(start + QUEUE_REEF_OFFSET_MS),
    delta: launchIso(start + QUEUE_DELTA_OFFSET_MS),
    mesa: launchIso(start + 8 * 60 * 60_000),
    keepsake: launchIso(start + 35 * 60_000),
    windowStart: launchIso(start + 30 * 60_000),
    windowEnd: launchIso(start + 40 * 60_000),
    sample: launchIso(start - 30_000),
    net: launchIso(launchBase),
    launchWindowEnd: launchIso(launchBase + 9 * 60_000),
    captureStart: launchIso(launchBase + 60_000),
    capturePeak: launchIso(launchBase + 4 * 60_000),
    captureEnd: launchIso(launchBase + 8 * 60_000),
    liftoffEnd: launchIso(launchBase + 60_000),
  };
}

export function writeTextAtomic(path, text, write = writeFileSync) {
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    write(tmp, text);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // No temp file was left to remove.
    }
    throw error;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function writeLockFile(lockPath, pid, link = linkSync) {
  const tmp = `${lockPath}.${pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, String(pid));
    link(tmp, lockPath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp lock file is already gone.
    }
    throw error;
  }
  try {
    unlinkSync(tmp);
  } catch {
    // The temp lock file is already gone.
  }
  return lockPath;
}

export function stealDeadLock(lockPath, observedPid) {
  if (pidAlive(observedPid)) return false;
  const claim = `${lockPath}.claim-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(lockPath, claim);
  } catch {
    return false;
  }
  let claimed = Number.NaN;
  try {
    claimed = Number(readFileSync(claim, 'utf8').trim());
  } catch {
    claimed = Number.NaN;
  }
  const matchesDead = claimed === observedPid && !pidAlive(claimed);
  if (!matchesDead) {
    try {
      linkSync(claim, lockPath);
    } catch {
      // A newer lock is already in place.
    }
  }
  try {
    unlinkSync(claim);
  } catch {
    // The claim file is already gone.
  }
  return matchesDead;
}

function releaseLock(lockPath, pid) {
  const claim = `${lockPath}.claim-${pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(lockPath, claim);
  } catch {
    return;
  }
  let claimed = Number.NaN;
  try {
    claimed = Number(readFileSync(claim, 'utf8').trim());
  } catch {
    claimed = Number.NaN;
  }
  if (claimed !== pid) {
    try {
      linkSync(claim, lockPath);
    } catch {
      // A newer lock is already in place.
    }
  }
  try {
    unlinkSync(claim);
  } catch {
    // The claim file is already gone.
  }
}

function acquireFixtureLock(dir) {
  const lockPath = `${dir}.writer.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return writeLockFile(lockPath, process.pid);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = Number.NaN;
      try {
        owner = Number(readFileSync(lockPath, 'utf8').trim());
      } catch {
        owner = Number.NaN;
      }
      if (!pidAlive(owner)) {
        stealDeadLock(lockPath, owner);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`fixture writer lock held by ${owner}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function withFixtureLock(dir, fn) {
  const lockPath = acquireFixtureLock(dir);
  try {
    return fn();
  } finally {
    releaseLock(lockPath, process.pid);
  }
}

export function liveFixtureRoot(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

export function readDriveClock(dir) {
  const file = join(liveFixtureRoot(dir), 'drive-clock.json');
  if (!existsSync(file)) return null;
  try {
    const body = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isFinite(body.start) || !Number.isFinite(body.startOffset)) return null;
    return { start: body.start, startOffset: body.startOffset };
  } catch {
    return null;
  }
}

export function effectiveNowMs(dir, wallMs = Date.now()) {
  const clock = readDriveClock(dir);
  if (!clock) return wallMs;
  return wallMs + clock.startOffset;
}

function listFiles(root) {
  const names = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith('.')) continue;
    const full = join(root, name);
    if (lstatSync(full).isFile()) names.push(name);
  }
  return names;
}

const BODY_NAMES = new Set([
  'passes.json',
  'top5.json',
  'top_24h.json',
  'track.json',
  'status.json',
  'targets.json',
  'cupola_windows.json',
  'tracked.json',
]);

function bodyUrl(name, sha) {
  return `v/verify/${sha}/${name}`;
}

function publishedEntry(name, entry) {
  return { path: bodyUrl(name, entry.sha256), sha256: entry.sha256, bytes: entry.bytes };
}

export function generationRoots(logicalDir) {
  const roots = [];
  const seen = new Set();
  const add = (root) => {
    if (!root || seen.has(root)) return;
    seen.add(root);
    roots.push(root);
  };
  try {
    add(realpathSync(logicalDir));
  } catch {
    // The directory is between generations.
  }
  const parent = dirname(logicalDir);
  const prefix = `${basename(logicalDir)}.gen-`;
  try {
    for (const name of readdirSync(parent)) {
      if (!name.startsWith(prefix)) continue;
      add(join(parent, name));
    }
  } catch {
    // The parent is gone.
  }
  return roots;
}

export function readBodyByHash(logicalDir, name, sha) {
  if (!BODY_NAMES.has(name) || !/^[a-f0-9]{64}$/.test(sha)) return null;
  for (const root of generationRoots(logicalDir)) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const body = readFileSync(file);
    if (sha256(body) === sha) return body;
  }
  return null;
}

export function bodyForRequestPath(logicalDir, urlPath) {
  const match = /^\/v\/verify\/([a-f0-9]{64})\/([^/]+)$/.exec(urlPath);
  if (!match) return null;
  return readBodyByHash(logicalDir, match[2], match[1]);
}

export function copyGeneration(logicalDir, sourceRoot, replacements, write = writeFileSync) {
  const next = `${logicalDir}.gen-${randomBytes(6).toString('hex')}`;
  mkdirSync(next);
  try {
    const names = new Set(listFiles(sourceRoot));
    for (const name of replacements.keys()) names.add(name);
    for (const name of names) {
      const text = replacements.has(name) ? replacements.get(name) : readFileSync(join(sourceRoot, name));
      write(join(next, name), text);
    }
    return next;
  } catch (error) {
    rmSync(next, { recursive: true, force: true });
    throw error;
  }
}

function stageGeneration(logicalDir, sourceRoot, replacements) {
  return copyGeneration(logicalDir, sourceRoot, replacements);
}

export function swapGenerationLink(logicalDir, next, rename = renameSync) {
  const link = `${logicalDir}.next-${randomBytes(4).toString('hex')}`;
  try {
    symlinkSync(next, link);
    rename(link, logicalDir);
  } catch (error) {
    try {
      unlinkSync(link);
    } catch {
      // The temp link is already gone.
    }
    throw error;
  }
}

function pruneGenerations(logicalDir, keep) {
  const parent = dirname(logicalDir);
  const prefix = `${basename(logicalDir)}.gen-`;
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(prefix)) continue;
    const full = join(parent, name);
    if (keep.has(full)) continue;
    rmSync(full, { recursive: true, force: true });
  }
}

function sealFixtureRoot(dir) {
  if (lstatSync(dir).isSymbolicLink()) return;
  const next = `${dir}.gen-${randomBytes(6).toString('hex')}`;
  renameSync(dir, next);
  try {
    symlinkSync(next, dir);
  } catch (error) {
    try {
      renameSync(next, dir);
    } catch {
      // The original directory could not be restored.
    }
    throw error;
  }
}

function switchToGeneration(logicalDir, next, previousRoot) {
  if (lstatSync(logicalDir).isSymbolicLink()) {
    swapGenerationLink(logicalDir, next);
  } else {
    const displaced = `${logicalDir}.displaced-${randomBytes(4).toString('hex')}`;
    renameSync(logicalDir, displaced);
    try {
      symlinkSync(next, logicalDir);
    } catch (error) {
      try {
        renameSync(displaced, logicalDir);
      } catch {
        // The original directory could not be restored.
      }
      throw error;
    }
    rmSync(displaced, { recursive: true, force: true });
  }
  const keep = new Set([next]);
  if (previousRoot && previousRoot !== logicalDir && previousRoot !== next) keep.add(previousRoot);
  pruneGenerations(logicalDir, keep);
}

function publishLocked(logicalDir, replacements) {
  const sourceRoot = liveFixtureRoot(logicalDir);
  const next = stageGeneration(logicalDir, sourceRoot, replacements);
  try {
    switchToGeneration(logicalDir, next, sourceRoot);
  } catch (error) {
    if (liveFixtureRoot(logicalDir) !== next) rmSync(next, { recursive: true, force: true });
    throw error;
  }
}

function wrapLon(lon) {
  let value = lon;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

function positionAt(satrec, ms) {
  const date = new Date(ms);
  const pv = satellite.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
  const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(date));
  const lat = satellite.degreesLat(geo.latitude);
  const lon = satellite.degreesLong(geo.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, altKm: geo.height };
}

async function loadTle() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE', {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`celestrak ${response.status}`);
    const lines = (await response.text()).trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const line1 = lines.find((line) => line.startsWith('1 '));
    const line2 = lines.find((line) => line.startsWith('2 '));
    if (!line1 || !line2) throw new Error('celestrak body had no TLE');
    return { line1, line2, source: 'celestrak' };
  } catch (error) {
    return {
      ...FALLBACK_TLE,
      source: 'fallback',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function loadStandInTle() {
  const url = 'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?FILE=starlink&FORMAT=tle';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`supgp starlink ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (text.split(/\r?\n/).filter((line) => line.trim()).length < 3 && text.length < 8000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel().catch(() => {});
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const name = lines.find((line) => !line.startsWith('1 ') && !line.startsWith('2 '));
    const line1 = lines.find((line) => line.startsWith('1 '));
    const line2 = lines.find((line) => line.startsWith('2 '));
    if (!name || !line1 || !line2) throw new Error('supgp starlink body had no TLE');
    return { name, line1, line2, source: 'supgp-starlink' };
  } finally {
    clearTimeout(timer);
  }
}

function tleEpochIso(satrec) {
  const year = satrec.epochyr + (satrec.epochyr < 57 ? 2000 : 1900);
  const ms = Date.UTC(year, 0, 1) + (satrec.epochdays - 1) * 86_400_000;
  return new Date(ms).toISOString();
}

function pass(spec) {
  return {
    target_id: spec.id,
    target_name: spec.name,
    target_regime: 'day',
    target_priority: 3,
    target_lat: spec.lat,
    target_lon: spec.lon,
    category: 'coast',
    water: true,
    closest_approach: spec.at,
    nadir_distance_km: 180,
    angle_off_nadir_deg: 12,
    iss_relative_bearing_deg: 90,
    pass_regime: 'day',
    obstruction_class: 'clear',
    p_unobstructed: 0.82,
    cloud_fraction: 0.12,
    cloud_source: 'gibs',
    sample_time: spec.generated,
    score: spec.score,
    score_components: {
      p_unobstructed: 0.82,
      regime_fit: 1,
      nadir_proximity: 0.9,
      priority_weight: 0.8,
      tle_freshness: 1,
    },
    iss_at_closest: { lat: spec.issLat, lon: spec.issLon, alt_km: 420 },
  };
}

function artifact(body) {
  const text = JSON.stringify(body);
  return { text, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

export async function buildFixtures(dir, now = Date.now(), eventStart = now) {
  mkdirSync(dir, { recursive: true });
  const tle = await loadTle();
  const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
  const hereNow = positionAt(satrec, now) ?? { lat: 0, lon: 0, altKm: 420 };
  const generated = launchIso(now - 30_000);
  const events = eventInstants(eventStart);
  const sample = events.sample;
  const queueAt = events.reef;
  const queueAt2 = events.delta;
  const upcomingAt = events.mesa;
  const keepsakeAt = events.keepsake;
  const reef = { lat: hereNow.lat, lon: wrapLon(hereNow.lon + 8) };
  const delta = { lat: hereNow.lat, lon: wrapLon(hereNow.lon + 12) };
  const mesa = { lat: hereNow.lat, lon: wrapLon(hereNow.lon - 12) };
  const pad = { lat: hereNow.lat, lon: wrapLon(hereNow.lon - 8) };
  const keepsake = { lat: hereNow.lat, lon: wrapLon(hereNow.lon + 4) };

  const top5 = [
    pass({ id: 'verify-reef', name: 'Verify Reef', ...reef, at: queueAt, score: 86, generated: sample, issLat: hereNow.lat, issLon: hereNow.lon }),
    pass({ id: 'verify-delta', name: 'Verify Delta', ...delta, at: queueAt2, score: 64, generated: sample, issLat: hereNow.lat, issLon: hereNow.lon }),
  ];
  const top24h = [
    pass({ id: 'verify-mesa', name: 'Verify Mesa', ...mesa, at: upcomingAt, score: 71, generated: sample, issLat: hereNow.lat, issLon: hereNow.lon }),
  ];
  const cupolaPass = {
    ...pass({ id: 'cupola:verify-window', name: 'Verify Keepsake', ...keepsake, at: keepsakeAt, score: 77, generated: sample, issLat: hereNow.lat, issLon: hereNow.lon }),
    golden_hour: true,
    water_pct: 0.45,
    window_start: events.windowStart,
    window_end: events.windowEnd,
  };
  const points = [];
  for (let t = 0; t <= 200 * 60; t += 30) {
    const pos = positionAt(satrec, now + t * 1000);
    if (!pos) continue;
    points.push([t, Number(pos.lat.toFixed(4)), Number(pos.lon.toFixed(4))]);
  }
  const epoch = tleEpochIso(satrec);
  const track = {
    iss_polynomial: {
      start: new Date(now).toISOString(),
      duration_seconds: 7200,
      lat_coeffs: [hereNow.lat],
      lon_coeffs: [hereNow.lon],
      polynomial_order: 0,
    },
    track_points: points,
    tle: { line1: tle.line1, line2: tle.line2 },
    tle_epoch: epoch,
    tle_age_hours: Math.abs(now - Date.parse(epoch)) / 3_600_000,
    tle_freshness_factor: 1,
  };
  const status = {
    last_run: generated,
    tick_minutes: 30,
    tle_age_hours: track.tle_age_hours,
    tle_freshness_factor: 1,
    cloud_source: 'gibs',
    cloud_composite_hour: generated,
    target_count: 3,
    pass_count: 3,
    version: 'verify',
    build_version: 'verify',
    launches_last_successful_fetch: generated,
    launches_count_upcoming: 1,
    launches_count_ascent_eligible: 1,
    launches_count_pass_opportunities: 1,
  };
  const targets = [
    { id: 'verify-reef', name: 'Verify Reef', geom: { type: 'point', lat: reef.lat, lon: reef.lon }, priority: 3, regime: 'day', category: 'coast' },
    { id: 'verify-delta', name: 'Verify Delta', geom: { type: 'point', lat: delta.lat, lon: delta.lon }, priority: 3, regime: 'day', category: 'coast' },
    { id: 'verify-mesa', name: 'Verify Mesa', geom: { type: 'point', lat: mesa.lat, lon: mesa.lon }, priority: 3, regime: 'day', category: 'terrain' },
  ];

  const net = events.net;
  const windowEnd = events.launchWindowEnd;
  const generatedLaunch = launchIso(now - 60_000);
  const pointerUntil = launchIso(now - 60_000 + 14 * 60_000);
  const assessmentUntil = launchIso(now - 60_000 + 2 * 60 * 60_000);
  const launchBody = {
    schema_version: 2,
    revision: 'verifyrev',
    generated_at: generatedLaunch,
    valid_until: pointerUntil,
    coverage: {
      complete: true,
      from: launchIso(now - 60 * 60_000),
      until: launchIso(now + 7 * 24 * 60 * 60_000),
      fetched_at: generatedLaunch,
      received: 1,
      parsed: 1,
      evaluated: 1,
      visible: 1,
      unevaluated: 0,
      reasons: [],
    },
    items: [
      {
        event_id: 'verify-ascent',
        revision: 'eventrev',
        name: 'Verify Ascent',
        rocket: 'Verify Rocket',
        site: { name: 'Verify Pad', lat: pad.lat, lon: pad.lon },
        status: 'geometry_supported',
        reason_codes: [],
        launch_window: { net, start: net, end: windowEnd, precision: 'second' },
        capture_intervals: [
          {
            start: events.captureStart,
            peak: events.capturePeak,
            end: events.captureEnd,
            liftoff_start: net,
            liftoff_end: events.liftoffEnd,
            look: { frame: 'orbital-lvlh', azimuth_deg: 45, off_nadir_deg: 55 },
          },
        ],
        trajectory: {
          quality: 'verified',
          source: 'Verification fixture',
          points: [
            { lat: pad.lat, lon: pad.lon, alt_km: 0, t_offset_seconds: 0 },
            { lat: pad.lat + 0.4, lon: wrapLon(pad.lon + 0.4), alt_km: 40, t_offset_seconds: 60 },
          ],
        },
        sources: [{ kind: 'schedule', url: 'https://example.org/verify-ascent', fetched_at: generatedLaunch }],
        assessment: {
          checked_at: generatedLaunch,
          valid_until: assessmentUntil,
          tle_epoch: generatedLaunch,
          model: { name: 'Nominal ascent envelope', duration_seconds: 600, max_altitude_km: 400, max_downrange_km: 1500 },
          net: {
            verdict: 'possible',
            reason: 'PAD_CLOSEST_APPROACH',
            at: net,
            pad_distance_km: 150,
            t_offset_seconds: 0,
            look: { frame: 'orbital-lvlh', azimuth_deg: 45, off_nadir_deg: 55 },
          },
          window: { verdict: 'unknown', reason: 'VIEW_UNCONFIRMED' },
        },
      },
      {
        event_id: 'verify-horizon',
        revision: 'eventrev-horizon',
        name: 'Verify Horizon',
        rocket: 'Verify Rocket',
        site: { name: 'Verify Coast', lat: hereNow.lat + 0.3, lon: hereNow.lon },
        status: 'map_only',
        reason_codes: ['TIME_PRECISION_COARSE'],
        launch_window: { net, start: net, end: windowEnd, precision: 'hour' },
        capture_intervals: [],
        trajectory: { quality: 'unknown', source: null, points: [] },
        sources: [{ kind: 'schedule', url: 'https://example.org/verify-horizon', fetched_at: generatedLaunch }],
      },
    ],
  };

  const requestedTracked = process.env.OPD_VERIFY_TRACKED || '';
  const trackedMode = ['elements', 'aged_out', 'missing', 'lookup_failed'].includes(requestedTracked) ? requestedTracked : 'unavailable';
  let standIn = null;
  let tracked = null;
  if (trackedMode === 'elements') {
    standIn = await loadStandInTle();
    const standRec = satellite.twoline2satrec(standIn.line1, standIn.line2);
    const standEpoch = tleEpochIso(standRec);
    tracked = {
      objects: [{
        id: 'starship',
        label: 'Starship',
        color: '#ff5c5c',
        state: 'elements',
        source: 'supgp',
        name: standIn.name,
        norad: Number(standIn.line1.slice(2, 7)),
        intldes: standIn.line1.slice(9, 17).trim(),
        line1: standIn.line1,
        line2: standIn.line2,
        epoch: standEpoch,
        age_hours: Math.round((Math.abs(now - Date.parse(standEpoch)) / 3_600_000) * 100) / 100,
      }],
    };
  } else if (trackedMode !== 'missing') {
    tracked = {
      objects: [{
        id: 'starship',
        label: 'Starship',
        color: '#ff5c5c',
        state: 'unavailable',
        reason: trackedMode === 'aged_out' || trackedMode === 'lookup_failed' ? trackedMode : 'no_public_orbit',
      }],
    };
  }

  const files = {
    'passes.json': artifact([...top5, ...top24h]),
    'top5.json': artifact(top5),
    'top_24h.json': artifact(top24h),
    'track.json': artifact(track),
    'status.json': artifact(status),
    'targets.json': artifact(targets),
    'cupola_windows.json': artifact({ version: 'verify', generated_at: generated, windows: [cupolaPass] }),
    'launch.json': artifact(launchBody),
  };
  if (tracked) files['tracked.json'] = artifact(tracked);
  for (const [name, entry] of Object.entries(files)) {
    writeFileSync(resolve(dir, name), entry.text);
  }
  const manifest = {
    version: `verify-${now}`,
    generated_at: new Date(now - 30_000).toISOString(),
    tle_epoch: epoch,
    cloud_composite_hour: generated,
    target_data_version: 'verify',
    build_version: 'verify',
    freshness: { tle_hours: 0.1, cloud_hours: 0.1, ok: true },
    artifacts: {
      passes: publishedEntry('passes.json', files['passes.json']),
      top5: publishedEntry('top5.json', files['top5.json']),
      top_24h: publishedEntry('top_24h.json', files['top_24h.json']),
      track: publishedEntry('track.json', files['track.json']),
      status: publishedEntry('status.json', files['status.json']),
      targets: publishedEntry('targets.json', files['targets.json']),
      cupola_windows: publishedEntry('cupola_windows.json', files['cupola_windows.json']),
    },
  };
  if (files['tracked.json']) {
    manifest.artifacts.tracked = {
      path: bodyUrl('tracked.json', files['tracked.json'].sha256),
      sha256: files['tracked.json'].sha256,
      bytes: files['tracked.json'].bytes,
    };
  }
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest));
  const launchText = files['launch.json'].text;
  const pointer = {
    schema_version: 2,
    revision: 'verifyrev',
    generated_at: generatedLaunch,
    valid_until: pointerUntil,
    path: 'launch/v/verifyrev.json',
    sha256: sha256(launchText),
  };
  writeFileSync(resolve(dir, 'launch-latest.json'), JSON.stringify(pointer));
  const catalog = {
    schema_version: 3,
    revision: 'verify-catalog',
    generated_at: generatedLaunch,
    schedule_valid_until: assessmentUntil,
    geometry_valid_until: pointerUntil,
    coverage: {
      from: launchIso(now - 60 * 60_000),
      until: launchIso(now + 14 * 24 * 60 * 60_000),
    },
    items: [
      {
        event_id: 'verify-ascent',
        name: 'Verify Ascent',
        schedule: { net, window_start: net, window_end: windowEnd },
        shots: [{ liftoff: net, start: net, best: events.captureStart, end: events.captureEnd }],
      },
    ],
  };
  writeFileSync(resolve(dir, 'catalog.json'), JSON.stringify(catalog));
  writeFileSync(resolve(dir, 'catalog-clock.json'), JSON.stringify({ anchor: eventStart }));
  const meta = {
    now,
    tleSource: tle.source,
    tleError: tle.error ?? null,
    lookupTimestamp: new Date(now).toISOString(),
    iss: hereNow,
    reef,
    delta,
    mesa,
    pad,
    names: {
      queue: ['Verify Reef', 'Verify Delta'],
      upcoming: ['Verify Mesa'],
      keepsake: 'Verify Keepsake',
      launch: 'Verify Ascent',
    },
    launchValidUntil: pointerUntil,
    trackedMode,
    standIn: standIn ? standIn.name : null,
  };
  writeFileSync(resolve(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  sealFixtureRoot(dir);
  return { manifest, meta, pointer, launchBody };
}

export function refreshLaunchClock(dir, nowMs = Date.now()) {
  return withFixtureLock(dir, () => {
    const root = liveFixtureRoot(dir);
    const launch = JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8'));
    const generated = new Date(nowMs - 60_000).toISOString();
    const until = new Date(nowMs - 60_000 + 14 * 60_000).toISOString();
    const assessmentUntil = new Date(nowMs - 60_000 + 2 * 60 * 60_000).toISOString();
    launch.generated_at = generated;
    launch.valid_until = until;
    if (launch.coverage) launch.coverage.fetched_at = generated;
    for (const item of launch.items || []) {
      for (const source of item.sources || []) source.fetched_at = generated;
      if (item.assessment) {
        item.assessment.checked_at = generated;
        item.assessment.valid_until = assessmentUntil;
        item.assessment.tle_epoch = generated;
      }
    }
    const text = JSON.stringify(launch);
    const pointer = JSON.parse(readFileSync(join(root, 'launch-latest.json'), 'utf8'));
    pointer.generated_at = generated;
    pointer.valid_until = until;
    pointer.sha256 = sha256(text);
    publishLocked(dir, new Map([
      ['launch.json', text],
      ['launch-latest.json', JSON.stringify(pointer)],
    ]));
    return until;
  });
}

const PASS_EVENT = {
  'verify-reef': 'reef',
  'verify-delta': 'delta',
  'verify-mesa': 'mesa',
  'cupola:verify-window': 'keepsake',
};

function stampPassList(passes, times) {
  for (const pass of passes) {
    const key = PASS_EVENT[pass.target_id];
    if (!key) continue;
    pass.closest_approach = times[key];
    pass.sample_time = times.sample;
    if (pass.target_id === 'cupola:verify-window') {
      pass.window_start = times.windowStart;
      pass.window_end = times.windowEnd;
    }
  }
}

function stampLaunchBody(launch, times) {
  for (const item of launch.items || []) {
    if (item.launch_window) {
      item.launch_window.net = times.net;
      item.launch_window.start = times.net;
      item.launch_window.end = times.launchWindowEnd;
    }
    for (const interval of item.capture_intervals || []) {
      interval.start = times.captureStart;
      interval.peak = times.capturePeak;
      interval.end = times.captureEnd;
      interval.liftoff_start = times.net;
      interval.liftoff_end = times.liftoffEnd;
    }
    if (item.assessment?.net) item.assessment.net.at = times.net;
  }
}

function stampCatalogBody(catalog, times) {
  for (const item of catalog.items || []) {
    if (item.schedule) {
      item.schedule.net = times.net;
      item.schedule.window_start = times.net;
      item.schedule.window_end = times.launchWindowEnd;
    }
    for (const shot of item.shots || []) {
      shot.liftoff = times.net;
      shot.start = times.net;
      shot.best = times.captureStart;
      shot.end = times.captureEnd;
    }
  }
}

const MANIFEST_FILES = {
  passes: 'passes.json',
  top5: 'top5.json',
  top_24h: 'top_24h.json',
  cupola_windows: 'cupola_windows.json',
};

export function stampEventTimes(dir, eventStart, wallMs = eventStart) {
  return withFixtureLock(dir, () => {
    const times = eventInstants(eventStart);
    const root = liveFixtureRoot(dir);
    const read = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'));
    const passes = read('passes.json');
    const top5 = read('top5.json');
    const top24 = read('top_24h.json');
    const cupola = read('cupola_windows.json');
    const launch = read('launch.json');
    stampPassList(passes, times);
    stampPassList(top5, times);
    stampPassList(top24, times);
    stampPassList(cupola.windows, times);
    stampLaunchBody(launch, times);
    const files = new Map();
    const put = (name, body) => {
      const entry = artifact(body);
      files.set(name, entry.text);
      return entry;
    };
    const written = {
      passes: put('passes.json', passes),
      top5: put('top5.json', top5),
      top_24h: put('top_24h.json', top24),
      cupola_windows: put('cupola_windows.json', cupola),
      launch: put('launch.json', launch),
    };
    if (existsSync(join(root, 'catalog.json'))) {
      const catalog = read('catalog.json');
      stampCatalogBody(catalog, times);
      files.set('catalog.json', JSON.stringify(catalog));
      files.set('catalog-clock.json', JSON.stringify({ anchor: eventStart }));
    }
    const manifest = read('manifest.json');
    for (const key of Object.keys(MANIFEST_FILES)) {
      manifest.artifacts[key].sha256 = written[key].sha256;
      manifest.artifacts[key].bytes = written[key].bytes;
      manifest.artifacts[key].path = bodyUrl(MANIFEST_FILES[key], written[key].sha256);
    }
    files.set('manifest.json', JSON.stringify(manifest));
    const pointer = read('launch-latest.json');
    pointer.sha256 = written.launch.sha256;
    files.set('launch-latest.json', JSON.stringify(pointer));
    files.set('drive-clock.json', JSON.stringify({ start: eventStart, startOffset: eventStart - wallMs }));
    publishLocked(dir, files);
    return times;
  });
}

const isDirect = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirect) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: fixtures.mjs <dir>');
    process.exit(2);
  }
  const built = await buildFixtures(dir);
  console.log(JSON.stringify({ tleSource: built.meta.tleSource, launchValidUntil: built.meta.launchValidUntil }));
}
