// Generates the raster icons Chrome needs (MV3 action icons cannot be SVG).
//
// The icon is the character's default (greet) portrait, downscaled from
// assets/emotions/greet-128.png, so the toolbar button and the floating ball
// never drift apart. Re-run this after replacing the emotion art.
//
// Usage: node tools/make-icons.mjs
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'assets', 'emotions', 'greet-128.png');
const outDir = join(root, 'icons');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Minimal PNG reader: 8-bit RGBA, non-interlaced. */
function decodePng(file) {
  const buf = readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error('需要 8 位 RGBA PNG');
      if (data[12] !== 0) throw new Error('不支持隔行扫描');
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const cur = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const a = i >= 4 ? cur[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      if (filter === 1) cur[i] = (cur[i] + a) & 0xff;
      else if (filter === 2) cur[i] = (cur[i] + b) & 0xff;
      else if (filter === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        cur[i] = (cur[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      } else if (filter !== 0) throw new Error(`未知的行过滤器 ${filter}`);
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, data: out };
}

/**
 * Area-average downscale, weighted by alpha so transparent edges do not pull
 * dark background colour into the visible pixels.
 */
function resample(img, size) {
  const { width: sw, height: sh, data } = img;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const y0 = (y * sh) / size;
    const y1 = ((y + 1) * sh) / size;
    for (let x = 0; x < size; x += 1) {
      const x0 = (x * sw) / size;
      const x1 = ((x + 1) * sw) / size;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          if (wx <= 0) continue;
          const weight = wx * wy;
          const i = (sy * sw + sx) * 4;
          const alpha = data[i + 3] / 255;
          r += data[i] * alpha * weight;
          g += data[i + 1] * alpha * weight;
          b += data[i + 2] * alpha * weight;
          a += alpha * weight;
          area += weight;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = area > 0 ? Math.round((a / area) * 255) : 0;
    }
  }
  return out;
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const art = decodePng(source);
console.log(`源图 ${source} ${art.width}x${art.height}`);
for (const size of [16, 48, 128]) {
  const png = encodePng(size, resample(art, size));
  writeFileSync(join(outDir, `icon${size}.png`), png);
  console.log(`icons/icon${size}.png ${png.length} bytes`);
}
