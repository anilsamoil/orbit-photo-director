import { isTleStale } from '../../../banner';
import { liveIssPositionSGP4 } from '../../../iss-sgp4';
import { findUpcomingPasses } from '../../../pin-drop';
import { formatTrackOffset } from '../../../track-offset';
import type { Track } from '../../../types';
import { buildPassList } from '../../overlays/pass-list';

/** Fields a target pin carries into its popup. */
export interface TargetPopupProps {
  target_id?: string;
  target_name?: string;
  score?: number;
  closest_approach?: string;
  cloud_fraction?: number;
  cloud_source?: string;
  pass_regime?: string;
  obstruction_class?: string;
  sample_time?: string | null;
  lat?: number;
  lon?: number;
  priority?: number;
  has_pass?: boolean;
  is_personal?: boolean;
  shot_count?: number;
  angle_off_nadir_deg?: number;
  iss_relative_bearing_deg?: number;
}

/** Operator label for the generator's cloud_source token. */
export function cloudSourceLabel(source: string | undefined): string {
  if (!source) return 'unknown';
  if (source === 'gfs-forecast') return 'GFS forecast';
  if (source === 'gibs') return 'MODIS observed';
  if (source.startsWith('geo-ir-')) {
    const sat = source.slice('geo-ir-'.length);
    return `${sat.toUpperCase()} observed`;
  }
  if (source === 'meteosat-ir108') return 'Meteosat observed';
  if (source === 'himawari-nict') return 'Himawari observed';
  if (source === 'mock') return 'mock (no obs)';
  if (source.endsWith('-no-coverage') || source === 'combined-no-coverage') return 'no obs';
  return source;
}

function formatRelativeMinutes(deltaMinutes: number): string {
  const abs = Math.abs(deltaMinutes);
  if (abs < 1) return '';
  const past = deltaMinutes < 0;
  const suffix = past ? ' ago' : '';
  const prefix = past ? '' : 'in ';
  if (abs < 60) return `${prefix}${abs}m${suffix}`;
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (m === 0) return `${prefix}${h}h${suffix}`;
  return `${prefix}${h}h ${m}m${suffix}`;
}

/** Popup body for a target tap. Text is `textContent` only.
 *  `now` is read again when the operator asks for the next passes, so that
 *  scan uses the clock at click time rather than the instant the popup opened. */
export function buildTargetPopupContent(
  props: TargetPopupProps,
  nowMs: number,
  onEdit?: (targetId: string) => void,
  track: Track | null = null,
  now: () => number = () => nowMs,
): HTMLElement {
  const body = document.createElement('div');
  body.className = 'map-target-popup';
  body.style.cssText = 'font:0.85rem/1.4 system-ui;color:#0b0d12;min-width:200px';

  const addRow = (cls: string, text: string, style: string): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = cls;
    row.style.cssText = style;
    row.textContent = text;
    body.appendChild(row);
    return row;
  };

  const nameEl = document.createElement('strong');
  nameEl.textContent = props.target_name ?? 'unknown';
  body.appendChild(nameEl);

  const hasPass = props.has_pass === true;

  if (hasPass) {
    addRow('map-popup-score', `score ${Math.round(props.score ?? 0)}`, 'font-weight:600;color:#0b0d12;margin-top:2px');
    if (props.closest_approach) {
      const passMs = Date.parse(props.closest_approach);
      if (Number.isFinite(passMs)) {
        const utc = props.closest_approach.replace('T', ' ').replace(/:\d{2}(\.\d+)?Z$/, 'Z');
        const rel = formatRelativeMinutes(Math.round((passMs - nowMs) / 60_000));
        addRow('map-popup-row', `Pass: ${utc}${rel ? ` (${rel})` : ''}`, 'margin-top:6px;color:#444');
      }
    }
    if (Number.isFinite(props.angle_off_nadir_deg) && Number.isFinite(props.iss_relative_bearing_deg)) {
      addRow('map-popup-row', formatTrackOffset(props.angle_off_nadir_deg!, props.iss_relative_bearing_deg!), 'margin-top:2px;color:#444');
    }
    const regimeBits: string[] = [];
    if (props.pass_regime) regimeBits.push(props.pass_regime);
    if (props.obstruction_class) regimeBits.push(props.obstruction_class);
    if (regimeBits.length > 0) addRow('map-popup-row', regimeBits.join(' · '), 'margin-top:2px;color:#444');
  } else {
    addRow(
      'map-popup-row',
      props.is_personal ? 'Saved target · no scored forecast available' : 'No upcoming pass in window',
      'margin-top:6px;color:#444',
    );
  }

  const atPass = hasPass && typeof props.cloud_fraction === 'number' ? Math.round(props.cloud_fraction) : null;
  addRow('map-popup-weather', atPass != null ? `Cloud: at pass ${atPass}%` : 'Cloud: checking now…', 'margin-top:2px;color:#444');

  if (typeof props.shot_count === 'number' && props.shot_count > 0) {
    addRow('map-popup-shot', `✓ shot ${props.shot_count}×`, 'margin-top:4px;color:#1a7a3a;font-weight:600');
  }

  if (props.is_personal && props.target_id && onEdit) {
    const id = props.target_id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'map-popup-edit';
    btn.textContent = 'Edit target';
    btn.style.cssText = 'margin-top:8px;font:inherit;cursor:pointer;border:1px solid #2a3142;background:#eef1f6;color:#0b0d12;border-radius:4px;padding:3px 8px';
    btn.addEventListener('click', () => onEdit(id));
    body.appendChild(btn);
  }

  if (props.is_personal && !hasPass && track
    && Number.isFinite(props.lat) && Number.isFinite(props.lon)
    && Math.abs(props.lat!) <= 90 && Math.abs(props.lon!) <= 180) {
    const lat = props.lat!;
    const lon = props.lon!;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'map-popup-next-passes';
    button.textContent = 'Next ISS passes';
    button.style.cssText = 'display:block;margin-top:8px;font:inherit;cursor:pointer';
    const results = document.createElement('div');
    results.className = 'map-popup-personal-passes';
    results.setAttribute('aria-live', 'polite');
    button.addEventListener('click', () => {
      button.disabled = true;
      results.textContent = 'Calculating upcoming passes…';
      window.setTimeout(() => {
        const queryMs = now();
        try {
          if (!liveIssPositionSGP4(track, queryMs)) {
            results.textContent = 'Orbit data is unavailable. Reconnect and refresh to check passes.';
            return;
          }
          const passes = findUpcomingPasses(track, lat, lon, queryMs);
          const prediction = buildPassList(lat, lon, 3, [{ name: 'ISS', color: '#125e87', passes }], queryMs, {
            emptyText: 'No ISS passes within 1500 km in the next 36 hours.',
            footerText: 'Geometric estimate from the saved orbit data; clouds and window obstructions are not included.',
          });
          const epoch = Date.parse(track.tle_epoch);
          const ageHours = Number.isFinite(epoch) ? (queryMs - epoch) / 3_600_000 : track.tle_age_hours;
          if (isTleStale(ageHours)) {
            const stale = document.createElement('p');
            stale.textContent = `Orbit data is ${Math.round(ageHours!)} hours old; pass times may have drifted. Refresh when connected.`;
            prediction.appendChild(stale);
          }
          results.replaceChildren(prediction);
        } catch {
          results.textContent = 'Could not calculate passes. Reconnect and refresh the orbit data.';
        } finally {
          button.disabled = false;
        }
      }, 0);
    });
    body.append(button, results);
  }

  return body;
}

/** Replace the weather row with the live cloud once it resolves.
 *  Removes the row when neither a live value nor an at-pass forecast exists. */
export function patchPopupWeather(
  body: HTMLElement,
  nowPct: number | null,
  props: TargetPopupProps,
): void {
  const row = body.querySelector<HTMLElement>('.map-popup-weather');
  if (!row) return;
  const atPass = props.has_pass === true && typeof props.cloud_fraction === 'number' ? Math.round(props.cloud_fraction) : null;
  const parts: string[] = [];
  if (nowPct != null) parts.push(`now ${nowPct}%`);
  if (atPass != null) parts.push(`at pass ${atPass}%`);
  if (parts.length === 0) {
    row.remove();
    return;
  }
  row.textContent = `Cloud: ${parts.join(' · ')}`;
}
