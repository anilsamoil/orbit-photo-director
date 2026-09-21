export const SAT_TRACK_LAYER_PREFIX = 'sat-track-layer-';
export const SAT_TRACK_SOURCE_PREFIX = 'sat-track-';

const SAT_TRACK_SLOT = `${SAT_TRACK_LAYER_PREFIX}*`;

/** Paint order, bottom first. This tuple is the only statement of where a
 *  layer sits in the stack. A layer id that is not in it is not a LayerId,
 *  so a layer cannot exist without a paint position.
 *
 *  Every selected satellite adds one `sat-track-layer-<key>` and all of
 *  them share the one slot. */
export const LAYER_ORDER = [
  'esri-imagery-layer',
  'carto-dark-layer',
  'gibs-clouds-layer',
  'geo-ir-layer',
  'fcst-clouds-layer',
  'ne-coastline-layer',
  'night-lights-global-dim-layer',
  'terminator-night-fill-layer',
  'viirs-night-lights-layer',
  'iss-track-layer',
  'my-targets-casing',
  'my-targets-layer',
  'targets-layer',
  'terminator-line-layer',
  'subsolar-point-layer',
  'ascent-trajectory-layer',
  'ascent-pad-layer',
  'esri-labels-reference-layer',
  SAT_TRACK_SLOT,
  'lookup-pin-layer',
  'dropped-pin-layer',
] as const;

export type StaticLayerId = Exclude<(typeof LAYER_ORDER)[number], typeof SAT_TRACK_SLOT>;
export type SatTrackLayerId = `${typeof SAT_TRACK_LAYER_PREFIX}${string}`;
export type LayerId = StaticLayerId | SatTrackLayerId;

export const SOURCE_IDS = [
  'carto-dark',
  'gibs-clouds',
  'esri-imagery',
  'ne-coastline',
  'viirs-night-lights',
  'geo-ir',
  'esri-labels-reference',
  'fcst-clouds',
  'iss-track',
  'my-targets',
  'targets',
  'terminator-line',
  'terminator-night-fill',
  'subsolar-point',
  'ascent-trajectory',
  'ascent-pad',
  'lookup-pin',
  'dropped-pin',
] as const;

export type StaticSourceId = (typeof SOURCE_IDS)[number];
export type SatTrackSourceId = `${typeof SAT_TRACK_SOURCE_PREFIX}${string}`;
export type SourceId = StaticSourceId | SatTrackSourceId;

export function isSatTrackLayer(id: string): id is SatTrackLayerId {
  return id.startsWith(SAT_TRACK_LAYER_PREFIX);
}

export function isLayerId(id: string): id is LayerId {
  return isSatTrackLayer(id) || (LAYER_ORDER as readonly string[]).includes(id);
}

/** Narrow an id read back from the map. Every layer on the map is one the
 *  app added, so anything else is a programming error worth stopping on. */
export function asLayerId(id: string): LayerId {
  if (!isLayerId(id)) throw new Error(`${id} is not in LAYER_ORDER`);
  return id;
}

export function satTrackLayerId(key: string): SatTrackLayerId {
  return `${SAT_TRACK_LAYER_PREFIX}${key}`;
}

export function satTrackSourceId(key: string): SatTrackSourceId {
  return `${SAT_TRACK_SOURCE_PREFIX}${key}`;
}

export function positionOf(id: LayerId): number {
  const slot = isSatTrackLayer(id) ? SAT_TRACK_SLOT : id;
  const at = (LAYER_ORDER as readonly string[]).indexOf(slot);
  if (at === -1) throw new Error(`${id} is not in LAYER_ORDER`);
  return at;
}

/** The layer to pass as `beforeId` so that `id` lands in its catalog
 *  position: the lowest painted layer that the catalog places above it, or
 *  `undefined` when nothing above it is painted yet and the layer belongs
 *  on top. Correct whatever order `painted` is in and whatever order the
 *  callers add layers in. */
export function beforeIdFor(id: LayerId, painted: readonly LayerId[]): LayerId | undefined {
  const at = positionOf(id);
  let best: LayerId | undefined;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const other of painted) {
    const otherAt = positionOf(other);
    if (otherAt > at && otherAt < bestAt) {
      best = other;
      bestAt = otherAt;
    }
  }
  return best;
}
