import { describe, expect, it } from 'vitest';

import { toHit } from '../src/map/adapters/maplibre/events';
import type { MapGeoJSONFeature } from 'maplibre-gl';

describe('GeoJSON hit properties', () => {
  it('passes a nested property object through without stringifying it', () => {
    const feature = {
      properties: { score: 80, nest: { ok: true, n: 2 } },
      geometry: { type: 'Point', coordinates: [1, 2] },
    } as unknown as MapGeoJSONFeature;
    expect(toHit(feature)).toEqual({
      properties: { score: 80, nest: { ok: true, n: 2 } },
      geometry: { type: 'Point', coordinates: [1, 2] },
    });
  });
});
