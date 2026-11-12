import { rgbToOklab } from './color';

/**
 * Marks painted over a photo before it is converted. Every pixel of the label map holds one value:
 * NONE (convert normally), REMOVE (leave as empty fabric), DETAIL (protect from simplifying),
 * FLAT0 up to CARTOON0, where each distinct value is one area that becomes a single solid color,
 * or CARTOON0 and up, where each distinct value is one area redrawn in a few flat tones of its own.
 */
export const NONE = 0, REMOVE = 1, DETAIL = 2, FLAT0 = 3, CARTOON0 = 128;

export interface Crop { x: number; y: number; w: number; h: number }
export interface LabelMap { w: number; h: number; data: Uint8Array }

/** The cropped photo at label-map resolution, as pixels to show and as Oklab for comparing colors. */
export interface Base {
  image: ImageData;
  L: Float32Array;
  A: Float32Array;
  B: Float32Array;
}

const LONG_SIDE = 512;

export function labelSize(aspect: number): [number, number] {
  return aspect >= 1
    ? [LONG_SIDE, Math.max(1, Math.round(LONG_SIDE / aspect))]
    : [Math.max(1, Math.round(LONG_SIDE * aspect)), LONG_SIDE];
}

export function makeLabels(aspect: number): LabelMap {
  const [w, h] = labelSize(aspect);
  return { w, h, data: new Uint8Array(w * h) };
}

/** Carries existing marks over when the crop changes, so adjusting the crop doesn't throw work away. */
export function remapLabels(old: LabelMap, from: Crop, to: Crop): LabelMap {
  const out = makeLabels(to.w / to.h);
  for (let y = 0; y < out.h; y++) {
    const iy = to.y + ((y + 0.5) / out.h) * to.h;
    const oy = Math.floor(((iy - from.y) / from.h) * old.h);
    if (oy < 0 || oy >= old.h) continue;
    for (let x = 0; x < out.w; x++) {
      const ix = to.x + ((x + 0.5) / out.w) * to.w;
      const ox = Math.floor(((ix - from.x) / from.w) * old.w);
      if (ox >= 0 && ox < old.w) out.data[y * out.w + x] = old.data[oy * old.w + ox];
    }
  }
  return out;
}

export function makeBase(img: HTMLImageElement, crop: Crop, w: number, h: number): Base {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
  const image = g.getImageData(0, 0, w, h);
  const n = w * h, d = image.data;
  const base: Base = { image, L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const lab = rgbToOklab(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    base.L[i] = lab[0]; base.A[i] = lab[1]; base.B[i] = lab[2];
  }
  return base;
}

export function nextFlatId(m: LabelMap): number {
  const used = new Uint8Array(256);
  for (let i = 0; i < m.data.length; i++) used[m.data[i]] = 1;
  for (let id = FLAT0; id < CARTOON0; id++) if (!used[id]) return id;
  return CARTOON0 - 1;
}

/** Every area id in use, in order. */
export function areaIds(m: LabelMap): number[] {
  const used = new Uint8Array(256);
  for (let i = 0; i < m.data.length; i++) used[m.data[i]] = 1;
  const out: number[] = [];
  for (let id = FLAT0; id < 256; id++) if (used[id]) out.push(id);
  return out;
}

export function nextCartoonId(m: LabelMap): number {
  const used = new Uint8Array(256);
  for (let i = 0; i < m.data.length; i++) used[m.data[i]] = 1;
  for (let id = CARTOON0; id < 256; id++) if (!used[id]) return id;
  return 255;
}

export function stamp(m: LabelMap, cx: number, cy: number, r: number, label: number): void {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(m.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(m.h - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) m.data[y * m.w + x] = label;
    }
  }
}

export function stampLine(m: LabelMap, x0: number, y0: number, x1: number, y1: number, r: number, label: number): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(1, r / 2)));
  for (let i = 1; i <= steps; i++) stamp(m, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, r, label);
}

/** Marks everything inside a hand-drawn outline. */
export function fillPolygon(m: LabelMap, pts: [number, number][], label: number): void {
  const c = document.createElement('canvas');
  c.width = m.w;
  c.height = m.h;
  const g = c.getContext('2d')!;
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fill();
  const d = g.getImageData(0, 0, m.w, m.h).data;
  for (let i = 0; i < m.data.length; i++) if (d[i * 4 + 3] > 127) m.data[i] = label;
}

/** Magic wand: marks the connected area whose color is within `tol` (Oklab distance) of the clicked spot. */
export function wand(m: LabelMap, base: Base, x: number, y: number, tol: number, label: number): void {
  const { w, h } = m, { L, A, B } = base;
  x = Math.min(w - 1, Math.max(0, Math.floor(x)));
  y = Math.min(h - 1, Math.max(0, Math.floor(y)));
  // Average a small patch so one odd pixel under the cursor doesn't decide the whole selection.
  let sl = 0, sa = 0, sb = 0, n = 0;
  for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) {
    for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) {
      const i = yy * w + xx;
      sl += L[i]; sa += A[i]; sb += B[i]; n++;
    }
  }
  sl /= n; sa /= n; sb /= n;
  const t2 = tol * tol;
  const ok = (i: number) => (L[i] - sl) ** 2 + (A[i] - sa) ** 2 + (B[i] - sb) ** 2 <= t2;
  const seen = new Uint8Array(w * h);
  const stack = [y * w + x];
  seen[y * w + x] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    m.data[i] = label;
    const cx = i % w;
    const tryPush = (j: number) => { if (!seen[j] && ok(j)) { seen[j] = 1; stack.push(j); } };
    if (cx > 0) tryPush(i - 1);
    if (cx < w - 1) tryPush(i + 1);
    if (i >= w) tryPush(i - w);
    if (i < w * (h - 1)) tryPush(i + w);
  }
}

export function fillUnmarked(m: LabelMap, label: number): void {
  for (let i = 0; i < m.data.length; i++) if (m.data[i] === NONE) m.data[i] = label;
}

/** The tint used to show one area, as [r, g, b]. Each area id gets its own hue. */
export function areaTint(label: number): [number, number, number] {
  const hue = ((label - FLAT0) * 137.5 + 300) % 360;
  const f = (n: number) => { const t = (n + hue / 30) % 12; return 255 * (0.6 - 0.4 * Math.max(-1, Math.min(t - 3, 9 - t, 1))); };
  return [f(0), f(8), f(4)];
}

/**
 * Draws the photo with its marks: removed parts as a checkerboard and each area in its own tint.
 * With `shapes`, the outlines of the detected shapes are drawn faintly and the one under the cursor is lit up.
 * With `sel`, the current selection is washed blue with a white edge.
 */
export function compose(base: Base, m: LabelMap, out: ImageData, shapes?: Shapes | null, hover = -1, sel?: Uint8Array | null): void {
  const src = base.image.data, dst = out.data, n = m.w * m.h;
  const tints = new Map<number, [number, number, number]>();
  for (let i = 0; i < n; i++) {
    const l = m.data[i], o = i * 4;
    let r = src[o], g = src[o + 1], b = src[o + 2];
    // Transparent parts of the picture have nothing to stitch, so they look removed too.
    if (l === REMOVE || src[o + 3] < 128) {
      const x = i % m.w, y = (i / m.w) | 0;
      const v = ((x >> 3) + (y >> 3)) & 1 ? 236 : 204;
      r = r * 0.12 + v * 0.88; g = g * 0.12 + v * 0.88; b = b * 0.12 + v * 0.88;
    } else if (l >= DETAIL) {
      let t = tints.get(l);
      if (!t) tints.set(l, (t = areaTint(l)));
      r = r * 0.82 + t[0] * 0.18; g = g * 0.82 + t[1] * 0.18; b = b * 0.82 + t[2] * 0.18;
    }
    if (shapes) {
      if (shapes.id[i] === hover) { r = r * 0.6 + 102; g = g * 0.6 + 102; b = b * 0.6 + 102; }
      else if (shapes.edge[i] && l !== REMOVE) { r = r * 0.7 + 76; g = g * 0.7 + 76; b = b * 0.7 + 76; }
    }
    if (sel && sel[i]) {
      // The current selection: a blue wash, with a bright line where it ends.
      const x = i % m.w;
      const rim = (x > 0 && !sel[i - 1]) || (x < m.w - 1 && !sel[i + 1]) || (i >= m.w && !sel[i - m.w]) || (i < n - m.w && !sel[i + m.w]);
      if (rim) { r = 255; g = 255; b = 255; }
      else { r = r * 0.55 + 20; g = g * 0.55 + 70; b = b * 0.55 + 115; }
    }
    dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; dst[o + 3] = 255;
  }
}

// ---- Softened colors ----------------------------------------------------

const softCache = new WeakMap<Base, { L: Float32Array; A: Float32Array; B: Float32Array }>();

/** A slightly blurred copy of the photo's colors, so texture (carpet, fur) doesn't read as edges. */
function softened(base: Base, w: number, h: number) {
  let s = softCache.get(base);
  if (s) return s;
  const blur = (src: Float32Array) => {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length), R = 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let d = -R; d <= R; d++) { const xx = x + d; if (xx >= 0 && xx < w) { sum += src[y * w + xx]; n++; } }
      tmp[y * w + x] = sum / n;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let d = -R; d <= R; d++) { const yy = y + d; if (yy >= 0 && yy < h) { sum += tmp[yy * w + x]; n++; } }
      out[y * w + x] = sum / n;
    }
    return out;
  };
  s = { L: blur(base.L), A: blur(base.A), B: blur(base.B) };
  softCache.set(base, s);
  return s;
}

// ---- Shape detection ----------------------------------------------------

/** The photo split into its obvious shapes: a shape number per pixel, and which pixels lie on a boundary. */
export interface Shapes { id: Int32Array; edge: Uint8Array }

/**
 * Splits the photo into shapes by joining neighbouring pixels whose colors are close, weakest
 * differences first, and refusing to join across a difference that is large compared with what is
 * already inside each shape (Felzenszwalb and Huttenlocher's method). `size` (1-10) sets how coarse
 * the shapes are.
 */
export function findShapes(base: Base, w: number, h: number, size: number): Shapes {
  const s = softened(base, w, h), n = w * h;
  const k = 0.1 * Math.pow(1.5, size), minSize = Math.round(12 + size * size * 3);
  // Every pair of side-by-side pixels, with how different they are.
  const m = (w - 1) * h + w * (h - 1);
  const ea = new Int32Array(m), eb = new Int32Array(m), ew = new Float32Array(m);
  let e = 0;
  const diff = (i: number, j: number) => Math.sqrt((s.L[i] - s.L[j]) ** 2 + (s.A[i] - s.A[j]) ** 2 + (s.B[i] - s.B[j]) ** 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x < w - 1) { ea[e] = i; eb[e] = i + 1; ew[e++] = diff(i, i + 1); }
    if (y < h - 1) { ea[e] = i; eb[e] = i + w; ew[e++] = diff(i, i + w); }
  }
  // Order the pairs from most alike to least (a counting sort; differences are small numbers).
  const BUCKETS = 4096, bucket = (v: number) => Math.min(BUCKETS - 1, Math.floor(v * BUCKETS * 2));
  const start = new Int32Array(BUCKETS + 1);
  for (let i = 0; i < m; i++) start[bucket(ew[i]) + 1]++;
  for (let i = 0; i < BUCKETS; i++) start[i + 1] += start[i];
  const order = new Int32Array(m), fillAt = start.slice(0, BUCKETS);
  for (let i = 0; i < m; i++) order[fillAt[bucket(ew[i])]++] = i;

  const parent = new Int32Array(n), count = new Int32Array(n).fill(1), inner = new Float32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a: number, b: number, wt: number) => {
    if (count[a] < count[b]) [a, b] = [b, a];
    parent[b] = a; count[a] += count[b]; inner[a] = Math.max(inner[a], inner[b], wt);
  };
  for (let o = 0; o < m; o++) {
    const i = order[o], a = find(ea[i]), b = find(eb[i]);
    if (a !== b && ew[i] <= Math.min(inner[a] + k / count[a], inner[b] + k / count[b])) join(a, b, ew[i]);
  }
  // Specks too small to be worth picking on their own join whatever they are most like.
  for (let o = 0; o < m; o++) {
    const i = order[o], a = find(ea[i]), b = find(eb[i]);
    if (a !== b && (count[a] < minSize || count[b] < minSize)) join(a, b, ew[i]);
  }
  const id = new Int32Array(n), edge = new Uint8Array(n);
  for (let i = 0; i < n; i++) id[i] = find(i);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if ((x < w - 1 && id[i] !== id[i + 1]) || (y < h - 1 && id[i] !== id[i + w])) edge[i] = 1;
  }
  return { id, edge };
}

/**
 * Marks the whole shape under a point, then closes any small unmarked specks left completely
 * surrounded by that mark, so a textured surface becomes one solid area instead of one full of holes.
 */
export function fillShape(m: LabelMap, shapes: Shapes, x: number, y: number, label: number): void {
  const ix = Math.min(m.w - 1, Math.max(0, Math.floor(x))), iy = Math.min(m.h - 1, Math.max(0, Math.floor(y)));
  const target = shapes.id[iy * m.w + ix];
  for (let i = 0; i < m.data.length; i++) if (shapes.id[i] === target) m.data[i] = label;
  if (label !== NONE) fillHoles(m, label, Math.round(m.w * m.h * 0.004));
}

/** Gives `label` to every patch of unmarked pixels that is smaller than `maxSize` and touches nothing but `label`. */
export function fillHoles(m: LabelMap, label: number, maxSize: number): void {
  const { w, h, data } = m, n = w * h, seen = new Uint8Array(n);
  const patch: number[] = [];
  for (let start = 0; start < n; start++) {
    if (seen[start] || data[start] !== NONE) continue;
    patch.length = 0;
    patch.push(start);
    seen[start] = 1;
    let enclosed = true;
    for (let p = 0; p < patch.length; p++) {
      const i = patch[p], x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) enclosed = false;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n) continue;
        if (data[j] === NONE) { if (!seen[j]) { seen[j] = 1; patch.push(j); } }
        else if (data[j] !== label) enclosed = false;
      }
    }
    if (enclosed && patch.length <= maxSize) for (const i of patch) data[i] = label;
  }
}

// ---- Selections ---------------------------------------------------------
// A selection is a mask the size of the label map: 1 for every selected pixel.

/** The pixels of the shape under a point, as a mask. */
export function shapeMask(shapes: Shapes, w: number, h: number, x: number, y: number): Uint8Array {
  const ix = Math.min(w - 1, Math.max(0, Math.floor(x))), iy = Math.min(h - 1, Math.max(0, Math.floor(y)));
  const target = shapes.id[iy * w + ix], out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) if (shapes.id[i] === target) out[i] = 1;
  return out;
}

/** Everything inside a hand-drawn outline, as a mask. */
export function polygonMask(w: number, h: number, pts: [number, number][]): Uint8Array {
  const t: LabelMap = { w, h, data: new Uint8Array(w * h) };
  fillPolygon(t, pts, 1);
  return t.data;
}

/** Adds `hit` to a selection, or takes it away. */
export function combine(sel: Uint8Array, hit: Uint8Array, subtract: boolean): void {
  for (let i = 0; i < sel.length; i++) if (hit[i]) sel[i] = subtract ? 0 : 1;
}

/** Grows a selection by `px` pixels all round (or shrinks it, for a negative number). */
export function growMask(sel: Uint8Array, w: number, h: number, px: number): void {
  const want = px > 0 ? 1 : 0;
  for (let step = 0; step < Math.abs(px); step++) {
    const src = sel.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i] === want) continue;
      if ((x > 0 && src[i - 1] === want) || (x < w - 1 && src[i + 1] === want) || (y > 0 && src[i - w] === want) || (y < h - 1 && src[i + w] === want)) sel[i] = want;
    }
  }
}

/**
 * Rounds off a selection's edge: ragged bits are trimmed, notches filled and specks dropped.
 * Each pixel ends up selected if most of the pixels within `radius` of it are.
 */
export function smoothMask(sel: Uint8Array, w: number, h: number, radius: number): void {
  const n = w * h, tmp = new Float32Array(n), acc = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let d = -radius; d <= radius; d++) { const xx = x + d; if (xx >= 0 && xx < w) { s += sel[y * w + xx]; c++; } }
    tmp[y * w + x] = s / c;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, c = 0;
    for (let d = -radius; d <= radius; d++) { const yy = y + d; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; c++; } }
    acc[y * w + x] = s / c;
  }
  for (let i = 0; i < n; i++) sel[i] = acc[i] >= 0.5 ? 1 : 0;
}

/** Closes pinholes in a selection: unselected patches smaller than `maxSize` that it completely surrounds. */
export function closeHoles(sel: Uint8Array, w: number, h: number, maxSize: number): void {
  const m: LabelMap = { w, h, data: sel };
  fillHoles(m, 1, maxSize);
}

// ---- The smart brush ----------------------------------------------------

interface Pieces { index: Int32Array; count: Int32Array; L: Float32Array; A: Float32Array; B: Float32Array }
const piecesCache = new WeakMap<Shapes, Pieces>();

/** The small pieces a fine split of the photo is made of, with the size and average color of each. */
function piecesOf(fine: Shapes, base: Base): Pieces {
  let p = piecesCache.get(fine);
  if (p) return p;
  const n = fine.id.length, index = new Int32Array(n), seen = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    let k = seen.get(fine.id[i]);
    if (k === undefined) { k = seen.size; seen.set(fine.id[i], k); }
    index[i] = k;
  }
  const K = seen.size, count = new Int32Array(K), L = new Float32Array(K), A = new Float32Array(K), B = new Float32Array(K);
  for (let i = 0; i < n; i++) { const k = index[i]; count[k]++; L[k] += base.L[i]; A[k] += base.A[i]; B[k] += base.B[i]; }
  for (let k = 0; k < K; k++) { L[k] /= count[k]; A[k] /= count[k]; B[k] /= count[k]; }
  p = { index, count, L, A, B };
  piecesCache.set(fine, p);
  return p;
}

/**
 * A brush stroke that follows the picture. The photo is already split into small pieces whose borders
 * lie on its real edges (`fine`). The stroke takes every piece its middle runs over, then spreads to
 * neighbouring pieces of a similar color that lie mostly within reach of the brush. Because whole pieces
 * are taken, the result ends exactly on the photo's edges instead of somewhere near them.
 * Returns the pixels the stroke selects.
 */
export function smartStroke(base: Base, fine: Shapes, w: number, h: number, path: [number, number][], r: number, tol: number): Uint8Array {
  const n = w * h, P = piecesOf(fine, base), K = P.count.length;
  const mask = (radius: number) => {
    const t: LabelMap = { w, h, data: new Uint8Array(n) };
    stamp(t, path[0][0], path[0][1], radius, 1);
    for (let i = 1; i < path.length; i++) stampLine(t, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1], radius, 1);
    return t.data;
  };
  const core = mask(Math.max(1.5, r * 0.5)), reach = mask(r * 2.5 + 2);
  const inCore = new Int32Array(K), inReach = new Int32Array(K);
  for (let i = 0; i < n; i++) { if (core[i]) inCore[P.index[i]]++; if (reach[i]) inReach[P.index[i]]++; }

  // Pieces the middle of the stroke clearly runs over are wanted for certain.
  const seeds: number[] = [];
  for (let k = 0; k < K; k++) if (inCore[k] >= Math.min(6, P.count[k] * 0.5)) seeds.push(k);
  const out = new Uint8Array(n);
  if (!seeds.length) { for (let i = 0; i < n; i++) out[i] = core[i]; return out; }

  // A neighbouring piece joins in when it looks like one of them and is mostly within reach.
  const t2 = tol * tol, wanted = new Uint8Array(K);
  for (const k of seeds) wanted[k] = 1;
  for (let k = 0; k < K; k++) {
    if (wanted[k] || inReach[k] < P.count[k] * 0.3) continue;
    for (const s of seeds) {
      if ((P.L[k] - P.L[s]) ** 2 + (P.A[k] - P.A[s]) ** 2 + (P.B[k] - P.B[s]) ** 2 <= t2) { wanted[k] = 2; break; }
    }
  }
  // Spread from the stroke through wanted pieces only, so nothing unconnected is picked up. Pieces the
  // stroke ran over are taken whole, right up to their edges; the others only as far as the brush reaches.
  const stack: number[] = [];
  for (let i = 0; i < n; i++) if (core[i] && wanted[P.index[i]]) { out[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop()!, x = i % w;
    const visit = (j: number) => {
      const k = wanted[P.index[j]];
      if (!out[j] && k && (k === 1 ? inReach[P.index[j]] >= P.count[P.index[j]] * 0.6 || reach[j] : reach[j])) { out[j] = 1; stack.push(j); }
    };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }
  closeHoles(out, w, h, Math.max(20, Math.round(r * r)));
  return out;
}

// ---- Snapping to edges --------------------------------------------------

/**
 * Moves the boundaries between differently labelled parts of `lab` onto the photo's real edges nearby.
 * `lab` holds one small number per pixel (a selection's 0 and 1, or the marks). Only pixels where `free`
 * is set may change, and none moves more than about `band` pixels.
 *
 * Each pixel near a boundary goes to whichever label it looks most like, judged against that label's
 * typical color close by. Those typical colors are taken only from pixels well inside each part (further
 * than `band` from any boundary), so a mark that spilled over an edge can't vouch for its own spill. A
 * small pull toward agreeing with the neighbours keeps the new boundary smooth instead of ragged.
 * Returns how many pixels changed.
 */
export function snapBoundaries(lab: Uint8Array, base: Base, w: number, h: number, free: Uint8Array | null, band = 6): number {
  const n = w * h;
  // How far each pixel is from a boundary (4-connected steps), up to band + 1.
  const far = band + 1, dist = new Uint8Array(n).fill(far), queue = new Int32Array(n);
  let qh = 0, qt = 0;
  for (let i = 0; i < n; i++) {
    const x = i % w, v = lab[i];
    if ((x > 0 && lab[i - 1] !== v) || (x < w - 1 && lab[i + 1] !== v) || (i >= w && lab[i - w] !== v) || (i < n - w && lab[i + w] !== v)) {
      dist[i] = 0; queue[qt++] = i;
    }
  }
  while (qh < qt) {
    const i = queue[qh++], d = dist[i] + 1, x = i % w;
    if (d >= far) continue;
    const go = (j: number) => { if (dist[j] > d) { dist[j] = d; queue[qt++] = j; } };
    if (x > 0) go(i - 1);
    if (x < w - 1) go(i + 1);
    if (i >= w) go(i - w);
    if (i < n - w) go(i + w);
  }
  const movable = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) if (dist[i] <= band && (!free || free[i])) { movable[i] = 1; any = true; }
  if (!any) return 0;

  // The labels that meet at a movable pixel, and the typical color of each one nearby.
  const used = new Set<number>();
  for (let i = 0; i < n; i++) if (movable[i]) used.add(lab[i]);
  const R = band * 2 + 4, s = lightlySmoothed(base, w, h);
  const local = new Map<number, { L: Float32Array; A: Float32Array; B: Float32Array; N: Float32Array }>();
  for (const l of used) {
    const inside = (i: number) => lab[i] === l && dist[i] > band;
    local.set(l, {
      L: boxSum(w, h, R, (i) => (inside(i) ? s.L[i] : 0)),
      A: boxSum(w, h, R, (i) => (inside(i) ? s.A[i] : 0)),
      B: boxSum(w, h, R, (i) => (inside(i) ? s.B[i] : 0)),
      N: boxSum(w, h, R, (i) => (inside(i) ? 1 : 0)),
    });
  }

  // Settle the boundary a step at a time: each pass, a pixel may take a label from right beside it.
  const SMOOTH = 0.035;
  let cur = lab.slice(), changed = 0;
  const cand: number[] = [];
  for (let pass = 0; pass < band + 2; pass++) {
    const next = cur.slice();
    let moved = 0;
    for (let i = 0; i < n; i++) {
      if (!movable[i]) continue;
      const x = i % w, y = (i / w) | 0, v = cur[i];
      cand.length = 0;
      cand.push(v);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const u = cur[yy * w + xx];
        if (!cand.includes(u)) cand.push(u);
      }
      // A pixel whose own part has nothing solid to compare against nearby stays as it is.
      const own = local.get(v);
      if (cand.length < 2 || !own || own.N[i] < 4) continue;
      let best = v, bestCost = Infinity;
      for (const l of cand) {
        const t = local.get(l);
        if (!t || t.N[i] < 4) continue;
        const k = t.N[i];
        const dc = Math.sqrt((s.L[i] - t.L[i] / k) ** 2 + (s.A[i] - t.A[i] / k) ** 2 + (s.B[i] - t.B[i] / k) ** 2);
        let other = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if ((dx || dy) && xx >= 0 && yy >= 0 && xx < w && yy < h && cur[yy * w + xx] !== l) other++;
        }
        const cost = dc + SMOOTH * other;
        if (cost < bestCost - 1e-6) { bestCost = cost; best = l; }
      }
      if (best !== v) { next[i] = best; moved++; }
    }
    cur = next;
    if (!moved) break;
  }
  for (let i = 0; i < n; i++) if (cur[i] !== lab[i]) { lab[i] = cur[i]; changed++; }
  return changed;
}

/** Sums of `f` over the square of radius `r` around every pixel. */
function boxSum(w: number, h: number, r: number, f: (i: number) => number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = 0; x <= Math.min(w - 1, r); x++) acc += f(row + x);
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc;
      if (x + r + 1 < w) acc += f(row + x + r + 1);
      if (x - r >= 0) acc -= f(row + x - r);
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = 0; y <= Math.min(h - 1, r); y++) acc += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc;
      if (y + r + 1 < h) acc += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) acc -= tmp[(y - r) * w + x];
    }
  }
  return out;
}

const liteCache = new WeakMap<Base, { L: Float32Array; A: Float32Array; B: Float32Array }>();

/** The photo's colors averaged over each pixel and its eight neighbours: enough to quiet noise, not enough to blur edges. */
function lightlySmoothed(base: Base, w: number, h: number) {
  let s = liteCache.get(base);
  if (s) return s;
  const one = (src: Float32Array) => {
    const sum = boxSum(w, h, 1, (i) => src[i]), cnt = boxSum(w, h, 1, () => 1);
    for (let i = 0; i < sum.length; i++) sum[i] /= cnt[i];
    return sum;
  };
  s = { L: one(base.L), A: one(base.A), B: one(base.B) };
  liteCache.set(base, s);
  return s;
}

/** Pixels within `px` of anything set in `mask`. */
export function near(mask: Uint8Array, w: number, h: number, px: number): Uint8Array {
  const out = mask.slice();
  growMask(out, w, h, px);
  return out;
}
