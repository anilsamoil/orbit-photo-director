import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
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

export const SESSION_MARGIN_MS = 6 * 60 * 60 * 1000;

export function driveStartMs(raw, wallMs) {
  const text = String(raw ?? '').trim();
  if (!text) return wallMs;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`OPD_VERIFY_DRIVE_START is not a time: ${text}`);
  return parsed;
}

function eventInstants(start) {
  const launchBase = start + SESSION_MARGIN_MS + 30 * 60_000;
  return {
    reef: launchIso(start + SESSION_MARGIN_MS + 20 * 60_000),
    delta: launchIso(start + SESSION_MARGIN_MS + 50 * 60_000),
    mesa: launchIso(start + 8 * 60 * 60_000),
    keepsake: launchIso(start + SESSION_MARGIN_MS + 35 * 60_000),
    windowStart: launchIso(start + SESSION_MARGIN_MS + 30 * 60_000),
    windowEnd: launchIso(start + SESSION_MARGIN_MS + 40 * 60_000),
    net: launchIso(launchBase),
    launchWindowEnd: launchIso(launchBase + 9 * 60_000),
    captureStart: launchIso(launchBase + 60_000),
    capturePeak: launchIso(launchBase + 4 * 60_000),
    captureEnd: launchIso(launchBase + 8 * 60_000),
    liftoffEnd: launchIso(launchBase + 60_000),
  };
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
    pass({ id: 'verify-reef', name: 'Verify Reef', ...reef, at: queueAt, score: 86, generated, issLat: hereNow.lat, issLon: hereNow.lon }),
    pass({ id: 'verify-delta', name: 'Verify Delta', ...delta, at: queueAt2, score: 64, generated, issLat: hereNow.lat, issLon: hereNow.lon }),
  ];
  const top24h = [
    pass({ id: 'verify-mesa', name: 'Verify Mesa', ...mesa, at: upcomingAt, score: 71, generated, issLat: hereNow.lat, issLon: hereNow.lon }),
  ];
  const cupolaPass = {
    ...pass({ id: 'cupola:verify-window', name: 'Verify Keepsake', ...keepsake, at: keepsakeAt, score: 77, generated, issLat: hereNow.lat, issLon: hereNow.lon }),
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
      passes: { path: 'v/verify/passes.json', sha256: files['passes.json'].sha256, bytes: files['passes.json'].bytes },
      top5: { path: 'v/verify/top5.json', sha256: files['top5.json'].sha256, bytes: files['top5.json'].bytes },
      top_24h: { path: 'v/verify/top_24h.json', sha256: files['top_24h.json'].sha256, bytes: files['top_24h.json'].bytes },
      track: { path: 'v/verify/track.json', sha256: files['track.json'].sha256, bytes: files['track.json'].bytes },
      status: { path: 'v/verify/status.json', sha256: files['status.json'].sha256, bytes: files['status.json'].bytes },
      targets: { path: 'v/verify/targets.json', sha256: files['targets.json'].sha256, bytes: files['targets.json'].bytes },
      cupola_windows: { path: 'v/verify/cupola_windows.json', sha256: files['cupola_windows.json'].sha256, bytes: files['cupola_windows.json'].bytes },
    },
  };
  if (files['tracked.json']) {
    manifest.artifacts.tracked = {
      path: 'v/verify/tracked.json',
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
  return { manifest, meta, pointer, launchBody };
}

export function refreshLaunchClock(dir, wallMs = Date.now()) {
  const launchPath = resolve(dir, 'launch.json');
  const pointerPath = resolve(dir, 'launch-latest.json');
  const launch = JSON.parse(readFileSync(launchPath, 'utf8'));
  const generated = new Date(wallMs - 60_000).toISOString();
  const until = new Date(wallMs - 60_000 + 14 * 60_000).toISOString();
  const assessmentUntil = new Date(wallMs - 60_000 + 2 * 60 * 60_000).toISOString();
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
  writeFileSync(launchPath, text);
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  pointer.generated_at = generated;
  pointer.valid_until = until;
  pointer.sha256 = sha256(text);
  writeFileSync(pointerPath, JSON.stringify(pointer));
  return until;
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

function writeJson(dir, name, body) {
  const entry = artifact(body);
  writeFileSync(resolve(dir, name), entry.text);
  return entry;
}

export function stampEventTimes(dir, eventStart) {
  const times = eventInstants(eventStart);
  const passes = JSON.parse(readFileSync(resolve(dir, 'passes.json'), 'utf8'));
  const top5 = JSON.parse(readFileSync(resolve(dir, 'top5.json'), 'utf8'));
  const top24 = JSON.parse(readFileSync(resolve(dir, 'top_24h.json'), 'utf8'));
  const cupola = JSON.parse(readFileSync(resolve(dir, 'cupola_windows.json'), 'utf8'));
  const launch = JSON.parse(readFileSync(resolve(dir, 'launch.json'), 'utf8'));
  stampPassList(passes, times);
  stampPassList(top5, times);
  stampPassList(top24, times);
  stampPassList(cupola.windows, times);
  stampLaunchBody(launch, times);
  const written = {
    passes: writeJson(dir, 'passes.json', passes),
    top5: writeJson(dir, 'top5.json', top5),
    top_24h: writeJson(dir, 'top_24h.json', top24),
    cupola_windows: writeJson(dir, 'cupola_windows.json', cupola),
    launch: writeJson(dir, 'launch.json', launch),
  };
  const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8'));
  for (const key of ['passes', 'top5', 'top_24h', 'cupola_windows']) {
    manifest.artifacts[key].sha256 = written[key].sha256;
    manifest.artifacts[key].bytes = written[key].bytes;
  }
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest));
  const pointer = JSON.parse(readFileSync(resolve(dir, 'launch-latest.json'), 'utf8'));
  pointer.sha256 = written.launch.sha256;
  writeFileSync(resolve(dir, 'launch-latest.json'), JSON.stringify(pointer));
  return times;
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
