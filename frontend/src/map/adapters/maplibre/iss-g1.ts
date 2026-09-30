import './worker-url';
import {
  LngLat,
  GeoJSONSource,
  Map,
  addProtocol,
  type Map as MapLibreMap,
} from 'maplibre-gl';
import type { SkySpecification } from '@maplibre/maplibre-gl-style-spec';

import {
  BLACK_MARBLE_2016_TEMPLATE,
  BLUE_MARBLE_TEMPLATE,
  compositeRgba,
  fillTileUrl,
} from '../../../iss-g1/lighting';
import {
  TANGENT_PITCH_DEG,
  poseAt,
  reconstructCamera,
  sensorFovDeg,
  verticalAngleDeg,
  angularSeparationDeg,
  type CameraPreset,
  type Geocentric,
  type SphericalFix,
} from '../../../iss-g1/model';

/** The existing Map leaves maximum pitch at the library default of 60.
 *  An exact tangent aim is 90 degrees in the target's frame, so only this
 *  renderer raises the limit. */
export const ISS_MAX_PITCH_DEG = TANGENT_PITCH_DEG;

const PROTOCOL = 'iss-g1';
const LIT_MAX_ZOOM = 5;
const MEASURE_EARTH = { r: 196, g: 90, b: 40 };

type Subsolar = { latDeg: number; lonDeg: number };

const jobs = {
  active: 0,
  waiting: [] as Array<() => void>,
};

function takeJob(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException('The lighting tile was cancelled', 'AbortError'));
  if (jobs.active < 2) {
    jobs.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const start = (): void => {
      signal.removeEventListener('abort', cancel);
      jobs.active += 1;
      resolve();
    };
    const cancel = (): void => {
      const index = jobs.waiting.indexOf(start);
      if (index >= 0) jobs.waiting.splice(index, 1);
      reject(new DOMException('The lighting tile was cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', cancel);
    jobs.waiting.push(start);
  });
}

function finishJob(): void {
  jobs.active -= 1;
  const next = jobs.waiting.shift();
  if (next) next();
}

async function decodeImage(blob: Blob): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The lighting tile could not be decoded');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { rgba: image.data, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

async function fetchRgba(url: string, signal: AbortSignal): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`NASA tile ${response.status} for ${url}`);
  return decodeImage(await response.blob());
}

const registered = { subsolar: null as Subsolar | null };

/** One protocol for every probe map. Raw NASA pixels stay on their own URLs.
 *  A failed decode throws instead of painting the opaque source. */
export function registerIssLighting(subsolar: Subsolar): void {
  if (registered.subsolar) return;
  registered.subsolar = subsolar;
  addProtocol(PROTOCOL, async (params, abortController) => {
    const sun = registered.subsolar;
    if (!sun) throw new Error('Lighting is not configured');
    const match = params.url.match(/iss-g1:\/\/daynight\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) throw new Error(`Unexpected lighting url ${params.url}`);
    const z = Number(match[1]);
    const y = Number(match[2]);
    const x = Number(match[3]);
    const signal = abortController.signal;
    await takeJob(signal);
    try {
      if (signal.aborted) throw new DOMException('The lighting tile was cancelled', 'AbortError');
      const [day, night] = await Promise.all([
        fetchRgba(fillTileUrl(BLUE_MARBLE_TEMPLATE, z, x, y), signal),
        fetchRgba(fillTileUrl(BLACK_MARBLE_2016_TEMPLATE, z, x, y), signal),
      ]);
      if (day.width !== night.width || day.height !== night.height || day.width !== 256) {
        throw new Error(`NASA tile size ${day.width}x${day.height} / ${night.width}x${night.height}`);
      }
      const mixed = compositeRgba(day.rgba, night.rgba, z, x, y, sun, day.width);
      const canvas = new OffscreenCanvas(day.width, day.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The lighting tile could not be encoded');
      const pixels = new Uint8ClampedArray(mixed.length);
      pixels.set(mixed);
      context.putImageData(new ImageData(pixels, day.width, day.height), 0, 0);
      const encoded = await canvas.convertToBlob({ type: 'image/png' });
      if (signal.aborted) throw new DOMException('The lighting tile was cancelled', 'AbortError');
      return { data: await encoded.arrayBuffer() };
    } finally {
      finishJob();
    }
  });
}

export type ProbeSample = {
  preset: CameraPreset;
  projection: string;
  verticalFovDeg: number;
  maxPitchDeg: number;
  pitchDeg: number;
  analyticPitchDeg: number;
  bearingDeg: number;
  inwardDeg: number;
  camera: Geocentric;
  intended: Geocentric;
  radiusErrorM: number;
  subpointErrorDeg: number;
  limbErrorDeg: number | null;
  earthFraction: number;
  nested: 'object' | 'string' | 'missing';
};

export type IssProbe = {
  whenReady(): Promise<void>;
  aim(now: SphericalFix, before: SphericalFix, after: SphericalFix, preset: CameraPreset, inwardDeg: number): Promise<ProbeSample>;
  showLighting(): Promise<void>;
  showMeasurement(): void;
  projectionAtZoom(zoom: number): string;
  centerLuminance(): number[];
  problems(): string[];
  destroy(): void;
};

function idle(map: MapLibreMap): Promise<void> {
  return new Promise((resolve) => {
    map.once('idle', () => resolve());
  });
}

function projectionName(map: MapLibreMap): string {
  const value = map.getProjection().type;
  return typeof value === 'string' ? value : 'expression';
}

function readFrame(map: MapLibreMap): ImageData {
  const source = map.getCanvas();
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  const context = copy.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('The probe could not read the frame');
  context.drawImage(source, 0, 0);
  return context.getImageData(0, 0, copy.width, copy.height);
}

function isEarth(data: Uint8ClampedArray, offset: number): boolean {
  const r = data[offset] ?? 0;
  const g = data[offset + 1] ?? 0;
  const b = data[offset + 2] ?? 0;
  return r > 140 && r > g + 40 && r > b + 40;
}

function limbRow(image: ImageData): { row: number | null; earthFraction: number } {
  const { data, width, height } = image;
  let earth = 0;
  for (let i = 0; i < width * height; i += 1) {
    if (isEarth(data, i * 4)) earth += 1;
  }
  const x = Math.floor(width / 2);
  let row: number | null = null;
  for (let y = 0; y < height; y += 1) {
    if (isEarth(data, (y * width + x) * 4)) {
      row = y;
      break;
    }
  }
  return { row, earthFraction: earth / (width * height) };
}

function measurementSky(): SkySpecification {
  return {
    'sky-color': '#000000',
    'horizon-color': '#000000',
    'sky-horizon-blend': 0,
    'atmosphere-blend': 0,
  };
}

export function createIssProbe(container: HTMLElement, subsolar: Subsolar): IssProbe {
  let map: MapLibreMap;
  try {
    map = new Map({
      container,
      pixelRatio: 1,
      interactive: false,
      maxPitch: ISS_MAX_PITCH_DEG,
      centerClampedToGround: false,
      attributionControl: { compact: true },
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: false },
      style: {
        version: 8,
        projection: { type: 'vertical-perspective' },
        sky: measurementSky(),
        sources: {
          'g1-nest': {
            type: 'geojson',
            data: {
              type: 'FeatureCollection',
              features: [{
                type: 'Feature',
                properties: { nest: { ok: true, n: 2 } },
                geometry: { type: 'Point', coordinates: [0, 0] },
              }],
            },
          },
        },
        layers: [
          { id: 'g1-ground', type: 'background', paint: { 'background-color': '#c45a28' } },
          {
            id: 'g1-nest',
            type: 'circle',
            source: 'g1-nest',
            paint: { 'circle-radius': 6, 'circle-color': '#ffffff' },
          },
        ],
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'GPUInitializationError') {
      throw new Error('WebGL2 is unavailable');
    }
    throw error;
  }
  map.setVerticalFieldOfView(sensorFovDeg().vertical);
  registerIssLighting(subsolar);
  const problems: string[] = [];
  map.on('error', (event) => {
    problems.push(event.error instanceof Error ? event.error.message : 'map error');
  });

  return {
    whenReady() {
      if (map.loaded()) return Promise.resolve();
      return new Promise((resolve) => {
        map.once('load', () => resolve());
      });
    },
    async aim(now, before, after, preset, inwardDeg) {
      const posed = poseAt(now, before, after, preset, inwardDeg);
      if (!posed.ok) throw new Error(posed.reason);
      const pose = posed.pose;
      map.setMaxPitch(ISS_MAX_PITCH_DEG);
      map.setVerticalFieldOfView(sensorFovDeg().vertical);
      const source = map.getSource('g1-nest');
      if (source instanceof GeoJSONSource) {
        source.setData({
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: { nest: { ok: true, n: 2 } },
            geometry: { type: 'Point', coordinates: [pose.targetLonDeg, pose.targetLatDeg] },
          }],
        });
      }
      map.setLayoutProperty('g1-nest', 'visibility', 'visible');
      const solved = map.calculateCameraOptionsFromTo(
        new LngLat(pose.camera.lonDeg, pose.camera.latDeg),
        pose.altitudeM,
        new LngLat(pose.targetLonDeg, pose.targetLatDeg),
        0,
      );
      map.jumpTo({ ...solved, bearing: pose.bearingDeg });
      await idle(map);
      const hits = map.queryRenderedFeatures(map.project([pose.targetLonDeg, pose.targetLatDeg]), { layers: ['g1-nest'] });
      const nest = hits[0]?.properties?.nest;
      const nested = nest && typeof nest === 'object' ? 'object' : typeof nest === 'string' ? 'string' : 'missing';
      const height = map.getCanvas().clientHeight || map.getContainer().clientHeight;
      const camera = reconstructCamera({
        targetLatDeg: map.getCenter().lat,
        targetLonDeg: map.getCenter().lng,
        pitchDeg: map.getPitch(),
        bearingDeg: map.getBearing(),
        zoom: map.getZoom(),
        verticalFovDeg: map.getVerticalFieldOfView(),
        viewportHeightPx: height,
      });
      map.setLayoutProperty('g1-nest', 'visibility', 'none');
      await idle(map);
      const frame = readFrame(map);
      const limb = limbRow(frame);
      const limbErrorDeg = preset === 'horizon' && limb.row !== null
        ? verticalAngleDeg(limb.row, frame.height, map.getVerticalFieldOfView()) - pose.inwardDeg
        : null;
      return {
        preset,
        projection: projectionName(map),
        verticalFovDeg: map.getVerticalFieldOfView(),
        maxPitchDeg: map.getMaxPitch(),
        pitchDeg: map.getPitch(),
        analyticPitchDeg: pose.analyticPitchDeg,
        bearingDeg: map.getBearing(),
        inwardDeg: pose.inwardDeg,
        camera,
        intended: pose.camera,
        radiusErrorM: camera.radiusM - pose.camera.radiusM,
        subpointErrorDeg: angularSeparationDeg(camera.latDeg, camera.lonDeg, pose.camera.latDeg, pose.camera.lonDeg),
        limbErrorDeg,
        earthFraction: limb.earthFraction,
        nested,
      };
    },
    async showLighting() {
      if (!map.getSource('g1-lit')) {
        map.addSource('g1-lit', {
          type: 'raster',
          tiles: [`${PROTOCOL}://daynight/{z}/{y}/{x}`],
          tileSize: 256,
          maxzoom: LIT_MAX_ZOOM,
          attribution: 'NASA Blue Marble Next Generation and VIIRS Black Marble 2016',
        });
        map.addLayer({ id: 'g1-lit', type: 'raster', source: 'g1-lit', paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 } });
      }
      map.setLayoutProperty('g1-lit', 'visibility', 'visible');
      map.setPaintProperty('g1-ground', 'background-color', '#10141c');
      map.setSky({
        'sky-color': '#02040c',
        'horizon-color': '#9eb6cc',
        'sky-horizon-blend': 0.45,
        'atmosphere-blend': 0.55,
      });
      await idle(map);
    },
    showMeasurement() {
      if (map.getLayer('g1-lit')) map.setLayoutProperty('g1-lit', 'visibility', 'none');
      map.setPaintProperty('g1-ground', 'background-color', '#c45a28');
      map.setSky(measurementSky());
    },
    projectionAtZoom(zoom) {
      const center = map.getCenter();
      const pitch = map.getPitch();
      const bearing = map.getBearing();
      const previous = map.getZoom();
      map.jumpTo({ center, zoom, pitch, bearing });
      const name = projectionName(map);
      map.jumpTo({ center, zoom: previous, pitch, bearing });
      return name;
    },
    centerLuminance() {
      const frame = readFrame(map);
      const x = Math.floor(frame.width / 2);
      const column: number[] = [];
      for (let y = 0; y < frame.height; y += 1) {
        const offset = (y * frame.width + x) * 4;
        const r = frame.data[offset] ?? 0;
        const g = frame.data[offset + 1] ?? 0;
        const b = frame.data[offset + 2] ?? 0;
        column.push(0.299 * r + 0.587 * g + 0.114 * b);
      }
      return column;
    },
    problems() {
      return problems.slice();
    },
    destroy() {
      map.remove();
    },
  };
}

export const MEASURE_EARTH_RGB = MEASURE_EARTH;
