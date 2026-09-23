import { liveIssNow, liveIssPosition } from '../../../iss';
import type { MapCore } from '../../map-core/core';
import type { MapFeature } from '../../map-core/feature';
import type { MarkerHandle } from '../../map-core/vendor-map';
import type { Track } from '../../../types';

export type MarkerPosition = { lat: number; lon: number };

/** SGP4 when the track has a TLE, otherwise the polynomial clamped to its window. */
export function markerPositionAt(
  track: Track,
  lookaheadMinutes: number,
  nowMs: number,
): MarkerPosition | null {
  const targetMs = nowMs + lookaheadMinutes * 60_000;
  const pos = liveIssNow(track, targetMs);
  if (pos) return pos;
  const startMs = Date.parse(track.iss_polynomial.start);
  if (Number.isNaN(startMs)) return null;
  const endMs = startMs + track.iss_polynomial.duration_seconds * 1000;
  return liveIssPosition(track, Math.min(targetMs, endMs - 1000));
}

/** ISS silhouette: central truss and two solar arrays, with a pulse behind. */
export function createIssMarkerElement(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'iss-marker';
  const pulse = document.createElement('span');
  pulse.className = 'iss-pulse';
  wrap.appendChild(pulse);

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '-20 -8 40 16');
  svg.setAttribute('aria-label', 'ISS live position');
  svg.setAttribute('role', 'img');

  const panel = (x: number): void => {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', '-3');
    rect.setAttribute('width', '14');
    rect.setAttribute('height', '6');
    rect.setAttribute('fill', '#5cd0ff');
    rect.setAttribute('stroke', '#0b0d12');
    rect.setAttribute('stroke-width', '0.7');
    svg.appendChild(rect);
    for (const dx of [4, 8, 12]) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(x + dx));
      line.setAttribute('y1', '-3');
      line.setAttribute('x2', String(x + dx));
      line.setAttribute('y2', '3');
      line.setAttribute('stroke', '#0b0d12');
      line.setAttribute('stroke-width', '0.4');
      svg.appendChild(line);
    }
  };
  panel(-18);
  panel(4);

  const truss = document.createElementNS(SVG_NS, 'rect');
  truss.setAttribute('x', '-3');
  truss.setAttribute('y', '-2');
  truss.setAttribute('width', '6');
  truss.setAttribute('height', '4');
  truss.setAttribute('fill', '#ffffff');
  truss.setAttribute('stroke', '#0b0d12');
  truss.setAttribute('stroke-width', '0.7');
  svg.appendChild(truss);

  wrap.appendChild(svg);
  return wrap;
}

type Runtime = {
  core: MapCore | null;
  marker: MarkerHandle | null;
};

const state: Runtime = { core: null, marker: null };

function lookaheadMinutes(core: MapCore, nowMs: number): number {
  const view = core.clock.viewTime();
  if (view.kind !== 'scrubbed') return 0;
  return Math.max(0, (view.atMs - nowMs) / 60_000);
}

/** Position of the marker at the current view, or null when the map has no track. */
export function issMarkerPosition(nowMs?: number): MarkerPosition | null {
  const core = state.core;
  const track = core?.view().track;
  if (!core || !track) return null;
  const at = nowMs ?? core.clock.now();
  return markerPositionAt(track, lookaheadMinutes(core, at), at);
}

export function hasIssMarker(): boolean {
  return state.marker !== null;
}

/** Move the existing marker onto the view instant. */
export function moveIssMarkerToView(nowMs?: number): MarkerPosition | null {
  const pos = issMarkerPosition(nowMs);
  if (pos) state.marker?.setLngLat([pos.lon, pos.lat]);
  return state.marker && pos ? pos : null;
}

/** Create the marker on first call and park it on the track. Later calls
 *  only move it, including a manifest refresh while the view is scrubbed. */
export function syncIssMarker(core: MapCore): void {
  state.core = core;
  const track = core.view().track;
  const pos = track ? markerPositionAt(track, lookaheadMinutes(core, core.clock.now()), core.clock.now()) : null;
  const at = pos ?? { lat: 0, lon: 0 };
  if (!state.marker) {
    state.marker = core.addMarker(createIssMarkerElement(), [at.lon, at.lat]);
    return;
  }
  if (pos) state.marker.setLngLat([pos.lon, pos.lat]);
}

/** Live tick. A scrubbed view stays where the controls put it. */
export function tickIssMarker(nowMs: number): void {
  const core = state.core;
  const track = core?.view().track;
  if (!core || !state.marker || !track || core.clock.isScrubbed()) return;
  const pos = markerPositionAt(track, 0, nowMs);
  if (pos) state.marker.setLngLat([pos.lon, pos.lat]);
}

/** The ISS sub-point. The composition root still runs the 1 Hz tick so a
 *  snap back to live can skip this move for that one second. */
export const issMarker: MapFeature = {
  id: 'iss-marker',
  mount(core) {
    syncIssMarker(core);
  },
};
