import { oklabToRgb, rgbToHex, rgbToOklab } from './color';
import { despeckle } from './model';
import { CARTOON0, Crop, DETAIL, FLAT0, LabelMap, NONE, REMOVE } from './marks';

/** A picture shrunk to one pixel per stitch, held in Oklab so color math matches what the eye sees. */
export interface Sampled {
  w: number;
  h: number;
  L: Float32Array;
  A: Float32Array;
  B: Float32Array;
  /** 1 where there will be a stitch, 0 where the fabric stays empty (transparent or marked for removal). */
  mask: Uint8Array;
  /** The mark covering most of each stitch: NONE, REMOVE, DETAIL, a solid-area id or a cartoon-area id. */
  label: Uint8Array;
}

export interface ConvertOptions {
  /** Colors for everything that is not a cartoon area. */
  colors: number;
  /** 0-4: how strongly to flatten texture and shading before picking colors. */
  smooth: number;
  /** 0-3: how aggressively to remove stray single stitches afterwards. */
  clean: number;
  /** Photo adjustments, each -100 to 100 with 0 meaning unchanged. */
  brightness?: number;
  contrast?: number;
  saturation?: number;
  /** 0-100: brightens dark parts of the photo and brings their color back, leaving light parts alone. */
  lift?: number;
  /** Flat tones an area is reduced to when it has no setting of its own (1-6). */
  tones?: number;
  /** Detail per area id: 1-6 flat tones, or 0 to keep every detail. */
  areaTones?: Record<number, number>;
  /** Soft edge per area id: how many stitches either side of its boundary are blended (0-3). */
  areaFeather?: Record<number, number>;
  /** Draw a dark one-stitch outline around each cartoon area. */
  outline?: boolean;
  /** Brighten cartoon areas that sit in shadow, so they look drawn rather than photographed. */
  evenLight?: boolean;
}

/** How much one color can be scaled up when its area is brightened, so shadows don't turn neon. */
const MAX_CHROMA_GAIN = 1.9;
/** Extra color strength given to cartoon areas. */
const VIVID = 1.4;

/** Brightens, adds contrast, boosts color and lifts shadows before conversion. */
function adjust(s: Sampled, o: ConvertOptions): Sampled {
  const br = (o.brightness ?? 0) / 400, ct = Math.pow(2, (o.contrast ?? 0) / 100);
  const sat = (o.saturation ?? 0) < 0 ? 1 + (o.saturation ?? 0) / 100 : 1 + (o.saturation ?? 0) / 50;
  const lift = ((o.lift ?? 0) / 100) * 2.4;
  if (!br && ct === 1 && sat === 1 && !lift) return s;
  const L = s.L.slice(), A = s.A.slice(), B = s.B.slice();
  for (let i = 0; i < L.length; i++) {
    let l = L[i], gain = sat;
    if (lift && l > 0.001) {
      // Adds most around the dark mid-tones and nothing at pure black or white; color grows with brightness.
      const lifted = l + lift * l * (1 - l) * (1 - l);
      gain *= Math.min(MAX_CHROMA_GAIN, lifted / l);
      l = lifted;
    }
    L[i] = Math.min(1, Math.max(0, (l - 0.5) * ct + 0.5 + br));
    A[i] *= gain;
    B[i] *= gain;
  }
  return { ...s, L, A, B };
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

/**
 * Gives cartoon areas their drawn look: stronger color, and (with `brighten`) each area that sits in
 * shadow is lifted toward an even, mid-bright level so an orange cat in the shade comes out orange.
 */
function cartoonLight(s: Sampled, brighten: boolean): Sampled {
  const byArea = new Map<number, number[]>();
  for (let i = 0; i < s.label.length; i++) {
    if (s.label[i] >= FLAT0 && s.mask[i]) (byArea.get(s.label[i]) ?? byArea.set(s.label[i], []).get(s.label[i])!).push(i);
  }
  if (!byArea.size) return s;
  const L = s.L.slice(), A = s.A.slice(), B = s.B.slice();
  for (const idx of byArea.values()) {
    const sorted = idx.map((i) => L[i]).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const target = 0.62;
    // A gain, not an offset: darks stay darker than lights, so the shading inside the area survives.
    const gain = brighten && median < target && median > 0.02 ? 1 + (target / median - 1) * 0.75 : 1;
    for (const i of idx) {
      const l = Math.min(0.97, L[i] * gain);
      // Color is pushed a little past natural, the way a drawing exaggerates it.
      const g = (L[i] > 0.001 ? Math.min(MAX_CHROMA_GAIN, l / L[i]) : 1) * VIVID;
      L[i] = l; A[i] *= g; B[i] *= g;
    }
  }
  return { ...s, L, A, B };
}

/**
 * Edge-preserving blur: each pixel moves toward neighbours of a similar color and ignores
 * very different ones, so flat areas get flatter while outlines stay sharp.
 * `cartoon` chooses which stitches are processed: unmarked ones gently, or cartoon areas strongly and
 * only among stitches of the same area. Everything else is left exactly as it is.
 */
function smooth(s: Sampled, passes: number, cartoon = false): Sampled {
  let { L, A, B } = s;
  const { w, h, mask, label } = s;
  const sigma = cartoon ? 0.13 : 0.07, sig2 = 2 * sigma * sigma;
  for (let p = 0; p < passes; p++) {
    const nL = new Float32Array(L.length), nA = new Float32Array(L.length), nB = new Float32Array(L.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const mine = cartoon ? label[i] >= FLAT0 : label[i] === NONE;
        if (!mine) { nL[i] = L[i]; nA[i] = A[i]; nB[i] = B[i]; continue; }
        let sl = 0, sa = 0, sb = 0, sw = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (!mask[j] || (cartoon && label[j] !== label[i])) continue;
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

interface Clusters { L: Float64Array; A: Float64Array; B: Float64Array; nearest: (i: number) => number }

/**
 * k-means clustering of the given stitches into k colors. Brightness counts for less than hue
 * (`lightWeight` below 1), so two things of different color stay apart even when equally dark.
 */
function kmeans(s: Sampled, idx: number[], k: number, lightWeight: number, weight: (i: number) => number): Clusters {
  const { L, A, B } = s;
  const step = Math.max(1, Math.ceil(idx.length / 15000));
  const pts: number[] = [];
  for (let i = 0; i < idx.length; i += step) pts.push(idx[i]);
  k = Math.max(1, Math.min(k, pts.length));
  const lw2 = lightWeight * lightWeight;
  const cL = new Float64Array(k), cA = new Float64Array(k), cB = new Float64Array(k);
  const d2 = (i: number, c: number) => lw2 * (L[i] - cL[c]) ** 2 + (A[i] - cA[c]) ** 2 + (B[i] - cB[c]) ** 2;

  // k-means++ start: spread the first guesses out so distinct colors each get a cluster.
  const rand = rng(12345);
  const dist = new Float64Array(pts.length).fill(Infinity);
  let pick = pts[Math.floor(rand() * pts.length)];
  for (let c = 0; c < k; c++) {
    cL[c] = L[pick]; cA[c] = A[pick]; cB[c] = B[pick];
    let total = 0;
    for (let j = 0; j < pts.length; j++) {
      const d = d2(pts[j], c);
      if (d < dist[j]) dist[j] = d;
      total += dist[j] * weight(pts[j]);
    }
    let t = rand() * total;
    pick = pts[pts.length - 1];
    for (let j = 0; j < pts.length; j++) {
      t -= dist[j] * weight(pts[j]);
      if (t <= 0) { pick = pts[j]; break; }
    }
  }

  const nearest = (i: number) => {
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      const d = d2(i, c);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  };

  const sums = new Float64Array(k * 4);
  for (let iter = 0; iter < 12; iter++) {
    sums.fill(0);
    for (const i of pts) {
      const c = nearest(i) * 4, m = weight(i);
      sums[c] += L[i] * m; sums[c + 1] += A[i] * m; sums[c + 2] += B[i] * m; sums[c + 3] += m;
    }
    for (let c = 0; c < k; c++) {
      const cnt = sums[c * 4 + 3];
      if (!cnt) continue;
      cL[c] = sums[c * 4] / cnt; cA[c] = sums[c * 4 + 1] / cnt; cB[c] = sums[c * 4 + 2] / cnt;
    }
  }
  return { L: cL, A: cA, B: cB, nearest };
}

/**
 * Turns a sampled picture into a pattern.
 *
 * Cartoon areas are handled one at a time: lighting evened out, texture smoothed away, then reduced to a
 * few flat tones of their own, so each keeps its own colors however dark or busy the rest of the photo is.
 * Everything else shares the main color budget.
 */
export function quantize(src: Sampled, o: ConvertOptions): ConvertResult {
  // Each area carries its own level of detail: a number of flat tones, or 0 for "keep every detail",
  // which is handled like the rest of the picture but protected from simplifying.
  const tonesOf = (l: number) => o.areaTones?.[l] ?? (l < CARTOON0 ? 1 : o.tones ?? 3);
  const relabel = src.label.slice();
  for (let i = 0; i < relabel.length; i++) if (relabel[i] >= FLAT0 && tonesOf(relabel[i]) === 0) relabel[i] = DETAIL;
  // Round off area outlines: a stitch whose mark is shared by fewer than three of its neighbours takes the
  // mark most of them have. This removes the one-stitch spikes a hand-made or ragged selection leaves.
  for (let pass = 0; pass < 2; pass++) {
    const from = relabel.slice();
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
      const i = y * src.w + x, l = from[i];
      if (!src.mask[i] || l === REMOVE) continue;
      const tally = new Map<number, number>();
      let same = 0, best = l, bestN = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= src.w || yy >= src.h) continue;
        const j = yy * src.w + xx;
        if (!src.mask[j] || from[j] === REMOVE) continue;
        if (from[j] === l) { same++; continue; }
        const c2 = (tally.get(from[j]) ?? 0) + 1;
        tally.set(from[j], c2);
        if (c2 > bestN) { bestN = c2; best = from[j]; }
      }
      if (same < 3 && bestN > same) relabel[i] = best;
    }
  }
  let s = adjust({ ...src, label: relabel }, o);
  s = cartoonLight(s, o.evenLight !== false);
  if (o.smooth > 0) s = smooth(s, o.smooth * 2);
  s = smooth(s, 5, true);
  const { w, h, mask, label } = s;
  const n = w * h;
  const cells = new Uint16Array(n);

  // Colors found so far, as Oklab triples; cells hold index + 1.
  const colors: [number, number, number][] = [];
  const add = (c: Clusters, k: number) => { colors.push([c.L[k], c.A[k], c.B[k]]); return colors.length; };

  const rest: number[] = [];
  const areas = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    if (label[i] >= FLAT0) (areas.get(label[i]) ?? areas.set(label[i], []).get(label[i])!).push(i);
    else rest.push(i);
  }
  if (!rest.length && !areas.size) return { width: w, height: h, cells, palette: [] };

  if (rest.length) {
    // Detail areas count for more, so the palette is chosen to serve them first.
    const c = kmeans(s, rest, o.colors, 0.75, (i) => (label[i] === DETAIL ? 4 : 1));
    const ids = Array.from(c.L, (_, k) => add(c, k));
    for (const i of rest) cells[i] = ids[c.nearest(i)];
  }

  for (const [area, idx] of areas) {
    const c = kmeans(s, idx, Math.max(1, Math.min(6, tonesOf(area))), 0.6, () => 1);
    const ids = Array.from(c.L, (_, k) => add(c, k));
    for (const i of idx) cells[i] = ids[c.nearest(i)];
  }

  // Tidy stray stitches. Empty fabric never creeps into the picture or the reverse.
  const tidy = (level: number, pick: (l: number) => boolean, withinArea: boolean) => {
    const before = cells.slice();
    despeckle(cells, w, h, level);
    for (let i = 0; i < n; i++) {
      if (cells[i] === before[i]) continue;
      const l = label[i];
      let ok = pick(l) && mask[i] === 1 && cells[i] !== 0;
      if (ok && withinArea) {
        // Only take a color that is already used next door inside the same area.
        ok = false;
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (before[j] === cells[i] && label[j] === l) { ok = true; break; }
        }
      }
      if (!ok) cells[i] = before[i];
    }
  };
  if (o.clean > 0) tidy(o.clean, (l) => l === NONE, false);
  // Cartoon areas are always tidied: drawn shapes have no speckle.
  if (areas.size) tidy(2, (l) => l >= FLAT0, true);

  // Soft edges: around an area set to feather, each stitch near the boundary takes whichever nearby color
  // best matches the blurred picture there, so the two sides run into each other instead of meeting at a
  // hard line.
  const featherOf = (l: number) => Math.max(0, Math.min(3, o.areaFeather?.[l] ?? 0));
  for (const [area, idx] of areas) {
    const f = featherOf(area);
    if (!f) continue;
    const near = new Int8Array(n);
    let front: number[] = [];
    const touch = (i: number, d: number) => { if (!near[i] && mask[i]) { near[i] = d; front.push(i); } };
    const around = (i: number) => {
      const x = i % w;
      return [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1].filter((j) => j >= 0);
    };
    for (const i of idx) for (const j of around(i)) if (mask[j] && label[j] !== area) { touch(i, 1); touch(j, 1); }
    const band = [...front];
    for (let d = 2; d <= f; d++) {
      const prev = front;
      front = [];
      for (const i of prev) for (const j of around(i)) touch(j, d);
      band.push(...front);
    }
    const snap = cells.slice();
    for (const i of band) {
      const x = i % w, y = (i / w) | 0;
      let sl = 0, sa = 0, sb = 0, cnt = 0;
      const choices = new Set<number>();
      for (let yy = Math.max(0, y - f); yy <= Math.min(h - 1, y + f); yy++) {
        for (let xx = Math.max(0, x - f); xx <= Math.min(w - 1, x + f); xx++) {
          const j = yy * w + xx;
          if (!mask[j] || !snap[j]) continue;
          sl += s.L[j]; sa += s.A[j]; sb += s.B[j]; cnt++;
          choices.add(snap[j]);
        }
      }
      if (!cnt) continue;
      sl /= cnt; sa /= cnt; sb /= cnt;
      let best = snap[i], bd = Infinity;
      for (const v of choices) {
        const col = colors[v - 1], d = (col[0] - sl) ** 2 + (col[1] - sa) ** 2 + (col[2] - sb) ** 2;
        if (d < bd) { bd = d; best = v; }
      }
      cells[i] = best;
    }
  }

  if (o.outline && areas.size) {
    // One shared dark line color, drawn on the outermost stitches of each cartoon area wherever it
    // meets something else (not along the edge of the canvas).
    let dark = 1;
    for (const c of colors) dark = Math.min(dark, c[0]);
    colors.push([Math.min(0.24, dark * 0.8), 0.006, 0.01]);
    const line = colors.length;
    const edge: number[] = [];
    for (const [area, idx] of areas) {
      // A feathered area has a soft edge, so it gets no hard line round it.
      if (featherOf(area)) continue;
      for (const i of idx) {
        const x = i % w, y = (i / w) | 0, l = label[i];
        const differs = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < w && yy < h && (label[yy * w + xx] !== l || !mask[yy * w + xx]);
        if (differs(x - 1, y) || differs(x + 1, y) || differs(x, y - 1) || differs(x, y + 1)) edge.push(i);
      }
    }
    for (const i of edge) cells[i] = line;
  }

  // Merge colors that came out almost identical in different areas, drop unused ones, most-used first.
  const merged = colors.map((_, k) => k);
  for (let a = 0; a < colors.length; a++) {
    if (merged[a] !== a) continue;
    for (let b = a + 1; b < colors.length; b++) {
      const d = (colors[a][0] - colors[b][0]) ** 2 + (colors[a][1] - colors[b][1]) ** 2 + (colors[a][2] - colors[b][2]) ** 2;
      if (merged[b] === b && d < 0.022 * 0.022) merged[b] = a;
    }
  }
  const counts = new Array<number>(colors.length).fill(0);
  for (let i = 0; i < n; i++) if (cells[i]) { cells[i] = merged[cells[i] - 1] + 1; counts[cells[i] - 1]++; }
  const order = colors.map((_, k) => k).filter((k) => counts[k] > 0).sort((a, b) => counts[b] - counts[a]);
  const remap = new Uint16Array(colors.length + 1);
  order.forEach((k, idx) => { remap[k + 1] = idx + 1; });
  for (let i = 0; i < n; i++) cells[i] = remap[cells[i]];
  const palette = order.map((k) => {
    const [r, g, b] = oklabToRgb(colors[k][0], colors[k][1], colors[k][2]);
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
