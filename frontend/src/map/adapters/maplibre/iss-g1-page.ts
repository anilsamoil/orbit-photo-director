import 'maplibre-gl/dist/maplibre-gl.css';

import { subsolarPoint } from '../../../terminator';
import {
  BLACK_MARBLE_2016_TEMPLATE,
  BLUE_MARBLE_TEMPLATE,
  compositeRgba,
  fillTileUrl,
  groundSunElevationDeg,
  lightingBucket,
  mixPixel,
  tilePixelLatLon,
} from '../../../iss-g1/lighting';
import {
  fittedFrame,
  type CameraPreset,
  type SphericalFix,
} from '../../../iss-g1/model';
import { createIssProbe, type IssProbe, type ProbeSample } from './iss-g1';

const FIXTURE_MS = Date.UTC(2026, 2, 20, 12, 0, 0);
const NOW: SphericalFix = { latDeg: 30, lonDeg: 31, altKm: 420 };
const BEFORE: SphericalFix = { latDeg: 30.4, lonDeg: 31, altKm: 420 };
const AFTER: SphericalFix = { latDeg: 29.6, lonDeg: 31, altKm: 420 };

type Check = { name: string; pass: boolean; detail: string };

export type G1Report = {
  status: 'pass' | 'fail';
  checks: Check[];
  horizon: ProbeSample | null;
  nadir: ProbeSample | null;
  projectionZoom12: string;
  nasa: { blue: string; black: string };
  lighting: { day: string; twilight: string; night: string };
  sweepBearings: number[];
  problems: string[];
  webgl: string;
};

declare global {
  interface Window {
    __opdG1?: {
      report: G1Report;
      sweep: () => Promise<number[]>;
    };
  }
}

function css(): string {
  return `
    body { margin: 0; background: #05060a; color: #e8eef6; font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; }
    header, section { padding: 12px 16px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .frames { display: flex; flex-wrap: wrap; gap: 16px; }
    figure { margin: 0; }
    figcaption { margin-bottom: 6px; font-weight: 650; }
    .frame { background: #000; }
    pre { white-space: pre-wrap; background: #10151d; padding: 10px; border-radius: 8px; }
    .swatches { display: flex; gap: 12px; }
    .swatch { width: 72px; height: 72px; border-radius: 8px; }
    canvas.limb { width: 100%; max-width: 640px; height: 140px; background: #000; }
    button { min-width: 44px; min-height: 44px; margin-right: 8px; }
  `;
}

function line(sample: ProbeSample | null): string {
  if (!sample) return 'no sample';
  return [
    `projection ${sample.projection}`,
    `fov ${sample.verticalFovDeg.toFixed(5)}`,
    `maxPitch ${sample.maxPitchDeg.toFixed(2)}`,
    `pitch ${sample.pitchDeg.toFixed(3)} analytic ${sample.analyticPitchDeg.toFixed(3)}`,
    `bearing ${sample.bearingDeg.toFixed(3)}`,
    `inward ${sample.inwardDeg.toFixed(2)}`,
    `radius error m ${sample.radiusErrorM.toFixed(1)}`,
    `subpoint error deg ${sample.subpointErrorDeg.toFixed(4)}`,
    `limb error deg ${sample.limbErrorDeg === null ? 'n/a' : sample.limbErrorDeg.toFixed(4)}`,
    `earth fraction ${sample.earthFraction.toFixed(4)}`,
    `nested ${sample.nested}`,
    `camera ${sample.camera.latDeg.toFixed(4)}, ${sample.camera.lonDeg.toFixed(4)} r ${sample.camera.radiusM.toFixed(1)}`,
  ].join('\n');
}

function drawLimb(canvas: HTMLCanvasElement, column: number[], errorDeg: number | null, inwardDeg: number, heightPx: number, fov: number): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const width = canvas.width;
  const height = canvas.height;
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = '#7d8ea3';
  context.beginPath();
  for (let y = 0; y < column.length; y += 1) {
    const x = ((column[y] ?? 0) / 255) * (width - 40);
    const py = (y / Math.max(1, column.length - 1)) * (height - 16) + 8;
    if (y === 0) context.moveTo(x, py);
    else context.lineTo(x, py);
  }
  context.stroke();
  const focal = (heightPx / 2) / Math.tan((fov * Math.PI / 180) / 2);
  const expectedRow = (heightPx - 1) / 2 - Math.tan(inwardDeg * Math.PI / 180) * focal;
  const marker = (expectedRow / Math.max(1, heightPx - 1)) * (height - 16) + 8;
  context.strokeStyle = '#f2c14e';
  context.beginPath();
  context.moveTo(0, marker);
  context.lineTo(width, marker);
  context.stroke();
  context.fillStyle = '#f2c14e';
  context.fillText(errorDeg === null ? 'no limb' : `limb error ${errorDeg.toFixed(3)} deg`, 8, 14);
}

async function decodePair(subsolar: { lat: number; lon: number }): Promise<{ blue: string; black: string; day: string; twilight: string; night: string }> {
  const blueUrl = fillTileUrl(BLUE_MARBLE_TEMPLATE, 0, 0, 0);
  const blackUrl = fillTileUrl(BLACK_MARBLE_2016_TEMPLATE, 0, 0, 0);
  const [blueResponse, blackResponse] = await Promise.all([fetch(blueUrl), fetch(blackUrl)]);
  if (!blueResponse.ok || !blackResponse.ok) {
    throw new Error(`NASA ${blueResponse.status} ${blackResponse.status}`);
  }
  const [blueBitmap, blackBitmap] = await Promise.all([
    createImageBitmap(await blueResponse.blob()),
    createImageBitmap(await blackResponse.blob()),
  ]);
  try {
    const blue = `${blueBitmap.width}x${blueBitmap.height}`;
    const black = `${blackBitmap.width}x${blackBitmap.height}`;
    const canvas = new OffscreenCanvas(blueBitmap.width, blueBitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('NASA decode had no canvas');
    context.drawImage(blueBitmap, 0, 0);
    const dayImage = context.getImageData(0, 0, blueBitmap.width, blueBitmap.height);
    context.drawImage(blackBitmap, 0, 0);
    const nightImage = context.getImageData(0, 0, blackBitmap.width, blackBitmap.height);
    const mixed = compositeRgba(dayImage.data, nightImage.data, 0, 0, 0, { latDeg: subsolar.lat, lonDeg: subsolar.lon }, 256);
    const picks = { day: '', twilight: '', night: '' };
    for (let i = 0; i < 256 * 256; i += 1) {
      const whereTile = tilePixelLatLon(0, 0, 0, (i % 256) + 0.5, Math.floor(i / 256) + 0.5, 256);
      const elevation = groundSunElevationDeg(whereTile.latDeg, whereTile.lonDeg, subsolar.lat, subsolar.lon);
      const color = `rgb(${mixed[i * 4]}, ${mixed[i * 4 + 1]}, ${mixed[i * 4 + 2]})`;
      if (!picks.day && elevation > 20) picks.day = color;
      if (!picks.twilight && elevation < -2.5 && elevation > -3.5) picks.twilight = color;
      if (!picks.night && elevation < -20) picks.night = color;
    }
    return { blue, black, ...picks };
  } finally {
    blueBitmap.close();
    blackBitmap.close();
  }
}

function checksFor(horizon: ProbeSample, nadir: ProbeSample, projectionZoom12: string, nasaBlue: string, nasaBlack: string): Check[] {
  const radiusOk = Math.abs(horizon.radiusErrorM) < 2_000 && Math.abs(nadir.radiusErrorM) < 2_000;
  const subpointOk = horizon.subpointErrorDeg < 0.05 && nadir.subpointErrorDeg < 0.05;
  const limbOk = horizon.limbErrorDeg !== null && Math.abs(horizon.limbErrorDeg) < 1;
  const pitchOk = Math.abs(horizon.pitchDeg - horizon.analyticPitchDeg) < 0.5
    && Math.abs(nadir.pitchDeg - nadir.analyticPitchDeg) < 0.5
    && horizon.maxPitchDeg >= 90
    && nadir.maxPitchDeg >= 90;
  const fovOk = Math.abs(horizon.verticalFovDeg - 81.20259) < 0.02 && Math.abs(nadir.verticalFovDeg - 81.20259) < 0.02;
  const projectionOk = horizon.projection === 'vertical-perspective'
    && nadir.projection === 'vertical-perspective'
    && projectionZoom12 === 'vertical-perspective';
  const nadirFilled = nadir.earthFraction > 0.98;
  const nestedOk = nadir.nested === 'object' || horizon.nested === 'object';
  const nasaOk = nasaBlue === '256x256' && nasaBlack === '256x256';
  return [
    { name: 'projection', pass: projectionOk, detail: `${horizon.projection} at zoom 12 ${projectionZoom12}` },
    { name: 'field of view', pass: fovOk, detail: horizon.verticalFovDeg.toFixed(5) },
    { name: 'pitch clamp', pass: pitchOk, detail: `horizon ${horizon.pitchDeg.toFixed(3)} / ${horizon.analyticPitchDeg.toFixed(3)} max ${horizon.maxPitchDeg}` },
    { name: 'camera radius', pass: radiusOk, detail: `horizon ${horizon.radiusErrorM.toFixed(1)} m, nadir ${nadir.radiusErrorM.toFixed(1)} m` },
    { name: 'sub-point', pass: subpointOk, detail: `horizon ${horizon.subpointErrorDeg.toFixed(4)} deg, nadir ${nadir.subpointErrorDeg.toFixed(4)} deg` },
    { name: 'limb', pass: limbOk, detail: horizon.limbErrorDeg === null ? 'missing' : `${horizon.limbErrorDeg.toFixed(4)} deg` },
    { name: 'nadir filled', pass: nadirFilled, detail: nadir.earthFraction.toFixed(4) },
    { name: 'nested property', pass: nestedOk, detail: `horizon ${horizon.nested}, nadir ${nadir.nested}` },
    { name: 'nasa tiles', pass: nasaOk, detail: `${nasaBlue} ${nasaBlack}` },
  ];
}

async function aimBest(probe: IssProbe, preset: CameraPreset): Promise<ProbeSample> {
  const inward = preset === 'horizon' ? [0, 0.25, 0.5] : [0];
  let last: ProbeSample | null = null;
  for (const offset of inward) {
    const sample = await probe.aim(NOW, BEFORE, AFTER, preset, offset);
    last = sample;
    const pitchClose = Math.abs(sample.pitchDeg - sample.analyticPitchDeg) < 0.5;
    const radiusClose = Math.abs(sample.radiusErrorM) < 2_000;
    const limbClose = preset === 'nadir' || (sample.limbErrorDeg !== null && Math.abs(sample.limbErrorDeg) < 1);
    if (pitchClose && radiusClose && limbClose) return sample;
  }
  if (!last) throw new Error('no aim');
  return last;
}

async function main(): Promise<void> {
  const style = document.createElement('style');
  style.textContent = css();
  document.head.appendChild(style);
  const root = document.createElement('main');
  root.innerHTML = `
    <header>
      <h1>G1 probe</h1>
      <p>Fixed vertical perspective. Not an app tab.</p>
      <button type="button" id="sweep">Sweep dateline</button>
    </header>
    <section class="frames">
      <figure><figcaption>Horizon</figcaption><div id="horizon" class="frame"></div></figure>
      <figure><figcaption>Straight down</figcaption><div id="nadir" class="frame"></div></figure>
    </section>
    <section>
      <canvas class="limb" id="limb" width="640" height="140"></canvas>
      <div class="swatches" id="swatches"></div>
      <pre id="readout">measuring</pre>
    </section>
  `;
  document.body.appendChild(root);
  const horizonHost = document.querySelector('#horizon');
  const nadirHost = document.querySelector('#nadir');
  const readoutNode = document.querySelector('#readout');
  const limb = document.querySelector('#limb');
  const swatches = document.querySelector('#swatches');
  if (!(horizonHost instanceof HTMLDivElement) || !(nadirHost instanceof HTMLDivElement) || !(readoutNode instanceof HTMLElement) || !(limb instanceof HTMLCanvasElement) || !(swatches instanceof HTMLElement)) {
    return;
  }
  const readout = readoutNode;
  const pane = Math.max(280, Math.min(640, window.innerWidth - 48));
  const frame = fittedFrame(pane, Math.min(pane / 1.5, 440));
  for (const host of [horizonHost, nadirHost]) {
    host.style.width = `${frame.widthPx}px`;
    host.style.height = `${frame.heightPx}px`;
  }
  const when = new Date(FIXTURE_MS);
  const sun = subsolarPoint(when);
  const subsolar = { latDeg: sun.lat, lonDeg: sun.lon };
  let horizonProbe: IssProbe;
  let nadirProbe: IssProbe;
  try {
    horizonProbe = createIssProbe(horizonHost, subsolar);
    nadirProbe = createIssProbe(nadirHost, subsolar);
  } catch (error) {
    console.error(error);
    readout.textContent = error instanceof Error ? `${error.name}: ${error.message}` : 'WebGL2 is unavailable';
    return;
  }
  await Promise.all([horizonProbe.whenReady(), nadirProbe.whenReady()]);
  const horizon = await aimBest(horizonProbe, 'horizon');
  const nadir = await aimBest(nadirProbe, 'nadir');
  const column = horizonProbe.centerLuminance();
  const projectionZoom12 = horizonProbe.projectionAtZoom(12);
  await horizonProbe.aim(NOW, BEFORE, AFTER, 'horizon', horizon.inwardDeg);
  await nadirProbe.aim(NOW, BEFORE, AFTER, 'nadir', 0);
  drawLimb(limb, column, horizon.limbErrorDeg, horizon.inwardDeg, frame.heightPx, horizon.verticalFovDeg);
  let nasa = { blue: 'failed', black: 'failed', day: '', twilight: '', night: '' };
  try {
    nasa = await decodePair(sun);
  } catch (error) {
    nasa.blue = error instanceof Error ? error.message : 'failed';
  }
  await horizonProbe.showLighting();
  await nadirProbe.showLighting();
  const dayMix = mixPixel({ r: 30, g: 80, b: 170 }, { r: 250, g: 210, b: 70 }, 15);
  const report: G1Report = {
    status: 'fail',
    checks: checksFor(horizon, nadir, projectionZoom12, nasa.blue, nasa.black),
    horizon,
    nadir,
    projectionZoom12,
    nasa: { blue: nasa.blue, black: nasa.black },
    lighting: {
      day: nasa.day || `rgb(${dayMix.r}, ${dayMix.g}, ${dayMix.b})`,
      twilight: nasa.twilight,
      night: nasa.night,
    },
    sweepBearings: [],
    problems: [...horizonProbe.problems(), ...nadirProbe.problems()],
    webgl: horizonHost.querySelector('canvas')?.getContext('webgl2')?.getParameter(horizonHost.querySelector('canvas')?.getContext('webgl2')?.VERSION ?? 0x1F02) ?? '',
  };
  report.status = report.checks.every((check) => check.pass) ? 'pass' : 'fail';
  const bucket = lightingBucket(FIXTURE_MS);
  readout.textContent = [
    `status ${report.status}`,
    `fixture ${new Date(FIXTURE_MS).toISOString()} lighting bucket ${bucket}`,
    `sun ${sun.lat.toFixed(3)}, ${sun.lon.toFixed(3)}`,
    ...report.checks.map((check) => `${check.pass ? 'pass' : 'fail'} ${check.name}: ${check.detail}`),
    'horizon',
    line(horizon),
    'straight down',
    line(nadir),
    `nasa ${nasa.blue} ${nasa.black}`,
    `problems ${report.problems.join(' | ') || 'none'}`,
  ].join('\n');
  for (const [name, color] of [['Day', report.lighting.day], ['Twilight', report.lighting.twilight], ['Night', report.lighting.night]] as const) {
    const item = document.createElement('div');
    const chip = document.createElement('div');
    chip.className = 'swatch';
    chip.style.background = color || '#333';
    const label = document.createElement('div');
    label.textContent = name;
    item.append(chip, label);
    swatches.append(item);
  }
  const glCanvas = horizonHost.querySelector('canvas');
  const gl = glCanvas?.getContext('webgl2');
  report.webgl = gl ? String(gl.getParameter(gl.VERSION)) : 'no webgl2';
  async function sweep(): Promise<number[]> {
    const bearings: number[] = [];
    for (let lon = 150; lon <= 210; lon += 5) {
      const wrapped = lon > 180 ? lon - 360 : lon;
      const sample = await horizonProbe.aim(
        { latDeg: 20, lonDeg: wrapped, altKm: 420 },
        { latDeg: 20.1, lonDeg: wrapped - 0.3, altKm: 420 },
        { latDeg: 19.9, lonDeg: wrapped + 0.3 > 180 ? wrapped + 0.3 - 360 : wrapped + 0.3, altKm: 420 },
        'horizon',
        horizon.inwardDeg,
      );
      bearings.push(sample.bearingDeg);
    }
    report.sweepBearings = bearings;
    readout.textContent += `\nsweep bearings ${bearings.map((value) => value.toFixed(1)).join(', ')}`;
    return bearings;
  }
  document.querySelector('#sweep')?.addEventListener('click', () => {
    void sweep();
  });
  window.__opdG1 = { report, sweep };
}

void main();
