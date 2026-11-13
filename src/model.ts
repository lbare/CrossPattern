import { hexToOklab } from './color';

export interface PaletteColor {
  id: number;
  hex: string;
  symbol: string;
  /** Locked colors can't be painted over by any tool. */
  locked?: boolean;
}

/** A backstitch runs between grid intersections (0..width, 0..height). */
export interface Backstitch {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  colorId: number;
}

/** The pattern exactly as it came out of picture conversion, kept so edits can be compared and undone locally. */
export interface Converted {
  width: number;
  height: number;
  hexes: string[];
  /** Index into hexes + 1 per square; 0 is empty. */
  cells: Uint16Array;
}

/** Pictures that can be shown over the pattern as a guide while editing. */
export interface Reference {
  /** The cropped photo as a data URL. */
  photo?: string;
  /** Where the photo sits, in squares. */
  rect: { x: number; y: number; w: number; h: number };
  converted?: Converted;
}

export interface Pattern {
  name: string;
  width: number;
  height: number;
  /** One palette id per square, row by row. 0 means empty fabric. */
  cells: Uint16Array;
  palette: PaletteColor[];
  backstitches: Backstitch[];
  reference?: Reference;
  /** Fabric color shown behind the stitches. */
  fabric?: string;
  /** 1 for every square that has been stitched in real life, for tracking progress. */
  done?: Uint8Array;
}

export const MAX_SIZE = 400;

export const SYMBOLS = [
  ...'●■▲◆★✚✖○□△◇☆♥♣♠♦▼◀▶◐◑◒◓✿❖ABCDEFGHJKLMNPRSTUVWXYZ23456789abcdefghkmnprstuvwxyz',
];

const DEFAULT_COLORS = [
  '#1f1f1f', '#ffffff', '#c8372d', '#e8873a', '#f2c94c',
  '#4c9a52', '#3b7dc4', '#7b4fa3', '#8a5a3b', '#f4b6c2',
];

export function nextSymbol(palette: PaletteColor[]): string {
  const used = new Set(palette.map((c) => c.symbol));
  return SYMBOLS.find((s) => !used.has(s)) ?? '?';
}

export function nextId(palette: PaletteColor[]): number {
  return palette.reduce((m, c) => Math.max(m, c.id), 0) + 1;
}

export function paletteFromHexes(hexes: string[]): PaletteColor[] {
  const palette: PaletteColor[] = [];
  for (const hex of hexes) palette.push({ id: palette.length + 1, hex, symbol: nextSymbol(palette) });
  return palette;
}

export function createPattern(width: number, height: number, name = 'Untitled pattern'): Pattern {
  return {
    name,
    width,
    height,
    cells: new Uint16Array(width * height),
    palette: paletteFromHexes(DEFAULT_COLORS),
    backstitches: [],
  };
}

export function countCells(p: Pattern): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < p.cells.length; i++) {
    const v = p.cells[i];
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

/** All squares on a straight line between two squares (Bresenham). */
export function linePoints(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const pts: [number, number][] = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    pts.push([x0, y0]);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return pts;
}

export function floodFill(cells: Uint16Array, w: number, h: number, x: number, y: number, id: number): boolean {
  const target = cells[y * w + x];
  if (target === id) return false;
  const stack = [y * w + x];
  cells[y * w + x] = id;
  while (stack.length) {
    const i = stack.pop()!;
    const cx = i % w;
    if (cx > 0 && cells[i - 1] === target) { cells[i - 1] = id; stack.push(i - 1); }
    if (cx < w - 1 && cells[i + 1] === target) { cells[i + 1] = id; stack.push(i + 1); }
    if (i >= w && cells[i - w] === target) { cells[i - w] = id; stack.push(i - w); }
    if (i < w * (h - 1) && cells[i + w] === target) { cells[i + w] = id; stack.push(i + w); }
  }
  return true;
}

export function replaceAll(cells: Uint16Array, from: number, to: number): boolean {
  if (from === to) return false;
  let changed = false;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === from) { cells[i] = to; changed = true; }
  }
  return changed;
}

/**
 * Removes stray stitches: a square with too few same-colored neighbours takes the
 * most common color around it. Higher levels remove bigger specks.
 * Returns how many squares changed.
 */
export function despeckle(cells: Uint16Array, w: number, h: number, level: number): number {
  let changed = 0;
  const vals = new Uint16Array(8), cnts = new Uint8Array(8);
  for (let pass = 0; pass < level; pass++) {
    const src = cells.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, v = src[i];
        let same = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((dx === 0 && dy === 0) || xx < 0 || xx >= w) continue;
            const nv = src[yy * w + xx];
            if (nv === v) { same++; continue; }
            let k = 0;
            while (k < n && vals[k] !== nv) k++;
            if (k === n) { vals[n] = nv; cnts[n] = 0; n++; }
            cnts[k]++;
          }
        }
        if (same > level - 1 || n === 0) continue;
        let best = 0;
        for (let k = 1; k < n; k++) if (cnts[k] > cnts[best]) best = k;
        if (cnts[best] > same) { cells[i] = vals[best]; changed++; }
      }
    }
  }
  return changed;
}

/** Local tidy for one square: if it has at most two same-colored neighbours, it takes the most common color around it. */
export function tidyCell(cells: Uint16Array, w: number, h: number, x: number, y: number): void {
  const v = cells[y * w + x];
  const tally = new Map<number, number>();
  let same = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if ((dx === 0 && dy === 0) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const nv = cells[yy * w + xx];
      if (nv === v) same++;
      else tally.set(nv, (tally.get(nv) ?? 0) + 1);
    }
  }
  if (same > 2) return;
  let best = v, bestN = same;
  for (const [nv, n] of tally) if (n > bestN) { best = nv; bestN = n; }
  cells[y * w + x] = best;
}

/** Merges the least-used colors into their closest remaining color until only `target` are left. */
export function reduceColors(p: Pattern, target: number): void {
  removeUnused(p);
  const counts = countCells(p);
  const lab = new Map(p.palette.map((c) => [c.id, hexToOklab(c.hex)]));
  while (p.palette.length > Math.max(1, target)) {
    // Locked colors are never merged away, though others may merge into them.
    const free = p.palette.filter((c) => !c.locked);
    if (!free.length) break;
    let least = free[0];
    for (const c of free) if ((counts.get(c.id) ?? 0) < (counts.get(least.id) ?? 0)) least = c;
    const a = lab.get(least.id)!;
    let near = least, nearD = Infinity;
    for (const c of p.palette) {
      if (c === least) continue;
      const b = lab.get(c.id)!;
      const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      if (d < nearD) { nearD = d; near = c; }
    }
    counts.set(near.id, (counts.get(near.id) ?? 0) + (counts.get(least.id) ?? 0));
    mergeColor(p, least.id, near.id);
  }
}

export function mergeColor(p: Pattern, from: number, to: number): void {
  replaceAll(p.cells, from, to);
  for (const b of p.backstitches) if (b.colorId === from) b.colorId = to;
  p.palette = p.palette.filter((c) => c.id !== from);
}

export function removeColor(p: Pattern, id: number): void {
  replaceAll(p.cells, id, 0);
  p.backstitches = p.backstitches.filter((b) => b.colorId !== id);
  p.palette = p.palette.filter((c) => c.id !== id);
}

export function removeUnused(p: Pattern): void {
  const counts = countCells(p);
  const inLines = new Set(p.backstitches.map((b) => b.colorId));
  p.palette = p.palette.filter((c) => counts.has(c.id) || inLines.has(c.id));
}

/** Changes the canvas size, keeping the top-left corner in place. */
export function resized(p: Pattern, width: number, height: number): Pattern {
  const cells = new Uint16Array(width * height);
  const w = Math.min(width, p.width), h = Math.min(height, p.height);
  for (let y = 0; y < h; y++) cells.set(p.cells.subarray(y * p.width, y * p.width + w), y * width);
  let done: Uint8Array | undefined;
  if (p.done) {
    done = new Uint8Array(width * height);
    for (let y = 0; y < h; y++) done.set(p.done.subarray(y * p.width, y * p.width + w), y * width);
  }
  const fits = (b: Backstitch) =>
    Math.max(b.x1, b.x2) <= width && Math.max(b.y1, b.y2) <= height;
  return { ...p, width, height, cells, done, backstitches: p.backstitches.filter(fits) };
}

/** Cuts the canvas down to a rectangle, carrying backstitches and guide pictures along. */
export function cropped(p: Pattern, r: { x: number; y: number; w: number; h: number }): Pattern {
  const cells = new Uint16Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) cells.set(p.cells.subarray((r.y + y) * p.width + r.x, (r.y + y) * p.width + r.x + r.w), y * r.w);
  const backstitches = p.backstitches
    .map((b) => ({ ...b, x1: b.x1 - r.x, y1: b.y1 - r.y, x2: b.x2 - r.x, y2: b.y2 - r.y }))
    .filter((b) => Math.min(b.x1, b.x2) >= 0 && Math.min(b.y1, b.y2) >= 0 && Math.max(b.x1, b.x2) <= r.w && Math.max(b.y1, b.y2) <= r.h);
  let reference = p.reference;
  if (reference) {
    const cv = reference.converted;
    let converted: Converted | undefined;
    if (cv && r.x + r.w <= cv.width && r.y + r.h <= cv.height) {
      const cc = new Uint16Array(r.w * r.h);
      for (let y = 0; y < r.h; y++) cc.set(cv.cells.subarray((r.y + y) * cv.width + r.x, (r.y + y) * cv.width + r.x + r.w), y * r.w);
      converted = { width: r.w, height: r.h, hexes: cv.hexes, cells: cc };
    }
    reference = { photo: reference.photo, rect: { ...reference.rect, x: reference.rect.x - r.x, y: reference.rect.y - r.y }, converted };
  }
  let done: Uint8Array | undefined;
  if (p.done) {
    done = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) done.set(p.done.subarray((r.y + y) * p.width + r.x, (r.y + y) * p.width + r.x + r.w), y * r.w);
  }
  return { ...p, width: r.w, height: r.h, cells, done, backstitches, reference };
}

/** The smallest rectangle that holds every stitch and backstitch, or null for an empty pattern. */
export function contentBounds(p: Pattern): { x: number; y: number; w: number; h: number } | null {
  let x0 = p.width, y0 = p.height, x1 = 0, y1 = 0;
  for (let y = 0; y < p.height; y++) {
    for (let x = 0; x < p.width; x++) {
      if (!p.cells[y * p.width + x]) continue;
      if (x < x0) x0 = x;
      if (x + 1 > x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y + 1 > y1) y1 = y + 1;
    }
  }
  for (const b of p.backstitches) {
    x0 = Math.min(x0, Math.floor(Math.min(b.x1, b.x2))); x1 = Math.max(x1, Math.ceil(Math.max(b.x1, b.x2)));
    y0 = Math.min(y0, Math.floor(Math.min(b.y1, b.y2))); y1 = Math.max(y1, Math.ceil(Math.max(b.y1, b.y2)));
  }
  x1 = Math.max(x1, x0 + 1);
  y1 = Math.max(y1, y0 + 1);
  return x0 < p.width && y0 < p.height ? { x: x0, y: y0, w: Math.min(x1, p.width) - x0, h: Math.min(y1, p.height) - y0 } : null;
}

/** Grid-line segments that run along every boundary between stitched and empty squares. */
export function outlineEdges(p: Pattern): { x1: number; y1: number; x2: number; y2: number }[] {
  const { width: w, height: h, cells } = p;
  return edgesOf(w, h, (x, y) => x >= 0 && y >= 0 && x < w && y < h && cells[y * w + x] !== 0);
}

/** Grid-line segments along every boundary of the region for which `filled` is true, joined into long runs. */
export function edgesOf(w: number, h: number, filled: (x: number, y: number) => boolean): { x1: number; y1: number; x2: number; y2: number }[] {
  const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (let y = 0; y <= h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && filled(x, y - 1) !== filled(x, y);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) { out.push({ x1: start, y1: y, x2: x, y2: y }); start = -1; }
    }
  }
  for (let x = 0; x <= w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && filled(x - 1, y) !== filled(x, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) { out.push({ x1: x, y1: start, x2: x, y2: y }); start = -1; }
    }
  }
  return out;
}

/** Stitched squares that sit right next to empty fabric. */
export function outlineCells(p: Pattern): number[] {
  const { width: w, height: h, cells } = p;
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!cells[i]) continue;
      if ((x > 0 && !cells[i - 1]) || (x < w - 1 && !cells[i + 1]) || (y > 0 && !cells[i - w]) || (y < h - 1 && !cells[i + w])) out.push(i);
    }
  }
  return out;
}

// ---- Saving and loading -------------------------------------------------

function encodeRuns(cells: ArrayLike<number>): number[] {
  const runs: number[] = [];
  for (let i = 0; i < cells.length; ) {
    const v = cells[i];
    let j = i + 1;
    while (j < cells.length && cells[j] === v) j++;
    runs.push(v, j - i);
    i = j;
  }
  return runs;
}

function decodeRuns(runs: number[], length: number): Uint16Array {
  const cells = new Uint16Array(length);
  let i = 0;
  for (let r = 0; r + 1 < runs.length; r += 2) {
    const n = Math.min(runs[r + 1], length - i);
    cells.fill(runs[r], i, i + n);
    i += n;
  }
  return cells;
}

export function serialize(p: Pattern, withPhoto = true): string {
  const ref = p.reference;
  const reference = ref && {
    photo: withPhoto ? ref.photo : undefined,
    rect: ref.rect,
    converted: ref.converted && { ...ref.converted, cells: encodeRuns(ref.converted.cells) },
  };
  return JSON.stringify({
    app: 'crosspattern',
    version: 1,
    name: p.name,
    width: p.width,
    height: p.height,
    palette: p.palette,
    backstitches: p.backstitches,
    cells: encodeRuns(p.cells),
    fabric: p.fabric,
    done: p.done?.some((v) => v) ? encodeRuns(p.done) : undefined,
    reference,
  });
}

export function deserialize(text: string): Pattern {
  const d = JSON.parse(text);
  const okSize = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_SIZE;
  if (d?.app !== 'crosspattern' || !okSize(d.width) || !okSize(d.height) || !Array.isArray(d.cells)) {
    throw new Error('This is not a CrossPattern file.');
  }
  const cells = decodeRuns(d.cells, d.width * d.height);
  const palette: PaletteColor[] = (d.palette ?? [])
    .filter((c: PaletteColor) => Number.isInteger(c?.id) && /^#[0-9a-f]{6}$/i.test(c?.hex))
    .map((c: PaletteColor) => ({ id: c.id, hex: c.hex.toLowerCase(), symbol: String(c.symbol ?? '?'), locked: c.locked ? true : undefined }));
  const ids = new Set(palette.map((c) => c.id));
  for (let k = 0; k < cells.length; k++) if (!ids.has(cells[k])) cells[k] = 0;
  const backstitches: Backstitch[] = (d.backstitches ?? []).filter(
    (b: Backstitch) => ids.has(b?.colorId) && [b.x1, b.y1, b.x2, b.y2].every(Number.isFinite),
  );
  let reference: Reference | undefined;
  const r = d.reference;
  if (r && [r.rect?.x, r.rect?.y, r.rect?.w, r.rect?.h].every(Number.isFinite)) {
    const cv = r.converted;
    const hexOk = (s: unknown) => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);
    reference = {
      photo: typeof r.photo === 'string' && r.photo.startsWith('data:image/') ? r.photo : undefined,
      rect: { x: r.rect.x, y: r.rect.y, w: r.rect.w, h: r.rect.h },
      converted: cv && okSize(cv.width) && okSize(cv.height) && Array.isArray(cv.hexes) && cv.hexes.every(hexOk) && Array.isArray(cv.cells)
        ? { width: cv.width, height: cv.height, hexes: cv.hexes, cells: decodeRuns(cv.cells, cv.width * cv.height).map((v) => (v <= cv.hexes.length ? v : 0)) }
        : undefined,
    };
    if (!reference.photo && !reference.converted) reference = undefined;
  }
  const fabric = typeof d.fabric === 'string' && /^#[0-9a-f]{6}$/i.test(d.fabric) ? d.fabric.toLowerCase() : undefined;
  const done = Array.isArray(d.done) ? Uint8Array.from(decodeRuns(d.done, cells.length), (v) => (v ? 1 : 0)) : undefined;
  return {
    name: String(d.name ?? 'Untitled pattern'), width: d.width, height: d.height, cells, palette, backstitches,
    reference, fabric, done,
  };
}

// ---- Sections, for stitching one patch at a time ------------------------

/**
 * Every square connected to `start` that has the same color, joined side by side and (with `corners`)
 * corner to corner too, the way a run of stitches is worked.
 */
export function connectedCells(cells: Uint16Array, w: number, h: number, start: number, corners = true): number[] {
  const color = cells[start], seen = new Uint8Array(cells.length), out = [start];
  seen[start] = 1;
  for (let k = 0; k < out.length; k++) {
    const i = out[k], x = i % w, y = (i / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || (!corners && dx && dy)) continue;
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (!seen[j] && cells[j] === color) { seen[j] = 1; out.push(j); }
    }
  }
  return out;
}

export interface Section {
  /** The squares in it. */
  cells: number[];
  /** Its bounding box, in squares. */
  x: number; y: number; w: number; h: number;
  /** How many of its squares are ticked off as stitched. */
  done: number;
}

/**
 * The separate patches of one color, in reading order (top to bottom, then left to right), with
 * `at` giving each square's section number (or -1 for squares of other colors).
 */
export function colorSections(p: Pattern, color: number): { list: Section[]; at: Int32Array } {
  const { width: w, height: h, cells } = p;
  const at = new Int32Array(cells.length).fill(-1), list: Section[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== color || at[i] >= 0) continue;
    const part = connectedCells(cells, w, h, i);
    let x0 = w, y0 = h, x1 = 0, y1 = 0, done = 0;
    for (const j of part) {
      at[j] = 0;
      const x = j % w, y = (j / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (p.done?.[j]) done++;
    }
    list.push({ cells: part, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, done });
  }
  // Found by scanning rows, so already top to bottom; sort so ties on the top row go left to right.
  list.sort((a, b) => a.y - b.y || a.x - b.x);
  list.forEach((s, k) => { for (const j of s.cells) at[j] = k; });
  return { list, at };
}

// ---- Cleaning up a converted pattern ------------------------------------

export interface CleanupOptions {
  /** 0-10: merge colors that look this alike (0 is off). */
  similar: number;
  /** Colors with fewer stitches than this are merged into the closest other color (0 is off). */
  rare: number;
  /** Patches of one color smaller than this many stitches take the color around them (0 is off). */
  patch: number;
  /** 0-3: smooth jagged edges and stray stitches. */
  smooth: number;
}

/** Turns the "look alike" setting into a distance between colors (Oklab). */
export const similarDistance = (level: number) => level * 0.012;

/**
 * Tidies a pattern after conversion, on a copy: colors that look alike are merged, rarely used colors
 * go, small patches take the color around them and jagged edges are smoothed. Locked colors are never
 * changed, though other colors may merge into them. Returns the tidied copy and how many squares changed.
 */
export function cleanUp(src: Pattern, o: CleanupOptions): { pattern: Pattern; changed: Uint8Array; count: number } {
  const p: Pattern = {
    ...src, cells: src.cells.slice(), palette: src.palette.map((c) => ({ ...c })),
    backstitches: src.backstitches.map((b) => ({ ...b })), done: src.done?.slice(),
  };
  const locked = new Set(p.palette.filter((c) => c.locked).map((c) => c.id));
  const lab = new Map(p.palette.map((c) => [c.id, hexToOklab(c.hex)]));
  const dist = (a: number, b: number) => {
    const x = lab.get(a)!, y = lab.get(b)!;
    return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2);
  };
  const merge = (from: number, to: number) => { mergeColor(p, from, to); };

  // Colors that look alike: the less used one merges into the other, closest pairs first.
  if (o.similar > 0) {
    const limit = similarDistance(o.similar);
    for (;;) {
      const counts = countCells(p), ids = p.palette.map((c) => c.id).filter((id) => counts.has(id));
      let best: [number, number] | null = null, bestD = limit;
      for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
        if (locked.has(ids[a]) && locked.has(ids[b])) continue;
        const d = dist(ids[a], ids[b]);
        if (d < bestD) { bestD = d; best = [ids[a], ids[b]]; }
      }
      if (!best) break;
      let [from, to] = (counts.get(best[0]) ?? 0) < (counts.get(best[1]) ?? 0) ? best : [best[1], best[0]];
      if (locked.has(from)) [from, to] = [to, from];
      merge(from, to);
    }
  }

  // Colors hardly used at all: each goes into the closest color that stays.
  if (o.rare > 0) {
    const counts = countCells(p);
    const rare = p.palette.filter((c) => !c.locked && counts.has(c.id) && counts.get(c.id)! < o.rare)
      .sort((a, b) => counts.get(a.id)! - counts.get(b.id)!);
    for (const c of rare) {
      const others = p.palette.filter((d) => d.id !== c.id && counts.has(d.id) && (counts.get(d.id)! >= o.rare || d.locked));
      if (!others.length) continue;
      let near = others[0];
      for (const d of others) if (dist(c.id, d.id) < dist(c.id, near.id)) near = d;
      counts.set(near.id, counts.get(near.id)! + counts.get(c.id)!);
      counts.delete(c.id);
      merge(c.id, near.id);
    }
  }

  if (o.patch > 1) mergeSmallPatches(p.cells, p.width, p.height, o.patch, locked);
  if (o.smooth > 0) {
    const before = p.cells.slice();
    despeckle(p.cells, p.width, p.height, o.smooth);
    for (let i = 0; i < before.length; i++) if (locked.has(before[i])) p.cells[i] = before[i];
  }

  removeUnused(p);
  const changed = new Uint8Array(p.cells.length);
  let count = 0;
  for (let i = 0; i < changed.length; i++) {
    if (p.cells[i] !== src.cells[i]) {
      changed[i] = 1;
      count++;
      if (p.done && !p.cells[i]) p.done[i] = 0;
    }
  }
  return { pattern: p, changed, count };
}

/**
 * Patches of one color (squares joined side by side) smaller than `minSize` take the color they share the
 * most border with, smallest patches first. Empty fabric counts as a color here, so specks floating in
 * the background go and pinholes in the design fill in. Returns how many squares changed.
 */
export function mergeSmallPatches(cells: Uint16Array, w: number, h: number, minSize: number, locked = new Set<number>()): number {
  const n = w * h, patchOf = new Int32Array(n).fill(-1), patches: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (patchOf[s] >= 0) continue;
    const v = cells[s], list = [s], id = patches.length;
    patchOf[s] = id;
    for (let k = 0; k < list.length; k++) {
      const i = list[k], x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
        if (j >= 0 && patchOf[j] < 0 && cells[j] === v) { patchOf[j] = id; list.push(j); }
      }
    }
    patches.push(list);
  }
  let changed = 0;
  const order = patches.map((_, k) => k).filter((k) => patches[k].length < minSize).sort((a, b) => patches[a].length - patches[b].length);
  const tally = new Map<number, number>();
  for (const k of order) {
    const list = patches[k], v = cells[list[0]];
    if (locked.has(v)) continue;
    tally.clear();
    for (const i of list) {
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
        if (j >= 0 && cells[j] !== v) tally.set(cells[j], (tally.get(cells[j]) ?? 0) + 1);
      }
    }
    let best = -1, bestN = 0;
    for (const [u, c] of tally) if (c > bestN) { best = u; bestN = c; }
    if (best < 0) continue;
    for (const i of list) cells[i] = best;
    changed += list.length;
  }
  return changed;
}

// ---- The order to stitch a section in -------------------------------------

/**
 * How a section is worked. "rows" is the Danish method: half stitches all along a row, then back along
 * the same row to cross them, so each row ends where it began. "single" is the English method: each
 * cross is finished before the next, snaking back and forth.
 */
export type StitchMethod = 'rows' | 'single';

/** One row (or column) of a section, with its squares in the order they are stitched. */
export interface Run { cells: number[]; vertical: boolean }

/** Further than this many squares, the thread should be finished off and started again rather than carried behind. */
export const MAX_CARRY = 3;

/**
 * Plans the order to stitch a section in, the way stitchers usually do: in rows from the top down,
 * starting at the top left, each row beginning at whichever end is nearest the thread. Tall, thin shapes
 * are worked in columns instead. Rows that are moved to by going back up are avoided where possible,
 * so the hand does not rub over finished stitches.
 *
 * `cells` are the squares still to stitch, so stitches already done, in any order, are simply left out
 * and a row broken by them becomes two. With `from` (a square where the thread is now), the plan starts
 * from the nearest row to it instead of the top left. If `from` is itself one of the squares to stitch
 * (a start chosen by hand), the plan starts on exactly that square; if it is partway along a row, the row
 * is split there and the rest of it is done later.
 */
export function stitchRoute(cells: number[], width: number, method: StitchMethod, from = -1): Run[] {
  if (!cells.length) return [];
  const set = new Set(cells);
  const X = (i: number) => i % width, Y = (i: number) => (i / width) | 0;
  const runsOf = (vertical: boolean) => {
    const step = vertical ? width : 1, out: number[][] = [];
    const sorted = [...cells].sort(vertical ? (a, b) => X(a) - X(b) || Y(a) - Y(b) : (a, b) => a - b);
    for (const i of sorted) {
      // Only start a run at a square with nothing before it in the same row (or column).
      const before = i - step;
      if (vertical ? set.has(before) : X(i) > 0 && set.has(before)) continue;
      const run = [i];
      for (let j = i + step; vertical ? set.has(j) : X(j) > X(j - 1) && set.has(j); j += step) run.push(j);
      out.push(run);
    }
    return out;
  };
  const rows = runsOf(false), cols = runsOf(true);
  // Columns only when they are clearly the longer way: a thin upright line, a tall narrow patch.
  const vertical = cols.length * 1.5 <= rows.length;
  const pool = vertical ? cols : rows;
  // A chosen start partway along a row: split the row there, so the plan can begin on that square.
  let startRun = -1;
  if (from >= 0 && set.has(from)) {
    const r = pool.findIndex((run) => run.includes(from)), j = pool[r].indexOf(from);
    // At either end the row is simply worked from there; in the middle it is split.
    if (j > 0 && j < pool[r].length - 1) { pool.push(pool[r].slice(0, j)); pool[r] = pool[r].slice(j); }
    startRun = r;
  }
  const used = new Uint8Array(pool.length), out: Run[] = [];
  // Distance to move the thread, with going back up (or back left, for columns) counted as costing more.
  const cost = (from: number, to: number) => {
    const dx = X(to) - X(from), dy = Y(to) - Y(from);
    const back = vertical ? Math.max(0, -dx) : Math.max(0, -dy);
    return Math.abs(dx) + Math.abs(dy) + back * 3;
  };
  let k = 0, forward = true;
  if (startRun >= 0) {
    k = startRun;
    // Begin on the chosen square and work away from it: the run starts there, unless it is the far end.
    forward = pool[k][0] === from;
  } else if (from >= 0) {
    let bestCost = Infinity;
    pool.forEach((run, r) => {
      const ca = cost(from, run[0]), cb = cost(from, run[run.length - 1]);
      if (ca < bestCost) { bestCost = ca; k = r; forward = true; }
      if (cb < bestCost) { bestCost = cb; k = r; forward = false; }
    });
  }
  for (;;) {
    used[k] = 1;
    const run = forward ? pool[k] : [...pool[k]].reverse();
    out.push({ cells: run, vertical });
    // Where the thread is now: back at the start of a row worked there and back, or at its far end.
    const at = method === 'rows' ? run[0] : run[run.length - 1];
    let best = -1, bestCost = Infinity, bestForward = true;
    for (let r = 0; r < pool.length; r++) {
      if (used[r]) continue;
      const a = pool[r][0], b = pool[r][pool[r].length - 1];
      const ca = cost(at, a), cb = cost(at, b);
      if (ca < bestCost) { bestCost = ca; best = r; bestForward = true; }
      if (cb < bestCost) { bestCost = cb; best = r; bestForward = false; }
    }
    if (best < 0) break;
    k = best;
    forward = bestForward;
  }
  return out;
}

/** Where the thread is after a run: back at its start for rows worked there and back, otherwise at its end. */
export const threadAfter = (run: Run, method: StitchMethod) => (method === 'rows' ? run.cells[0] : run.cells[run.cells.length - 1]);

/** How far the thread moves between two squares, in squares (a diagonal step counts as one). */
export const carry = (from: number, to: number, width: number) =>
  Math.max(Math.abs((from % width) - (to % width)), Math.abs(((from / width) | 0) - ((to / width) | 0)));

// ---- How much thread a section takes ------------------------------------

export interface ThreadOptions {
  /** Fabric count: squares per inch. */
  count: number;
  /** The longest length to thread a needle with, in mm (longer tangles and wears). */
  maxLength: number;
  method: StitchMethod;
}

/**
 * Thread used per full cross, in mm: two diagonals on the front and two short runs on the back, plus
 * what goes through the fabric and into tension. Matches the usual rule of thumb that a skein (8 m of
 * six strands) does about 1,800 stitches in two strands on 14-count. Finishing each cross before the
 * next takes a little more, from the longer way it travels on the back.
 */
export const perStitch = (count: number, method: StitchMethod) => (184 / count) * (method === 'single' ? 1.08 : 1);

/** Thread used up by starting a length (anchored under the first stitches) and finishing it off, in mm. */
export const TIE_OFF = 100;

/** One length of thread to cut: how long, and the row (and stitch in it) where it runs out. */
export interface ThreadLength { mm: number; endRun: number; endStitch: number }

/**
 * Plans the thread for some rows, in the order they will be stitched: how much in all, and how to cut
 * it into lengths no longer than `maxLength`. A length is changed at the end of a row where it can be,
 * so you are not left finishing off in the middle of one, and always before a move that is too long to
 * carry. Each length allows for starting and finishing off, and is rounded up to the next 5 cm.
 */
export function planThread(runs: Run[], width: number, o: ThreadOptions): { total: number; lengths: ThreadLength[] } {
  const per = perStitch(o.count, o.method), cell = 25.4 / o.count, usable = Math.max(per * 2, o.maxLength - TIE_OFF);
  const lengths: ThreadLength[] = [];
  let used = 0, total = 0, last: { run: number; stitch: number } | null = null;
  const close = () => {
    if (!last) return;
    lengths.push({ mm: Math.min(o.maxLength, Math.ceil((used + TIE_OFF) / 50) * 50), endRun: last.run, endStitch: last.stitch });
    total += used + TIE_OFF;
    used = 0;
    last = null;
  };
  runs.forEach((run, k) => {
    let move = 0;
    if (k > 0) {
      const d = carry(threadAfter(runs[k - 1], o.method), run.cells[0], width);
      if (d > MAX_CARRY) close(); else move = Math.max(0, d - 1) * cell;
    }
    const need = move + run.cells.length * per;
    // Change thread at this row's start if it will not fit, as long as the thread so far is mostly used.
    if (last && used + need > usable && used > usable * 0.5) { close(); move = 0; }
    used += move;
    for (let j = 0; j < run.cells.length; j++) {
      if (last && used + per > usable) close();
      used += per;
      last = { run: k, stitch: j };
    }
  });
  close();
  return { total: Math.round(total), lengths };
}
