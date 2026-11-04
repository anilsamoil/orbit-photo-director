import { inflateSync } from 'node:zlib';

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
