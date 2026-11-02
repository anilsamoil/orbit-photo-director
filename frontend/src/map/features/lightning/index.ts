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

    function paint() {
      if (!enabled || !status) return;
      const now = core.clock.now();
      const scrubbed = core.clock.isScrubbed();
      const label = feed ? observationLabel(feed, now, core.center())
        : request ? 'Loading observations…' : 'Feed unavailable';
      status.textContent = 'NOAA GLM · ' + label
        + (feed && refreshFailed ? ' · refresh unavailable' : '')
        + (scrubbed ? ' · hidden at scrubbed time' : '');
      const visible = feed && !scrubbed && now - feed.end < STALE_MS;
      if (feed && visible) {
        core.setGeoJson('lightning', flashFeatures(feed, now));
        core.ensureLayer({
          id: 'lightning-layer', source: 'lightning', type: 'circle',
          paint: {
            'circle-color': '#ffdf73',
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 2.5, 8, 5],
            'circle-opacity': ['interpolate', ['linear'], ['get', 'ageSeconds'], 0, 1, 300, 0.7, 780, 0.14],
          },
        });
      }
      core.setVisibility('lightning-layer', visible ? 'visible' : 'none');
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
        request?.abort();
        request = null;
        feed = null;
        refreshFailed = false;
        core.setVisibility('lightning-layer', 'none');
      }
    });
    core.clock.onViewTime(paint);
    core.on('moveend', paint);
  },
};
