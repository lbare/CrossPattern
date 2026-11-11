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

/** Draws the photo with its marks: removed areas as a checkerboard, solid areas in their final color, detail and cartoon areas tinted. */
export function compose(base: Base, m: LabelMap, out: ImageData): void {
  const src = base.image.data, dst = out.data, n = m.w * m.h;
  const sums = new Float64Array(256 * 4);
  for (let i = 0; i < n; i++) {
    const l = m.data[i];
    if (l < FLAT0 || l >= CARTOON0) continue;
    sums[l * 4] += src[i * 4]; sums[l * 4 + 1] += src[i * 4 + 1]; sums[l * 4 + 2] += src[i * 4 + 2]; sums[l * 4 + 3]++;
  }
  for (let i = 0; i < n; i++) {
    const l = m.data[i], o = i * 4;
    let r = src[o], g = src[o + 1], b = src[o + 2];
    if (l === REMOVE) {
      const x = i % m.w, y = (i / m.w) | 0;
      const v = ((x >> 3) + (y >> 3)) & 1 ? 236 : 204;
      r = r * 0.12 + v * 0.88; g = g * 0.12 + v * 0.88; b = b * 0.12 + v * 0.88;
    } else if (l === DETAIL) {
      r = r * 0.84 + 30 * 0.16; g = g * 0.84 + 210 * 0.16; b = b * 0.84 + 130 * 0.16;
    } else if (l >= CARTOON0) {
      // Each cartoon area gets its own tint so neighbouring areas can be told apart.
      const hue = ((l - CARTOON0) * 137.5 + 300) % 360, k = 0.2;
      const f = (n: number) => { const t = (n + hue / 30) % 12; return 255 * (0.6 - 0.4 * Math.max(-1, Math.min(t - 3, 9 - t, 1))); };
      r = r * (1 - k) + f(0) * k; g = g * (1 - k) + f(8) * k; b = b * (1 - k) + f(4) * k;
    } else if (l >= FLAT0) {
      const c = sums[l * 4 + 3];
      r = sums[l * 4] / c; g = sums[l * 4 + 1] / c; b = sums[l * 4 + 2] / c;
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
