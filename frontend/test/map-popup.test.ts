import { describe, expect, it } from 'vitest';
import {
  buildTargetPopupContent,
  cloudSourceLabel,
  type TargetPopupProps,
} from '../src/map';

describe('cloudSourceLabel', () => {
  it('returns "GFS forecast" for the forecast source', () => {
    expect(cloudSourceLabel('gfs-forecast')).toBe('GFS forecast');
  });

  it('returns "MODIS observed" for gibs', () => {
    expect(cloudSourceLabel('gibs')).toBe('MODIS observed');
  });

  it('formats GOES-IR sources with satellite name', () => {
    expect(cloudSourceLabel('geo-ir-goes16')).toBe('GOES16 observed');
    expect(cloudSourceLabel('geo-ir-goes18')).toBe('GOES18 observed');
  });

  it('formats Meteosat + Himawari', () => {
    expect(cloudSourceLabel('meteosat-ir108')).toBe('Meteosat observed');
    expect(cloudSourceLabel('himawari-nict')).toBe('Himawari observed');
  });

  it('returns "no obs" for combined-no-coverage', () => {
    expect(cloudSourceLabel('combined-no-coverage')).toBe('no obs');
  });

  it('returns "mock" for mock', () => {
    expect(cloudSourceLabel('mock')).toContain('mock');
  });

  it('returns "unknown" for undefined', () => {
    expect(cloudSourceLabel(undefined)).toBe('unknown');
  });

  it('passes through unrecognized sources verbatim', () => {
    expect(cloudSourceLabel('future-source-name')).toBe('future-source-name');
  });
});

describe('buildTargetPopupContent', () => {
  const NOW = Date.parse('2024-10-17T12:00:00Z');

  it('renders the target name and score', () => {
    const props: TargetPopupProps = {
      target_name: 'Tokyo at night',
      score: 87,
    };
    const el = buildTargetPopupContent(props, NOW);
    expect(el.querySelector('strong')?.textContent).toBe('Tokyo at night');
    expect(el.querySelector('.map-popup-score')?.textContent).toBe('score 87');
  });

  it('renders pass time with relative-time suffix when in the future', () => {
    const props: TargetPopupProps = {
      target_name: 'Test',
      score: 50,
      closest_approach: '2024-10-17T18:00:00Z',
    };
    const el = buildTargetPopupContent(props, NOW);
    const rows = el.querySelectorAll('.map-popup-row');
    const passRow = Array.from(rows).find((r) => r.textContent?.startsWith('Pass:'));
    expect(passRow?.textContent).toContain('Pass: 2024-10-17 18:00Z');
    expect(passRow?.textContent).toContain('in 6h');
  });

  it('renders "ago" for past pass times', () => {
    const props: TargetPopupProps = {
      target_name: 'Test',
      score: 50,
      closest_approach: '2024-10-17T11:30:00Z',
    };
    const el = buildTargetPopupContent(props, NOW);
    const rows = el.querySelectorAll('.map-popup-row');
    const passRow = Array.from(rows).find((r) => r.textContent?.startsWith('Pass:'));
    expect(passRow?.textContent).toContain('30m ago');
  });

  it('omits relative-time when pass is within ±30s (rounds to 0 min)', () => {
    const props: TargetPopupProps = {
      target_name: 'Test',
      score: 50,
      // 10s delta rounds to 0 minutes; helper returns empty string for "< 1 min"
      closest_approach: '2024-10-17T12:00:10Z',
    };
    const el = buildTargetPopupContent(props, NOW);
    const rows = el.querySelectorAll('.map-popup-row');
    const passRow = Array.from(rows).find((r) => r.textContent?.startsWith('Pass:'));
    expect(passRow?.textContent).toMatch(/^Pass: 2024-10-17 12:00Z$/);
  });

  it('renders forecast cloud row with operator-facing source label', () => {
    const props: TargetPopupProps = {
      target_name: 'Test',
      score: 70,
      cloud_fraction: 18,
      cloud_source: 'gfs-forecast',
    };
    const el = buildTargetPopupContent(props, NOW);
    const rows = el.querySelectorAll('.map-popup-row');
    const cloudRow = Array.from(rows).find((r) => r.textContent?.startsWith('Cloud:'));
    expect(cloudRow?.textContent).toBe('Cloud: 18% (GFS forecast)');
  });

  it('renders observed cloud row with the satellite label', () => {
    const props: TargetPopupProps = {
      target_name: 'Test',
      score: 70,
      cloud_fraction: 35,
      cloud_source: 'geo-ir-goes16',
    };
    const el = buildTargetPopupContent(props, NOW);
    const cloudRow = Array.from(el.querySelectorAll('.map-popup-row'))
      .find((r) => r.textContent?.startsWith('Cloud:'));
    expect(cloudRow?.textContent).toBe('Cloud: 35% (GOES16 observed)');
  });

  it('renders regime + obstruction row', () => {
    const props: TargetPopupProps = {
      target_name: 'Test',
      score: 70,
      pass_regime: 'night',
      obstruction_class: 'clear',
    };
    const el = buildTargetPopupContent(props, NOW);
    const rows = el.querySelectorAll('.map-popup-row');
    const regimeRow = Array.from(rows).find((r) => r.textContent === 'night · clear');
    expect(regimeRow).toBeTruthy();
  });

  it('omits optional rows gracefully', () => {
    const props: TargetPopupProps = {
      target_name: 'Test',
      score: 70,
      // no closest_approach, no cloud, no regime
    };
    const el = buildTargetPopupContent(props, NOW);
    expect(el.querySelectorAll('.map-popup-row').length).toBe(0);
  });

  it('escapes HTML in target_name via textContent (XSS defense)', () => {
    const props: TargetPopupProps = {
      target_name: '<img src=x onerror="alert(1)">',
      score: 70,
    };
    const el = buildTargetPopupContent(props, NOW);
    // The strong tag's text is literal; no img child node was created
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('strong')?.textContent).toBe('<img src=x onerror="alert(1)">');
  });

  it('rounds cloud_fraction to integer', () => {
    const props: TargetPopupProps = {
      target_name: 'Test',
      score: 70,
      cloud_fraction: 18.7,
      cloud_source: 'gfs-forecast',
    };
    const el = buildTargetPopupContent(props, NOW);
    const cloudRow = Array.from(el.querySelectorAll('.map-popup-row'))
      .find((r) => r.textContent?.startsWith('Cloud:'));
    expect(cloudRow?.textContent).toContain('19%');
  });

  it('handles missing score gracefully (defaults to 0)', () => {
    const props: TargetPopupProps = {
      target_name: 'Test',
    };
    const el = buildTargetPopupContent(props, NOW);
    expect(el.querySelector('.map-popup-score')?.textContent).toBe('score 0');
  });

  it('handles missing target_name with "unknown"', () => {
    const props: TargetPopupProps = {
      score: 50,
    };
    const el = buildTargetPopupContent(props, NOW);
    expect(el.querySelector('strong')?.textContent).toBe('unknown');
  });
});
