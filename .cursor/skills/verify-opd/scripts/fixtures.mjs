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

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function launchIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
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

export async function buildFixtures(dir, now = Date.now()) {
  mkdirSync(dir, { recursive: true });
  const tle = await loadTle();
  const satrec = satellite.twoline2satrec(tle.line1, tle.line2);
  const hereNow = positionAt(satrec, now) ?? { lat: 0, lon: 0, altKm: 420 };
  const generated = launchIso(now - 30_000);
  const queueAt = launchIso(now + 20 * 60_000);
  const queueAt2 = launchIso(now + 50 * 60_000);
  const upcomingAt = launchIso(now + 8 * 60 * 60_000);
  const keepsakeAt = launchIso(now + 35 * 60_000);
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
    window_start: launchIso(now + 30 * 60_000),
    window_end: launchIso(now + 40 * 60_000),
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

  const net = launchIso(now + 2 * 60 * 60_000);
  const windowEnd = launchIso(now + 2 * 60 * 60_000 + 9 * 60_000);
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
            start: launchIso(now + 2 * 60 * 60_000 + 60_000),
            peak: launchIso(now + 2 * 60 * 60_000 + 4 * 60_000),
            end: launchIso(now + 2 * 60 * 60_000 + 8 * 60_000),
            liftoff_start: net,
            liftoff_end: launchIso(now + 2 * 60 * 60_000 + 60_000),
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
    ],
  };

  const requestedTracked = process.env.OPD_VERIFY_TRACKED || '';
  const trackedMode = ['elements', 'aged_out', 'missing'].includes(requestedTracked) ? requestedTracked : 'unavailable';
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
        reason: trackedMode === 'aged_out' ? 'aged_out' : 'no_public_orbit',
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
