import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countryLabelCountsScreen, letteringOccluded } from '../../../../frontend/src/map/adapters/maplibre/country-label-size.ts';

export function rasterHelperFrom(source) {
  const text = String(source);
  if (text.startsWith('file:')) return fileURLToPath(new URL('./raster-ocr.py', text));
  const decoded = decodeURIComponent(text);
  const marker = '/raster-ocr.mjs';
  const at = decoded.lastIndexOf(marker);
  if (at < 0) throw new Error(`raster OCR helper is not a file URL: ${text}`);
  let path = decoded.slice(0, at);
  const embedded = path.lastIndexOf('/@fs');
  if (embedded >= 0) path = path.slice(embedded + 4);
  if (path.startsWith('file:')) path = fileURLToPath(path);
  return `${path}/raster-ocr.py`;
}

const moduleSource = import.meta.url;
const helper = rasterHelperFrom(moduleSource);
let interpreter;
const decoded = new Map();
const fetched = new Map();
export const rasterOcrStats = { calls: 0, fetches: 0, hits: 0 };

export function ocrPython() {
  if (interpreter) return interpreter;
  const explicit = process.env.OPD_VERIFY_OCR_PYTHON;
  const candidates = explicit ? [explicit] : [resolve(process.cwd(), '.venv/bin/python'), '/usr/bin/python3', 'python3'];
  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['-c', 'import PIL, sys; print(sys.executable)'], { encoding: 'utf8' });
    if (probe.status === 0) return interpreter = probe.stdout.trim();
  }
  throw new Error('raster OCR needs an explicit Pillow interpreter: set OPD_VERIFY_OCR_PYTHON');
}

function ocrTimeout(passes) {
  const seconds = Number(process.env.OPD_VERIFY_OCR_PASS_TIMEOUT || 60);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('OPD_VERIFY_OCR_PASS_TIMEOUT must be positive seconds');
  return Math.ceil(passes * seconds * 1000 + 20000);
}

export function checkRasterOcr() {
  const python = ocrPython();
  const probe = spawnSync(python, [helper, '--doctor'], { encoding: 'utf8', timeout: ocrTimeout(1), maxBuffer: 1024 * 1024 });
  if (probe.status !== 0) throw new Error(`raster OCR known-text probe failed: ${(probe.stderr || probe.error || '').toString().slice(0, 1000)}`);
  const result = JSON.parse(probe.stdout);
  if (!result.ok) throw new Error('raster OCR known-text probe failed');
  return result;
}

export function clearRasterOcrRun() {
  fetched.clear();
  decoded.clear();
  rasterOcrStats.calls = 0;
  rasterOcrStats.fetches = 0;
  rasterOcrStats.hits = 0;
}

function runHelper(args, input, passes, maxBuffer) {
  const result = spawnSync(ocrPython(), [helper, ...args], {
    input,
    encoding: 'utf8',
    timeout: ocrTimeout(passes),
    maxBuffer,
    killSignal: 'SIGTERM',
  });
  return result;
}

export function ocrFrame(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'opd-ocr-frame-'));
  const file = join(dir, 'frame.png');
  try {
    writeFileSync(file, Buffer.from(bytes));
    const result = runHelper(['--frame', file], undefined, 1, 8 * 1024 * 1024);
    if (result.status !== 0) throw new Error(`frame OCR failed: ${(result.stderr || result.error || '').toString().slice(0, 500)}`);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function ocrCropTexts(pngs) {
  if (!pngs.length) return [];
  const input = JSON.stringify({ crops: pngs.map((png) => Buffer.from(png).toString('base64')) });
  const result = runHelper(['--crops'], input, pngs.length, 8 * 1024 * 1024);
  if (result.status !== 0) throw new Error(`line OCR failed: ${(result.stderr || result.error || '').toString().slice(0, 500)}`);
  const parsed = JSON.parse(result.stdout);
  if (!parsed || !Array.isArray(parsed.texts) || parsed.texts.length !== pngs.length) {
    throw new Error('line OCR returned no reading');
  }
  return parsed.texts;
}

export function ocrRasterTile(tiles) {
  rasterOcrStats.calls += 1;
  const normalized = Buffer.isBuffer(tiles) ? [{ x: 0, y: 0, bytes: tiles }] : tiles;
  const dir = mkdtempSync(join(tmpdir(), 'opd-ocr-tiles-'));
  const file = join(dir, 'tiles.json');
  try {
    writeFileSync(file, JSON.stringify({ tiles: normalized.map(tile => ({ ...tile, bytes: tile.bytes.toString('base64') })) }));
    const result = runHelper(['--tiles', file], undefined, 3, 16 * 1024 * 1024);
    if (result.status !== 0) throw new Error(`raster tile OCR failed: ${(result.stderr || result.error || '').toString().slice(0, 1000)}`);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function fetchTile(url) {
  if (fetched.has(url)) return fetched.get(url);
  const task = (async () => {
    const fresh = `${url}${url.includes('?') ? '&' : '?'}ocrNonce=${Date.now()}-${Math.random()}`;
    let last;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(fresh, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        rasterOcrStats.fetches += 1;
        return Buffer.from(await response.arrayBuffer());
      } catch (error) { last = error; }
    }
    throw new Error(`raster tile fetch failed ${url}: ${last}`);
  })();
  fetched.set(url, task);
  return task;
}

/** Bound OCR to loaded/rendered tiles near the independently specified centroid. */
export function countryRasterUrls(urls, country) {
  return urls.filter(url => {
    const parsed = /\/tile\/(\d+)\/(\d+)\/(\d+)/.exec(url);
    if (!parsed) throw new Error(`unrecognized raster tile URL: ${url}`);
    const n = 2 ** Number(parsed[1]);
    const x = Math.max(0, Math.min(n-1, Math.floor((country.lng+180)/360*n)));
    const rad = country.lat * Math.PI/180;
    const y = Math.max(0, Math.min(n-1, Math.floor((1-Math.asinh(Math.tan(rad))/Math.PI)/2*n)));
    return Math.abs(Number(parsed[3])-x) <= 1 && Math.abs(Number(parsed[2])-y) <= 1;
  });
}

export async function rasterWords(urls) {
  const groups = new Map();
  await Promise.all([...new Set(urls)].sort().map(async url => {
    const parsed = /^(.*\/tile\/(\d+))\/(\d+)\/(\d+)/.exec(url);
    if (!parsed) throw new Error(`unrecognized raster tile URL: ${url}`);
    const key = parsed[1];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ x: Number(parsed[4]), y: Number(parsed[3]), z: Number(parsed[2]), bytes: await fetchTile(url) });
  }));
  const mosaics = [];
  for (const [service, tiles] of groups) {
    tiles.sort((left,right)=>left.y-right.y || left.x-right.x);
    const hash = createHash('sha256');
    for (const tile of tiles) { hash.update(`${tile.x},${tile.y},${tile.z}:`); hash.update(tile.bytes); }
    const key = hash.digest('hex');
    if (!decoded.has(key)) decoded.set(key, ocrRasterTile(tiles));
    else rasterOcrStats.hits += 1;
    mosaics.push({ ...decoded.get(key), service, z: tiles[0].z, hash: key });
  }
  return { text: mosaics.map(part => part.text).join('\n'), mosaics };
}

function sovereignBoxes(mosaic, country) {
  const name = country.toUpperCase();
  const stems = new Set([name]);
  for (let index = 0; index < name.length; index += 1) {
    const stem = name.slice(0, index) + name.slice(index+1);
    if (stem.length >= 4) stems.add(stem);
  }
  const result = [];
  for (const line of mosaic.lines || [mosaic.words]) {
    const tokens = line.map(word => word.text.normalize('NFKD').toUpperCase().replace(/[^A-Z]/g, ''));
    for (let start = 0; start < tokens.length; start += 1) for (let end = start+1; end <= Math.min(tokens.length, start+name.length); end += 1) {
      const text = tokens.slice(start,end).join('');
      if (!stems.has(text) || line.slice(start,end).some(word => word.uppercase === false)) continue;
      if (['SOUTH','WESTERN','WEST','NORTH','NORTHERN','NEW'].includes(tokens[start-1])) continue;
      if (['OCEAN','SEA','BIGHT'].includes(tokens[end])) continue;
      if (tokens[start-2] === 'GULF' && tokens[start-1] === 'OF') continue;
      const picked = line.slice(start,end).map(word=>word.box);
      const box = [Math.min(...picked.map(b=>b[0]))-1,Math.min(...picked.map(b=>b[1]))-1,Math.max(...picked.map(b=>b[2]))+1,Math.max(...picked.map(b=>b[3]))+1];
      const existing = result.find(item => Math.min(item.box[2],box[2]) > Math.max(item.box[0],box[0]) && Math.min(item.box[3],box[3]) > Math.max(item.box[1],box[1]));
      if (existing) existing.box = [Math.min(existing.box[0],box[0]),Math.min(existing.box[1],box[1]),Math.max(existing.box[2],box[2]),Math.max(existing.box[3],box[3])];
      else result.push({text,box});
    }
  }
  return result;
}

export function sovereignScreenBoxes(pack, row, country) {
  if (!row.viewport) throw new Error('raster readability requires composed viewport geometry');
  const { origin } = row.viewport;
  const zoom = Number(row.zoom);
  const boxes = [];
  for (const mosaic of pack.mosaics) for (const word of sovereignBoxes(mosaic, country)) {
    const [x1, y1, x2, y2] = word.box;
    const scale = Number.isFinite(zoom) ? (512 * (2 ** zoom)) / (256 * (2 ** mosaic.z)) : row.viewport.scale;
    for (const wrap of row.viewport.worldCopies ? [-1, 0, 1] : [0]) {
      const world = 256 * (2 ** mosaic.z) * wrap;
      boxes.push({
        service: mosaic.service,
        text: word.text,
        scale,
        box: [(x1 + world) * scale + origin.x, y1 * scale + origin.y, (x2 + world) * scale + origin.x, y2 * scale + origin.y],
      });
    }
  }
  return boxes;
}

/** sovereignBoxes grows each glyph by one tile pixel so split tokens merge. That pad is not ink. */
function glyphInk(word) {
  const box = word.box;
  const pad = Number.isFinite(word.scale) && word.scale > 0 ? word.scale : 0;
  return [box[0] + pad, box[1] + pad, box[2] - pad, box[3] - pad];
}

export function readableRasterName(pack, row, country) {
  const { width, height, occlusions } = row.viewport;
  const zoom = Number(row.zoom);
  const boxes = sovereignScreenBoxes(pack, row, country).filter((word) => {
    const ink = glyphInk(word);
    if (!(ink[2] > ink[0] && ink[3] > ink[1])) return false;
    if (ink[0] < 0 || ink[1] < 0 || ink[2] > width || ink[3] > height) return false;
    if (Number.isFinite(zoom) && !countryLabelCountsScreen(ink, zoom)) return false;
    if (letteringOccluded(ink, occlusions || [])) return false;
    return true;
  });
  const unique = [];
  for (const word of boxes) {
    const ink = glyphInk(word);
    if (unique.some((kept) => {
      const other = glyphInk(kept);
      return ink[0] < other[2] && ink[2] > other[0] && ink[1] < other[3] && ink[3] > other[1];
    })) continue;
    unique.push(word);
  }
  return { readable: unique.length > 0, boxes: unique };
}
