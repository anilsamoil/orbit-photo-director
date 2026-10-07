import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const COUNTRY_NAMES = ['Canada', 'Mexico', 'Brazil', 'Argentina'];

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
  let labelFeatures = [];
  try {
    labelFeatures = orbit.queryRenderedFeatures({ layers: ['inset-countries'] }) || [];
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
  const shortGlyphs = readPlanLabels(orbit, 9999, width, height);
  orbit.setLayoutProperty('inset-countries', 'visibility', 'none');
  const hidden = readPlanLabels(orbit, glyphs, width, height);
  orbit.setLayoutProperty('inset-countries', 'visibility', 'visible');
  orbit.setPaintProperty('inset-countries', 'text-color', 'transparent');
  const clear = readPlanLabels(orbit, glyphs, width, height);
  return { unmutated, textOpacity, textField, restored, shortGlyphs, hidden, clear };
}

function runBite() {
  const report = biteReport();
  const line = (name, verdict) => `${name} ok:${verdict.ok === true}`;
  console.log(line('unmutated', report.unmutated));
  console.log(line('text-opacity', report.textOpacity));
  console.log(line('text-field', report.textField));
  const bite = report.unmutated.ok === true
    && report.textOpacity.ok === false
    && report.textOpacity.reason === 'opacity'
    && report.textField.ok === false
    && report.textField.reason === 'names'
    && report.restored.ok === true
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
