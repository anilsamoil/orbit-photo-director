import { readFileSync } from 'node:fs';
import { countryLabelCountsScreen, letteringOccluded } from '../../../../frontend/src/map/adapters/maplibre/country-label-size.ts';
import vm from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { ocrFrame } from './raster-ocr.mjs';
import { countCountryGlyphs } from './rotated-name-count.mjs';

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

export function rasterPainted(words, country) {
  const name = String(country || '').toUpperCase();
  if (name.length < 4) return false;
  const stems = [name];
  for (let index = 0; index < name.length; index += 1) {
    const stem = name.slice(0, index) + name.slice(index + 1);
    if (stem.length >= 4) stems.push(stem);
  }
  return String(words || '').toUpperCase().split(/\r?\n/).some((line) => {
    const tokens = line.split(/[^A-Z]+/).filter(Boolean);
    return tokens.some((word, index) => {
      if (['SOUTH', 'WESTERN', 'WEST', 'NORTH', 'NORTHERN', 'NEW'].includes(tokens[index - 1])) return false;
      if (tokens[index - 2] === 'GULF' && tokens[index - 1] === 'OF') return false;
      if (['OCEAN', 'SEA', 'BIGHT'].includes(tokens[index + 1])) return false;
      if (word.startsWith(name) && word.length > name.length) return false;
      if (stems.includes(word)) return true;
      return stems.some((stem) => stem !== name && word.includes(stem) && word.length > stem.length && word.length <= stem.length + 4);
    });
  });
}

export function countrySweepZooms(levels = loadCountryRasterLevels()) {
  const zooms = new Set([-1.1497862143712645, -0.23372503287116042, 5, 5.5, 6.5, 6.51, 8]);
  for (let step = -50; step <= 310; step += 5) zooms.add(step / 100);
  for (let tile = 1; tile <= levels.through; tile += 1) {
    const edge = tile - 1.5;
    for (const offset of [-0.01, 0, 0.01]) zooms.add(Number((edge + offset).toFixed(2)));
  }
  return [...zooms].sort((left, right) => left - right);
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

/** Independent of the generated file: the reviewed fresh Esri sovereign-name audit, through tile z6. */
export const AUDITED_RASTER_LEVELS = {
  through: 6,
  countries: Object.fromEntries(PLAN_COUNTRIES.map(({ name }) => [name,
    name === 'Australia' ? [1, 2, 3, 4, 5, 6] : name === 'Kenya' ? [4, 5, 6] : [3, 4, 5, 6],
  ])),
};

export function auditRasterLevels(levels) {
  if (levels?.through !== AUDITED_RASTER_LEVELS.through) return { ok: false, reason: 'audit-through' };
  for (const { name } of PLAN_COUNTRIES) {
    if (JSON.stringify(levels.countries?.[name]) !== JSON.stringify(AUDITED_RASTER_LEVELS.countries[name])) {
      return { ok: false, reason: 'audit-levels', country: name, actual: levels.countries?.[name], expected: AUDITED_RASTER_LEVELS.countries[name] };
    }
  }
  return { ok: true };
}

/** Read the production style builder, not a second implementation of its hole-band algorithm. */
export function loadCountrySymbolLayers() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const file = resolve(root, 'frontend/src/map/adapters/maplibre/track-inset.ts');
  const require = createRequire(resolve(root, 'frontend/package.json'));
  const ts = require('typescript');
  const source = readFileSync(file, 'utf8') + '\nexport { countryLabelLayer };\n';
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: (id) => {
    if (id === './country-raster-levels.json') return loadCountryRasterLevels();
    if (id.endsWith('plan-labels')) return { PLAN_RASTER_NAME_ZOOM: 3, planTier: () => [] };
    return {};
  } });
  vm.runInContext(compiled, context, { filename: file });
  return [JSON.parse(JSON.stringify(module.exports.countryLabelLayer()))];
}

function opacityAt(value, zoom) {
  if (value == null) return 1;
  if (typeof value === 'number') return value;
  if (!Array.isArray(value) || value[0] !== 'step') return 0;
  let result = value[2];
  for (let index = 3; index + 1 < value.length; index += 2) {
    if (zoom >= Number(value[index])) result = value[index + 1];
  }
  return Number(result);
}

/** Main's one country layer. Opacity 0 or a zoom step would hide names the raster has not shown. */
export function countryStyleVerdict(layers, levels = loadCountryRasterLevels()) {
  const audit = auditRasterLevels(levels);
  if (!audit.ok) return audit;
  const symbols = (layers || []).filter((layer) => layer.type === 'symbol');
  if (symbols.length !== 1 || symbols[0].id !== 'inset-countries' || symbols[0].source !== 'inset-countries') {
    return { ok: false, reason: 'layer', ids: symbols.map((layer) => layer.id) };
  }
  const layer = symbols[0];
  if (layer.maxzoom !== 3) return { ok: false, reason: 'maxzoom', maxzoom: layer.maxzoom };
  if (layer.layout?.['text-allow-overlap'] === true || layer.layout?.['text-ignore-placement'] === true) {
    return { ok: false, reason: 'placement' };
  }
  if (layer.layout?.['text-variable-anchor-offset'] || layer.layout?.['symbol-sort-key']) {
    return { ok: false, reason: 'anchor' };
  }
  const opacity = layer.paint?.['text-opacity'];
  if (opacity === 0 || (Array.isArray(opacity) && opacity[0] === 'step')) return { ok: false, reason: 'opacity' };
  return { ok: true };
}

/** Tiles loaded and settled. This does not say a country name is readable. */
export function tilesLoaded(row) {
  if (!row || row.tilesOk !== true) {
    return { ok: false, check: 'tiles', reason: 'tiles', zoom: row && row.zoom, detail: row && row.detail };
  }
  const zoom = Number(row.zoom);
  if (!Number.isFinite(zoom)) return { ok: false, check: 'tiles', reason: 'zoom', zoom: row && row.zoom };
  if (row.tileZ != null && row.tileZ !== labelTile(zoom)) {
    return { ok: false, check: 'tiles', reason: 'tile', tileZ: row.tileZ, expected: labelTile(zoom), zoom };
  }
  return { ok: true, check: 'tiles', zoom, tileZ: row.tileZ };
}

/** Every rendered symbol is one of the twelve plan countries. A same-length stand-in is not a match. */
export function countryIdentity(names, country) {
  const list = nameList(names);
  const known = new Set(PLAN_COUNTRIES.map((entry) => entry.name));
  const unknown = list.filter((name) => !known.has(name));
  if (country && !known.has(country)) return { ok: false, check: 'country', reason: 'identity', country };
  if (unknown.length) return { ok: false, check: 'country', reason: 'identity', unknown, country };
  return { ok: true, check: 'country', country, names: list };
}

/** How many times the target is drawn. The expected count comes from main, not from a one-name rule. */
export function occurrenceCount(count, expected) {
  const actual = Number(count);
  return {
    ok: actual === expected,
    check: 'count',
    reason: actual === expected ? undefined : 'count',
    count: actual,
    expected,
  };
}

/** Visible symbol names compared with main's names for the same camera. */
export function matchesMain(actual, mainNames) {
  const left = nameList(actual).slice().sort();
  const right = nameList(mainNames).slice().sort();
  const ok = JSON.stringify(left) === JSON.stringify(right);
  return { ok, check: 'parity', reason: ok ? undefined : 'parity', actual: left, main: right };
}

/** Kenya west keeps main's two raster names. The symbol layer adds none. */
export const KENYA_WEST_RASTER_COUNT = 2;

/** Share of sampled pixels that may differ between a head frame and main's frame of the same camera. */
export const RASTER_PAIR_TOLERANCE = 0.012;

function rectContains(rect, x, y) {
  return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
}

/** Whole-frame pixel compare. A country name is a separate count of the letters in the frame. */
export function pairedRasterNames(head, main, options = {}) {
  const settings = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  if (!head || !main || !head.data || !main.data || head.width !== main.width || head.height !== main.height || head.width < 2 || head.height < 2) {
    return { ok: false, check: 'raster', reason: 'pair' };
  }
  const ignore = (settings.ignoreRects || []).map((rect) => ({
    left: rect.left - 8,
    top: rect.top - 8,
    right: rect.right + 8,
    bottom: rect.bottom + 8,
  }));
  let seen = 0;
  let differ = 0;
  const step = 2;
  for (let y = 0; y < head.height; y += step) {
    for (let x = 0; x < head.width; x += step) {
      if (ignore.some((rect) => rectContains(rect, x, y))) continue;
      seen += 1;
      const index = (y * head.width + x) * 4;
      const delta = Math.abs(head.data[index] - main.data[index])
        + Math.abs(head.data[index + 1] - main.data[index + 1])
        + Math.abs(head.data[index + 2] - main.data[index + 2]);
      if (delta > 48) differ += 1;
    }
  }
  const ratio = seen ? differ / seen : 1;
  const tolerance = Number.isFinite(settings.tolerance) ? settings.tolerance : RASTER_PAIR_TOLERANCE;
  if (!(ratio <= tolerance)) {
    return { ok: false, check: 'raster', reason: 'pixels', ratio, differ, seen };
  }
  return { ok: true, check: 'raster', reason: undefined, ratio, differ, seen };
}

function boxHitsRect(box, rect) {
  return box[0] < rect.right && box[2] > rect.left && box[1] < rect.bottom && box[3] > rect.top;
}

function boxDiffers(left, right, box) {
  if (!left || !right || !left.data || !right.data || left.width !== right.width || left.height !== right.height) return true;
  const pad = 6;
  const x0 = Math.max(0, Math.floor(box[0]) - pad);
  const y0 = Math.max(0, Math.floor(box[1]) - pad);
  const x1 = Math.min(left.width, Math.ceil(box[2]) + pad);
  const y1 = Math.min(left.height, Math.ceil(box[3]) + pad);
  let seen = 0;
  let differ = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = (y * left.width + x) * 4;
      seen += 1;
      const delta = Math.abs(left.data[index] - right.data[index])
        + Math.abs(left.data[index + 1] - right.data[index + 1])
        + Math.abs(left.data[index + 2] - right.data[index + 2]);
      if (delta > 48) differ += 1;
    }
  }
  return !(seen > 0) || differ / seen > 0.08;
}

/** How many times each plan country is readable in this frame. A stored count is not a reading. */
export function frameCountryNames(image, options = {}) {
  if (!image || !image.png) return { ok: false, reason: 'frame', counts: {}, words: [] };
  const recognized = ocrFrame(image.png);
  if (!recognized || !Array.isArray(recognized.words) || recognized.words.length === 0) {
    return { ok: false, reason: 'unread', counts: {}, words: [] };
  }
  const names = new Set(PLAN_COUNTRIES.map((entry) => entry.name.toUpperCase()));
  const chrome = options.chromeRects || [];
  const words = [];
  const counts = {};
  for (const word of recognized.words) {
    const text = String(word.text || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!names.has(text) || word.uppercase === false) continue;
    const box = word.box || [0, 0, 0, 0];
    if (chrome.some((rect) => boxHitsRect(box, rect))) continue;
    words.push({ text, box });
    counts[text] = (counts[text] || 0) + 1;
  }
  return { ok: true, counts, words };
}

function countsFromWords(found, image, other) {
  const counts = {};
  for (const word of found.words || []) {
    if (other && !boxDiffers(image, other, word.box)) continue;
    counts[word.text] = (counts[word.text] || 0) + 1;
  }
  return counts;
}

/** Name identity and occurrence count, read from the head frame and the main frame. */
export function frameNameVerdict(head, main, country, options = {}) {
  const chrome = options.chromeRects || [];
  const mainChrome = options.mainChromeRects || [];
  const leftFound = frameCountryNames(head, { chromeRects: chrome });
  const rightFound = frameCountryNames(main, { chromeRects: mainChrome });
  const leftCounts = leftFound.ok ? countsFromWords(leftFound, head, main) : {};
  const rightCounts = rightFound.ok ? countsFromWords(rightFound, main, head) : {};
  const key = String(country || '').toUpperCase();
  const headCount = leftCounts[key] || 0;
  const mainCount = rightCounts[key] || 0;
  if (!leftFound.ok || !rightFound.ok) {
    return { ok: false, check: 'name', reason: 'unread', count: headCount, expected: mainCount, head: leftCounts, main: rightCounts };
  }
  const stable = (counts) => JSON.stringify(Object.fromEntries(Object.entries(counts).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))));
  if (stable(leftCounts) !== stable(rightCounts)) {
    return { ok: false, check: 'name', reason: 'name', count: headCount, expected: mainCount, head: leftCounts, main: rightCounts };
  }
  const count = occurrenceCount(headCount, mainCount);
  if (!count.ok) return { ok: false, check: 'count', reason: 'count', count: headCount, expected: mainCount, head: leftCounts, main: rightCounts };
  if (options.kenyaWest && head.data && main.data) {
    const headBlocked = [...chrome, ...(options.ignoreRects || [])];
    const mainBlocked = [...mainChrome, ...(options.mainIgnoreRects || [])];
    const headGlyphs = countCountryGlyphs(head.data, head.width, head.height, country, { ignoreRects: headBlocked });
    const mainGlyphs = countCountryGlyphs(main.data, main.width, main.height, country, { ignoreRects: mainBlocked });
    const same = occurrenceCount(headGlyphs, mainGlyphs);
    if (!same.ok) return { ok: false, check: 'count', reason: 'count', count: headGlyphs, expected: mainGlyphs, head: leftCounts, main: rightCounts };
    return { ok: true, check: 'count', count: headGlyphs, expected: mainGlyphs, head: leftCounts, main: rightCounts };
  }
  return { ok: true, check: 'name', count: headCount, expected: mainCount, head: leftCounts, main: rightCounts };
}

/** The plan label source uses main's tile cap, not the audit cap. Overzooming z6 turns border lettering into a second name. */
export const LABEL_SOURCE_MAX_ZOOM = 19;

export function labelTile(zoom) {
  return Math.min(LABEL_SOURCE_MAX_ZOOM, Math.max(0, Math.round(Number(zoom) + 1)));
}

function idealTile(zoom) {
  return labelTile(zoom);
}

function levelPaints(levels, country, tileZoom) {
  const painted = levels.countries[country] || [];
  if (tileZoom <= levels.through) return painted.includes(tileZoom);
  return painted.includes(levels.through);
}

/** The map's own lettering test: white ink when the audit measured it, otherwise the padded box. */
export function auditedNameReadable(country, zoom, viewport, levels = loadCountryRasterLevels()) {
  if (!viewport || !viewport.origin || !Number.isFinite(Number(zoom))) return false;
  const painted = levels.countries?.[country] || [];
  const world = 512 * (2 ** Number(zoom));
  const sources = [
    { service: 'reference', tile: Math.min(levels.through, Math.max(0, Math.round(Number(zoom) + 1))) },
    { service: 'dark', tile: Math.min(20, Math.max(0, Math.round(Number(zoom) + 1))) },
  ].filter((source) => painted.includes(source.tile));
  return sources.some((source) => (levels.bounds?.[country]?.[String(source.tile)] || []).some((entry) => {
    if (entry.service !== source.service) return false;
    const box = entry.box;
    if (!(box[2] - box[0] >= 0.0004 && box[3] - box[1] >= 0.0004)) return false;
    const glyph = entry.ink || box;
    const screen = [
      viewport.origin.x + glyph[0] * world,
      viewport.origin.y + glyph[1] * world,
      viewport.origin.x + glyph[2] * world,
      viewport.origin.y + glyph[3] * world,
    ];
    if (screen[0] < 0 || screen[1] < 0 || screen[2] > viewport.width || screen[3] > viewport.height) return false;
    return !(viewport.occlusions || []).some((rect) => screen[0] < rect[2] && screen[2] > rect[0] && screen[1] < rect[3] && screen[3] > rect[1]);
  }));
}

/** Stored lettering boxes are candidates. A raster name still needs a pixel hit on one of them. */
export function auditedNameCandidates(country, zoom, viewport, levels = loadCountryRasterLevels()) {
  if (!viewport || !viewport.origin || !Number.isFinite(Number(zoom))) return [];
  const painted = levels.countries?.[country] || [];
  const world = 512 * (2 ** Number(zoom));
  const sources = [
    { service: 'reference', tile: Math.min(levels.through, Math.max(0, Math.round(Number(zoom) + 1))) },
    { service: 'dark', tile: Math.min(20, Math.max(0, Math.round(Number(zoom) + 1))) },
  ].filter((source) => painted.includes(source.tile));
  const boxes = [];
  for (const source of sources) {
    for (const entry of levels.bounds?.[country]?.[String(source.tile)] || []) {
      if (entry.service !== source.service) continue;
      const box = entry.box;
      if (!(box[2] - box[0] >= 0.0004 && box[3] - box[1] >= 0.0004)) continue;
      const glyph = entry.ink || box;
      boxes.push({
        box: [
          viewport.origin.x + glyph[0] * world,
          viewport.origin.y + glyph[1] * world,
          viewport.origin.x + glyph[2] * world,
          viewport.origin.y + glyph[3] * world,
        ],
      });
    }
  }
  return boxes;
}

export function rasterNameEvidence(pixelBoxes, candidates, masks = []) {
  const overlaps = (left, right) => left[0] < right[2] && left[2] > right[0] && left[1] < right[3] && left[3] > right[1];
  const visible = (pixelBoxes || []).filter((pixel) => {
    const box = pixel.box || pixel;
    return !(masks || []).some((mask) => overlaps(box, [mask.left, mask.top, mask.right, mask.bottom]));
  });
  if (!visible.length || !candidates?.length) return false;
  return visible.some((pixel) => candidates.some((candidate) => overlaps(pixel.box || pixel, candidate.box || candidate)));
}

/** A letter that crosses the canvas and is not hidden by a label cover. */
export function clippedRasterRemnant(boxes, viewport, covers) {
  const open = [];
  for (const item of boxes || []) {
    const box = item.box;
    const left = Math.max(box[0], 0);
    const top = Math.max(box[1], 0);
    const right = Math.min(box[2], viewport.width);
    const bottom = Math.min(box[3], viewport.height);
    const overflow = Math.max(-box[0], -box[1], box[2] - viewport.width, box[3] - viewport.height);
    if (!(overflow > 0) || right - left < 1 || bottom - top < 1) continue;
    const crossesLeft = box[0] < -1;
    const crossesTop = box[1] < -1;
    const crossesRight = box[2] > viewport.width + 1;
    const crossesBottom = box[3] > viewport.height + 1;
    const covered = (covers || []).some((cover) => cover.left < right && cover.right > left && cover.top < bottom && cover.bottom > top
      && (!crossesLeft || cover.left <= 1)
      && (!crossesTop || cover.top <= 1)
      && (!crossesRight || cover.right >= viewport.width - 1)
      && (!crossesBottom || cover.bottom >= viewport.height - 1));
    if (!covered) open.push([left, top, right, bottom]);
  }
  return { covered: open.length === 0, open };
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
  const rasterCount = Number.isFinite(Number(row.rasterCount))
    ? Number(row.rasterCount)
    : (typeof row.rasterReadable === 'boolean' ? (row.rasterReadable ? 1 : 0) : (rasterPainted(row.words, row.country) ? 1 : 0));
  const sources = count + rasterCount;
  if (sources !== 1) {
    return {
      ok: false,
      reason: sources === 0 ? 'gap' : 'duplicate',
      country: row.country,
      zoom,
      count,
      raster: rasterCount,
    };
  }
  return { ok: true, country: row.country, zoom, count, raster: rasterCount };
}

/** Projected anchor of a country, in plan pixels. Zero names are allowed only when this point is off the canvas. */
export function anchorOnPlan(anchor, center, zoom, width, height) {
  const scale = 512 * (2 ** zoom);
  const yOf = (latitude) => (1 - Math.asinh(Math.tan(latitude * Math.PI / 180)) / Math.PI) / 2;
  const x = width / 2 + (anchor[0] - center[0]) / 360 * scale;
  const y = height / 2 + (yOf(anchor[1]) - yOf(center[1])) * scale;
  return { x, y, inside: x >= 0 && y >= 0 && x <= width && y <= height };
}

/** A rendered symbol box that leaves the plan is a clipped word, not a complete name. */
export function symbolCrossesEdge(box, width, height) {
  if (!box) return false;
  const left = box.left ?? box[0];
  const top = box.top ?? box[1];
  const right = box.right ?? box[2];
  const bottom = box.bottom ?? box[3];
  return left < -0.5 || top < -0.5 || right > width + 0.5 || bottom > height + 0.5;
}

/** One name, or none when the anchor is off the plan. Peeking ink, a clipped symbol, or a mask across a kept name fails even when the count is one. */
export function nameCountOk(total, anchorInside, pixels) {
  if (pixels && (pixels.peek || pixels.openRemnant)) return { ok: false, reason: 'peek', total };
  if (pixels && pixels.clipped) return { ok: false, reason: 'clipped', total };
  if (pixels && pixels.maskCut) return { ok: false, reason: 'mask', total };
  if (total >= 2) return { ok: false, reason: 'duplicate', total };
  if (total === 0) return { ok: !anchorInside, reason: anchorInside ? 'gap' : 'offscreen', total };
  return { ok: true, total };
}

/** Fully visible names that clear the same lettering-size floor as the raster reader. */
export function completeNameCount(screenBoxes, viewport, masks = []) {
  const width = viewport && viewport.width;
  const height = viewport && viewport.height;
  const zoom = viewport && Number(viewport.zoom);
  const overlaps = (box, mask) => box[0] < mask.right && box[2] > mask.left && box[1] < mask.bottom && box[3] > mask.top;
  return (screenBoxes || []).filter((item) => {
    const box = item.box || item;
    const pad = Number.isFinite(item.scale) && item.scale > 0 ? item.scale : 0;
    const ink = [box[0] + pad, box[1] + pad, box[2] - pad, box[3] - pad];
    if (!(ink[2] > ink[0] && ink[3] > ink[1])) return false;
    if (!(ink[0] >= 0 && ink[1] >= 0 && ink[2] <= width && ink[3] <= height)) return false;
    if (Number.isFinite(zoom) && !countryLabelCountsScreen(ink, zoom)) return false;
    if (letteringOccluded(ink, viewport.occlusions || [])) return false;
    return !(masks || []).some((mask) => overlaps(ink, mask));
  }).length;
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
    if (Array.isArray(value) && value[0] === 'case' && value[value.length - 1] === 1) return 1;
    return 0;
  }
  function colorAlpha(colorValue) {
    if (colorValue == null) return 1;
    if (typeof colorValue === 'object' && typeof colorValue.a === 'number') return colorValue.a;
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
    if (field && typeof field === 'object' && Array.isArray(field.sections)) {
      return field.sections.map((section) => (section && typeof section.text === 'string' ? section.text : '')).join('');
    }
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
    const field = feature && feature.textField != null ? feature.textField : sample.textField;
    const featureOpacity = feature && feature.textOpacity != null ? resolvedOpacity(feature.textOpacity) : opacity;
    const featureAlpha = feature && feature.textColor != null ? colorAlpha(feature.textColor) : alpha;
    if (feature && feature.visibility === 'none') continue;
    if (!(featureOpacity > 0) || !(featureAlpha > 0)) continue;
    const text = shownText(field, feature && feature.properties);
    const propertyName = feature && feature.properties && feature.properties.name;
    if (typeof propertyName === 'string' && text !== propertyName) continue;
    if (text.length < 2 || !catalog.includes(text)) continue;
    if (!(feature.x >= 8 && feature.y >= 8 && feature.x <= width - 8 && feature.y <= height - 8)) continue;
    names.push(text);
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
    const layer = feature.layer || {};
    const layout = layer.layout || {};
    const paint = layer.paint || {};
    rendered.push({
      properties: feature.properties || {},
      x: point.x,
      y: point.y,
      textField: layout['text-field'],
      textColor: paint['text-color'],
      textOpacity: paint['text-opacity'],
      visibility: layout.visibility,
    });
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
    && !australiaLevels.includes(0)
    && australiaLevels.includes(1)
    && australiaLevels.includes(2)
    && australiaLevels.includes(3)
    && australiaLevels.includes(4)
    && australiaLevels.includes(5)
    && australiaLevels.includes(6);
  const style = countryStyleVerdict(loadCountrySymbolLayers(), levels);
  console.log(`production-style ok:${style.ok === true} ${style.ok ? '' : JSON.stringify(style)}`);
  const complement = sweepRows(AUDITED_RASTER_LEVELS, (_name, _zoom, raster) => (raster ? 0 : 1))
    .map((row) => oneNameSource(row))
    .find((verdict) => verdict.ok !== true);
  const restoredFloor = sweepRows(levels, (name, zoom) => {
    const painted = levels.countries[name] || [];
    const first = painted.length ? Math.min(...painted) : 3;
    return zoom < Math.max(1.5, first - 1.5) ? 1 : 0;
  }).map((row) => oneNameSource(row)).find((verdict) => verdict.ok !== true);
  const droppedHole = sweepRows(levels, (name, _zoom, _raster, tileZ) => {
    const painted = new Set(levels.countries[name] || []);
    if (name === 'Australia') painted.delete(3);
    const raster = tileZ <= levels.through ? painted.has(tileZ) : painted.has(levels.through);
    return raster ? 0 : 1;
  }).map((row) => {
    if (row.country === 'Australia' && row.tileZ === 3) return oneNameSource({ ...row, words: 'AUSTRALIA' });
    return oneNameSource(row);
  }).find((verdict) => verdict.ok !== true);
  const ocean = oneNameSource({
    tilesOk: true, zoom: 0, tileZ: 1, country: 'India', names: ['India'], words: 'INDIAN OCEAN',
  });
  console.log(`sweep-complement ok:${complement == null}`);
  console.log(`sweep-floor ok:${restoredFloor != null && restoredFloor.ok === false}`);
  console.log(`sweep-hole ok:${droppedHole != null && droppedHole.ok === false && droppedHole.reason === 'duplicate'}`);
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
    && droppedHole.reason === 'duplicate'
    && ocean.ok === true
    && style.ok === true
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
