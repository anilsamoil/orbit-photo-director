import { showMapLegend } from '../../../map-legend';
import type { MapFeature } from '../../map-core/feature';
import { flashFeatures, observationLabel, parseLightningFeed, STALE_MS, type LightningFeed } from './feed';

export const lightning: MapFeature = {
  id: 'lightning',
  mount(core) {
    const button = document.getElementById('toggle-lightning');
    const status = document.getElementById('lightning-status');
    if (!button || !status) return;
    let enabled = false;
    let feed: LightningFeed | null = null;
    let request: AbortController | null = null;
    let refreshFailed = false;
    let stopTick: (() => void) | undefined;
    let nextPoll = 0;
    let expiry: ReturnType<typeof setTimeout> | null = null;
    let rendered: { feed: LightningFeed; ageBucket: number } | null = null;

    function cancelExpiry() {
      if (expiry !== null) clearTimeout(expiry);
      expiry = null;
    }

    function paint() {
      if (!enabled || !status) return;
      const now = core.clock.now();
      const scrubbed = core.clock.isScrubbed();
      const future = feed !== null && now < feed.end;
      const label = future ? 'Observations ahead of clock · hidden'
        : feed ? observationLabel(feed, now, core.center())
        : request ? 'Loading observations…' : 'Feed unavailable';
      const text = 'NOAA GLM · ' + label
        + (feed && refreshFailed ? ' · refresh unavailable' : '')
        + (scrubbed ? ' · hidden at scrubbed time' : '');
      if (status.textContent !== text) status.textContent = text;
      const visible = feed && !future && !scrubbed && now - feed.end < STALE_MS;
      const ageBucket = feed ? Math.floor((now - feed.end) / 30_000) : 0;
      if (feed && visible && (rendered?.feed !== feed || rendered.ageBucket !== ageBucket)) {
        core.setGeoJson('lightning', flashFeatures(feed, feed.end + ageBucket * 30_000));
        core.ensureLayer({
          id: 'lightning-layer', source: 'lightning', type: 'circle',
          paint: {
            'circle-color': '#ffdf73',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 2.5, 8, 5],
            'circle-opacity': ['interpolate', ['linear'], ['get', 'ageSeconds'], 0, 1, 300, 0.7, 780, 0.14],
          },
        });
        rendered = { feed, ageBucket };
      }
      core.setVisibility('lightning-layer', visible ? 'visible' : 'none');
      cancelExpiry();
      if (feed && feed.end + STALE_MS > now) {
        expiry = setTimeout(paint, feed.end + STALE_MS - now);
      }
    }

    async function poll() {
      if (request) return;
      const controller = new AbortController();
      request = controller;
      nextPoll = core.clock.now() + 120_000;
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch('/lightning/latest.json', { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('GLM feed unavailable');
        const parsed = parseLightningFeed(await response.json(), core.clock.now());
        if (request !== controller) return;
        feed = parsed;
        refreshFailed = false;
      } catch {
        if (request === controller) refreshFailed = true;
      } finally {
        clearTimeout(timeout);
        if (request === controller) {
          request = null;
          paint();
        }
      }
    }

    button.addEventListener('click', () => {
      enabled = !enabled;
      button.setAttribute('aria-pressed', String(enabled));
      button.classList.toggle('active', enabled);
      status.hidden = !enabled;
      if (enabled) {
        showMapLegend();
        void poll();
        paint();
        stopTick = core.clock.every(30_000, now => {
          paint();
          if (now >= nextPoll) void poll();
        });
      } else {
        stopTick?.();
        cancelExpiry();
        request?.abort();
        request = null;
        feed = null;
        rendered = null;
        refreshFailed = false;
        core.setVisibility('lightning-layer', 'none');
      }
    });
    core.clock.onViewTime(paint);
    core.on('moveend', paint);
    document.addEventListener('visibilitychange', paint);
    window.addEventListener('pageshow', paint);
  },
};
