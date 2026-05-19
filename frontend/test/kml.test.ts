import { describe, expect, it, vi } from 'vitest';
import {
  buildKml,
  downloadKml,
  googleEarthWebUrl,
  kmlFilename,
  type LookupResult,
  xmlEscape,
} from '../src/kml';

const sampleResult = (overrides: Partial<LookupResult> = {}): LookupResult => ({
  timestamp_utc: new Date('2024-10-17T12:23:00Z'),
  lat: 35.681,
  lon: 139.692,
  alt_km: 408.5,
  tle_age_at_lookup_hours: 17.4,
  confidence: 'high',
  source: 'paste',
  ...overrides,
});

describe('xmlEscape', () => {
  it('escapes the five canonical XML chars', () => {
    expect(xmlEscape('<a href="x" b=\'y\'>&copy;</a>')).toBe(
      '&lt;a href=&quot;x&quot; b=&apos;y&apos;&gt;&amp;copy;&lt;/a&gt;',
    );
  });
});

describe('buildKml', () => {
  it('emits a well-formed KML 2.2 document', () => {
    const kml = buildKml(sampleResult());
    expect(kml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(kml).toContain('xmlns="http://www.opengis.net/kml/2.2"');
    expect(kml).toContain('<Placemark>');
    expect(kml).toContain('</Placemark>');
  });

  it('includes coordinates in lon,lat,alt(m) order per KML spec', () => {
    const kml = buildKml(sampleResult({ lat: 35.681, lon: 139.692, alt_km: 408.5 }));
    expect(kml).toContain('<coordinates>139.692000,35.681000,408500.0</coordinates>');
  });

  it('uses relativeToGround altitudeMode for proper rendering above the surface', () => {
    const kml = buildKml(sampleResult());
    expect(kml).toContain('<altitudeMode>relativeToGround</altitudeMode>');
  });

  it('includes the timestamp in a KML TimeStamp element', () => {
    const kml = buildKml(sampleResult());
    expect(kml).toContain('<TimeStamp><when>2024-10-17T12:23:00.000Z</when></TimeStamp>');
  });

  it('parses back as valid XML', () => {
    const kml = buildKml(sampleResult());
    const parser = new DOMParser();
    const doc = parser.parseFromString(kml, 'application/xml');
    const errors = doc.getElementsByTagName('parsererror');
    expect(errors.length).toBe(0);
    const placemarks = doc.getElementsByTagName('Placemark');
    expect(placemarks.length).toBe(1);
  });

  it('renders confidence text in the description', () => {
    const kml = buildKml(sampleResult({ confidence: 'low', tle_age_at_lookup_hours: 96.0 }));
    expect(kml).toContain('low');
    expect(kml).toContain('96.0');
  });
});

describe('googleEarthWebUrl', () => {
  it('builds a Google Earth Web URL with lat/lon at 6 decimals', () => {
    const url = googleEarthWebUrl(sampleResult({ lat: 35.681, lon: 139.692 }));
    expect(url).toBe('https://earth.google.com/web/@35.681000,139.692000,0a,1000d,1y,0h,0t,0r');
  });

  it('produces a parseable URL', () => {
    const url = googleEarthWebUrl(sampleResult());
    expect(() => new URL(url)).not.toThrow();
  });
});

describe('kmlFilename', () => {
  it('formats as iss-position-YYYYMMDD-HHMMSS.kml', () => {
    expect(kmlFilename(sampleResult())).toBe('iss-position-20241017-122300.kml');
  });

  it('pads single-digit components', () => {
    const r = sampleResult({ timestamp_utc: new Date('2024-01-05T03:08:07Z') });
    expect(kmlFilename(r)).toBe('iss-position-20240105-030807.kml');
  });

  it('uses UTC components, not local time', () => {
    const r = sampleResult({ timestamp_utc: new Date(Date.UTC(2024, 0, 1, 0, 0, 0)) });
    expect(kmlFilename(r)).toBe('iss-position-20240101-000000.kml');
  });
});

describe('downloadKml', () => {
  it('triggers a download via blob + anchor click', () => {
    // jsdom doesn't fully implement URL.createObjectURL by default — stub it.
    const createObjectURL = vi.fn(() => 'blob:fake-url');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(global.URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(global.URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });

    const clickSpy = vi.fn();
    const origAppend = document.body.appendChild.bind(document.body);
    const origRemove = document.body.removeChild.bind(document.body);
    const seen: HTMLAnchorElement[] = [];
    document.body.appendChild = ((node: Node) => {
      if (node instanceof HTMLAnchorElement) {
        seen.push(node);
        node.click = clickSpy;
      }
      return origAppend(node);
    }) as typeof document.body.appendChild;

    downloadKml(sampleResult());

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(seen.length).toBeGreaterThan(0);
    const lastAnchor = seen[seen.length - 1];
    expect(lastAnchor).toBeDefined();
    if (lastAnchor) {
      expect(lastAnchor.download).toBe('iss-position-20241017-122300.kml');
    }

    // Restore
    document.body.appendChild = origAppend as typeof document.body.appendChild;
    document.body.removeChild = origRemove as typeof document.body.removeChild;
  });
});
