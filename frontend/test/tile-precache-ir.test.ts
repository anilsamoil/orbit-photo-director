/**
 * Tests for the geo-IR tile helpers (Feature C) in tile-precache.ts:
 * satellite picking (incl. the no-coverage gaps + poles + dateline), the
 * 10-minute time flooring, and the GIBS URL shape.
 */
import { describe, it, expect } from 'vitest';
import {
  pickGeoIRSat,
  floorTo10MinIso,
  geoIRTimeForNow,
  gibsGeoIRUrl,
  geoIRTileUrl,
  GIBS_GEO_IR_MAX_ZOOM,
} from '../src/tile-precache';

describe('pickGeoIRSat', () => {
  it('Americas → GOES-East', () => {
    expect(pickGeoIRSat(29, -95)?.label).toBe('GOES-East'); // Houston
    expect(pickGeoIRSat(-10, -60)?.label).toBe('GOES-East'); // Amazon
  });
  it('east Pacific → GOES-West', () => {
    expect(pickGeoIRSat(0, -150)?.label).toBe('GOES-West');
  });
  it('Asia / west Pacific → Himawari', () => {
    expect(pickGeoIRSat(35, 130)?.label).toBe('Himawari'); // Japan
    expect(pickGeoIRSat(0, 179)?.label).toBe('Himawari'); // just west of dateline
  });
  it('Europe / Africa → Meteosat-11 (RealEarth fills the old GIBS gap)', () => {
    expect(pickGeoIRSat(50, 15)?.label).toBe('Meteosat-11'); // central Europe
    expect(pickGeoIRSat(-18, 25)?.label).toBe('Meteosat-11'); // Victoria Falls area
  });
  it('tags each satellite with its tile source', () => {
    expect(pickGeoIRSat(29, -95)?.source).toBe('gibs'); // GOES-East
    expect(pickGeoIRSat(50, 15)?.source).toBe('realearth'); // Meteosat
  });
  it('poleward of 70° is still null (geostationary limb unusable)', () => {
    expect(pickGeoIRSat(85, -95)).toBeNull();
    expect(pickGeoIRSat(-80, 130)).toBeNull();
  });
  it('rejects non-finite input', () => {
    expect(pickGeoIRSat(NaN, 0)).toBeNull();
  });
});

describe('geoIRTileUrl (source-aware)', () => {
  it('GIBS satellites → GIBS WMTS template with the frame time', () => {
    const sat = pickGeoIRSat(29, -95)!; // GOES-East, gibs
    const url = geoIRTileUrl(sat, '2026-06-22T12:00:00Z');
    expect(url).toContain('gibs.earthdata.nasa.gov');
    expect(url).toContain('/2026-06-22T12:00:00Z/');
    expect(url).toContain('{z}/{y}/{x}.png');
  });
  it('Meteosat → RealEarth template, latest frame + cache-bust (no pinned time)', () => {
    const sat = pickGeoIRSat(50, 15)!; // Meteosat, realearth
    const url = geoIRTileUrl(sat, '2026-06-22T12:00:00Z');
    expect(url).toContain('realearth.ssec.wisc.edu/api/image');
    expect(url).toContain('products=Met11-SEVIRI-FD-BAND09');
    expect(url).toContain('x={x}&y={y}&z={z}');
    expect(url).toContain('_v='); // rolling cache-bust → refresh
    expect(url).not.toContain('/default/'); // not the GIBS time-path scheme
  });
});

describe('floorTo10MinIso', () => {
  it('floors to the previous 10-minute mark as a full ISO instant', () => {
    expect(floorTo10MinIso(Date.parse('2026-06-21T17:34:23Z'))).toBe('2026-06-21T17:30:00Z');
    expect(floorTo10MinIso(Date.parse('2026-06-21T17:30:00Z'))).toBe('2026-06-21T17:30:00Z');
    expect(floorTo10MinIso(Date.parse('2026-06-21T00:09:59Z'))).toBe('2026-06-21T00:00:00Z');
  });
});

describe('geoIRTimeForNow', () => {
  it('backs off 30 min for publish latency, floored to 10 min', () => {
    expect(geoIRTimeForNow(Date.parse('2026-06-21T18:05:00Z'))).toBe('2026-06-21T17:30:00Z');
  });
});

describe('gibsGeoIRUrl', () => {
  it('builds the GIBS web-mercator WMTS template at Level6', () => {
    const url = gibsGeoIRUrl('GOES-East_ABI_Band13_Clean_Infrared', '2026-06-21T17:30:00Z');
    expect(url).toContain('/epsg3857/best/GOES-East_ABI_Band13_Clean_Infrared/default/2026-06-21T17:30:00Z/');
    expect(url).toContain('GoogleMapsCompatible_Level6/{z}/{y}/{x}.png');
    expect(GIBS_GEO_IR_MAX_ZOOM).toBe(6);
  });
});
