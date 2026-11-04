import { inflateSync } from 'node:zlib';

/** Decode an 8-bit RGB or RGBA PNG, including a data URL, into straight pixels. */
export function decodePng(input) {
  const text = typeof input === 'string' ? input : '';
  const raw = text.startsWith('data:')
    ? Buffer.from(text.slice(text.indexOf(',') + 1), 'base64')
    : Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (raw.length < 8 || raw[0] !== 137) return null;
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat = [];
  while (offset + 8 <= raw.length) {
    const length = raw.readUInt32BE(offset);
    const type = raw.toString('ascii', offset + 4, offset + 8);
    const data = raw.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!width || !height || (colorType !== 2 && colorType !== 6)) return null;
  const channels = colorType === 2 ? 3 : 4;
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source];
    source += 1;
    const row = inflated.subarray(source, source + stride);
    source += stride;
    const prior = y === 0 ? null : out.subarray((y - 1) * width * 4, y * width * 4);
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        const index = x * channels + c;
        const left = x === 0 ? 0 : row[index - channels];
        const up = prior ? prior[x * 4 + c] : 0;
        const upLeft = prior && x > 0 ? prior[(x - 1) * 4 + c] : 0;
        let value = row[index];
        if (filter === 1) value = (value + left) & 255;
        else if (filter === 2) value = (value + up) & 255;
        else if (filter === 3) value = (value + Math.floor((left + up) / 2)) & 255;
        else if (filter === 4) {
          const guess = left + up - upLeft;
          const dl = Math.abs(guess - left);
          const du = Math.abs(guess - up);
          const dlu = Math.abs(guess - upLeft);
          const paeth = dl <= du && dl <= dlu ? left : du <= dlu ? up : upLeft;
          value = (value + paeth) & 255;
        }
        row[index] = value;
        out[(y * width + x) * 4 + c] = value;
      }
      if (channels === 3) out[(y * width + x) * 4 + 3] = 255;
    }
  }
  return { width, height, data: out };
}

function luma(pixels, index) {
  return 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
}

function boxBlur(source, width, height, radius) {
  const horizontal = new Float32Array(source.length);
  const out = new Float32Array(source.length);
  const window = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) sum += source[y * width + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x += 1) {
      horizontal[y * width + x] = sum / window;
      const leave = source[y * width + Math.max(0, x - radius)];
      const enter = source[y * width + Math.min(width - 1, x + radius + 1)];
      sum += enter - leave;
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / window;
      const leave = horizontal[Math.max(0, y - radius) * width + x];
      const enter = horizontal[Math.min(height - 1, y + radius + 1) * width + x];
      sum += enter - leave;
    }
  }
  return out;
}

function components(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const found = [];
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    seen[start] = 1;
    let minX = start % width;
    let maxX = minX;
    let minY = Math.floor(start / width);
    let maxY = minY;
    let area = 0;
    while (head < tail) {
      const id = queue[head];
      head += 1;
      area += 1;
      const x = id % width;
      const y = (id - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (seen[next] || !mask[next]) continue;
          seen[next] = 1;
          queue[tail] = next;
          tail += 1;
        }
      }
    }
    found.push({ minX, minY, maxX, maxY, area, width: maxX - minX + 1, height: maxY - minY + 1 });
  }
  return found;
}


/**
 * Complete country names in a plan screenshot, including names rotated along a border.
 * A border stroke is one run. A name is four or more separated letter runs on one line.
 * City labels sit on a round dot and do not count. A blank tile has no runs.
 */
export function rotatedNameSpans(pixels, width, height) {
  if (!pixels || !width || !height) return [];
  const tone = new Float32Array(width * height);
  for (let p = 0, i = 0; p < width * height; p += 1, i += 4) tone[p] = luma(pixels, i);
  const blurred = boxBlur(tone, width, height, 3);
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < tone.length; p += 1) {
    const contrast = tone[p] - blurred[p];
    if (contrast >= 14 && tone[p] > 60 && tone[p] < 250) mask[p] = 1;
  }
  const parts = components(mask, width, height);
  const letters = [];
  const dots = [];
  const bulky = [];
  for (const part of parts) {
    const short = Math.min(part.width, part.height);
    const long = Math.max(part.width, part.height);
    const fill = part.area / (part.width * part.height);
    if (long > 48 && short <= 7) {
      bulky.push(part);
      continue;
    }
    if (short >= 6 && long <= 14 && long / short < 1.35 && fill >= 0.55 && part.area >= 24) {
      dots.push({ x: (part.minX + part.maxX) / 2, y: (part.minY + part.maxY) / 2 });
      continue;
    }
    if (part.area < 12 || short < 3 || long > 40) {
      if (long > 40) bulky.push(part);
      continue;
    }
    letters.push({
      x: (part.minX + part.maxX) / 2,
      y: (part.minY + part.maxY) / 2,
      size: long,
    });
  }
  for (const part of bulky) {
    const subWidth = part.width;
    const subHeight = part.height;
    const sub = new Uint8Array(subWidth * subHeight);
    for (let y = part.minY; y <= part.maxY; y += 1) {
      for (let x = part.minX; x <= part.maxX; x += 1) {
        const id = y * width + x;
        if (mask[id] && tone[id] < 210) sub[(y - part.minY) * subWidth + (x - part.minX)] = 1;
      }
    }
    for (const bit of components(sub, subWidth, subHeight)) {
      const short = Math.min(bit.width, bit.height);
      const long = Math.max(bit.width, bit.height);
      if (bit.area < 8 || short < 2 || long > 36) continue;
      letters.push({
        x: part.minX + (bit.minX + bit.maxX) / 2,
        y: part.minY + (bit.minY + bit.maxY) / 2,
        size: long,
      });
    }
  }
  const parent = letters.map((_, index) => index);
  const find = (index) => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]];
      cursor = parent[cursor];
    }
    return cursor;
  };
  for (let left = 0; left < letters.length; left += 1) {
    for (let right = left + 1; right < letters.length; right += 1) {
      const dx = letters[left].x - letters[right].x;
      const dy = letters[left].y - letters[right].y;
      const reach = 2.4 * Math.max(letters[left].size, letters[right].size);
      const similar = Math.max(letters[left].size, letters[right].size) < 2.3 * Math.min(letters[left].size, letters[right].size);
      if (similar && dx * dx + dy * dy < reach * reach) parent[find(right)] = find(left);
    }
  }
  const groups = new Map();
  letters.forEach((letter, index) => {
    const key = find(index);
    const group = groups.get(key) || [];
    group.push(letter);
    groups.set(key, group);
  });
  const spans = [];
  for (const group of groups.values()) {
    if (group.length < 4) continue;
    const sizes = group.map((letter) => letter.size).sort((a, b) => a - b);
    if (sizes[sizes.length - 1] > 2.5 * sizes[0]) continue;
    const xs = group.map((letter) => letter.x);
    const ys = group.map((letter) => letter.y);
    const cx = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const cy = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    if (span < sizes[Math.floor(sizes.length / 2)] * 2.2) continue;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    if (minX < 8 || minY < 8 || maxX > width - 9 || maxY > height - 9) continue;
    const nearDot = dots.some((dot) => {
      const inside = dot.x >= minX - 6 && dot.x <= maxX + 6 && dot.y >= minY - 6 && dot.y <= maxY + 6;
      if (inside) return false;
      return (dot.x - cx) ** 2 + (dot.y - cy) ** 2 < 96 ** 2;
    });
    if (nearDot) continue;
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    spans.push({
      left: Math.min(...xs),
      top: Math.min(...ys),
      right: Math.max(...xs),
      bottom: Math.max(...ys),
      letters: group.length,
      size: sizes[Math.floor(sizes.length / 2)],
      angle: Math.abs(Math.atan2(spanY, spanX) * 180 / Math.PI),
    });
  }
  return { spans, dots, letters, bulky };
}

/** A painted plan has label ink. A transparent tile does not. */
export function hasLabelInk(pixels, width, height) {
  if (!pixels || !width || !height) return false;
  let hits = 0;
  const step = Math.max(1, Math.floor((width * height) / 20000));
  for (let p = 0; p < width * height; p += step) {
    const index = p * 4;
    const tone = 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
    if (tone > 160) hits += 1;
    if (hits >= 12) return true;
  }
  return false;
}

/** Bright strokes sitting just outside a label mask are remnant halos, not land. */
export function peekingGlyphInk(pixels, width, height, masks) {
  if (!pixels || !width || !masks || masks.length === 0) return false;
  let hits = 0;
  for (const mask of masks) {
    const left = Math.max(0, Math.floor(mask.left) - 6);
    const top = Math.max(0, Math.floor(mask.top) - 6);
    const right = Math.min(width - 1, Math.ceil(mask.right) + 6);
    const bottom = Math.min(height - 1, Math.ceil(mask.bottom) + 6);
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const inside = x >= mask.left && x <= mask.right && y >= mask.top && y <= mask.bottom;
        if (inside) continue;
        const near = x >= mask.left - 6 && x <= mask.right + 6 && y >= mask.top - 6 && y <= mask.bottom + 6;
        if (!near) continue;
        const index = (y * width + x) * 4;
        const tone = 0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2];
        if (tone > 150) hits += 1;
      }
    }
  }
  return hits >= 8;
}

function dedupedLetters(letters) {
  const uniq = [];
  for (const letter of letters || []) {
    if (uniq.some((kept) => (kept.x - letter.x) ** 2 + (kept.y - letter.y) ** 2 < 9)) continue;
    uniq.push(letter);
  }
  return uniq;
}

function neutralInk(pixels, width, height, letter) {
  const x = Math.round(letter.x);
  const y = Math.round(letter.y);
  let best = null;
  let score = -1;
  for (let dy = -5; dy <= 5; dy += 1) {
    for (let dx = -5; dx <= 5; dx += 1) {
      const column = x + dx;
      const row = y + dy;
      if (column < 0 || row < 0 || column >= width || row >= height) continue;
      const index = (row * width + column) * 4;
      const sum = pixels[index] + pixels[index + 1] + pixels[index + 2];
      if (sum > score) {
        score = sum;
        best = [pixels[index], pixels[index + 1], pixels[index + 2]];
      }
    }
  }
  return !!best && best[0] > 160 && best[0] - best[2] < 20 && best[1] - best[2] < 16;
}

function parallelLines(group) {
  if (group.length < 4) return [];
  const cx = group.reduce((sum, letter) => sum + letter.x, 0) / group.length;
  const cy = group.reduce((sum, letter) => sum + letter.y, 0) / group.length;
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (const letter of group) {
    const dx = letter.x - cx;
    const dy = letter.y - cy;
    xx += dx * dx;
    yy += dy * dy;
    xy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);
  const placed = group.map((letter) => ({
    letter,
    side: (letter.x - cx) * -dirY + (letter.y - cy) * dirX,
  }));
  placed.sort((left, right) => left.side - right.side);
  const lines = [];
  for (const item of placed) {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(item.side - last[0].side) > Math.max(4, item.letter.size * 0.8)) lines.push([item]);
    else last.push(item);
  }
  return lines.map((line) => line.map((item) => item.letter));
}

/** Names of one country in a screenshot. Rotated border lettering counts. Scattered bright pixels do not. */
function covered(letter, rects) {
  return (rects || []).some((rect) => letter.x >= rect.left && letter.x < rect.right && letter.y >= rect.top && letter.y < rect.bottom);
}

function mergeBoxes(boxes) {
  const open = boxes.map((box) => box.slice());
  let changed = true;
  while (changed) {
    changed = false;
    for (let left = 0; left < open.length; left += 1) {
      for (let right = left + 1; right < open.length; right += 1) {
        const a = open[left];
        const b = open[right];
        if (!(a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1])) continue;
        open[left] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
        open.splice(right, 1);
        changed = true;
        break;
      }
      if (changed) break;
    }
  }
  return open;
}

export function countryGlyphBoxes(pixels, width, height, country, options = {}) {
  const found = rotatedNameSpans(pixels, width, height);
  const letters = dedupedLetters(Array.isArray(found) ? [] : found.letters).filter((letter) => neutralInk(pixels, width, height, letter) && !covered(letter, options.ignoreRects));
  const nameLength = String(country || '').replace(/[^a-z]/gi, '').length;
  const parent = letters.map((_, index) => index);
  const find = (index) => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]];
      cursor = parent[cursor];
    }
    return cursor;
  };
  for (let left = 0; left < letters.length; left += 1) {
    for (let right = left + 1; right < letters.length; right += 1) {
      const dist = Math.hypot(letters[left].x - letters[right].x, letters[left].y - letters[right].y);
      const reach = 2.6 * Math.max(letters[left].size, letters[right].size);
      if (dist > 1 && dist < reach) parent[find(right)] = find(left);
    }
  }
  const groups = new Map();
  letters.forEach((letter, index) => {
    const key = find(index);
    const group = groups.get(key) || [];
    group.push(letter);
    groups.set(key, group);
  });
  const boxes = [];
  for (const group of groups.values()) {
    for (const line of parallelLines(group)) {
      if (line.length < nameLength - 1 || line.length > nameLength + 1) continue;
      const xs = line.map((letter) => letter.x);
      const ys = line.map((letter) => letter.y);
      const length = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      const sizes = line.map((letter) => letter.size).sort((left, right) => left - right);
      const size = sizes[Math.floor(sizes.length / 2)];
      if (size < 5 || size > 20 || length < 18 || length > 140) continue;
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanY = Math.max(...ys) - Math.min(...ys);
      const angle = Math.abs(Math.atan2(spanY, spanX) * 180 / Math.PI);
      if (angle < 12 && line.length !== nameLength && Math.abs(line.length - nameLength) > 1) continue;
      boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
  }
  return mergeBoxes(boxes);
}

export function countCountryGlyphs(pixels, width, height, country, options = {}) {
  return countryGlyphBoxes(pixels, width, height, country, options).length;
}

/** How many complete country names the screenshot paints. */
export function countRotatedNames(pixels, width, height) {
  const found = rotatedNameSpans(pixels, width, height);
  return Array.isArray(found) ? found.length : found.spans.length;
}
