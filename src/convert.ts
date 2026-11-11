import { oklabToRgb, rgbToHex, rgbToOklab } from './color';
import { despeckle } from './model';
import { Crop, DETAIL, FLAT0, LabelMap, NONE, REMOVE } from './marks';

/** A picture shrunk to one pixel per stitch, held in Oklab so color math matches what the eye sees. */
export interface Sampled {
  w: number;
  h: number;
  L: Float32Array;
  A: Float32Array;
  B: Float32Array;
  /** 1 where there will be a stitch, 0 where the fabric stays empty (transparent or marked for removal). */
  mask: Uint8Array;
  /** The mark covering most of each stitch: NONE, REMOVE, DETAIL or a solid-area id. */
  label: Uint8Array;
}

export interface ConvertOptions {
  colors: number;
  /** 0-4: how strongly to flatten texture and shading before picking colors. */
  smooth: number;
  /** 0-3: how aggressively to remove stray single stitches afterwards. */
  clean: number;
}

export interface ConvertResult {
  width: number;
  height: number;
  cells: Uint16Array;
  /** Hex colors; cells hold index + 1. Ordered from most to least used. */
  palette: string[];
}

/**
 * Shrinks the cropped part of the image to w × h by averaging every source block, which avoids the
 * speckle of plain resizing. Pixels marked for removal are left out of the average, so the edge of a
 * cut-out subject keeps the subject's own color instead of blending with the background.
 */
export function sampleImage(img: HTMLImageElement, crop: Crop, w: number, h: number, labels?: LabelMap): Sampled {
  const k = Math.max(1, Math.min(6, Math.floor(crop.w / w)));
  const c = document.createElement('canvas');
  c.width = w * k;
  c.height = h * k;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height).data;

  // Where each source pixel falls in the label map.
  const lx = new Int32Array(c.width), ly = new Int32Array(c.height);
  if (labels) {
    for (let x = 0; x < c.width; x++) lx[x] = Math.min(labels.w - 1, Math.floor(((x + 0.5) * labels.w) / c.width));
    for (let y = 0; y < c.height; y++) ly[y] = Math.min(labels.h - 1, Math.floor(((y + 0.5) * labels.h) / c.height)) * labels.w;
  }

  const n = w * h;
  const s: Sampled = {
    w, h, L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n),
    mask: new Uint8Array(n), label: new Uint8Array(n),
  };
  const votes = new Uint16Array(256);
  const seen: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, gr = 0, b = 0, a = 0;
      seen.length = 0;
      for (let yy = 0; yy < k; yy++) {
        const py = y * k + yy;
        let o = (py * c.width + x * k) * 4;
        for (let xx = 0; xx < k; xx++, o += 4) {
          const lab = labels ? labels.data[ly[py] + lx[x * k + xx]] : NONE;
          if (!votes[lab]++) seen.push(lab);
          if (lab === REMOVE) continue;
          const al = d[o + 3];
          r += d[o] * al; gr += d[o + 1] * al; b += d[o + 2] * al; a += al;
        }
      }
      let major = seen[0];
      for (const lab of seen) { if (votes[lab] > votes[major]) major = lab; }
      for (const lab of seen) votes[lab] = 0;
      const i = y * w + x;
      s.label[i] = major;
      if (major === REMOVE || a / (k * k) < 128) continue;
      const lab = rgbToOklab(r / a, gr / a, b / a);
      s.L[i] = lab[0]; s.A[i] = lab[1]; s.B[i] = lab[2]; s.mask[i] = 1;
    }
  }
  return s;
}

/** Gives every stitch of a solid area the area's average color. */
function flattenAreas(s: Sampled): Sampled {
  const sums = new Float64Array(256 * 4);
  let any = false;
  for (let i = 0; i < s.label.length; i++) {
    const l = s.label[i];
    if (l < FLAT0 || !s.mask[i]) continue;
    any = true;
    sums[l * 4] += s.L[i]; sums[l * 4 + 1] += s.A[i]; sums[l * 4 + 2] += s.B[i]; sums[l * 4 + 3]++;
  }
  if (!any) return s;
  const L = s.L.slice(), A = s.A.slice(), B = s.B.slice();
  for (let i = 0; i < s.label.length; i++) {
    const l = s.label[i];
    if (l < FLAT0 || !s.mask[i]) continue;
    const c = sums[l * 4 + 3];
    L[i] = sums[l * 4] / c; A[i] = sums[l * 4 + 1] / c; B[i] = sums[l * 4 + 2] / c;
  }
  return { ...s, L, A, B };
}

/**
 * Edge-preserving blur: each pixel moves toward neighbours of a similar color and ignores
 * very different ones, so flat areas get flatter while outlines stay sharp.
 * Only unmarked stitches are changed; detail and solid areas are left exactly as they are.
 */
function smooth(s: Sampled, passes: number): Sampled {
  let { L, A, B } = s;
  const { w, h, mask, label } = s;
  const sig2 = 2 * 0.07 * 0.07;
  for (let p = 0; p < passes; p++) {
    const nL = new Float32Array(L.length), nA = new Float32Array(L.length), nB = new Float32Array(L.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        if (label[i] !== NONE) { nL[i] = L[i]; nA[i] = A[i]; nB[i] = B[i]; continue; }
        let sl = 0, sa = 0, sb = 0, sw = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (!mask[j]) continue;
            const d2 = (L[i] - L[j]) ** 2 + (A[i] - A[j]) ** 2 + (B[i] - B[j]) ** 2;
            const wt = Math.exp(-d2 / sig2);
            sl += L[j] * wt; sa += A[j] * wt; sb += B[j] * wt; sw += wt;
          }
        }
        nL[i] = sl / sw; nA[i] = sa / sw; nB[i] = sb / sw;
      }
    }
    L = nL; A = nA; B = nB;
  }
  return { ...s, L, A, B };
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reduces a sampled picture to a small set of colors (k-means clustering), then tidies stray stitches. */
export function quantize(src: Sampled, o: ConvertOptions): ConvertResult {
  const flat = flattenAreas(src);
  const s = o.smooth > 0 ? smooth(flat, o.smooth * 2) : flat;
  const { w, h, L, A, B, mask, label } = s;
  const n = w * h;

  const all: number[] = [];
  for (let i = 0; i < n; i++) if (mask[i]) all.push(i);
  const cells = new Uint16Array(n);
  if (!all.length) return { width: w, height: h, cells, palette: [] };

  const step = Math.max(1, Math.ceil(all.length / 15000));
  const pts: number[] = [];
  for (let i = 0; i < all.length; i += step) pts.push(all[i]);
  const k = Math.max(1, Math.min(o.colors, pts.length));

  // k-means++ start: spread the first guesses out so distinct colors each get a cluster.
  const rand = rng(12345);
  const cL = new Float64Array(k), cA = new Float64Array(k), cB = new Float64Array(k);
  // Detail areas count for more, so the palette is chosen to serve them first.
  const wt = (i: number) => (label[i] === DETAIL ? 4 : 1);
  const dist = new Float64Array(pts.length).fill(Infinity);
  let pick = pts[Math.floor(rand() * pts.length)];
  for (let c = 0; c < k; c++) {
    cL[c] = L[pick]; cA[c] = A[pick]; cB[c] = B[pick];
    let total = 0;
    for (let j = 0; j < pts.length; j++) {
      const i = pts[j];
      const d = (L[i] - cL[c]) ** 2 + (A[i] - cA[c]) ** 2 + (B[i] - cB[c]) ** 2;
      if (d < dist[j]) dist[j] = d;
      total += dist[j] * wt(i);
    }
    let t = rand() * total;
    pick = pts[pts.length - 1];
    for (let j = 0; j < pts.length; j++) {
      t -= dist[j] * wt(pts[j]);
      if (t <= 0) { pick = pts[j]; break; }
    }
  }

  const nearest = (i: number) => {
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      const d = (L[i] - cL[c]) ** 2 + (A[i] - cA[c]) ** 2 + (B[i] - cB[c]) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };

  const sums = new Float64Array(k * 4);
  for (let iter = 0; iter < 12; iter++) {
    sums.fill(0);
    for (const i of pts) {
      const c = nearest(i) * 4, m = wt(i);
      sums[c] += L[i] * m; sums[c + 1] += A[i] * m; sums[c + 2] += B[i] * m; sums[c + 3] += m;
    }
    for (let c = 0; c < k; c++) {
      const cnt = sums[c * 4 + 3];
      if (!cnt) continue;
      cL[c] = sums[c * 4] / cnt; cA[c] = sums[c * 4 + 1] / cnt; cB[c] = sums[c * 4 + 2] / cnt;
    }
  }

  for (const i of all) cells[i] = nearest(i) + 1;
  if (o.clean > 0) {
    // Tidy only unmarked stitches, and never let empty fabric creep into the picture or the reverse.
    const before = cells.slice();
    despeckle(cells, w, h, o.clean);
    for (let i = 0; i < n; i++) {
      if (label[i] !== NONE || !mask[i] || !cells[i]) cells[i] = before[i];
    }
  }

  // Drop colors that ended up unused and order the rest by how much they are used.
  const counts = new Array<number>(k + 1).fill(0);
  for (let i = 0; i < n; i++) counts[cells[i]]++;
  const order = [...Array(k).keys()].filter((c) => counts[c + 1] > 0).sort((a, b) => counts[b + 1] - counts[a + 1]);
  const remap = new Uint16Array(k + 1);
  order.forEach((c, idx) => { remap[c + 1] = idx + 1; });
  for (let i = 0; i < n; i++) cells[i] = remap[cells[i]];
  const palette = order.map((c) => {
    const [r, g, b] = oklabToRgb(cL[c], cA[c], cB[c]);
    return rgbToHex(r, g, b);
  });
  return { width: w, height: h, cells, palette };
}

export function resultToImageData(r: ConvertResult): ImageData {
  const img = new ImageData(r.width, r.height);
  const rgb = r.palette.map((hex) => parseInt(hex.slice(1), 16));
  for (let i = 0; i < r.cells.length; i++) {
    const v = r.cells[i];
    if (!v) continue;
    const c = rgb[v - 1];
    img.data[i * 4] = c >> 16;
    img.data[i * 4 + 1] = (c >> 8) & 255;
    img.data[i * 4 + 2] = c & 255;
    img.data[i * 4 + 3] = 255;
  }
  return img;
}
