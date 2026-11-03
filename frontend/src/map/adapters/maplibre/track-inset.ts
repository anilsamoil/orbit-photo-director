import { Map, Marker, type LngLat, type Map as MapLibreMap, type SymbolLayerSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { insetTrackBounds, type LonLat } from '../../../insets/bounds';
import { terminatorNightPolygonFeatures } from '../../../terminator';
import { countryLabelCounts, letteringOccluded } from './country-label-size';
import countryRasterLevels from './country-raster-levels.json' with { type: 'json' };

const ESRI_DARK_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
];

/** Reference raster. Painted tile zooms live in country-raster-levels.json. */
const ESRI_LABEL_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
];

/** Audited national-name tile levels and their Mercator lettering bounds in each raster service. */
const COUNTRY_RASTER_LEVELS: {
  through: number;
  countries: Record<string, readonly number[]>;
  bounds?: Record<string, Record<string, readonly { service: string; box: readonly number[]; ink?: readonly number[] }[]>>;
} = countryRasterLevels;

const COUNTRY_CENTROIDS: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Canada' }, geometry: { type: 'Point', coordinates: [-100, 50] } },
    { type: 'Feature', properties: { name: 'Mexico' }, geometry: { type: 'Point', coordinates: [-102, 23] } },
    { type: 'Feature', properties: { name: 'Brazil' }, geometry: { type: 'Point', coordinates: [-55, -10] } },
    { type: 'Feature', properties: { name: 'Argentina' }, geometry: { type: 'Point', coordinates: [-64, -34] } },
    { type: 'Feature', properties: { name: 'France' }, geometry: { type: 'Point', coordinates: [2, 46] } },
    { type: 'Feature', properties: { name: 'Egypt' }, geometry: { type: 'Point', coordinates: [30, 26] } },
    { type: 'Feature', properties: { name: 'Nigeria' }, geometry: { type: 'Point', coordinates: [8, 10] } },
    { type: 'Feature', properties: { name: 'Kenya' }, geometry: { type: 'Point', coordinates: [38, 1] } },
    { type: 'Feature', properties: { name: 'China' }, geometry: { type: 'Point', coordinates: [104, 35] } },
    { type: 'Feature', properties: { name: 'India' }, geometry: { type: 'Point', coordinates: [79, 22] } },
    { type: 'Feature', properties: { name: 'Japan' }, geometry: { type: 'Point', coordinates: [138, 36] } },
    { type: 'Feature', properties: { name: 'Australia' }, geometry: { type: 'Point', coordinates: [134, -25] } },
  ],
};

/** Caps the fit. A tighter track zooms in. A full orbit stays below zoom 2. */
const INSET_FIT_MAX_ZOOM = 5;

/** Caps a pinch or a wheel. Past this the dark basemap is only pixels. */
const INSET_MAX_ZOOM = 8;

const INSET_BASEMAP_MAX_ZOOM = 20;

/** Label tiles follow main. Capping at the audit overzooms the z6 border names into a second complete label. */
const INSET_LABEL_MAX_ZOOM = 19;

const INSET_GLYPHS = '/glyphs/{fontstack}/{range}.pbf';
const INSET_GLYPH_RANGE = '/glyphs/Open%20Sans%20Regular/0-255.pbf';

/** A 274px column needs a zoom below 0 to hold one orbit. */
const INSET_MIN_ZOOM = -2;

/** Half the 40px ISS marker, plus 2px, so the icon stays inside the canvas. */
const INSET_FIT_PADDING_PX = 22;

/** One click opens the Map tab. A second click inside this window recenters instead. */
const PLAN_OPEN_DELAY_MS = 280;

/** A move past this, or a second touch, is a gesture. Releasing it does not open Map. */
const PLAN_NAV_SLOP_PX = 1;

/** A wheel can leave scroll-zoom active for as long as it keeps ticking. A deferred resize paints after this delay. A pointer that is still down waits until it ends. */
export const PLAN_WHEEL_RESIZE_CAP_MS = 1000;

const NIGHT_MINUTE_MS = 60_000;

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** A tile-0 hole cannot use maxzoom below 0. The geojson worker buckets overscaled zoom 0, and `isHidden(0)` drops that layer. */
const TILE_ZERO_HIDE_AT = -0.5;

type SymbolBand = { minzoom?: number; maxzoom?: number; hideAt?: number };

function holeBands(painted: readonly number[], through: number): SymbolBand[] {
  const has = new Set(painted);
  const holes: number[] = [];
  for (let tile = 0; tile <= through; tile += 1) {
    if (!has.has(tile)) holes.push(tile);
  }
  const bands: SymbolBand[] = [];
  let index = 0;
  while (index < holes.length) {
    let end = index;
    while (end + 1 < holes.length && holes[end + 1] === holes[end]! + 1) end += 1;
    const first = holes[index]!;
    const last = holes[end]!;
    const band: SymbolBand = {};
    if (first === 0 && last === 0) {
      band.hideAt = TILE_ZERO_HIDE_AT;
    } else {
      if (first > 0) band.minzoom = first - 1.5;
      if (!(last === through && !has.has(through))) band.maxzoom = last - 0.5;
    }
    bands.push(band);
    index = end + 1;
  }
  return bands;
}

function bandKey(band: SymbolBand): string {
  if (band.hideAt != null) return `hide-${String(band.hideAt).replace('-', 'n').replace('.', '-')}`;
  const min = band.minzoom == null ? 'floor' : String(band.minzoom).replace('-', 'n').replace('.', '-');
  const max = band.maxzoom == null ? 'ceil' : String(band.maxzoom).replace('-', 'n').replace('.', '-');
  return `${min}-${max}`;
}

function coversView(band: SymbolBand, zoom: number): boolean {
  if (band.hideAt != null && zoom >= band.hideAt) return false;
  const min = band.minzoom ?? Number.NEGATIVE_INFINITY;
  const max = band.maxzoom ?? Number.POSITIVE_INFINITY;
  return zoom >= min && zoom < max;
}

const COUNTRY_TEXT_LAYOUT: SymbolLayerSpecification['layout'] = {
  'text-field': ['get', 'name'],
  'text-font': ['Open Sans Regular'],
  'text-size': 12,
  'text-variable-anchor-offset': ['match', ['get', 'name'], 'Kenya',
    ['literal', ['top', [0, 1.5], 'bottom', [0, -1.5], ...countryPlacementCandidates()]],
    ['literal', countryPlacementCandidates()]],
  'symbol-sort-key': ['match', ['get', 'name'], 'Nigeria', 0, 'Kenya', 1, 2],
};

/** Try nearby free space before moving a crowded fitted-world label farther from its centroid. */
function countryPlacementCandidates(): Array<string | [number, number]> {
  const candidates: Array<string | [number, number]> = ['center', [0, 0]];
  for (const offset of [0.6, 1.5, 2]) {
    candidates.push('left', [offset, 0], 'right', [-offset, 0], 'top', [0, offset], 'bottom', [0, -offset],
      'top-left', [offset, offset], 'top-right', [-offset, offset], 'bottom-left', [offset, -offset], 'bottom-right', [-offset, -offset]);
  }
  return candidates;
}

const COUNTRY_TEXT_PAINT: SymbolLayerSpecification['paint'] = {
  'text-color': '#f7f4ea',
  'text-halo-color': '#02040c',
  'text-halo-width': 1.4,
};

/** Symbol layers for the centroid names. A layer is on only where round(viewZoom + 1) is missing from that country's painted tiles. */
function countrySymbolLayers() {
  const grouped: Record<string, { band: SymbolBand; names: string[] }> = {};
  for (const [name, painted] of Object.entries(COUNTRY_RASTER_LEVELS.countries)) {
    for (const band of holeBands(painted, COUNTRY_RASTER_LEVELS.through)) {
      const key = bandKey(band);
      const group = grouped[key] ?? { band, names: [] };
      group.names.push(name);
      grouped[key] = group;
    }
  }
  const groups = Object.values(grouped);
  const primary = groups.reduce((best, group) => {
    if (!coversView(group.band, 0)) return best;
    if (!best || group.names.length > best.names.length) return group;
    return best;
  }, null as { band: SymbolBand; names: string[] } | null);
  return groups
    .sort((left, right) => (left.band.minzoom ?? -Infinity) - (right.band.minzoom ?? -Infinity)
      || (left.band.maxzoom ?? Infinity) - (right.band.maxzoom ?? Infinity))
    .map((group) => ({
      id: group === primary ? 'inset-countries' : `inset-countries-${bandKey(group.band)}`,
      type: 'symbol' as const,
      source: 'inset-countries',
      ...(group.band.minzoom == null ? {} : { minzoom: group.band.minzoom }),
      ...(group.band.maxzoom == null ? {} : { maxzoom: group.band.maxzoom }),
      filter: ['in', ['get', 'name'], ['literal', group.names]] as ['in', ['get', 'name'], ['literal', string[]]],
      layout: COUNTRY_TEXT_LAYOUT,
      paint: {
        ...COUNTRY_TEXT_PAINT,
        ...(group.band.hideAt == null ? {} : { 'text-opacity': ['step', ['zoom'], 1, group.band.hideAt, 0] as ['step', ['zoom'], 1, number, 0] }),
      },
    }));
}

const COUNTRY_SYMBOL_LAYERS = countrySymbolLayers();

type ScreenBox = { left: number; top: number; right: number; bottom: number };

/** Raster halos sit a few screen pixels outside the audited ink. The mask has to cover them and stay off a kept name. */
export const LABEL_HALO_PX = 4;

/** Open Sans at 12px, measured wide enough that a shifted word is not clipped. */
const SYMBOL_CHAR_PX = 7.2;

const SYMBOL_HEIGHT_PX = 16;

/** Same edge as the verifier: a letter that crosses the canvas is not a complete raster name. */
const RASTER_INK_EDGE_PX = 0;

/** Matches the dark-gray land under a letter that crosses the canvas edge. */
const CLIPPED_LABEL_COVER = '#414143';

/** A raster name owns the label only when its complete lettering is visible above the inset chrome. */
export function readableCountryName(box: ScreenBox, viewport: ScreenBox, occlusions: readonly ScreenBox[]): boolean {
  return box.left >= viewport.left - RASTER_INK_EDGE_PX && box.top >= viewport.top - RASTER_INK_EDGE_PX
    && box.right <= viewport.right + RASTER_INK_EDGE_PX && box.bottom <= viewport.bottom + RASTER_INK_EDGE_PX
    && !letteringOccluded(box, occlusions);
}

function mercatorLngLat(x: number, y: number): [number, number] {
  return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
}

const RASTER_SOURCES = [
  { service: 'reference', maxzoom: INSET_LABEL_MAX_ZOOM },
  { service: 'dark', maxzoom: INSET_BASEMAP_MAX_ZOOM },
] as const;

function drawnTile(zoom: number, maxzoom: number): number {
  return Math.min(maxzoom, Math.max(0, Math.round(zoom + 1)));
}

function shownBox(screen: ScreenBox, viewport: ScreenBox): ScreenBox | null {
  const left = Math.max(screen.left, viewport.left);
  const top = Math.max(screen.top, viewport.top);
  const right = Math.min(screen.right, viewport.right);
  const bottom = Math.min(screen.bottom, viewport.bottom);
  if (right - left < 1 || bottom - top < 1) return null;
  return { left, top, right, bottom };
}

function padBox(box: ScreenBox, halo: number): ScreenBox {
  return { left: box.left - halo, top: box.top - halo, right: box.right + halo, bottom: box.bottom + halo };
}

/** The screen box of a centered country symbol. */
export function countrySymbolBox(name: string, anchor: { x: number; y: number }): ScreenBox {
  const width = Math.ceil(name.length * SYMBOL_CHAR_PX);
  return {
    left: anchor.x - width / 2,
    top: anchor.y - SYMBOL_HEIGHT_PX / 2,
    right: anchor.x + width / 2,
    bottom: anchor.y + SYMBOL_HEIGHT_PX / 2,
  };
}

/** Move a symbol fully inside the plan. A word wider than the plan is not drawn. */
export function fittedSymbolAnchor(name: string, anchor: { x: number; y: number }, viewport: ScreenBox): { x: number; y: number } | null {
  if (anchor.x < viewport.left || anchor.y < viewport.top || anchor.x > viewport.right || anchor.y > viewport.bottom) return null;
  const box = countrySymbolBox(name, anchor);
  let x = anchor.x;
  let y = anchor.y;
  if (box.left < viewport.left) x += viewport.left - box.left;
  if (box.right > viewport.right) x += viewport.right - box.right;
  if (box.top < viewport.top) y += viewport.top - box.top;
  if (box.bottom > viewport.bottom) y += viewport.bottom - box.bottom;
  const fitted = countrySymbolBox(name, { x, y });
  if (fitted.left < viewport.left - 0.5 || fitted.top < viewport.top - 0.5 || fitted.right > viewport.right + 0.5 || fitted.bottom > viewport.bottom + 0.5) return null;
  return { x, y };
}

function exposedCovers(screen: ScreenBox, kept: ScreenBox | null, viewport: ScreenBox): ScreenBox[] {
  if (!kept) {
    const box = shownBox(screen, viewport);
    return box ? [box] : [];
  }
  const parts: ScreenBox[] = [
    { left: screen.left, top: screen.top, right: screen.right, bottom: Math.min(screen.bottom, kept.top) },
    { left: screen.left, top: Math.max(screen.top, kept.bottom), right: screen.right, bottom: screen.bottom },
    { left: screen.left, top: Math.max(screen.top, kept.top), right: Math.min(screen.right, kept.left), bottom: Math.min(screen.bottom, kept.bottom) },
    { left: Math.max(screen.left, kept.right), top: Math.max(screen.top, kept.top), right: screen.right, bottom: Math.min(screen.bottom, kept.bottom) },
  ];
  return parts.flatMap((part) => {
    const box = shownBox(part, viewport);
    return box ? [box] : [];
  });
}

/** Cover a remnant, halo included, and keep that paint off the name that stays. */
export function remnantCovers(extent: ScreenBox, kept: ScreenBox | null, viewport: ScreenBox, halo = LABEL_HALO_PX): ScreenBox[] {
  return exposedCovers(padBox(extent, halo), kept ? padBox(kept, halo) : null, viewport);
}

/** Keep one complete name. Smaller border names and every clipped or occluded scrap are masked. */
export function keptLettering(entries: readonly { complete: boolean; area: number }[]): { keep: number; mask: number[] } {
  const complete = entries.map((entry, index) => ({ ...entry, index })).filter((entry) => entry.complete);
  if (complete.length > 1) {
    const ranked = [...complete].sort((left, right) => right.area - left.area || left.index - right.index);
    const keep = ranked[0]?.index ?? -1;
    return { keep, mask: entries.map((_, index) => index).filter((index) => index !== keep) };
  }
  return { keep: complete[0]?.index ?? -1, mask: entries.flatMap((entry, index) => entry.complete ? [] : [index]) };
}

function viewportFallbacks(map: MapLibreMap, frame: HTMLElement): { names: string[]; covers: ScreenBox[]; rasterCount: number; symbols: { name: string; anchor: { x: number; y: number } }[]; kept: ScreenBox[] } {
  const zoom = map.getZoom();
  const frameBox = frame.getBoundingClientRect();
  const viewport = { left: 0, top: 0, right: frame.clientWidth, bottom: frame.clientHeight };
  const occlusions = Array.from(frame.ownerDocument.querySelectorAll('[data-iss-clock], [data-iss-edition], [data-iss-split-chrome]'))
    .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left - frameBox.left, top: box.top - frameBox.top, right: box.right - frameBox.left, bottom: box.bottom - frameBox.top };
    });
  const covers: ScreenBox[] = [];
  const symbols: { name: string; anchor: { x: number; y: number } }[] = [];
  const kept: ScreenBox[] = [];
  let rasterCount = 0;
  const names = COUNTRY_CENTROIDS.features.flatMap((feature) => {
    if (feature.geometry.type !== 'Point') return [];
    const name = String(feature.properties?.name);
    const painted = COUNTRY_RASTER_LEVELS.countries[name] ?? [];
    if (drawnTile(zoom, INSET_LABEL_MAX_ZOOM) > COUNTRY_RASTER_LEVELS.through) return [];
    const sources = RASTER_SOURCES.flatMap((source) => {
      const drawn = drawnTile(zoom, source.maxzoom);
      const audited = painted.filter((level) => level <= drawn);
      const tile = audited.includes(drawn) ? drawn : audited[audited.length - 1];
      return tile == null ? [] : [{ service: source.service, tile, stale: !painted.includes(drawn) }];
    });
    if (sources.length === 0) return [];
    const glyphs: { screen: ScreenBox; extent: ScreenBox; complete: boolean; area: number }[] = [];
    for (const source of sources) {
      for (const entry of COUNTRY_RASTER_LEVELS.bounds?.[name]?.[source.tile] ?? []) {
        if (entry.service !== source.service) continue;
        const projectBounds = (bounds: readonly number[]): ScreenBox => {
          const start = map.project(mercatorLngLat(bounds[0]!, bounds[1]!));
          const end = map.project(mercatorLngLat(bounds[2]!, bounds[3]!));
          return { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y) };
        };
        const glyph = entry.ink ?? entry.box;
        const ink = projectBounds(glyph);
        const extent = projectBounds(entry.box);
        const counted = countryLabelCounts({ width: glyph[2]! - glyph[0]!, height: glyph[3]! - glyph[1]! });
        glyphs.push({
          screen: ink,
          extent,
          complete: !source.stale && counted && readableCountryName(ink, viewport, occlusions),
          area: Math.abs(ink.right - ink.left) * Math.abs(ink.bottom - ink.top),
        });
      }
    }
    const decision = keptLettering(glyphs);
    const keptInk = decision.keep >= 0 ? glyphs[decision.keep]!.screen : null;
    if (keptInk) {
      rasterCount += 1;
      kept.push(keptInk);
    }
    const anchor = map.project(feature.geometry.coordinates as [number, number]);
    const fitted = keptInk ? null : fittedSymbolAnchor(name, anchor, viewport);
    const protect = keptInk ?? (fitted ? countrySymbolBox(name, fitted) : null);
    for (const index of decision.mask) {
      covers.push(...remnantCovers(glyphs[index]!.extent, protect, viewport));
    }
    if (!fitted) return [];
    symbols.push({ name, anchor: fitted });
    return [name];
  });
  return { names, covers, rasterCount, symbols, kept };
}

type InsetFrame = HTMLElement & { __opdTrackInset?: MapLibreMap };

export type TrackInset = {
  show(features: readonly GeoJSON.Feature[] | null, position: LonLat | null, when?: Date): void;
  destroy(): void;
};

/** Returns the requested center. Zoom stays inside the inset minimum and maximum. The default constrain fills a tall frame and pushes a full orbit off the canvas. */
export function letterboxCamera(center: LngLat, zoom: number): { center: LngLat; zoom: number } {
  const clamped = Math.min(INSET_MAX_ZOOM, Math.max(INSET_MIN_ZOOM, zoom));
  return { center, zoom: clamped };
}

/** A freed camera keeps the operator's zoom. A fresh track or a resize frames the orbit again. */
export function planShouldRefit(freed: boolean, trackDirty: boolean, sizeChanged: boolean): boolean {
  if (freed) return false;
  return trackDirty || sizeChanged;
}

export function createTrackInset(frame: HTMLElement, markerElement: HTMLElement): TrackInset {
  const map: MapLibreMap = new Map({
    container: frame,
    interactive: true,
    attributionControl: false,
    fadeDuration: 0,
    minZoom: INSET_MIN_ZOOM,
    maxZoom: INSET_MAX_ZOOM,
    scrollZoom: true,
    dragPan: true,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    touchZoomRotate: true,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    renderWorldCopies: false,
    transformConstrain: letterboxCamera,
    style: {
      version: 8,
      glyphs: INSET_GLYPHS,
      sources: {
        'inset-basemap': { type: 'raster', tiles: ESRI_DARK_TILES, tileSize: 256, maxzoom: INSET_BASEMAP_MAX_ZOOM },
        'inset-night': { type: 'geojson', data: EMPTY },
        'inset-labels': { type: 'raster', tiles: ESRI_LABEL_TILES, tileSize: 256, maxzoom: INSET_LABEL_MAX_ZOOM },
        'inset-label-mask': { type: 'geojson', data: EMPTY },
        'inset-countries': { type: 'geojson', data: COUNTRY_CENTROIDS },
        'inset-country-fallbacks': { type: 'geojson', data: EMPTY },
        'inset-track': { type: 'geojson', data: EMPTY },
      },
      layers: [
        { id: 'inset-basemap', type: 'raster', source: 'inset-basemap' },
        {
          id: 'inset-night',
          type: 'fill',
          source: 'inset-night',
          paint: { 'fill-color': '#000000', 'fill-opacity': 0.28 },
        },
        { id: 'inset-labels', type: 'raster', source: 'inset-labels', paint: { 'raster-opacity': 0.85 } },
        { id: 'inset-label-mask', type: 'fill', source: 'inset-label-mask', paint: { 'fill-color': CLIPPED_LABEL_COVER, 'fill-opacity': 1 } },
        {
          id: 'inset-track',
          type: 'line',
          source: 'inset-track',
          paint: { 'line-color': '#5cd0ff', 'line-width': 2 },
        },
        ...COUNTRY_SYMBOL_LAYERS,
        {
          id: 'inset-countries-viewport',
          type: 'symbol',
          source: 'inset-country-fallbacks',
          filter: ['in', ['get', 'name'], ['literal', []]],
          layout: {
            'text-field': ['get', 'name'],
            'text-font': ['Open Sans Regular'],
            'text-size': 12,
            'text-anchor': 'center',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: COUNTRY_TEXT_PAINT,
        },
      ],
    },
  });
  const insetFrame = frame as InsetFrame;
  insetFrame.__opdTrackInset = map;
  if (map.dragRotate) map.dragRotate.disable();
  if (map.touchZoomRotate) map.touchZoomRotate.disableRotation();
  const marker = new Marker({ element: markerElement, anchor: 'center' });
  let removed = false;
  let freed = false;
  let openTimer = 0;
  void fetch(INSET_GLYPH_RANGE)
    .then(async (response) => {
      if (!response.ok) return;
      const bytes = await response.arrayBuffer();
      if (removed || bytes.byteLength < 10000) return;
      frame.dataset.insetGlyphs = String(bytes.byteLength);
    })
    .catch(() => {});
  let track: readonly GeoJSON.Feature[] | null = null;
  let position: LonLat | null = null;
  let whenMs: number | null = null;
  let nightKey = Number.NaN;
  let trackDirty = false;
  let fittedWidth = -1;
  let fittedHeight = -1;
  let viewportNames = '';
  let viewportCovers = '';
  const syncCountryLabels = (): void => {
    if (removed || !map.isStyleLoaded() || frame.clientWidth < 2 || frame.clientHeight < 2) return;
    const state = viewportFallbacks(map, frame);
    const features = state.covers.map((cover) => {
      const ring = [
        map.unproject([cover.left, cover.top]),
        map.unproject([cover.right, cover.top]),
        map.unproject([cover.right, cover.bottom]),
        map.unproject([cover.left, cover.bottom]),
      ].map((point) => [point.lng, point.lat] as [number, number]);
      ring.push(ring[0]!);
      return { type: 'Feature' as const, properties: {}, geometry: { type: 'Polygon' as const, coordinates: [ring] } };
    });
    const coverKey = JSON.stringify(features);
    if (coverKey !== viewportCovers) {
      viewportCovers = coverKey;
      const source = map.getSource('inset-label-mask');
      if (source && 'setData' in source && typeof source.setData === 'function') {
        source.setData({ type: 'FeatureCollection', features });
      }
    }
    const symbolFeatures = state.symbols.map((symbol) => {
      const point = map.unproject([symbol.anchor.x, symbol.anchor.y]);
      return {
        type: 'Feature' as const,
        properties: { name: symbol.name },
        geometry: { type: 'Point' as const, coordinates: [point.lng, point.lat] as [number, number] },
      };
    });
    const symbolSource = map.getSource('inset-country-fallbacks');
    if (symbolSource && 'setData' in symbolSource && typeof symbolSource.setData === 'function') {
      symbolSource.setData({ type: 'FeatureCollection', features: symbolFeatures });
    }
    Object.assign(map, {
      __opdLabelMasks: state.covers,
      __opdRasterCount: state.rasterCount,
      __opdKeptBoxes: state.kept,
      __opdSymbolBoxes: state.symbols.map((symbol) => countrySymbolBox(symbol.name, symbol.anchor)),
    });
    const key = state.names.join('|');
    if (key === viewportNames) return;
    viewportNames = key;
    map.setFilter('inset-countries-viewport', ['in', ['get', 'name'], ['literal', state.names]]);
  };
  map.on('render', syncCountryLabels);
  map.on('move', syncCountryLabels);
  map.on('moveend', syncCountryLabels);
  let paintedWidth = -1;
  let paintedHeight = -1;
  let paintedRatio = -1;
  const activePointers = new Set<number>();
  let navMoved = false;
  let navMulti = false;
  let navOrigin: { x: number; y: number } | null = null;
  let resizeWaiting = false;
  let wheelCapTimer = 0;
  const resizeNow = map.resize.bind(map);
  const clearWheelCap = (): void => {
    window.clearTimeout(wheelCapTimer);
    wheelCapTimer = 0;
  };
  const armWheelCap = (): void => {
    if (wheelCapTimer !== 0 || removed) return;
    wheelCapTimer = window.setTimeout(() => {
      wheelCapTimer = 0;
      if (removed || !resizeWaiting || activePointers.size > 0) return;
      resizeWaiting = false;
      resizeNow();
    }, PLAN_WHEEL_RESIZE_CAP_MS);
  };
  const flushResize = (): void => {
    if (!resizeWaiting || activePointers.size > 0) return;
    if (map.scrollZoom?.isZooming()) {
      armWheelCap();
      return;
    }
    clearWheelCap();
    map.resize();
  };
  const settleResize = (): void => {
    flushResize();
    queueMicrotask(() => {
      if (activePointers.size === 0) flushResize();
    });
  };
  Object.defineProperty(map, 'resize', {
    configurable: true,
    value(eventData?: object, constrainTransform?: boolean) {
      if (activePointers.size > 0) {
        resizeWaiting = true;
        clearWheelCap();
        return map;
      }
      if (map.scrollZoom?.isZooming()) {
        resizeWaiting = true;
        armWheelCap();
        return map;
      }
      clearWheelCap();
      resizeWaiting = false;
      return resizeNow(eventData, constrainTransform);
    },
  });
  const stopClick = (event: Event): void => {
    event.stopPropagation();
  };
  const onWheel = (event: WheelEvent): void => {
    if (event.deltaX === 0 && event.deltaY === 0) return;
    freed = true;
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (activePointers.has(event.pointerId)) return;
    if (activePointers.size === 0) {
      navMoved = false;
      navMulti = false;
      navOrigin = { x: event.clientX, y: event.clientY };
    } else {
      navMulti = true;
    }
    activePointers.add(event.pointerId);
    clearWheelCap();
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!navOrigin || !activePointers.has(event.pointerId)) return;
    const dx = event.clientX - navOrigin.x;
    const dy = event.clientY - navOrigin.y;
    if (dx * dx + dy * dy > PLAN_NAV_SLOP_PX * PLAN_NAV_SLOP_PX) navMoved = true;
  };
  const onPointerEnd = (event: PointerEvent): void => {
    if (!activePointers.delete(event.pointerId)) return;
    if (activePointers.size === 0) settleResize();
  };
  const onWindowBlur = (): void => {
    if (activePointers.size === 0) return;
    activePointers.clear();
    settleResize();
  };
  frame.addEventListener('click', stopClick);
  frame.addEventListener('wheel', onWheel, { capture: true, passive: true });
  frame.addEventListener('pointerdown', onPointerDown, true);
  frame.addEventListener('pointermove', onPointerMove, true);
  frame.addEventListener('pointerup', onPointerEnd, true);
  frame.addEventListener('pointercancel', onPointerEnd, true);
  frame.addEventListener('lostpointercapture', onPointerEnd, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerEnd, true);
  window.addEventListener('pointercancel', onPointerEnd, true);
  window.addEventListener('lostpointercapture', onPointerEnd, true);
  window.addEventListener('blur', onWindowBlur);
  const openPlan = (): void => {
    const button = frame.closest('button');
    if (button instanceof HTMLButtonElement) button.click();
  };
  const refit = (): void => {
    freed = false;
    fittedWidth = -1;
    fittedHeight = -1;
    apply();
  };
  map.on('movestart', (event) => {
    if (event.originalEvent) freed = true;
  });
  map.on('moveend', () => {
    flushResize();
  });
  map.on('click', () => {
    if (navMoved || navMulti) {
      navMoved = false;
      navMulti = false;
      navOrigin = null;
      return;
    }
    window.clearTimeout(openTimer);
    openTimer = window.setTimeout(openPlan, PLAN_OPEN_DELAY_MS);
  });
  map.on('dblclick', (event) => {
    window.clearTimeout(openTimer);
    openTimer = 0;
    event.preventDefault();
    refit();
  });
  const apply = (): void => {
    if (removed || !map.isStyleLoaded()) return;
    const width = frame.clientWidth;
    const height = frame.clientHeight;
    const ratio = window.devicePixelRatio;
    if (width !== paintedWidth || height !== paintedHeight || ratio !== paintedRatio) {
      paintedWidth = width;
      paintedHeight = height;
      paintedRatio = ratio;
      map.resize();
    }
    const sizeChanged = width !== fittedWidth || height !== fittedHeight;
    if (track && trackDirty) {
      const source = map.getSource('inset-track');
      if (source && 'setData' in source && typeof source.setData === 'function') {
        source.setData({ type: 'FeatureCollection', features: track.slice() });
      }
      trackDirty = false;
    }
    if (whenMs !== null) {
      const key = Math.floor(whenMs / NIGHT_MINUTE_MS);
      if (key !== nightKey) {
        nightKey = key;
        const source = map.getSource('inset-night');
        if (source && 'setData' in source && typeof source.setData === 'function') {
          source.setData({
            type: 'FeatureCollection',
            features: terminatorNightPolygonFeatures(new Date(whenMs)),
          });
        }
      }
    }
    if (planShouldRefit(freed, track !== null && fittedWidth < 0, sizeChanged) && track && width >= 2 && height >= 2) {
      const bounds = insetTrackBounds(track, position);
      if (bounds) {
        map.fitBounds(bounds, { padding: INSET_FIT_PADDING_PX, maxZoom: INSET_FIT_MAX_ZOOM, animate: false });
        fittedWidth = width;
        fittedHeight = height;
      }
    }
    if (position) {
      marker.setLngLat([position.lon, position.lat]).addTo(map);
      if (fittedWidth < 0 && width >= 2 && height >= 2) {
        map.jumpTo({ center: [position.lon, position.lat], zoom: 1.4 });
        fittedWidth = width;
        fittedHeight = height;
      }
    }
  };
  if (map.isStyleLoaded()) apply();
  else map.once('load', apply);
  return {
    show(features, nextPosition, when) {
      if (removed) return;
      if (features) {
        track = features;
        trackDirty = true;
        if (!freed) {
          fittedWidth = -1;
          fittedHeight = -1;
        }
      }
      position = nextPosition;
      if (when) whenMs = when.getTime();
      apply();
    },
    destroy() {
      if (removed) return;
      removed = true;
      window.clearTimeout(openTimer);
      clearWheelCap();
      frame.removeEventListener('click', stopClick);
      frame.removeEventListener('wheel', onWheel, true);
      frame.removeEventListener('pointerdown', onPointerDown, true);
      frame.removeEventListener('pointermove', onPointerMove, true);
      frame.removeEventListener('pointerup', onPointerEnd, true);
      frame.removeEventListener('pointercancel', onPointerEnd, true);
      frame.removeEventListener('lostpointercapture', onPointerEnd, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerEnd, true);
      window.removeEventListener('pointercancel', onPointerEnd, true);
      window.removeEventListener('lostpointercapture', onPointerEnd, true);
      window.removeEventListener('blur', onWindowBlur);
      marker.remove();
      map.remove();
      delete insetFrame.__opdTrackInset;
    },
  };
}
