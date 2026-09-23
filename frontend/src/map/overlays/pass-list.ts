import { formatUtcHm } from '../../countdown';
import type { UpcomingPass } from '../../pin-drop';
import type { IssIllumination } from '../../terminator';
import { formatTrackOffset } from '../../track-offset';

export interface PassListSection {
  name: string;
  color: string;
  passes: UpcomingPass[];
}

export type PassListOptions = { emptyText?: string; footerText?: string };

export function buildPassList(
  lat: number,
  lon: number,
  precision: number,
  sections: PassListSection[],
  nowMs: number,
  options: PassListOptions = {},
): HTMLElement {
  const body = document.createElement('div');
  body.className = 'dropped-pin-popup';
  body.style.cssText = 'font:0.85rem/1.4 system-ui;color:#0b0d12';

  const title = document.createElement('strong');
  const latStr = `${Math.abs(lat).toFixed(precision)}°${lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(lon).toFixed(precision)}°${lon >= 0 ? 'E' : 'W'}`;
  title.textContent = `📍 ${latStr}, ${lonStr}`;
  body.appendChild(title);

  let anyPasses = false;

  for (const section of sections) {
    if (section.passes.length === 0) continue;
    anyPasses = true;
    const heading = document.createElement('div');
    heading.style.cssText = `margin:8px 0 2px;color:${section.color};font-weight:600;font-size:0.82rem`;
    heading.textContent = `${section.name} — next ${section.passes.length} pass${section.passes.length === 1 ? '' : 'es'}`;
    body.appendChild(heading);

    const list = document.createElement('div');
    list.style.cssText = 'font:0.78rem/1.5 ui-monospace,Menlo,monospace;color:#0b0d12';
    for (const p of section.passes) {
      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:55px 50px 55px minmax(0,1fr) 70px;gap:6px;padding:3px 0;border-bottom:1px solid #eee;align-items:baseline';
      const rel = document.createElement('span');
      rel.style.fontWeight = '600';
      rel.textContent = formatRelative(p.closestApproachMs - nowMs);
      const utc = document.createElement('span');
      utc.textContent = formatUtcHm(p.closestApproachMs);
      const nadir = document.createElement('span');
      nadir.style.textAlign = 'right';
      nadir.textContent = `${Math.round(p.nadirKm)} km`;
      const shoot = document.createElement('span');
      shoot.style.cssText = 'font-size:0.72rem;color:#444;min-width:0;overflow-wrap:anywhere';
      shoot.textContent = formatShootHint(p);
      const regime = document.createElement('span');
      regime.style.textAlign = 'right';
      regime.style.color = regimeColor(p.regime);
      regime.textContent = regimeLabel(p.regime);
      row.append(rel, utc, nadir, shoot, regime);
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  if (!anyPasses) {
    const empty = document.createElement('div');
    empty.style.cssText = 'margin-top:8px;color:#444';
    empty.textContent = options.emptyText ?? 'No passes from any tracked satellite within 1500 km in the next 36 hours.';
    body.appendChild(empty);
    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top:6px;color:#888;font-size:0.78rem';
    hint.textContent = 'Most low-Earth-orbit satellites have inclinations 27-65°; points near the poles see few passes.';
    body.appendChild(hint);
  }

  const footer = document.createElement('div');
  footer.style.cssText = 'margin-top:6px;color:#888;font-size:0.72rem';
  footer.textContent = options.footerText ?? 'Closest-approach within 1500 km horizon. Click pin to dismiss.';
  body.appendChild(footer);

  return body;
}

export function formatShootHint(p: UpcomingPass): string {
  if (typeof p.angleOffNadirDeg !== 'number') return '';
  const deg = Math.round(p.angleOffNadirDeg);
  const win = p.angleOffNadirDeg < 30 ? 'WORF' : 'Cupola';
  if (typeof p.relativeBearingDeg !== 'number') {
    return `${deg}° · ${win}`;
  }
  return `${formatTrackOffset(p.angleOffNadirDeg, p.relativeBearingDeg)} · ${win}`;
}

function formatRelative(deltaMs: number): string {
  const totalMin = Math.round(deltaMs / 60000);
  if (totalMin < 60) return `+${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m === 0 ? `+${h}h` : `+${h}h${m}m`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh === 0 ? `+${d}d` : `+${d}d${rh}h`;
}

function regimeLabel(r: IssIllumination): string {
  if (r === 'iss-day') return 'day';
  if (r === 'iss-twilight') return 'twilight';
  return 'night';
}

function regimeColor(r: IssIllumination): string {
  if (r === 'iss-day') return '#0a8acc';
  if (r === 'iss-twilight') return '#a8389a';
  return '#5b6b8a';
}
