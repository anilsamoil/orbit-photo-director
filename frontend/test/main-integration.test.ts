/**
 * Integration tests for main.ts orchestration: boot order, transactional
 * refresh, !isOnline guard, offline-banner branches, pending-sync badge.
 *
 * The 6 critical findings from the V2 /review pass all surfaced because
 * main.ts's coordination layer was never directly tested. These tests
 * cover the V2-plan-required `main.boot order`, `main.transactional refresh`,
 * `main.pending-sync badge`, `manifest.snapshot-on-success`, and
 * `manifest.snapshot-on-fail` cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as manifestModule from '../src/manifest';
import type { Manifest, PassEntry, Track } from '../src/types';

// Mock the network layer at module boundary so tests control what each
// fetch resolves with.
vi.mock('../src/manifest', () => ({
  fetchManifest: vi.fn(),
  fetchTop5: vi.fn(),
  fetchTop24h: vi.fn(),
  fetchTrack: vi.fn(),
  artifactUrl: vi.fn((m: Manifest, name: string) => `/${m.artifacts[name]?.path ?? ''}`),
  fetchArtifact: vi.fn(),
  fetchPasses: vi.fn(async () => []),
  fetchStatus: vi.fn(),
}));

// Mock tile-precache so refresh() doesn't fire real cross-origin tile
// fetches against carto/gibs CDNs during the test run. Without this mock
// the integration suite makes ~18 network requests per "newer manifest"
// scenario, which is slow + flaky + violates the test-isolation contract.
vi.mock('../src/tile-precache', async () => {
  const actual = await vi.importActual<typeof import('../src/tile-precache')>(
    '../src/tile-precache',
  );
  return {
    ...actual,
    precacheTilesForTargets: vi.fn(),
  };
});

// Mock aurora module so refresh() doesn't fire real /api/kp fetches during
// test runs. Same isolation concern as tile-precache above.
vi.mock('../src/aurora', async () => {
  const actual = await vi.importActual<typeof import('../src/aurora')>('../src/aurora');
  return {
    ...actual,
    fetchKpData: vi.fn(() => Promise.resolve(null)),
    renderKpWidget: vi.fn(),
    initKpWidget: vi.fn(),
  };
});

// Inline minimal DOM that main.ts queries against. Mirrors the structure
// in frontend/index.html — only the IDs main.ts touches.
const DOM = `
  <header>
    <div id="iss-now"></div>
    <button id="tab-queue"></button>
    <button id="tab-upcoming"></button>
    <button id="tab-map"></button>
    <button id="tab-log">Log<span id="pending-sync-badge" hidden></span></button>
  </header>
  <div id="status-banner"></div>
  <div id="toast" hidden></div>
  <main id="view"><section><div id="cards"></div><div id="empty" hidden></div></section>
  <section><div id="upcoming-cards"></div><div id="upcoming-empty" hidden></div></section></main>
`;

function buildManifest(over: Partial<Manifest> = {}): Manifest {
  return {
    version: '20260504T120000Z',
    generated_at: new Date().toISOString(),
    tle_epoch: '2026-05-04T00:00:00Z',
    cloud_composite_hour: '2026-05-04T11:00:00Z',
    target_data_version: 'v1',
    build_version: '2.0.0.0',
    freshness: { tle_hours: 12, cloud_hours: 0, ok: true },
    artifacts: {
      top5: { path: 'v/X/top5.json', sha256: 'a'.repeat(64), bytes: 100 },
      top_24h: { path: 'v/X/top_24h.json', sha256: 'b'.repeat(64), bytes: 100 },
      track: { path: 'v/X/track.json', sha256: 'c'.repeat(64), bytes: 100 },
    },
    ...over,
  };
}

function buildPass(over: Partial<PassEntry> = {}): PassEntry {
  return {
    target_id: 'tokyo-night',
    target_name: 'Tokyo at night',
    target_regime: 'night',
    target_priority: 5,
    target_lat: 35.68,
    target_lon: 139.69,
    closest_approach: new Date(Date.now() + 30 * 60_000).toISOString(),
    nadir_distance_km: 200,
    pass_regime: 'night',
    obstruction_class: 'clear',
    p_unobstructed: 0.85,
    cloud_fraction: 15,
    cloud_source: 'gibs',
    score: 0.78,
    score_components: {
      p_unobstructed: 0.85, regime_fit: 1, nadir_proximity: 0.75,
      priority_weight: 1, tle_freshness: 1,
    },
    iss_at_closest: { lat: 35.7, lon: 139.7, alt_km: 410 },
    ...over,
  };
}

function buildTrack(): Track {
  return {
    iss_polynomial: {
      start: new Date().toISOString(),
      duration_seconds: 7200,
      lat_coeffs: [0, 0, 0, 0, 0.01, 0],
      lon_coeffs: [0, 0, 0, 0, 0.04, 0],
      polynomial_order: 5,
    },
    tle_epoch: '2026-05-04T00:00:00Z',
    tle_age_hours: 12,
    tle_freshness_factor: 1,
  };
}

beforeEach(() => {
  document.body.innerHTML = DOM;
  localStorage.clear();
  vi.resetModules();    // clears module-level state in main.ts (refreshInFlight, currentManifest, etc.)
  vi.resetAllMocks();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('main.ts: boot order', () => {
  it('renders snapshot synchronously before the first fetch resolves', async () => {
    // Seed snapshot with one pass.
    const seedManifest = buildManifest({ version: '20260504T100000Z' });
    const seedPass = buildPass({ target_id: 'seed-pass', target_name: 'From snapshot' });
    localStorage.setItem('opd-snapshot', JSON.stringify({
      manifest: seedManifest,
      top5: [seedPass],
      top_24h: [],
      track: buildTrack(),
      status: null,
      savedAt: Date.now(),
    }));

    // Stub fetchManifest to never resolve — refresh() will hang forever.
    vi.mocked(manifestModule.fetchManifest).mockReturnValue(new Promise(() => {}));

    const { init } = await import('../src/main');
    void init();
    // Microtask flush so bootFromSnapshot's synchronous renderQueue runs
    await Promise.resolve();
    await Promise.resolve();

    const cards = document.querySelectorAll('#cards .card');
    expect(cards.length).toBe(1);
    expect(cards[0]?.querySelector('.card-name')?.textContent).toBe('From snapshot');
    expect(document.getElementById('status-banner')?.textContent).toContain('Last updated');
  });

  it('falls back to bannerLoading when no snapshot exists', async () => {
    vi.mocked(manifestModule.fetchManifest).mockReturnValue(new Promise(() => {}));
    const { init } = await import('../src/main');
    void init();
    await Promise.resolve();
    expect(document.getElementById('status-banner')?.textContent).toContain('Loading');
  });

  it('discards a snapshot whose nested fields throw inside boot', async () => {
    // Snapshot passes shape validation (manifest+track are objects) but
    // manifest.freshness is undefined — bootFromSnapshot would throw at
    // bannerFromManifest(snap.manifest.generated_at, snap.manifest.freshness.ok, ...).
    localStorage.setItem('opd-snapshot', JSON.stringify({
      manifest: { version: 'x', generated_at: 'invalid', /* freshness MISSING */ artifacts: {} },
      top5: [],
      top_24h: [],
      track: {},
      status: null,
      savedAt: Date.now(),
    }));
    // Drive the network to fail fast so init() returns instead of awaiting
    // a refresh that never resolves. We're testing recovery, not the
    // post-recovery refresh path.
    vi.mocked(manifestModule.fetchManifest).mockRejectedValue(new Error('test'));

    const { init } = await import('../src/main');
    await init();

    // Snapshot was discarded, banner shows the bannerError fallback (no
    // snapshot + offline path).
    expect(localStorage.getItem('opd-snapshot')).toBeNull();
    const bannerText = document.getElementById('status-banner')?.textContent ?? '';
    // Either the bannerError or the bannerLoading — both prove the
    // recovery succeeded (no throw escaped init).
    expect(
      bannerText.includes('Failed to load') ||
      bannerText.includes('Loading') ||
      bannerText.includes('no cached data'),
    ).toBe(true);
  });
});

describe('main.ts: transactional refresh', () => {
  it('does NOT overwrite snapshot when one artifact fetch fails', async () => {
    const seedManifest = buildManifest({ version: '20260504T100000Z' });
    const priorSnapshot = JSON.stringify({
      manifest: seedManifest,
      top5: [buildPass({ target_id: 'old-pass' })],
      top_24h: [],
      track: buildTrack(),
      status: null,
      savedAt: Date.now() - 60_000,
    });
    localStorage.setItem('opd-snapshot', priorSnapshot);

    // Newer manifest, but track fetch rejects — refresh should leave the
    // prior snapshot untouched.
    vi.mocked(manifestModule.fetchManifest).mockResolvedValue(
      buildManifest({ version: '20260504T120000Z' }),
    );
    vi.mocked(manifestModule.fetchTop5).mockResolvedValue([buildPass()]);
    vi.mocked(manifestModule.fetchTop24h).mockResolvedValue([]);
    vi.mocked(manifestModule.fetchTrack).mockRejectedValue(new Error('500'));

    const { refresh } = await import('../src/main');
    await refresh();

    // Snapshot is unchanged — the partial-fail rolled back transactionally
    expect(localStorage.getItem('opd-snapshot')).toBe(priorSnapshot);
  });

  it('persists a NEW snapshot when all artifacts resolve', async () => {
    const newManifest = buildManifest({ version: '20260504T130000Z' });
    vi.mocked(manifestModule.fetchManifest).mockResolvedValue(newManifest);
    vi.mocked(manifestModule.fetchTop5).mockResolvedValue([buildPass()]);
    vi.mocked(manifestModule.fetchTop24h).mockResolvedValue([]);
    vi.mocked(manifestModule.fetchTrack).mockResolvedValue(buildTrack());

    const { refresh } = await import('../src/main');
    await refresh();

    const written = JSON.parse(localStorage.getItem('opd-snapshot')!);
    expect(written.manifest.version).toBe('20260504T130000Z');
    expect(written.top5).toHaveLength(1);
  });
});

describe('main.ts: !isOnline guard', () => {
  it('skips fetchManifest entirely when navigator.onLine is false', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const { refresh } = await import('../src/main');
    await refresh();
    expect(manifestModule.fetchManifest).not.toHaveBeenCalled();
  });

  it('falls back to bannerError when offline AND no snapshot', async () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const { refresh } = await import('../src/main');
    await refresh();
    expect(document.getElementById('status-banner')?.textContent).toContain('no cached data');
  });
});

describe('main.ts: renderOfflineBanner branches', () => {
  it('renders the offline-age banner when a fresh snapshot exists', async () => {
    localStorage.setItem('opd-snapshot', JSON.stringify({
      manifest: buildManifest(),
      top5: [],
      top_24h: [],
      track: buildTrack(),
      status: null,
      savedAt: Date.now() - 30 * 60_000, // 30 min ago
    }));
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

    const { refresh } = await import('../src/main');
    await refresh();

    const banner = document.getElementById('status-banner');
    expect(banner?.textContent).toContain('LOS');
    expect(banner?.textContent).toContain('30 min');
  });

  it('appends TLE-overlay when tle_age_hours > 48 in the snapshot', async () => {
    localStorage.setItem('opd-snapshot', JSON.stringify({
      manifest: buildManifest(),
      top5: [],
      top_24h: [],
      track: { ...buildTrack(), tle_age_hours: 72 },
      status: null,
      savedAt: Date.now() - 60_000,
    }));
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

    const { refresh } = await import('../src/main');
    await refresh();

    const banner = document.getElementById('status-banner');
    expect(banner?.textContent).toContain('TLE 72h old');
    expect(banner?.className).toContain('banner-orange');
  });
});

describe('main.ts: past-pass filter on Queue + Upcoming render', () => {
  // Chris reported (2026-05-10): generator publishes top5 as the next-90-min
  // slice from the manifest tick time; by the time the user looks 30-60 min
  // later, several picks may already be past. Old behavior rendered them as
  // "Past" cards. New behavior filters past at render + falls back to the
  // empty-state placeholder.
  it('hides Queue cards whose closest_approach is in the past', async () => {
    const now = Date.now();
    const past = new Date(now - 5 * 60_000).toISOString(); // 5 min ago
    const future = new Date(now + 25 * 60_000).toISOString(); // 25 min from now
    localStorage.setItem('opd-snapshot', JSON.stringify({
      manifest: buildManifest(),
      top5: [
        buildPass({ target_id: 'past-1', closest_approach: past }),
        buildPass({ target_id: 'past-2', closest_approach: past }),
        buildPass({ target_id: 'future-1', closest_approach: future }),
      ],
      top_24h: [],
      track: buildTrack(),
      status: null,
      savedAt: now,
    }));
    vi.mocked(manifestModule.fetchManifest).mockReturnValue(new Promise(() => {}));

    const { init } = await import('../src/main');
    void init();
    await Promise.resolve();
    await Promise.resolve();

    const cards = document.querySelectorAll('#cards .card');
    expect(cards.length).toBe(1);
    const ids = Array.from(cards).map((c) => (c as HTMLElement).dataset.targetId);
    expect(ids).toEqual(['future-1']);
  });

  it('shows the empty state when ALL queue picks are past', async () => {
    const now = Date.now();
    const past = new Date(now - 10 * 60_000).toISOString();
    localStorage.setItem('opd-snapshot', JSON.stringify({
      manifest: buildManifest(),
      top5: [
        buildPass({ target_id: 'past-1', closest_approach: past }),
        buildPass({ target_id: 'past-2', closest_approach: past }),
      ],
      top_24h: [],
      track: buildTrack(),
      status: null,
      savedAt: now,
    }));
    vi.mocked(manifestModule.fetchManifest).mockReturnValue(new Promise(() => {}));

    const { init } = await import('../src/main');
    void init();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelectorAll('#cards .card').length).toBe(0);
    expect(document.getElementById('empty')?.hidden).toBe(false);
  });

  it('also hides past entries from Upcoming (defense-in-depth for very stale manifests)', async () => {
    const now = Date.now();
    const past = new Date(now - 60_000).toISOString();
    const future = new Date(now + 6 * 3600_000).toISOString(); // 6h out
    localStorage.setItem('opd-snapshot', JSON.stringify({
      manifest: buildManifest(),
      top5: [],
      top_24h: [
        buildPass({ target_id: 'past-upcoming', closest_approach: past }),
        buildPass({ target_id: 'future-upcoming', closest_approach: future }),
      ],
      track: buildTrack(),
      status: null,
      savedAt: now,
    }));
    vi.mocked(manifestModule.fetchManifest).mockReturnValue(new Promise(() => {}));

    const { init } = await import('../src/main');
    void init();
    await Promise.resolve();
    await Promise.resolve();

    const upcomingCards = document.querySelectorAll('#upcoming-cards .card');
    expect(upcomingCards.length).toBe(1);
    expect((upcomingCards[0] as HTMLElement).dataset.targetId).toBe('future-upcoming');
  });
});

// v3 — Hide-from-card flow (Anil 2026-05-26). Component A of the v3
// operator-ergonomics batch. Tested through the exposed `handleHideAction`
// + `onCardAction` since the click handler in main.ts mutates module state
// (currentProfile via loadOrCreateProfileFromURL during init()).
describe('main.ts: hide-from-card (v3)', () => {
  // Init() boots from URL, so we seed window.location.search via
  // history.replaceState. Default-profile path keeps the test surface
  // minimal — same code path the operator hits on a fresh `?u=anil` open.
  beforeEach(() => {
    history.replaceState(null, '', '/?u=anil');
    // Drive refresh to fail fast so init() returns instead of awaiting
    // a real network call — we just need init() to set currentProfile.
    vi.mocked(manifestModule.fetchManifest).mockRejectedValue(new Error('test'));
  });

  it('handleHideAction adds the target_id to removedCuratedIds', async () => {
    const { init, handleHideAction } = await import('../src/main');
    await init();
    const pass = buildPass({ target_id: 'aurora-scandinavia', target_name: 'Aurora — Scandinavia' });
    handleHideAction(pass);
    const profileRaw = localStorage.getItem('opd-profile-anil');
    const profile = JSON.parse(profileRaw!);
    expect(profile.removedCuratedIds).toContain('aurora-scandinavia');
  });

  it('handleHideAction removes the matching card from the DOM immediately', async () => {
    const { init, handleHideAction } = await import('../src/main');
    await init();
    // Mount a card by target_id matching what we're about to hide.
    const cardsHost = document.getElementById('cards')!;
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.targetId = 'etna-volcano';
    card.dataset.passTime = '2026-05-26T12:00:00Z';
    cardsHost.appendChild(card);
    handleHideAction(buildPass({ target_id: 'etna-volcano', target_name: 'Etna' }));
    expect(document.querySelector('.card[data-target-id="etna-volcano"]')).toBeNull();
  });

  it('handleHideAction removes the same id from BOTH Queue and Upcoming containers', async () => {
    const { init, handleHideAction } = await import('../src/main');
    await init();
    for (const containerId of ['cards', 'upcoming-cards']) {
      const host = document.getElementById(containerId)!;
      const card = document.createElement('article');
      card.className = 'card';
      card.dataset.targetId = 'patagonia-glaciers';
      host.appendChild(card);
    }
    handleHideAction(buildPass({ target_id: 'patagonia-glaciers', target_name: 'Patagonia' }));
    expect(document.querySelectorAll('.card[data-target-id="patagonia-glaciers"]').length).toBe(0);
  });

  it('handleHideAction fires the "Hidden ..." toast with the target name', async () => {
    const { init, handleHideAction } = await import('../src/main');
    await init();
    handleHideAction(buildPass({ target_id: 'tokyo-night', target_name: 'Tokyo at night' }));
    const toast = document.getElementById('toast')!;
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain('Tokyo at night');
    expect(toast.textContent).toContain('Hidden');
    expect(toast.textContent).toContain('Profile tab');
  });

  // v3.2 — personal-target Hide flow now DELETES the target from
  // profile.additions instead of being a defensive no-op. Restorable via
  // the Profile-tab CRUD form ("re-add"). This matches the per-row
  // Delete already shown on the Profile tab — Hide-from-card is the
  // queue-side shortcut to the same op.
  it('handleHideAction on a personal-target removes it from additions (v3.2)', async () => {
    const { init, handleHideAction } = await import('../src/main');
    const profileModule = await import('../src/profile');
    await init();
    // Seed a personal target on the active profile so handleHideAction
    // has something to delete.
    const raw = profileModule.loadProfile('anil')!;
    const seeded = profileModule.addPersonalTarget(raw, {
      id: 'personal:anil:abc',
      name: 'My personal',
      lat: 0,
      lon: 0,
      priority: 3,
      createdAt: '2026-05-26T00:00:00Z',
    });
    profileModule.saveProfile(seeded);
    handleHideAction(buildPass({
      target_id: 'personal:anil:abc',
      target_name: 'My personal',
    }));
    const profile = JSON.parse(localStorage.getItem('opd-profile-anil')!);
    // Target gone from additions.
    expect(profile.additions.find((t: { id: string }) => t.id === 'personal:anil:abc')).toBeUndefined();
    // And NOT added to removedCuratedIds — that's a curated-only list.
    expect(profile.removedCuratedIds).toEqual([]);
  });

  it('handleHideAction on a personal-target fires the "Removed personal target" toast (v3.2)', async () => {
    const { init, handleHideAction } = await import('../src/main');
    const profileModule = await import('../src/profile');
    await init();
    const raw = profileModule.loadProfile('anil')!;
    const seeded = profileModule.addPersonalTarget(raw, {
      id: 'personal:anil:xyz',
      name: 'Backyard observatory',
      lat: 10,
      lon: 20,
      priority: 3,
      createdAt: '2026-05-26T00:00:00Z',
    });
    profileModule.saveProfile(seeded);
    handleHideAction(buildPass({
      target_id: 'personal:anil:xyz',
      target_name: 'Backyard observatory',
    }));
    const toast = document.getElementById('toast')!;
    expect(toast.hidden).toBe(false);
    expect(toast.textContent).toContain('Removed personal target');
    expect(toast.textContent).toContain('Backyard observatory');
    expect(toast.textContent).toContain('re-add in Profile tab');
  });

  it('handleHideAction on a personal-target removes the card from DOM immediately (v3.2)', async () => {
    const { init, handleHideAction } = await import('../src/main');
    const profileModule = await import('../src/profile');
    await init();
    const raw = profileModule.loadProfile('anil')!;
    const seeded = profileModule.addPersonalTarget(raw, {
      id: 'personal:anil:dom',
      name: 'DOM test target',
      lat: 0,
      lon: 0,
      priority: 3,
      createdAt: '2026-05-26T00:00:00Z',
    });
    profileModule.saveProfile(seeded);
    const cardsHost = document.getElementById('cards')!;
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.targetId = 'personal:anil:dom';
    cardsHost.appendChild(card);
    handleHideAction(buildPass({
      target_id: 'personal:anil:dom',
      target_name: 'DOM test target',
    }));
    expect(document.querySelector('.card[data-target-id="personal:anil:dom"]')).toBeNull();
  });

  it('handleHideAction is idempotent when the id is already hidden', async () => {
    const { init, handleHideAction } = await import('../src/main');
    await init();
    handleHideAction(buildPass({ target_id: 'aurora-scandinavia' }));
    handleHideAction(buildPass({ target_id: 'aurora-scandinavia' }));
    const profile = JSON.parse(localStorage.getItem('opd-profile-anil')!);
    const matches = profile.removedCuratedIds.filter(
      (id: string) => id === 'aurora-scandinavia',
    );
    expect(matches).toHaveLength(1);
  });
});

describe('main.ts: updatePendingSyncBadge', () => {
  it('hides the badge when the calib queue is empty', async () => {
    localStorage.removeItem('opd-calib-queue');
    const { updatePendingSyncBadge } = await import('../src/main');
    updatePendingSyncBadge();
    const el = document.getElementById('pending-sync-badge')!;
    expect(el.hidden).toBe(true);
    expect(el.textContent).toBe('');
  });

  it('shows the count and singular/plural title text', async () => {
    localStorage.setItem('opd-calib-queue', JSON.stringify([
      { target_id: 'a', pass_time: 'x', action: 'shoot' },
    ]));
    const { updatePendingSyncBadge } = await import('../src/main');
    updatePendingSyncBadge();
    let el = document.getElementById('pending-sync-badge')!;
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('1');
    expect(el.title).toContain('1 calibration entry queued');

    localStorage.setItem('opd-calib-queue', JSON.stringify([
      { target_id: 'a', pass_time: 'x', action: 'shoot' },
      { target_id: 'b', pass_time: 'y', action: 'skip' },
      { target_id: 'c', pass_time: 'z', action: 'shoot' },
    ]));
    updatePendingSyncBadge();
    el = document.getElementById('pending-sync-badge')!;
    expect(el.textContent).toBe('3');
    expect(el.title).toContain('3 calibration entries queued');
  });
});
