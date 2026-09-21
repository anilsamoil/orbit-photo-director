import { findUpcomingPasses, roundForZoom } from '../../../pin-drop';
import { parseProfileFromURL } from '../../../profile';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import type { LngLat, Point } from '../../map-core/geometry';
import { buildPassList, type PassListSection } from '../../overlays/pass-list';
import { DROPPED_PIN_LAYER, NO_PIN, pinFeature } from './layers';
import { buildPinAddFooter } from './popup';

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_THRESHOLD_PX = 8;
const ISS_COLOR = '#5cd0ff';

export const pinDrop: MapFeature = {
  id: 'pin-drop',
  mount(core) {
    const dismiss = (): void => {
      core.closePopup('pin');
      core.setGeoJson('dropped-pin', NO_PIN);
    };

    const drop = ([lng, lat]: LngLat): void => {
      const { track, satellites } = core.view();
      if (!track) return;
      const pin = roundForZoom(lat, lng, core.zoom());
      core.setGeoJson('dropped-pin', pinFeature(pin));
      core.ensureLayer(DROPPED_PIN_LAYER);

      const nowMs = core.clock.now();
      const sections: PassListSection[] = [
        { name: 'ISS', color: ISS_COLOR, passes: findUpcomingPasses(track, pin.lat, pin.lon, nowMs) },
        ...satellites.map(({ name, color, track: orbit }) => ({
          name,
          color,
          passes: findUpcomingPasses(orbit, pin.lat, pin.lon, nowMs),
        })),
      ];
      const body = buildPassList(pin.lat, pin.lon, pin.precision, sections, nowMs);
      const profile = parseProfileFromURL(window.location.href);
      body.appendChild(buildPinAddFooter(pin.lat, pin.lon, pin.precision, profile, dismiss));
      core.openPopup({ at: [pin.lon, pin.lat], content: body, maxWidth: '340px', owner: 'pin' });
    };

    core.on('contextmenu', ({ lngLat }) => drop(lngLat));
    bindLongPress(core, drop);
    core.onLayer('click', 'dropped-pin-layer', dismiss);
    core.onLayer('mouseenter', 'dropped-pin-layer', () => core.setCursor('pointer'));
    core.onLayer('mouseleave', 'dropped-pin-layer', () => core.setCursor(''));
  },
};

function bindLongPress(core: MapCore, drop: (at: LngLat) => void): void {
  let press: { start: Point; timer: ReturnType<typeof setTimeout> } | null = null;
  const release = (): void => {
    if (press) clearTimeout(press.timer);
    press = null;
  };

  core.on('touchstart', ({ lngLat, touches }) => {
    release();
    const [finger, second] = touches;
    if (!finger || second) return;
    press = {
      start: finger,
      timer: setTimeout(() => {
        press = null;
        drop(lngLat);
      }, LONG_PRESS_MS),
    };
  });
  core.on('touchmove', ({ touches }) => {
    const [finger] = touches;
    if (!press || !finger) return;
    if (Math.hypot(finger.x - press.start.x, finger.y - press.start.y) > LONG_PRESS_MOVE_THRESHOLD_PX) release();
  });
  core.on('touchend', release);
}
