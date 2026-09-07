/** Local-only synthetic browser fixture. Never proxies production or sends. */
import { resolve, sep } from 'node:path';
import { artifact, envelope, interval, launch, supported, NOW } from '../frontend/test/launch-fixtures';

const root = resolve(import.meta.dir, '../frontend/dist');
const port = Number(process.env.PORT ?? 8769);
const started = Date.now();
let mode = 'ready';
const iso = (minutes = 0) => new Date(started + minutes * 60_000).toISOString();
function shift(value: unknown): any {
  if (typeof value === 'string' && /^2026-09-07T/.test(value)) return new Date(Date.parse(value) + started - NOW).toISOString();
  if (Array.isArray(value)) return value.map(shift);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shift(v)]));
  return value;
}
const ground = Array.from({ length: 5 }, (_, i) => ({
  target_id: `synthetic-ground-${i}`, target_name: `Synthetic ground target ${i + 1}`,
  target_regime: 'any', target_priority: 5, target_lat: i, target_lon: i,
  closest_approach: iso(20 + i * 5), nadir_distance_km: 100,
  angle_off_nadir_deg: 20, iss_relative_bearing_deg: 45, pass_regime: 'day',
  obstruction_class: 'clear', p_unobstructed: 85, cloud_fraction: 15,
  cloud_source: 'synthetic', score: 85 - i,
  score_components: { p_unobstructed: .85, regime_fit: 1, nadir_proximity: .9, priority_weight: 1, tle_freshness: 1 },
  iss_at_closest: { lat: 0, lon: 0, alt_km: 410 },
}));
const track = {
  iss_polynomial: { start: iso(), duration_seconds: 14400, lat_coeffs: [0], lon_coeffs: [0], polynomial_order: 0 },
  track_points: Array.from({ length: 240 }, (_, i) => [i * 60, 40 * Math.sin(i / 15), ((i * 4 + 180) % 360) - 180]),
  tle_epoch: iso(), tle_age_hours: 0, tle_freshness_factor: 1,
};
const status = { last_run: iso(), tick_minutes: 60, tle_age_hours: 0, tle_freshness_factor: 1,
  cloud_source: 'synthetic', cloud_composite_hour: iso(), target_count: 5, pass_count: 5, version: 'synthetic-qa', build_version: 'synthetic-qa' };
const earth: Record<string, unknown> = { top5: ground, top_24h: ground, passes: ground, track, status, targets: [] };
const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const sample = (index: number) => supported({ event_id: `qa-supported-${index}`, revision: `qa-event-${index}`, name: `SYNTHETIC QA ascent ${index}`,
  site: { name: 'Synthetic equatorial site', lat: index * 5, lon: index * 5 }, capture_intervals: [interval(10 + index, 15 + index)] });
const items = [sample(1), sample(2), sample(3), launch({ event_id: 'qa-tentative', name: 'SYNTHETIC QA tentative launch with unknown trajectory',
  site: { name: 'Synthetic pad', lat: 0, lon: 0 } }), launch({ event_id: 'qa-day3', name: 'SYNTHETIC QA day-three map candidate',
  launch_window: { net: new Date(NOW + 72 * 3600_000).toISOString(), start: null, end: null, precision: null } })];
const builds = new Map<string, Awaited<ReturnType<typeof envelope>>>();
for (const key of ['ready', 'stale', 'partial', 'map-only']) {
  const a = shift(artifact(key === 'map-only' ? items.filter((x) => x.status === 'map_only') : items));
  a.revision = `qa-${key}`;
  if (key === 'stale') { a.generated_at = iso(-16); a.valid_until = iso(-1); }
  if (key === 'partial') { a.coverage.complete = false; a.coverage.reasons = ['FEED_PAGINATED']; }
  builds.set(key, await envelope(a));
}
const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/__qa/mode/')) {
    const next = path.split('/').at(-1)!;
    if (!['ready', 'stale', 'partial', 'map-only', 'corrupt', 'unavailable'].includes(next)) return json({ error: 'unknown mode' }, 400);
    mode = next;
    return json({ mode, synthetic: true });
  }
  if (path === '/manifest.json') return json({ version: '20990101T000000Z', generated_at: iso(), tle_epoch: iso(),
    cloud_composite_hour: iso(), target_data_version: 'synthetic', build_version: 'synthetic-qa', freshness: { tle_hours: 0, cloud_hours: 0, ok: true },
    artifacts: Object.fromEntries(Object.keys(earth).map((k) => [k, { path: `v/20990101T000000Z/${k}.json`, sha256: '', bytes: 0 }])) });
  if (path.startsWith('/v/20990101T000000Z/')) return json(earth[path.split('/').at(-1)!.replace('.json', '')] ?? {});
  if (path === '/launch/latest.json') {
    if (mode === 'unavailable') return json({ error: 'synthetic outage' }, 503);
    return json(builds.get(mode === 'corrupt' ? 'ready' : mode)!.pointer);
  }
  if (path.startsWith('/launch/v/')) {
    if (mode === 'corrupt') return json({ tampered: true });
    const entry = [...builds.values()].find((x) => `/${x.pointer.path}` === path);
    return entry ? new Response(entry.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }) : json({}, 404);
  }
  if (path.startsWith('/api/')) return json({ items: [], targets: [], entries: [] });
  if (path === '/__opd_probe') return new Response(null, { status: 204 });
  const filename = resolve(root, `.${path === '/' ? '/index.html' : path}`);
  if (!filename.startsWith(root + sep)) return new Response(null, { status: 404 });
  const file = Bun.file(filename);
  return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
} });
console.log(`SYNTHETIC QA ONLY http://127.0.0.1:${server.port}`);
