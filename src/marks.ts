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
 */
export function compose(base: Base, m: LabelMap, out: ImageData, shapes?: Shapes | null, hover = -1): void {
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
    dst[o] = r; dst[o + 1] = g; dst[o + 2] = b; dst[o + 3] = 255;
  }
}

// ---- Edge snapping ------------------------------------------------------

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

/**
 * A brush stroke that snaps to the edges of what it is painted on. The middle of the stroke says which
 * colors are wanted; the mark then spreads outward through similar colors until it meets an edge (up to
 * about a brush-width beyond the stroke), and pulls back from anything the brush overshot onto.
 */
export function snapStroke(m: LabelMap, base: Base, path: [number, number][], r: number, tol: number, label: number): void {
  const { w, h } = m, n = w * h;
  const soft = softened(base, w, h);
  const mask = (radius: number) => {
    const t: LabelMap = { w, h, data: new Uint8Array(n) };
    stamp(t, path[0][0], path[0][1], radius, 1);
    for (let i = 1; i < path.length; i++) stampLine(t, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1], radius, 1);
    return t.data;
  };
  const core = mask(Math.max(1.5, r * 0.45)), reach = mask(r * 2 + 2);

  // The few colors that make up what is under the middle of the stroke.
  const samples: number[] = [];
  for (let i = 0; i < n; i++) if (core[i]) samples.push(i);
  if (!samples.length) return;
  const step = Math.max(1, Math.floor(samples.length / 1500));
  const pts = samples.filter((_, k) => k % step === 0);
  const K = Math.min(4, pts.length);
  const cL = new Float64Array(K), cA = new Float64Array(K), cB = new Float64Array(K);
  const d2 = (i: number, c: number) => (soft.L[i] - cL[c]) ** 2 + (soft.A[i] - cA[c]) ** 2 + (soft.B[i] - cB[c]) ** 2;
  const near = (i: number) => { let b = Infinity; for (let c = 0; c < K; c++) b = Math.min(b, d2(i, c)); return b; };
  // Start the groups far apart, then settle them.
  let pick = pts[0];
  for (let c = 0; c < K; c++) {
    cL[c] = soft.L[pick]; cA[c] = soft.A[pick]; cB[c] = soft.B[pick];
    let far = -1;
    for (const i of pts) { let b = Infinity; for (let k = 0; k <= c; k++) b = Math.min(b, d2(i, k)); if (b > far) { far = b; pick = i; } }
  }
  for (let iter = 0; iter < 5; iter++) {
    const sum = new Float64Array(K * 4);
    for (const i of pts) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < K; c++) { const d = d2(i, c); if (d < bd) { bd = d; best = c; } }
      sum[best * 4] += soft.L[i]; sum[best * 4 + 1] += soft.A[i]; sum[best * 4 + 2] += soft.B[i]; sum[best * 4 + 3]++;
    }
    for (let c = 0; c < K; c++) if (sum[c * 4 + 3]) { cL[c] = sum[c * 4] / sum[c * 4 + 3]; cA[c] = sum[c * 4 + 1] / sum[c * 4 + 3]; cB[c] = sum[c * 4 + 2] / sum[c * 4 + 3]; }
  }

  // Spread from the middle of the stroke through similar colors, staying within reach of the brush.
  const t2 = tol * tol, sel = new Uint8Array(n), stack: number[] = [];
  for (const i of samples) { sel[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop()!, x = i % w;
    const visit = (j: number) => { if (!sel[j] && reach[j] && near(j) <= t2) { sel[j] = 1; stack.push(j); } };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < n - w) visit(i + w);
  }
  // Fill pinholes left by odd-colored specks, so the mark is solid.
  for (let pass = 0; pass < 2; pass++) {
    const add: number[] = [];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (sel[i] || !reach[i]) continue;
      const c = sel[i - 1] + sel[i + 1] + sel[i - w] + sel[i + w] + sel[i - w - 1] + sel[i - w + 1] + sel[i + w - 1] + sel[i + w + 1];
      if (c >= 5) add.push(i);
    }
    for (const i of add) sel[i] = 1;
  }
  for (let i = 0; i < n; i++) if (sel[i]) m.data[i] = label;
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
