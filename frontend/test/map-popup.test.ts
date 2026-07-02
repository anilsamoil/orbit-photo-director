import { describe, expect, it, vi } from 'vitest';
import {
  buildTargetPopupContent,
  cloudSourceLabel,
  patchPopupWeather,
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

describe('buildTargetPopupContent — two-shape popup', () => {
  const NOW = Date.parse('2024-10-17T12:00:00Z');
  // Shape A factory: a target WITH an upcoming pass.
  const passA = (over: Partial<TargetPopupProps> = {}): TargetPopupProps => ({
    target_name: 'Tokyo',
    has_pass: true,
    score: 87,
    closest_approach: '2024-10-17T18:00:00Z',
    ...over,
  });

  it('Shape A: name + score + pass time with relative suffix', () => {
    const el = buildTargetPopupContent(passA(), NOW);
    expect(el.querySelector('strong')?.textContent).toBe('Tokyo');
    expect(el.querySelector('.map-popup-score')?.textContent).toBe('score 87');
    const passRow = Array.from(el.querySelectorAll('.map-popup-row'))
      .find((r) => r.textContent?.startsWith('Pass:'));
    expect(passRow?.textContent).toContain('Pass: 2024-10-17 18:00Z');
    expect(passRow?.textContent).toContain('in 6h');
  });

  it('Shape A: "ago" for past pass times', () => {
    const el = buildTargetPopupContent(passA({ closest_approach: '2024-10-17T11:30:00Z' }), NOW);
    const passRow = Array.from(el.querySelectorAll('.map-popup-row'))
      .find((r) => r.textContent?.startsWith('Pass:'));
    expect(passRow?.textContent).toContain('30m ago');
  });

  it('Shape A: omits relative-time when pass rounds to 0 min', () => {
    const el = buildTargetPopupContent(passA({ closest_approach: '2024-10-17T12:00:10Z' }), NOW);
    const passRow = Array.from(el.querySelectorAll('.map-popup-row'))
      .find((r) => r.textContent?.startsWith('Pass:'));
    expect(passRow?.textContent).toMatch(/^Pass: 2024-10-17 12:00Z$/);
  });

  it('Shape A: distance-from-track row ONLY when both angles finite (no NaN — R7)', () => {
    const withAngles = buildTargetPopupContent(
      passA({ angle_off_nadir_deg: 29, iss_relative_bearing_deg: 250 }),
      NOW,
    );
    const offRow = Array.from(withAngles.querySelectorAll('.map-popup-row'))
      .find((r) => /track/.test(r.textContent ?? ''));
    expect(offRow?.textContent).toMatch(/° (left|right) of track/);
    expect(withAngles.textContent).not.toContain('NaN');
    // No angles → no off-nadir row, never "NaN° … of track"
    const noAngles = buildTargetPopupContent(passA(), NOW);
    expect(
      Array.from(noAngles.querySelectorAll('.map-popup-row')).some((r) => /track/.test(r.textContent ?? '')),
    ).toBe(false);
    expect(noAngles.textContent).not.toContain('NaN');
  });

  it('Shape A: regime + obstruction row', () => {
    const el = buildTargetPopupContent(passA({ pass_regime: 'night', obstruction_class: 'clear' }), NOW);
    const regimeRow = Array.from(el.querySelectorAll('.map-popup-row'))
      .find((r) => r.textContent === 'night · clear');
    expect(regimeRow).toBeTruthy();
  });

  it('Shape A: ONE weather row baselines the at-pass forecast (rounded — R9)', () => {
    const el = buildTargetPopupContent(passA({ cloud_fraction: 18.7 }), NOW);
    expect(el.querySelectorAll('.map-popup-weather').length).toBe(1);
    expect(el.querySelector('.map-popup-weather')?.textContent).toBe('Cloud: at pass 19%');
  });

  it('Shape A: weather row shows "checking now…" when no forecast baseline', () => {
    const el = buildTargetPopupContent(passA(), NOW);
    expect(el.querySelector('.map-popup-weather')?.textContent).toBe('Cloud: checking now…');
  });

  it('Shape B (no pass): "No upcoming pass", NEVER "score 0" (R6)', () => {
    const el = buildTargetPopupContent({ target_name: 'Great Wall', has_pass: false }, NOW);
    expect(el.querySelector('.map-popup-score')).toBeNull();
    expect(el.textContent).not.toContain('score 0');
    expect(
      Array.from(el.querySelectorAll('.map-popup-row')).some(
        (r) => r.textContent === 'No upcoming pass in window',
      ),
    ).toBe(true);
    expect(el.querySelector('.map-popup-weather')?.textContent).toBe('Cloud: checking now…');
  });

  it('Shape B: missing has_pass is treated as no pass (never "score 0")', () => {
    const el = buildTargetPopupContent({ target_name: 'Mystery' }, NOW);
    expect(el.querySelector('.map-popup-score')).toBeNull();
    expect(el.textContent).not.toContain('score');
  });

  it('shot status renders ONLY when count > 0 (absence ≠ never shot — R12)', () => {
    expect(buildTargetPopupContent(passA({ shot_count: 3 }), NOW)
      .querySelector('.map-popup-shot')?.textContent).toBe('✓ shot 3×');
    expect(buildTargetPopupContent(passA({ shot_count: 0 }), NOW)
      .querySelector('.map-popup-shot')).toBeNull();
    expect(buildTargetPopupContent(passA(), NOW)
      .querySelector('.map-popup-shot')).toBeNull();
  });

  it('Edit button only for personal targets AND only with an onEdit callback (R11)', () => {
    const onEdit = vi.fn();
    const personal = buildTargetPopupContent(
      passA({ is_personal: true, target_id: 'personal:default:gw' }),
      NOW,
      onEdit,
    );
    const btn = personal.querySelector<HTMLButtonElement>('.map-popup-edit');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(onEdit).toHaveBeenCalledWith('personal:default:gw');
    // curated target → no Edit button even with a callback
    expect(
      buildTargetPopupContent(passA({ is_personal: false, target_id: 'pettit:x' }), NOW, onEdit)
        .querySelector('.map-popup-edit'),
    ).toBeNull();
    // personal but no callback → no button
    expect(
      buildTargetPopupContent(passA({ is_personal: true, target_id: 'personal:default:gw' }), NOW)
        .querySelector('.map-popup-edit'),
    ).toBeNull();
  });

  it('XSS: name renders as literal text, no injected node (R13)', () => {
    const payload = '"><img src=x onerror="alert(1)">';
    const el = buildTargetPopupContent(passA({ target_name: payload }), NOW);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('strong')?.textContent).toBe(payload);
  });

  it('missing target_name → "unknown"', () => {
    expect(
      buildTargetPopupContent({ has_pass: false }, NOW).querySelector('strong')?.textContent,
    ).toBe('unknown');
  });
});

describe('patchPopupWeather', () => {
  const NOW = Date.parse('2024-10-17T12:00:00Z');

  it('combines live now + at-pass on the single weather row', () => {
    const body = buildTargetPopupContent({ has_pass: true, score: 50, cloud_fraction: 18 }, NOW);
    patchPopupWeather(body, 42, { has_pass: true, cloud_fraction: 18 });
    expect(body.querySelector('.map-popup-weather')?.textContent).toBe('Cloud: now 42% · at pass 18%');
  });

  it('now-only when there is no pass', () => {
    const body = buildTargetPopupContent({ has_pass: false }, NOW);
    patchPopupWeather(body, 30, { has_pass: false });
    expect(body.querySelector('.map-popup-weather')?.textContent).toBe('Cloud: now 30%');
  });

  it('collapses the row when there is nothing to show (null now, no pass)', () => {
    const body = buildTargetPopupContent({ has_pass: false }, NOW);
    patchPopupWeather(body, null, { has_pass: false });
    expect(body.querySelector('.map-popup-weather')).toBeNull();
  });

  it('falls back to at-pass when the live value is null (Shape A)', () => {
    const body = buildTargetPopupContent({ has_pass: true, score: 50, cloud_fraction: 18 }, NOW);
    patchPopupWeather(body, null, { has_pass: true, cloud_fraction: 18 });
    expect(body.querySelector('.map-popup-weather')?.textContent).toBe('Cloud: at pass 18%');
  });
});
