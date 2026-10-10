import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./raster-ocr.py', import.meta.url));
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

export function checkRasterOcr() {
  const python = ocrPython();
  const probe = spawnSync(python, [helper, '--doctor'], { encoding: 'utf8', timeout: 100000, maxBuffer: 1024 * 1024 });
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

export function ocrRasterTile(tiles) {
  rasterOcrStats.calls += 1;
  const normalized = Buffer.isBuffer(tiles) ? [{ x: 0, y: 0, bytes: tiles }] : tiles;
  const input = JSON.stringify({ tiles: normalized.map(tile => ({ ...tile, bytes: tile.bytes.toString('base64') })) });
  const result = spawnSync(ocrPython(), [helper], { input, encoding: 'utf8', timeout: 100000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`raster tile OCR failed: ${(result.stderr || result.error || '').toString().slice(0, 1000)}`);
  return JSON.parse(result.stdout);
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

export function readableRasterName(pack, row, country) {
  if (!row.viewport) throw new Error('raster readability requires composed viewport geometry');
  const { width, height, scale, origin, occlusions } = row.viewport;
  const boxes = [];
  for (const mosaic of pack.mosaics) for (const word of sovereignBoxes(mosaic,country)) {
    const [x1, y1, x2, y2] = word.box;
    for (const wrap of row.viewport.worldCopies ? [-1, 0, 1] : [0]) {
      const world = 256 * (2 ** mosaic.z) * wrap;
      const box = [(x1+world)*scale+origin.x, y1*scale+origin.y, (x2+world)*scale+origin.x, y2*scale+origin.y];
      if (box[0] < 0 || box[1] < 0 || box[2] > width || box[3] > height) continue;
      if ((occlusions || []).some(rect => box[0] < rect[2] && box[2] > rect[0] && box[1] < rect[3] && box[3] > rect[1])) continue;
      boxes.push({ service: mosaic.service, text: word.text, box });
    }
  }
  return { readable: boxes.length > 0, boxes };
}
