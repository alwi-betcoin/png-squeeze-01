// PNG Squeeze — lossless screenshot compressor.
// Reads /input/<id>/image.png (1280x720 RGBA PNGs), writes each one back as the smallest
// lossless PNG it can build: colour-type reduction (palette / grey / grey+alpha / RGB /
// RGBA / tRNS key), per-row filtering chosen by fixed filters, adaptive heuristics and a
// brute-force deflate test per row, all screened by real deflate size, and the stream
// written by whichever is smaller of zlib level 9 and a built-in optimal-parse deflate
// (zopfli-style shortest-path parsing with its own Huffman encoder). Deterministic: every
// choice is a function of the pixels alone, never of the clock.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------- CRC-32 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------- PNG decode (generic: any colour type the contest accepts, any filters) ----------
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}
function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0, height = 0, colourType = 6;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      colourType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: height * (stride + 1) + 1 });
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    else if (ft === 2) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    else if (ft === 3) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    else for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? samples[o + i - bpp] : 0, b = y > 0 ? samples[p + i] : 0, c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
      samples[o + i] = raw[src + i] + paeth(a, b, c);
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = (palette as Uint8Array).length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = (palette as Uint8Array)[e * 3];
      rgba[d + 1] = (palette as Uint8Array)[e * 3 + 1];
      rgba[d + 2] = (palette as Uint8Array)[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------- PNG encode ----------
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}
function pngOf(width: number, height: number, colourType: number, plte: Uint8Array | null, trns: Uint8Array | null, idat: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width); v.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = colourType;
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', ihdr)];
  if (plte !== null) parts.push(chunk('PLTE', plte));
  if (trns !== null) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', idat), chunk('IEND', new Uint8Array(0)));
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// ---------- Image analysis and colour-type forms ----------
type Colour = { rgba: number[]; word: number; count: number };
function wordsOf(rgba: Uint8Array): Uint32Array {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}
function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: Colour[] | null } {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true, grey = true, many = false;
  const counts = new Map<number, number>();
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) as number };
  });
  return { opaque, grey, colours };
}
function transparentKey(rgba: Uint8Array, grey: boolean): number {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return -1;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return -1;
  }
  if (key === -1) return -1;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return -1;
  }
  return key;
}
function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}
type Form = { colourType: number; bpp: number; samples: Uint8Array; plte: Uint8Array | null; trns: Uint8Array | null; overhead: number };
function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): Form {
  const lum = (c: Colour) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0, tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    if (order === 'value') return x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return { colourType: 3, bpp: 1, samples: indices, plte, trns, overhead: 12 + plte.length + (trns === null ? 0 : 12 + trns.length) };
}
function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance', 'value']) forms.push(paletteForm(rgba, colours, order));
    if (!grey) return forms;
  }
  const key = opaque ? -1 : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key >= 0 ? 0 : 4;
    if (key >= 0) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key >= 0 ? 2 : 6;
    if (key >= 0) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = ct === 0 ? 1 : ct === 4 ? 2 : ct === 2 ? 3 : 4;
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, overhead: trns === null ? 0 : 12 + trns.length });
  return forms;
}

// ---------- Filtering ----------
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  else if (type === 2) for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  else if (type === 3) for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  else for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0, b = prev === null ? 0 : prev[i], c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paeth(a, b, c);
  }
}
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) { const v = row[i]; s += v < 128 ? v : 256 - v; }
  return s;
}
// All filtered variants of one form's samples: the five fixed filters and two adaptive
// heuristics chosen in a single sweep (each row's five trial filters are computed once and
// scored by both heuristics). The brute-force variant lives in bruteData below.
type Variant = { choice: string; data: Uint8Array };
function filteredVariants(samples: Uint8Array, width: number, height: number, bpp: number): Variant[] {
  const stride = width * bpp;
  const rowBytes = stride + 1;
  const out: Variant[] = [];
  for (let t = 0; t < 5; t++) {
    const raw = new Uint8Array(height * rowBytes);
    for (let y = 0; y < height; y++) {
      const cur = samples.subarray(y * stride, (y + 1) * stride);
      const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
      raw[y * rowBytes] = t;
      filterRow(t, cur, prev, bpp, raw.subarray(y * rowBytes + 1, y * rowBytes + 1 + stride));
    }
    out.push({ choice: 'fixed' + t, data: raw });
  }
  const adapt: Record<string, Uint8Array> = {
    minsum: new Uint8Array(height * rowBytes),
    pairs: new Uint8Array(height * rowBytes),
  };
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * rowBytes;
    for (let t = 0; t < 5; t++) filterRow(t, cur, prev, bpp, trial[t]);
    const pick = (costs: number[], buf: Uint8Array) => {
      let type = 0, best = Infinity;
      for (let t = 0; t < 5; t++) if (costs[t] < best) { best = costs[t]; type = t; }
      buf[at] = type;
      buf.set(trial[type], at + 1);
    };
    pick(trial.map(signedSum), adapt.minsum);
    const stamp = y * 5 + 1;
    const pc = trial.map((row, t) => {
      let pairs = 0;
      const s = stamp + t;
      for (let i = 1; i < row.length; i++) {
        const pair = (row[i - 1] << 8) | row[i];
        if (seen[pair] !== s) { seen[pair] = s; pairs++; }
      }
      return pairs;
    });
    pick(pc, adapt.pairs);
  }
  out.push({ choice: 'minsum', data: adapt.minsum }, { choice: 'pairs', data: adapt.pairs });
  return out;
}
// The brute-force variant: each row's filter is the one whose trial row deflates smallest
// after the preceding 32 KiB of the output built so far (the reference compressor's method).
function bruteData(samples: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const rowBytes = stride + 1;
  const raw = new Uint8Array(height * rowBytes);
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const rowWithType = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * rowBytes;
    for (let t = 0; t < 5; t++) filterRow(t, cur, prev, bpp, trial[t]);
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      rowWithType[0] = t;
      rowWithType.set(trial[t], 1);
      const z = before.length === 0
        ? deflateSync(rowWithType, { level: 4, memLevel: 9 })
        : deflateSync(rowWithType, { level: 4, memLevel: 9, dictionary: before });
      if (z.length < best) { best = z.length; type = t; }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

// ---------- Compression: screen at level 6, finish with the best of zlib 9 / optimal parse ----------
const SCREEN_OPTS = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
function squeeze(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const forms = formsOf(rgba);
  type Cand = { form: Form; data: Uint8Array; bytes: number };
  const cands: Cand[] = [];
  for (const form of forms) {
    for (const v of filteredVariants(form.samples, width, height, form.bpp)) {
      const z = deflateSync(v.data, SCREEN_OPTS);
      cands.push({ form, data: v.data, bytes: z.length + form.overhead });
    }
  }
  cands.sort((a, b) => a.bytes - b.bytes);
  // Brute-force row choice only for the leading form: it costs five small deflates a row.
  const lead = cands[0];
  const bd = bruteData(lead.form.samples, width, height, lead.form.bpp);
  const bz = deflateSync(bd, SCREEN_OPTS);
  cands.push({ form: lead.form, data: bd, bytes: bz.length + lead.form.overhead });
  cands.sort((a, b) => a.bytes - b.bytes);
  // Finish: zlib level 9 and the optimal-parse deflate on the best variant; zlib 9 also on
  // a runner-up variant when its screen size is within 1.5%. Smallest PNG wins.
  let bestPng: Uint8Array | null = null;
  const consider = (cand: Cand, idat: Uint8Array) => {
    const png = pngOf(width, height, cand.form.colourType, cand.form.plte, cand.form.trns, idat);
    if (bestPng === null || png.length < bestPng.length) bestPng = png;
  };
  const best = cands[0];
  consider(best, deflateSync(best.data, { level: 9, memLevel: 9 }));
  consider(best, deflateOptimal(best.data));
  const seenData = new Set<Uint8Array>([best.data]);
  for (const cand of cands.slice(1)) {
    if (cand.bytes > best.bytes * 1.015 || seenData.has(cand.data)) continue;
    seenData.add(cand.data);
    consider(cand, deflateSync(cand.data, { level: 9, memLevel: 9 }));
    break;
  }
  return bestPng as Uint8Array;
}

// ---------- Optimal-parse deflate (zopfli-style, written for this entry) ----------
// A greedy parse seeds symbol statistics; a shortest-path parse under the bit costs those
// statistics imply then picks, for every position, the cheapest of a literal or a match
// (each match length costed with the smallest distance that reaches it). The token stream
// is written with length-limited Huffman codes (package-merge) in one, two or four dynamic
// blocks, whichever is smallest. All limits are fixed constants: the work depends only on
// the data, never on the clock.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_CODE = new Uint8Array(259);
for (let c = 0; c < 29; c++) {
  const hi = c === 28 ? 258 : LEN_BASE[c + 1] - 1;
  for (let l = LEN_BASE[c]; l <= hi; l++) LEN_CODE[l] = c;
}
const DIST_CODE = new Uint8Array(32769);
for (let c = 0; c < 30; c++) {
  const hi = c === 29 ? 32768 : DIST_BASE[c + 1] - 1;
  for (let d = DIST_BASE[c]; d <= hi; d++) DIST_CODE[d] = c;
}
const CAND_LENS = [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 30, 34, 42, 50, 58, 66, 82, 98, 114, 130, 162, 194, 226, 257, 258];
type PMNode = { w: number; sym: number; l: PMNode | null; r: PMNode | null };
function huffmanLengths(freq: Float64Array, maxLen: number): Uint8Array {
  const n = freq.length;
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  const lengths = new Uint8Array(n);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  syms.sort((a, b) => freq[a] - freq[b] || a - b);
  let list: PMNode[] = syms.map((s) => ({ w: freq[s], sym: s, l: null, r: null }));
  const leaves = list.slice();
  for (let round = 0; round < maxLen - 1; round++) {
    const packed: PMNode[] = [];
    for (let i = 0; i + 1 < list.length; i += 2) packed.push({ w: list[i].w + list[i + 1].w, sym: -1, l: list[i], r: list[i + 1] });
    const merged: PMNode[] = [];
    let a = 0, b = 0;
    while (a < leaves.length || b < packed.length) {
      if (b >= packed.length || (a < leaves.length && leaves[a].w <= packed[b].w)) merged.push(leaves[a++]);
      else merged.push(packed[b++]);
    }
    list = merged;
  }
  const take = 2 * syms.length - 2;
  const count = (node: PMNode) => {
    if (node.sym >= 0) { lengths[node.sym]++; return; }
    count(node.l as PMNode); count(node.r as PMNode);
  };
  for (let i = 0; i < Math.min(take, list.length); i++) count(list[i]);
  return lengths;
}
function canonicalCodes(lengths: Uint8Array): Uint32Array {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const blCount = new Uint32Array(maxLen + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const next = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) { code = (code + blCount[b - 1]) << 1; next[b] = code; }
  const codes = new Uint32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) codes[i] = next[lengths[i]]++;
  return codes;
}
class BitWriter {
  bytes: number[] = [];
  acc = 0;
  nbits = 0;
  bits(value: number, count: number): void {
    this.acc |= value << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) { this.bytes.push(this.acc & 0xff); this.acc >>>= 8; this.nbits -= 8; }
  }
  huff(code: number, len: number): void {
    let rev = 0;
    for (let i = 0; i < len; i++) rev = (rev << 1) | ((code >>> i) & 1);
    this.bits(rev, len);
  }
  finish(): Uint8Array {
    if (this.nbits > 0) this.bytes.push(this.acc & 0xff);
    return Uint8Array.from(this.bytes);
  }
}
function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
const HASH_BITS = 16;
const HASH_SIZE = 1 << HASH_BITS;
function hash3(data: Uint8Array, i: number): number {
  const v = (data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2];
  return ((v * 0x9e3779b1) >>> (32 - HASH_BITS)) & (HASH_SIZE - 1);
}
const _distForLen = new Int32Array(259);
const _touched = new Int32Array(259);
function findMatch(data: Uint8Array, i: number, head: Int32Array, prev: Int32Array, maxChain: number): [number, Int32Array] | null {
  const n = data.length;
  const maxLen = Math.min(258, n - i);
  if (maxLen < 3) return null;
  let cand = head[hash3(data, i)];
  let bestLen = 2;
  let touched = 0;
  const limit = Math.max(0, i - 32768);
  let chain = maxChain;
  while (cand >= limit && chain-- > 0) {
    if (data[cand + bestLen] === data[i + bestLen]) {
      let l = 0;
      while (l < maxLen && data[cand + l] === data[i + l]) l++;
      if (l > bestLen) {
        const dist = i - cand;
        for (let k = bestLen + 1; k <= l; k++) { _distForLen[k] = dist; _touched[touched++] = k; }
        bestLen = l;
        if (l >= maxLen || l >= 64) break;
      }
    }
    cand = prev[cand];
  }
  if (bestLen < 3) return null;
  return [bestLen, _distForLen];
}
type Token = { lit?: number; len?: number; dist?: number };
function greedyParse(data: Uint8Array, maxChain: number): Token[] {
  const n = data.length;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n);
  const tokens: Token[] = [];
  let i = 0;
  const insert = (p: number) => { if (p + 2 < n) { const h = hash3(data, p); prev[p] = head[h]; head[h] = p; } };
  while (i < n) {
    const m = findMatch(data, i, head, prev, maxChain);
    if (m !== null) {
      const mDist = m[1][m[0]];
      insert(i);
      const m2 = i + 1 < n ? findMatch(data, i + 1, head, prev, maxChain) : null;
      if (m2 !== null && m2[0] > m[0]) {
        tokens.push({ lit: data[i] });
        i++;
        continue;
      }
      tokens.push({ len: m[0], dist: mDist });
      for (let p = i + 1; p < i + m[0]; p++) insert(p);
      i += m[0];
    } else {
      tokens.push({ lit: data[i] });
      insert(i);
      i++;
    }
  }
  return tokens;
}
function countsOf(tokens: Token[]): { litFreq: Float64Array; distFreq: Float64Array } {
  const litFreq = new Float64Array(286);
  const distFreq = new Float64Array(30);
  for (const t of tokens) {
    if (t.lit !== undefined) litFreq[t.lit]++;
    else { litFreq[257 + LEN_CODE[t.len as number]]++; distFreq[DIST_CODE[t.dist as number]]++; }
  }
  litFreq[256] = 1;
  return { litFreq, distFreq };
}
function modelOf(litFreq: Float64Array, distFreq: Float64Array): { litCost: Float64Array; lenPart: Float64Array; distPart: Float64Array } {
  const lf = Float64Array.from(litFreq);
  const df = Float64Array.from(distFreq);
  for (let s = 257; s < 286; s++) lf[s] += 1;
  for (let s = 0; s < 30; s++) df[s] += 1;
  const litLen = huffmanLengths(lf, 15);
  const distLen = huffmanLengths(df, 15);
  const litCost = new Float64Array(286);
  for (let s = 0; s < 286; s++) litCost[s] = litLen[s] > 0 ? litLen[s] : 24;
  const distCost = new Float64Array(30);
  for (let s = 0; s < 30; s++) distCost[s] = distLen[s] > 0 ? distLen[s] : 24;
  const lenPart = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenPart[l] = litCost[257 + LEN_CODE[l]] + LEN_EXTRA[LEN_CODE[l]];
  const distPart = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) distPart[d] = distCost[DIST_CODE[d]] + DIST_EXTRA[DIST_CODE[d]];
  return { litCost, lenPart, distPart };
}
function dpParse(data: Uint8Array, model: { litCost: Float64Array; lenPart: Float64Array; distPart: Float64Array }, maxChain: number): Token[] {
  const n = data.length;
  const dp = new Float64Array(n + 1).fill(Infinity);
  const choiceLen = new Uint16Array(n + 1);
  const choiceDist = new Int32Array(n + 1);
  dp[0] = 0;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const base = dp[i];
    if (base < Infinity) {
      const cLit = base + model.litCost[data[i]];
      if (cLit < dp[i + 1]) { dp[i + 1] = cLit; choiceLen[i + 1] = 1; choiceDist[i + 1] = 0; }
      if (i + 2 < n) {
        const m = findMatch(data, i, head, prev, maxChain);
        if (m !== null) {
          const [maxL, distForLen] = m;
          for (const L of CAND_LENS) {
            if (L > maxL) break;
            const dist = distForLen[L];
            if (dist === 0) continue;
            const c = base + model.lenPart[L] + model.distPart[dist];
            if (c < dp[i + L]) { dp[i + L] = c; choiceLen[i + L] = L; choiceDist[i + L] = dist; }
          }
          if (!CAND_LENS.includes(maxL)) {
            const dist = distForLen[maxL];
            const c = base + model.lenPart[maxL] + model.distPart[dist];
            if (c < dp[i + maxL]) { dp[i + maxL] = c; choiceLen[i + maxL] = maxL; choiceDist[i + maxL] = dist; }
          }
        }
      }
    }
    if (i + 2 < n) { const h = hash3(data, i); prev[i] = head[h]; head[h] = i; }
  }
  const tokens: Token[] = [];
  let j = n;
  while (j > 0) {
    const L = choiceLen[j];
    if (L === 1) { tokens.push({ lit: data[j - 1] }); j -= 1; }
    else { tokens.push({ len: L, dist: choiceDist[j] }); j -= L; }
  }
  tokens.reverse();
  return tokens;
}
function encodeBlock(w: BitWriter, tokens: Token[], isFinal: boolean): void {
  const { litFreq, distFreq } = countsOf(tokens);
  let usedDist = 0, lastDist = 0;
  for (let s = 0; s < 30; s++) if (distFreq[s] > 0) { usedDist++; lastDist = s; }
  if (usedDist === 1) distFreq[lastDist === 0 ? 1 : 0] = 1;
  if (usedDist === 0) { distFreq[0] = 1; distFreq[1] = 1; }
  const litLen = huffmanLengths(litFreq, 15);
  const distLen = huffmanLengths(distFreq, 15);
  const litCodes = canonicalCodes(litLen);
  const distCodes = canonicalCodes(distLen);
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const seq: number[] = [];
  for (let s = 0; s < hlit; s++) seq.push(litLen[s]);
  for (let s = 0; s < hdist; s++) seq.push(distLen[s]);
  const rle: { sym: number; extra: number; ebits: number }[] = [];
  let i = 0;
  while (i < seq.length) {
    const v = seq[i];
    let run = 1;
    while (i + run < seq.length && seq[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const take = Math.min(138, r); rle.push({ sym: 18, extra: take - 11, ebits: 7 }); r -= take; }
      if (r >= 3) { rle.push({ sym: 17, extra: r - 3, ebits: 3 }); r = 0; }
      while (r-- > 0) rle.push({ sym: 0, extra: 0, ebits: 0 });
    } else {
      rle.push({ sym: v, extra: 0, ebits: 0 });
      let r = run - 1;
      while (r >= 3) { const take = Math.min(6, r); rle.push({ sym: 16, extra: take - 3, ebits: 2 }); r -= take; }
      while (r-- > 0) rle.push({ sym: v, extra: 0, ebits: 0 });
    }
    i += run;
  }
  const clFreq = new Float64Array(19);
  for (const t of rle) clFreq[t.sym]++;
  let usedCl = 0, lastCl = 0;
  for (let s = 0; s < 19; s++) if (clFreq[s] > 0) { usedCl++; lastCl = s; }
  if (usedCl === 1) clFreq[lastCl === 0 ? 1 : 0] = 1;
  const clLen = huffmanLengths(clFreq, 7);
  const clCodes = canonicalCodes(clLen);
  const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let hclen = 19;
  while (hclen > 4 && clLen[ORDER[hclen - 1]] === 0) hclen--;
  w.bits(isFinal ? 1 : 0, 1);
  w.bits(2, 2);
  w.bits(hlit - 257, 5);
  w.bits(hdist - 1, 5);
  w.bits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.bits(clLen[ORDER[k]], 3);
  for (const t of rle) {
    w.huff(clCodes[t.sym], clLen[t.sym]);
    if (t.ebits > 0) w.bits(t.extra, t.ebits);
  }
  for (const t of tokens) {
    if (t.lit !== undefined) w.huff(litCodes[t.lit], litLen[t.lit]);
    else {
      const lc = LEN_CODE[t.len as number];
      w.huff(litCodes[257 + lc], litLen[257 + lc]);
      if (LEN_EXTRA[lc] > 0) w.bits((t.len as number) - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dc = DIST_CODE[t.dist as number];
      w.huff(distCodes[dc], distLen[dc]);
      if (DIST_EXTRA[dc] > 0) w.bits((t.dist as number) - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
  w.huff(litCodes[256], litLen[256]);
}
function encodeZlib(data: Uint8Array, tokens: Token[], numBlocks: number): Uint8Array {
  const w = new BitWriter();
  if (numBlocks <= 1) {
    encodeBlock(w, tokens, true);
  } else {
    const total = data.length;
    let start = 0, pos = 0, block = 0;
    for (let ti = 0; ti < tokens.length; ti++) {
      pos += tokens[ti].lit !== undefined ? 1 : (tokens[ti].len as number);
      const boundary = Math.floor(((block + 1) * total) / numBlocks);
      if (pos >= boundary && block < numBlocks - 1) {
        encodeBlock(w, tokens.slice(start, ti + 1), false);
        start = ti + 1;
        block++;
      }
    }
    encodeBlock(w, tokens.slice(start), true);
  }
  const body = w.finish();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler32(data));
  return out;
}
function deflateOptimal(data: Uint8Array): Uint8Array {
  let tokens = greedyParse(data, 8);
  const { litFreq, distFreq } = countsOf(tokens);
  // The chain limit steps down for the largest inputs: a fixed, data-size-only rule that
  // bounds the total work of a set (never the clock), keeping the run well inside its wall.
  const chain = data.length <= 1500000 ? 64 : 48;
  tokens = dpParse(data, modelOf(litFreq, distFreq), chain);
  let best: Uint8Array | null = null;
  for (const nb of [1, 2, 4]) {
    const z = encodeZlib(data, tokens, nb);
    if (best === null || z.length < best.length) best = z;
  }
  return best as Uint8Array;
}

// ---------- Main ----------
for (const id of readdirSync(I).sort()) {
  const img = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  const out = squeeze(img.rgba, img.width, img.height);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), out);
}
