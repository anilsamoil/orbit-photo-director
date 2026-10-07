import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const COUNTRY_NAMES = ['Canada', 'Mexico', 'Brazil', 'Argentina'];

export function planLabelVerdict(sample) {
  const names = [];
  const rendered = Array.isArray(sample.rendered) ? sample.rendered : [];
  const width = Number(sample.width);
  const height = Number(sample.height);
  for (const feature of rendered) {
    const name = feature && feature.properties && feature.properties.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (!(feature.x >= 8 && feature.y >= 8 && feature.x <= width - 8 && feature.y <= height - 8)) continue;
    if (!names.includes(name)) names.push(name);
  }
  const glyphs = Number(sample.glyphs);
  if (glyphs < 10000 || names.length < 4) {
    return { ok: false, step: 'labels', reason: 'names', glyphs, names };
  }
  return { ok: true, names, glyphs };
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
  return { unmutated, textOpacity, textField, restored };
}

function runBite() {
  const report = biteReport();
  const line = (name, verdict) => `${name} ok:${verdict.ok === true}`;
  console.log(line('unmutated', report.unmutated));
  console.log(line('text-opacity', report.textOpacity));
  console.log(line('text-field', report.textField));
  const bite = report.unmutated.ok === true
    && report.textOpacity.ok === false
    && report.textField.ok === false
    && report.restored.ok === true;
  if (!bite) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBite();
}
