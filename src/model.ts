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
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && cells[y * w + x] !== 0;
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
