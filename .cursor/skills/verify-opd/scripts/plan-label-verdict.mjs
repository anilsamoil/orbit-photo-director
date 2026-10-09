import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const COUNTRY_NAMES = ['Canada', 'Mexico', 'Brazil', 'Argentina'];

export const FRACTIONAL_LABEL_ZOOMS = [2.5, 2.9, 3, 3.1];

function nameList(names) {
  return Array.isArray(names) ? names.filter((name) => typeof name === 'string') : [];
}

/** Symbol texts at the zooms where the reference raster already draws country names. */
export function fractionalCountrySymbols(rows) {
  if (!Array.isArray(rows) || rows.length !== FRACTIONAL_LABEL_ZOOMS.length) {
    return { ok: false, reason: 'zooms', rows: Array.isArray(rows) ? rows.length : 0 };
  }
  const counts = [];
  for (let index = 0; index < FRACTIONAL_LABEL_ZOOMS.length; index += 1) {
    const expected = FRACTIONAL_LABEL_ZOOMS[index];
    const row = rows[index];
    const zoom = row && Number(row.zoom);
    if (!row || !Number.isFinite(zoom) || Math.abs(zoom - expected) > 0.001) {
      return { ok: false, reason: 'zoom', zoom: row && row.zoom, expected };
    }
    const names = nameList(row.names);
    const seen = new Map();
    for (const name of names) seen.set(name, (seen.get(name) || 0) + 1);
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    if (names.length > 0 || duplicated.length > 0) {
      return { ok: false, reason: 'symbols', zoom, count: names.length, names, duplicated };
    }
    counts.push({ zoom, count: 0 });
  }
  return { ok: true, counts };
}

/** France or Japan still has one symbol text at the zoom below the raster names. */
export function keptCountrySymbol(names, country) {
  const list = nameList(names);
  const count = list.filter((name) => name === country).length;
  if (count !== 1) return { ok: false, reason: 'kept', country, count, names: list };
  return { ok: true, country, count };
}

function rasterPainted(words, country) {
  const name = String(country || '').toUpperCase();
  if (name.length < 4) return false;
  const stems = [name];
  for (let index = 0; index < name.length; index += 1) {
    const stem = name.slice(0, index) + name.slice(index + 1);
    if (stem.length >= 4) stems.push(stem);
  }
  const tokens = String(words || '').toUpperCase().split(/[^A-Z]+/).filter((word) => word.length >= 4);
  const extended = tokens.some((word) => word.startsWith(name) && word.length > name.length);
  return tokens.some((word) => {
    if (extended && word === name) return false;
    if (word.startsWith(name) && word.length > name.length) return false;
    if (stems.includes(word)) return true;
    return stems.some((stem) => stem !== name && word.includes(stem) && word.length > stem.length && word.length <= stem.length + 4);
  });
}

export function countrySweepZooms() {
  const zooms = [];
  for (let step = -50; step <= 310; step += 5) zooms.push(step / 100);
  for (const extra of [1.49, 1.51, 2.49, 2.51]) zooms.push(extra);
  zooms.sort((left, right) => left - right);
  return zooms;
}

export const PLAN_COUNTRIES = [
  { name: 'Canada', lng: -100, lat: 50 },
  { name: 'Mexico', lng: -102, lat: 23 },
  { name: 'Brazil', lng: -55, lat: -10 },
  { name: 'Argentina', lng: -64, lat: -34 },
  { name: 'France', lng: 2, lat: 46 },
  { name: 'Egypt', lng: 30, lat: 26 },
  { name: 'Nigeria', lng: 8, lat: 10 },
  { name: 'Kenya', lng: 38, lat: 1 },
  { name: 'China', lng: 104, lat: 35 },
  { name: 'India', lng: 79, lat: 22 },
  { name: 'Japan', lng: 138, lat: 36 },
  { name: 'Australia', lng: 134, lat: -25 },
];

export function loadCountryRasterLevels() {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../frontend/src/map/adapters/maplibre/country-raster-levels.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function idealTile(zoom) {
  return Math.max(0, Math.round(Number(zoom) + 1));
}

function levelPaints(levels, country, tileZoom) {
  const painted = levels.countries[country] || [];
  if (tileZoom <= levels.through) return painted.includes(tileZoom);
  return painted.includes(levels.through);
}

/** Exactly one name source: the centroid symbol, or the raster lettering, never both and never neither. */
export function oneNameSource(row) {
  if (!row || row.tilesOk !== true) {
    return { ok: false, reason: 'tiles', country: row && row.country, zoom: row && row.zoom, detail: row && row.detail };
  }
  const zoom = Number(row.zoom);
  if (!Number.isFinite(zoom)) return { ok: false, reason: 'zoom', zoom: row && row.zoom };
  const ideal = idealTile(zoom);
  if (row.tileZ !== ideal) {
    return { ok: false, reason: 'tile', tileZ: row.tileZ, expected: ideal, country: row.country, zoom };
  }
  const names = nameList(row.names);
  const count = names.filter((name) => name === row.country).length;
  if (count > 1) return { ok: false, reason: 'symbol', country: row.country, zoom, count, names };
  const painted = rasterPainted(row.words, row.country);
  const sources = (count === 1 ? 1 : 0) + (painted ? 1 : 0);
  if (sources !== 1) {
    return {
      ok: false,
      reason: sources === 0 ? 'gap' : 'duplicate',
      country: row.country,
      zoom,
      count,
      raster: painted,
    };
  }
  return { ok: true, country: row.country, zoom, count, raster: painted };
}

function sweepRows(levels, symbolCount) {
  const rows = [];
  for (const country of PLAN_COUNTRIES) {
    for (const zoom of countrySweepZooms()) {
      const tileZ = idealTile(zoom);
      const raster = levelPaints(levels, country.name, tileZ);
      const count = symbolCount(country.name, zoom, raster, tileZ);
      rows.push({
        tilesOk: true,
        zoom,
        tileZ,
        country: country.name,
        names: count === 1 ? [country.name] : [],
        words: raster ? country.name.toUpperCase() : 'OCEAN',
      });
    }
  }
  return rows;
}

/** One handoff sample. tilesOk false is a failure, including a wait that timed out.
 *  After the cutoff the symbol is gone and the raster lettering is in the OCR words.
 *  Before the cutoff the symbol is still there. */
export function handoffSample(row, expect) {
  if (!row || row.tilesOk !== true) {
    return { ok: false, reason: 'tiles', country: expect && expect.country, zoom: expect && expect.zoom, detail: row && row.detail };
  }
  const zoom = Number(row.zoom);
  if (!expect || !Number.isFinite(zoom) || Math.abs(zoom - expect.zoom) > 0.001) {
    return { ok: false, reason: 'zoom', zoom: row.zoom, expected: expect && expect.zoom };
  }
  if (row.tileZ !== expect.tileZ) {
    return { ok: false, reason: 'tile', tileZ: row.tileZ, expected: expect.tileZ, country: expect.country };
  }
  const names = nameList(row.names);
  const count = names.filter((name) => name === expect.country).length;
  if (count !== expect.symbols) {
    return { ok: false, reason: 'symbol', country: expect.country, zoom, count, names };
  }
  const painted = rasterPainted(row.words, expect.country);
  if (expect.raster && !painted) {
    return { ok: false, reason: 'raster', country: expect.country, zoom, words: row.words };
  }
  return { ok: true, country: expect.country, zoom, count, raster: painted };
}

export function planLabelVerdict(sample) {
  function resolvedOpacity(value) {
    if (value == null) return 1;
    if (typeof value === 'number') return value;
    if (Array.isArray(value) && value[0] === 'literal' && typeof value[1] === 'number') return value[1];
    return 0;
  }
  function colorAlpha(colorValue) {
    if (colorValue == null) return 1;
    if (typeof colorValue !== 'string') return 0;
    const text = colorValue.trim().toLowerCase();
    if (text === 'transparent') return 0;
    const hex = /^#([0-9a-f]+)$/.exec(text);
    if (hex && (hex[1].length === 3 || hex[1].length === 6)) return 1;
    if (hex && hex[1].length === 4) return parseInt(hex[1][3] + hex[1][3], 16) / 255;
    if (hex && hex[1].length === 8) return parseInt(hex[1].slice(6, 8), 16) / 255;
    const rgba = /^rgba?\(([^)]*)\)$/.exec(text);
    if (!rgba) return 0;
    const parts = rgba[1].split(',').map((part) => part.trim());
    if (parts.length < 4) return 1;
    const alpha = Number(parts[3]);
    return Number.isFinite(alpha) ? alpha : 0;
  }
  function shownText(field, properties) {
    if (typeof field === 'string') return field;
    if (Array.isArray(field) && field[0] === 'get' && typeof field[1] === 'string') {
      const value = properties ? properties[field[1]] : undefined;
      return typeof value === 'string' ? value : '';
    }
    if (Array.isArray(field) && field[0] === 'literal' && typeof field[1] === 'string') return field[1];
    return '';
  }
  const glyphs = Number(sample.glyphs);
  const width = Number(sample.width);
  const height = Number(sample.height);
  if (!sample.layerPresent) return { ok: false, step: 'labels', reason: 'layer', glyphs };
  if (sample.visibility != null && sample.visibility !== 'visible') {
    return { ok: false, step: 'labels', reason: 'visibility', glyphs };
  }
  const opacity = resolvedOpacity(sample.textOpacity);
  if (!(opacity > 0)) return { ok: false, step: 'labels', reason: 'opacity', opacity, glyphs };
  const alpha = colorAlpha(sample.textColor);
  if (!(alpha > 0)) {
    return { ok: false, step: 'labels', reason: 'color', color: sample.textColor == null ? null : sample.textColor, glyphs };
  }
  if (sample.textAllowOverlap === true) {
    return { ok: false, step: 'labels', reason: 'allow-overlap', glyphs };
  }
  if (sample.textIgnorePlacement === true) {
    return { ok: false, step: 'labels', reason: 'ignore-placement', glyphs };
  }
  const catalog = Array.isArray(sample.catalog) ? sample.catalog : [];
  const names = [];
  const rendered = Array.isArray(sample.rendered) ? sample.rendered : [];
  for (const feature of rendered) {
    const text = shownText(sample.textField, feature && feature.properties);
    if (text.length < 2 || !catalog.includes(text)) continue;
    if (!(feature.x >= 8 && feature.y >= 8 && feature.x <= width - 8 && feature.y <= height - 8)) continue;
    if (!names.includes(text)) names.push(text);
  }
  if (glyphs < 10000) return { ok: false, step: 'labels', reason: 'glyphs', glyphs, names, opacity };
  if (names.length < 4) return { ok: false, step: 'labels', reason: 'names', glyphs, names, opacity };
  return { ok: true, names, glyphs, opacity };
}

export function planLabelReaders() {
  return `${planLabelVerdict.toString()}
function readPlanLabels(orbit, glyphs, width, height) {
  if (!orbit || typeof orbit.getLayer !== 'function' || typeof orbit.getPaintProperty !== 'function' || typeof orbit.getLayoutProperty !== 'function' || !orbit.getLayer('inset-countries')) {
    return { ok: false, step: 'labels', reason: 'layer', glyphs: glyphs };
  }
  const visibility = orbit.getLayoutProperty('inset-countries', 'visibility');
  const textOpacity = orbit.getPaintProperty('inset-countries', 'text-opacity');
  const textColor = orbit.getPaintProperty('inset-countries', 'text-color');
  const textField = orbit.getLayoutProperty('inset-countries', 'text-field');
  const textAllowOverlap = orbit.getLayoutProperty('inset-countries', 'text-allow-overlap');
  const textIgnorePlacement = orbit.getLayoutProperty('inset-countries', 'text-ignore-placement');
  let labelLayers = ['inset-countries'];
  if (typeof orbit.getStyle === 'function') {
    const style = orbit.getStyle();
    const listed = style && style.layers
      ? style.layers.filter((layer) => layer && layer.source === 'inset-countries' && layer.type === 'symbol').map((layer) => layer.id)
      : [];
    if (listed.length) labelLayers = listed;
  }
  let labelFeatures = [];
  try {
    labelFeatures = orbit.queryRenderedFeatures({ layers: labelLayers }) || [];
  } catch (error) {
    return { ok: false, step: 'labels', reason: 'query', glyphs: glyphs };
  }
  const catalog = [];
  try {
    const stored = orbit.querySourceFeatures('inset-countries') || [];
    for (const feature of stored) {
      const name = feature && feature.properties && feature.properties.name;
      if (typeof name === 'string' && name.length > 1 && !catalog.includes(name)) catalog.push(name);
    }
  } catch (error) {
    catalog.length = 0;
  }
  const rendered = [];
  for (const feature of labelFeatures) {
    const geometry = feature && feature.geometry;
    if (!geometry || geometry.type !== 'Point' || !geometry.coordinates) continue;
    const point = orbit.project(geometry.coordinates);
    rendered.push({ properties: feature.properties || {}, x: point.x, y: point.y });
  }
  return planLabelVerdict({
    glyphs: glyphs,
    layerPresent: true,
    visibility: visibility,
    textOpacity: textOpacity,
    textColor: textColor,
    textField: textField,
    textAllowOverlap: textAllowOverlap,
    textIgnorePlacement: textIgnorePlacement,
    catalog: catalog,
    rendered: rendered,
    width: width,
    height: height,
  });
}
`;
}

function countryFeatures() {
  return COUNTRY_NAMES.map((name, index) => ({
    properties: { name },
    geometry: { type: 'Point', coordinates: [-100 + index, 20] },
  }));
}

function fakeOrbit() {
  const paint = { 'text-color': '#f7f4ea' };
  const layout = { 'text-field': ['get', 'name'] };
  const features = countryFeatures();
  return {
    getLayer(id) {
      return id === 'inset-countries' ? { id } : undefined;
    },
    getPaintProperty(_id, key) {
      return paint[key];
    },
    getLayoutProperty(_id, key) {
      return layout[key];
    },
    setPaintProperty(_id, key, value) {
      paint[key] = value;
    },
    setLayoutProperty(_id, key, value) {
      layout[key] = value;
    },
    queryRenderedFeatures() {
      return features;
    },
    querySourceFeatures() {
      return features;
    },
    project() {
      return { x: 40, y: 40 };
    },
  };
}

function readPlanLabelsFromPageSource() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${planLabelReaders()}\nthis.readPlanLabels = readPlanLabels;`, context);
  return context.readPlanLabels;
}

export function biteReport() {
  const readPlanLabels = readPlanLabelsFromPageSource();
  const orbit = fakeOrbit();
  const glyphs = 12000;
  const width = 320;
  const height = 240;
  const unmutated = readPlanLabels(orbit, glyphs, width, height);
  const opacityPrevious = orbit.getPaintProperty('inset-countries', 'text-opacity');
  orbit.setPaintProperty('inset-countries', 'text-opacity', 0);
  const textOpacity = readPlanLabels(orbit, glyphs, width, height);
  orbit.setPaintProperty('inset-countries', 'text-opacity', opacityPrevious == null ? 1 : opacityPrevious);
  const fieldPrevious = orbit.getLayoutProperty('inset-countries', 'text-field');
  orbit.setLayoutProperty('inset-countries', 'text-field', 'X');
  const textField = readPlanLabels(orbit, glyphs, width, height);
  orbit.setLayoutProperty('inset-countries', 'text-field', fieldPrevious);
  const restored = readPlanLabels(orbit, glyphs, width, height);
  orbit.setLayoutProperty('inset-countries', 'text-allow-overlap', true);
  const allowOverlap = readPlanLabels(orbit, glyphs, width, height);
  orbit.setLayoutProperty('inset-countries', 'text-allow-overlap', undefined);
  orbit.setLayoutProperty('inset-countries', 'text-ignore-placement', true);
  const ignorePlacement = readPlanLabels(orbit, glyphs, width, height);
  orbit.setLayoutProperty('inset-countries', 'text-ignore-placement', undefined);
  const shortGlyphs = readPlanLabels(orbit, 9999, width, height);
  orbit.setLayoutProperty('inset-countries', 'visibility', 'none');
  const hidden = readPlanLabels(orbit, glyphs, width, height);
  orbit.setLayoutProperty('inset-countries', 'visibility', 'visible');
  orbit.setPaintProperty('inset-countries', 'text-color', 'transparent');
  const clear = readPlanLabels(orbit, glyphs, width, height);
  return { unmutated, textOpacity, textField, restored, allowOverlap, ignorePlacement, shortGlyphs, hidden, clear };
}

function runBite() {
  const report = biteReport();
  const fractionalMain = fractionalCountrySymbols([2.5, 2.9, 3, 3.1].map((zoom) => ({
    zoom,
    names: ['Canada', 'France', 'Japan', 'France'],
  })));
  const fractionalFixed = fractionalCountrySymbols([2.5, 2.9, 3, 3.1].map((zoom) => ({
    zoom,
    names: [],
  })));
  const keptFrance = keptCountrySymbol(['Egypt', 'France', 'Nigeria'], 'France');
  const keptJapan = keptCountrySymbol(['China', 'Japan'], 'Japan');
  const keptMissing = keptCountrySymbol(['China'], 'Japan');
  console.log(`fractional-main ok:${fractionalMain.ok === true}`);
  console.log(`fractional-fixed ok:${fractionalFixed.ok === true}`);
  console.log(`kept-france ok:${keptFrance.ok === true}`);
  console.log(`kept-japan ok:${keptJapan.ok === true}`);
  console.log(`kept-missing ok:${keptMissing.ok === true}`);
  const handoffTiles = handoffSample({ tilesOk: false, detail: 'timeout' }, {
    zoom: 1.5, country: 'France', symbols: 0, raster: true, tileZ: 3,
  });
  const handoffGap = handoffSample({
    tilesOk: true, zoom: 1.49, tileZ: 2, names: [], words: 'EUROPE',
  }, { zoom: 1.49, country: 'France', symbols: 1, raster: false, tileZ: 2 });
  const handoffDuplicate = handoffSample({
    tilesOk: true, zoom: 1.5, tileZ: 3, names: ['France'], words: 'FRANCE',
  }, { zoom: 1.5, country: 'France', symbols: 0, raster: true, tileZ: 3 });
  const handoffFrance = handoffSample({
    tilesOk: true, zoom: 1.5, tileZ: 3, names: ['Spain'], words: 'FARIS RANCEMMAI',
  }, { zoom: 1.5, country: 'France', symbols: 0, raster: true, tileZ: 3 });
  const handoffKenya = handoffSample({
    tilesOk: true, zoom: 2.5, tileZ: 4, names: [], words: 'KENYA',
  }, { zoom: 2.5, country: 'Kenya', symbols: 0, raster: true, tileZ: 4 });
  const handoffKenyaEarly = handoffSample({
    tilesOk: true, zoom: 2.49, tileZ: 3, names: [], words: 'AFRICA',
  }, { zoom: 2.49, country: 'Kenya', symbols: 1, raster: false, tileZ: 3 });
  const handoffMiss = handoffSample({
    tilesOk: true, zoom: 1.5, tileZ: 3, names: [], words: 'EUROPE SPAIN',
  }, { zoom: 1.5, country: 'France', symbols: 0, raster: true, tileZ: 3 });
  console.log(`handoff-tiles ok:${handoffTiles.ok === true}`);
  console.log(`handoff-gap ok:${handoffGap.ok === true}`);
  console.log(`handoff-duplicate ok:${handoffDuplicate.ok === true}`);
  console.log(`handoff-france ok:${handoffFrance.ok === true}`);
  console.log(`handoff-kenya ok:${handoffKenya.ok === true}`);
  console.log(`handoff-kenya-early ok:${handoffKenyaEarly.ok === true}`);
  console.log(`handoff-miss ok:${handoffMiss.ok === true}`);
  const levels = loadCountryRasterLevels();
  const australiaLevels = levels.countries.Australia;
  const levelShape = Array.isArray(australiaLevels)
    && australiaLevels.includes(1)
    && australiaLevels.includes(2)
    && !australiaLevels.includes(3)
    && australiaLevels.includes(4);
  const complement = sweepRows(levels, (_name, _zoom, raster) => (raster ? 0 : 1))
    .map((row) => oneNameSource(row))
    .find((verdict) => verdict.ok !== true);
  const restoredFloor = sweepRows(levels, (name, zoom) => {
    const painted = levels.countries[name] || [];
    const first = painted.length ? Math.min(...painted) : 3;
    return zoom < Math.max(1.5, first - 1.5) ? 1 : 0;
  }).map((row) => oneNameSource(row)).find((verdict) => verdict.ok !== true);
  const droppedHole = sweepRows(levels, (name, zoom, _raster, tileZ) => {
    const painted = new Set(levels.countries[name] || []);
    if (name === 'Australia') painted.add(3);
    const raster = tileZ <= levels.through ? painted.has(tileZ) : painted.has(levels.through);
    return raster ? 0 : 1;
  }).map((row) => {
    if (row.country === 'Australia' && row.tileZ === 3) return oneNameSource({ ...row, words: 'INDONESIA' });
    return oneNameSource(row);
  }).find((verdict) => verdict.ok !== true);
  const ocean = oneNameSource({
    tilesOk: true, zoom: 0, tileZ: 1, country: 'India', names: ['India'], words: 'INDIAN OCEAN india',
  });
  console.log(`sweep-complement ok:${complement == null}`);
  console.log(`sweep-floor ok:${restoredFloor != null && restoredFloor.ok === false}`);
  console.log(`sweep-hole ok:${droppedHole != null && droppedHole.ok === false && droppedHole.reason === 'gap'}`);
  console.log(`sweep-ocean ok:${ocean.ok === true}`);
  console.log(`sweep-australia ok:${levelShape === true}`);
  const fractionalBite = fractionalMain.ok === false
    && fractionalMain.reason === 'symbols'
    && fractionalMain.zoom === 2.5
    && fractionalMain.duplicated.includes('France')
    && fractionalFixed.ok === true
    && keptFrance.ok === true
    && keptJapan.ok === true
    && keptMissing.ok === false
    && keptMissing.reason === 'kept'
    && handoffTiles.ok === false
    && handoffTiles.reason === 'tiles'
    && handoffGap.ok === false
    && handoffGap.reason === 'symbol'
    && handoffDuplicate.ok === false
    && handoffDuplicate.reason === 'symbol'
    && handoffFrance.ok === true
    && handoffKenya.ok === true
    && handoffKenyaEarly.ok === false
    && handoffKenyaEarly.reason === 'symbol'
    && handoffMiss.ok === false
    && handoffMiss.reason === 'raster'
    && complement == null
    && restoredFloor != null
    && restoredFloor.ok === false
    && droppedHole != null
    && droppedHole.reason === 'gap'
    && ocean.ok === true
    && levelShape === true;
  if (!fractionalBite) process.exit(1);
  const line = (name, verdict) => `${name} ok:${verdict.ok === true}`;
  console.log(line('unmutated', report.unmutated));
  console.log(line('text-opacity', report.textOpacity));
  console.log(line('text-field', report.textField));
  console.log(line('text-allow-overlap', report.allowOverlap));
  console.log(line('text-ignore-placement', report.ignorePlacement));
  const bite = report.unmutated.ok === true
    && report.textOpacity.ok === false
    && report.textOpacity.reason === 'opacity'
    && report.textField.ok === false
    && report.textField.reason === 'names'
    && report.restored.ok === true
    && report.allowOverlap.ok === false
    && report.allowOverlap.reason === 'allow-overlap'
    && report.ignorePlacement.ok === false
    && report.ignorePlacement.reason === 'ignore-placement'
    && report.shortGlyphs.ok === false
    && report.shortGlyphs.reason === 'glyphs'
    && report.hidden.ok === false
    && report.hidden.reason === 'visibility'
    && report.clear.ok === false
    && report.clear.reason === 'color';
  if (!bite) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBite();
}
