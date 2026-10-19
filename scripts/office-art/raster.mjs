// Tiny pixel-art raster kit for the Office art generator: layers that hold a
// palette ramp and a tone per pixel (not RGB), polygon fills on pixel centres,
// selective outlines, and a dependency-free PNG encoder (node:zlib only), so
// the same input always produces byte-identical PNGs.
import { deflateSync } from 'node:zlib';

/** Tone indices into a 5-step ramp: highlight, light, base, shade, dark (outline). */
export const HI = 0;
export const LIGHT = 1;
export const BASE = 2;
export const SHADE = 3;
export const DARK = 4;

export class Layer {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.r = new Array(w * h).fill(null); // ramp name per pixel, null = empty
    this.t = new Uint8Array(w * h); // tone per pixel
  }

  inside(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  set(x, y, ramp, tone) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (!this.inside(x, y)) return;
    const k = y * this.w + x;
    this.r[k] = ramp;
    this.t[k] = tone;
  }

  clear(x, y) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (!this.inside(x, y)) return;
    this.r[y * this.w + x] = null;
  }

  ramp(x, y) {
    return this.inside(x, y) ? this.r[y * this.w + x] : null;
  }

  tone(x, y) {
    return this.inside(x, y) ? this.t[y * this.w + x] : 0;
  }

  filled(x, y) {
    return this.ramp(x, y) !== null;
  }

  clone() {
    const c = new Layer(this.w, this.h);
    c.r = this.r.slice();
    c.t = this.t.slice();
    return c;
  }
}

/** Fill a polygon (screen-space vertices) by testing each pixel centre. */
export function fillPoly(layer, pts, ramp, tone) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(layer.w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(layer.h - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (pointInPoly(x + 0.5, y + 0.5, pts)) layer.set(x, y, ramp, tone);
    }
  }
}

function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function rect(layer, x, y, w, h, ramp, tone) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) layer.set(xx, yy, ramp, tone);
}

/** Bresenham line, one pixel wide. */
export function line(layer, x0, y0, x1, y1, ramp, tone) {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    layer.set(x0, y0, ramp, tone);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/**
 * Selective outline: every empty pixel 4-adjacent to the shape takes the
 * dark tone of the darkest neighbouring ramp. Returns a new layer.
 */
export function outline(layer, ramps, { diagonal = false } = {}) {
  const out = layer.clone();
  const dirs = [
    [0, -1],
    [-1, 0],
    [1, 0],
    [0, 1],
  ];
  if (diagonal) dirs.push([-1, -1], [1, -1], [-1, 1], [1, 1]);
  for (let y = 0; y < layer.h; y++) {
    for (let x = 0; x < layer.w; x++) {
      if (layer.filled(x, y)) continue;
      let best = null;
      let bestLum = Infinity;
      for (const [dx, dy] of dirs) {
        const r = layer.ramp(x + dx, y + dy);
        if (!r) continue;
        const lum = luminance(ramps[r][DARK]);
        if (lum < bestLum) {
          bestLum = lum;
          best = r;
        }
      }
      if (best) out.set(x, y, best, DARK);
    }
  }
  return out;
}

/** Draw `src` over `dst` with its top-left at (dx, dy). */
export function compose(dst, src, dx = 0, dy = 0) {
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const r = src.ramp(x, y);
      if (r) dst.set(x + dx, y + dy, r, src.tone(x, y));
    }
  }
  return dst;
}

/** Copy a region out of a layer. */
export function crop(src, x, y, w, h) {
  const c = new Layer(w, h);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const r = src.ramp(x + xx, y + yy);
    if (r) c.set(xx, yy, r, src.tone(x + xx, y + yy));
  }
  return c;
}

/** Tight bounding box of the filled pixels. */
export function bounds(layer) {
  let x0 = layer.w;
  let y0 = layer.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < layer.h; y++) for (let x = 0; x < layer.w; x++) {
    if (!layer.filled(x, y)) continue;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Resolve a layer to RGBA bytes. */
export function toRgba(layer, ramps) {
  const buf = Buffer.alloc(layer.w * layer.h * 4);
  for (let k = 0; k < layer.w * layer.h; k++) {
    const r = layer.r[k];
    if (!r) continue;
    const ramp = ramps[r];
    if (!ramp) throw new Error(`unknown ramp ${r}`);
    const [R, G, B] = hexToRgb(ramp[layer.t[k]]);
    buf[k * 4] = R;
    buf[k * 4 + 1] = G;
    buf[k * 4 + 2] = B;
    buf[k * 4 + 3] = 255;
  }
  return buf;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode RGBA bytes as a PNG (8-bit RGBA, no filter, fixed zlib level). */
export function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Nearest-neighbour upscale of RGBA bytes (for previews only). */
export function scaleRgba(w, h, rgba, s) {
  const out = Buffer.alloc(w * s * h * s * 4);
  for (let y = 0; y < h * s; y++) for (let x = 0; x < w * s; x++) {
    const si = (Math.floor(y / s) * w + Math.floor(x / s)) * 4;
    rgba.copy(out, (y * w * s + x) * 4, si, si + 4);
  }
  return out;
}
