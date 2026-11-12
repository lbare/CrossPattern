import { describe, expect, it } from 'vitest';
import { hexToOklab, hexToRgb, rgbToOklab } from './color';
import { Sampled, quantize } from './convert';
import {
  Base, CARTOON0, FLAT0, LabelMap, NONE, REMOVE, areaIds, fillHoles, fillShape, findShapes, fillUnmarked, makeLabels,
  combine, growMask, nextCartoonId, remapLabels, shapeMask, smartStroke, smoothMask, snapBoundaries, stamp, stampLine,
} from './marks';

/** A sampled picture from rows of letters, each letter a color. '.' is transparent. */
const COLORS: Record<string, string> = { r: '#d02020', g: '#20a040', b: '#2040c0', w: '#f4f4f4', k: '#101010', o: '#e08020' };
function sampled(rows: string[], labels?: number[][]): Sampled {
  const w = rows[0].length, h = rows.length, n = w * h;
  const s: Sampled = { w, h, L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n), mask: new Uint8Array(n), label: new Uint8Array(n) };
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const i = y * w + x;
    if (labels) s.label[i] = labels[y][x];
    if (ch === '.' || s.label[i] === REMOVE) return;
    const [L, A, B] = rgbToOklab(...hexToRgb(COLORS[ch]));
    s.L[i] = L; s.A[i] = A; s.B[i] = B; s.mask[i] = 1;
  }));
  return s;
}
const opts = { colors: 4, smooth: 0, clean: 0 };

describe('quantize', () => {
  it('finds the colors of a simple picture', () => {
    const r = quantize(sampled(['rrgg', 'rrgg', 'rrgg']), { ...opts, colors: 2 });
    expect(r.palette).toHaveLength(2);
    expect(r.cells[0]).toBe(r.cells[4]);
    expect(r.cells[0]).not.toBe(r.cells[3]);
    expect([...r.cells].every((v) => v > 0)).toBe(true);
  });
  it('never uses more colors than asked for', () => {
    const r = quantize(sampled(['rgbw', 'kogr', 'bwko']), { ...opts, colors: 3 });
    expect(r.palette.length).toBeLessThanOrEqual(3);
  });
  it('gives the same result every time', () => {
    const s = sampled(['rgbw', 'kogr', 'bwko', 'rrgg']);
    expect(quantize(s, opts)).toEqual(quantize(s, opts));
  });
  it('leaves transparent and removed squares empty', () => {
    const r = quantize(sampled(['r.gg', 'rrgg'], [[0, 0, 0, REMOVE], [0, 0, 0, 0]]), opts);
    expect(r.cells[1]).toBe(0);
    expect(r.cells[3]).toBe(0);
    expect(r.cells[0]).toBeGreaterThan(0);
  });
  it('returns an empty pattern for an empty picture', () => {
    const r = quantize(sampled(['..', '..']), opts);
    expect(r.palette).toEqual([]);
    expect([...r.cells]).toEqual([0, 0, 0, 0]);
  });
  it('orders the palette from most to least used', () => {
    const r = quantize(sampled(['rrrr', 'rrrr', 'rrrg']), { ...opts, colors: 2 });
    expect(r.cells[0]).toBe(1);
    expect(r.cells[11]).toBe(2);
  });

  describe('areas', () => {
    const A = CARTOON0, rows = ['rrogww', 'rorgww', 'rrogww', 'orrgww'];
    const labels = rows.map((row) => [...row].map((_, x) => (x < 3 ? A : NONE)));
    it('gives an area one flat color when asked', () => {
      const r = quantize(sampled(rows, labels), { ...opts, outline: false, areaTones: { [A]: 1 } });
      const inArea = new Set(rows.flatMap((_, y) => [0, 1, 2].map((x) => r.cells[y * 6 + x])));
      expect(inArea.size).toBe(1);
    });
    it('gives an area its own tones, separate from the rest', () => {
      // Two solid blocks inside the area, so both tones survive the tidy step.
      const wide = ['rroogww', 'rroogww', 'rroogww', 'rroogww'];
      const marks = wide.map((row) => [...row].map((_, x) => (x < 4 ? A : NONE)));
      const r = quantize(sampled(wide, marks), { ...opts, colors: 2, outline: false, areaTones: { [A]: 2 } });
      const inArea = new Set(wide.flatMap((_, y) => [0, 1, 2, 3].map((x) => r.cells[y * 7 + x])));
      const outside = new Set(wide.flatMap((_, y) => [4, 5, 6].map((x) => r.cells[y * 7 + x])));
      expect(inArea.size).toBe(2);
      expect([...inArea].some((v) => outside.has(v))).toBe(false);
    });
    it('treats old one-color areas as a single color by default', () => {
      const flat = rows.map((row) => [...row].map((_, x) => (x < 3 ? FLAT0 : NONE)));
      const r = quantize(sampled(rows, flat), { ...opts, outline: false });
      expect(new Set(rows.flatMap((_, y) => [0, 1, 2].map((x) => r.cells[y * 6 + x]))).size).toBe(1);
    });
    it('keeps full detail when the area is set to it', () => {
      const r = quantize(sampled(rows, labels), { ...opts, colors: 6, areaTones: { [A]: 0 } });
      expect(new Set(rows.flatMap((_, y) => [0, 1, 2].map((x) => r.cells[y * 6 + x]))).size).toBeGreaterThan(1);
    });
    it('feathers an edge using only the colors on either side, with no outline', () => {
      const wide = ['rrrrgggg', 'rrrrgggg', 'rrrrgggg', 'rrrrgggg'];
      const marks = wide.map((row) => [...row].map((_, x) => (x < 4 ? A : NONE)));
      const hard = quantize(sampled(wide, marks), { ...opts, colors: 1, outline: true, areaTones: { [A]: 1 } });
      const soft = quantize(sampled(wide, marks), { ...opts, colors: 1, outline: true, areaTones: { [A]: 1 }, areaFeather: { [A]: 2 } });
      expect(hard.palette).toHaveLength(3); // red, green and the outline
      expect(soft.palette).toHaveLength(2); // no outline when the edge is soft
      expect([...soft.cells].every((v) => v > 0)).toBe(true);
    });
    it('draws a dark outline where an area meets something else', () => {
      const r = quantize(sampled(rows, labels), { ...opts, outline: true, areaTones: { [A]: 1 } });
      const edge = r.palette[r.cells[2] - 1], inner = r.palette[r.cells[0] - 1];
      expect(edge).not.toBe(inner);
      expect(hexToOklab(edge)[0]).toBeLessThan(0.3);
      // Column 0 is on the canvas edge, not next to anything else, so it is not outlined.
      expect(r.cells[0]).toBe(r.cells[1]);
    });
  });

  it('lifts shadows without touching white', () => {
    const dark = sampled(['kkkk', 'wwww'].map((r) => r.replace(/k/g, 'b')));
    const before = quantize(dark, { ...opts, colors: 2 }), after = quantize(dark, { ...opts, colors: 2, lift: 100 });
    const L = (r: typeof before, i: number) => hexToOklab(r.palette[r.cells[i] - 1])[0];
    expect(L(after, 0)).toBeGreaterThan(L(before, 0) + 0.05);
    expect(Math.abs(L(after, 4) - L(before, 4))).toBeLessThan(0.03);
  });
});

/** A fake photo for the marking tools: left half one color, right half another, with a little noise. */
function halves(w = 40, h = 30): Base {
  const n = w * h, base = { image: { data: new Uint8ClampedArray(n * 4) }, L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, rgb = hexToRgb(x < w / 2 ? COLORS.o : COLORS.b).map((v) => v + ((x * 7 + y * 13) % 5) - 2) as [number, number, number];
    const [L, A, B] = rgbToOklab(...rgb);
    base.L[i] = L; base.A[i] = A; base.B[i] = B;
    base.image.data.set([...rgb, 255], i * 4);
  }
  return base as unknown as Base;
}
const blank = (w = 40, h = 30): LabelMap => ({ w, h, data: new Uint8Array(w * h) });

describe('marking tools', () => {
  it('stamps a brush dab and a stroke', () => {
    const m = blank();
    stamp(m, 10, 10, 3, 5);
    expect(m.data[10 * 40 + 10]).toBe(5);
    expect(m.data[0]).toBe(0);
    stampLine(m, 5, 20, 30, 20, 2, 7);
    expect(m.data[20 * 40 + 18]).toBe(7);
  });
  it('hands out area ids and lists them', () => {
    const m = blank();
    expect(nextCartoonId(m)).toBe(CARTOON0);
    stamp(m, 5, 5, 2, CARTOON0);
    expect(nextCartoonId(m)).toBe(CARTOON0 + 1);
    stamp(m, 20, 20, 2, FLAT0);
    expect(areaIds(m)).toEqual([FLAT0, CARTOON0]);
  });
  it('fills everything unmarked', () => {
    const m = blank(4, 2);
    m.data[0] = REMOVE;
    fillUnmarked(m, 9);
    expect([...m.data]).toEqual([REMOVE, 9, 9, 9, 9, 9, 9, 9]);
  });
  it('closes small holes inside a mark but not gaps open to the outside', () => {
    const m = blank(10, 10);
    for (let y = 2; y <= 7; y++) for (let x = 2; x <= 7; x++) m.data[y * 10 + x] = 9;
    m.data[4 * 10 + 4] = NONE; // enclosed speck
    fillHoles(m, 9, 5);
    expect(m.data[4 * 10 + 4]).toBe(9);
    expect(m.data[0]).toBe(NONE);
  });
  it('does not swallow a different mark that sits inside', () => {
    const m = blank(10, 10);
    for (let y = 2; y <= 7; y++) for (let x = 2; x <= 7; x++) m.data[y * 10 + x] = 9;
    m.data[4 * 10 + 4] = NONE; m.data[4 * 10 + 5] = REMOVE;
    fillHoles(m, 9, 5);
    expect(m.data[4 * 10 + 4]).toBe(NONE);
  });
  it('keeps marks in place when the crop is unchanged', () => {
    const m = makeLabels(4 / 3);
    stamp(m, 100, 100, 10, 5);
    const crop = { x: 0, y: 0, w: 400, h: 300 };
    expect([...remapLabels(m, crop, crop).data]).toEqual([...m.data]);
  });
  it('splits a picture into its obvious shapes', () => {
    const base = halves(), shapes = findShapes(base, 40, 30, 5);
    const left = shapes.id[15 * 40 + 5], right = shapes.id[15 * 40 + 35];
    expect(left).not.toBe(right);
    expect(shapes.id[2 * 40 + 2]).toBe(left);
    expect(shapes.id[28 * 40 + 38]).toBe(right);
    expect(new Set(shapes.id).size).toBe(2);
  });
  it('marks a whole shape with one click', () => {
    const base = halves(), m = blank();
    fillShape(m, findShapes(base, 40, 30, 5), 5, 15, 9);
    expect(m.data[15 * 40 + 2]).toBe(9);
    expect(m.data[15 * 40 + 30]).toBe(NONE);
  });
  it('follows the edge with the smart brush', () => {
    const base = halves(), fine = findShapes(base, 40, 30, 2);
    // A stroke just left of the boundary, with a brush wide enough to spill over it.
    const hit = smartStroke(base, fine, 40, 30, [[16, 5], [16, 25]], 4, 0.09);
    expect(hit[15 * 40 + 16]).toBe(1);
    expect(hit[15 * 40 + 19]).toBe(1); // reaches the edge
    expect(hit[15 * 40 + 21]).toBe(0); // and stops there
  });
  it('adds to and subtracts from a selection', () => {
    const base = halves(), shapes = findShapes(base, 40, 30, 5), sel = new Uint8Array(40 * 30);
    combine(sel, shapeMask(shapes, 40, 30, 5, 15), false);
    expect(sel[15 * 40 + 5]).toBe(1);
    expect(sel[15 * 40 + 30]).toBe(0);
    combine(sel, shapeMask(shapes, 40, 30, 30, 15), false);
    expect(sel[15 * 40 + 30]).toBe(1);
    combine(sel, shapeMask(shapes, 40, 30, 5, 15), true);
    expect(sel[15 * 40 + 5]).toBe(0);
    expect(sel[15 * 40 + 30]).toBe(1);
  });
  it('grows and shrinks a selection', () => {
    const sel = new Uint8Array(100);
    sel[5 * 10 + 5] = 1;
    growMask(sel, 10, 10, 1);
    expect(sel.reduce((a, v) => a + v, 0)).toBe(5);
    growMask(sel, 10, 10, -1);
    expect(sel.reduce((a, v) => a + v, 0)).toBe(1);
  });
  it('smooths a ragged selection edge', () => {
    const sel = new Uint8Array(20 * 20);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) sel[y * 20 + x] = 1;
    sel[10 * 20 + 16] = 1; // a spike sticking out
    sel[10 * 20 + 10] = 0; // a pinhole
    smoothMask(sel, 20, 20, 2);
    expect(sel[10 * 20 + 16]).toBe(0);
    expect(sel[10 * 20 + 10]).toBe(1);
    expect(sel[10 * 20 + 8]).toBe(1);
  });
});

describe('snapping to edges', () => {
  /** A noisy photo: dark red on the left of x = 40, brown on the right, as Oklab. */
  function twoTone(w: number, h: number, edgeAt: (y: number) => number): Base {
    const n = w * h, base: Base = { image: null as unknown as ImageData, L: new Float32Array(n), A: new Float32Array(n), B: new Float32Array(n) };
    let seed = 7;
    const noise = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647 - 0.5) * 0.06; };
    const red = rgbToOklab(...hexToRgb('#5a1a20')), brown = rgbToOklab(...hexToRgb('#7a5a3a'));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = x < edgeAt(y) ? red : brown, i = y * w + x;
      base.L[i] = c[0] + noise(); base.A[i] = c[1] + noise() * 0.3; base.B[i] = c[2] + noise() * 0.3;
    }
    return base;
  }
  const edgeOf = (sel: Uint8Array, w: number, y: number) => { let x = 0; while (x < w && sel[y * w + x]) x++; return x; };

  it('pulls a selection that spilled over an edge back onto it', () => {
    const w = 120, h = 60, base = twoTone(w, h, () => 40), sel = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < 49; x++) sel[y * w + x] = 1; // 9 pixels too far
    snapBoundaries(sel, base, w, h, null, 12);
    for (const y of [10, 30, 50]) expect(Math.abs(edgeOf(sel, w, y) - 40)).toBeLessThanOrEqual(1);
  });

  it('pushes a selection that fell short out to the edge, and follows a slanted edge', () => {
    const w = 120, h = 60, edge = (y: number) => 30 + Math.floor(y / 3), base = twoTone(w, h, edge), sel = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < 36; x++) sel[y * w + x] = 1;
    snapBoundaries(sel, base, w, h, null, 12);
    for (const y of [5, 20, 30, 45]) expect(Math.abs(edgeOf(sel, w, y) - edge(y))).toBeLessThanOrEqual(1);
  });

  it('leaves pixels alone where it is not allowed to change them', () => {
    const w = 120, h = 60, base = twoTone(w, h, () => 40), sel = new Uint8Array(w * h), free = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < 49; x++) sel[y * w + x] = 1;
    for (let i = 0; i < w * 30; i++) free[i] = 1; // top half only
    snapBoundaries(sel, base, w, h, free, 12);
    expect(Math.abs(edgeOf(sel, w, 10) - 40)).toBeLessThanOrEqual(1);
    expect(edgeOf(sel, w, 50)).toBe(49);
  });

  it('settles the line between two marked areas', () => {
    const w = 120, h = 60, base = twoTone(w, h, () => 40), m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = x < 47 ? CARTOON0 : CARTOON0 + 1;
    snapBoundaries(m, base, w, h, null, 12);
    for (const y of [10, 30, 50]) { let x = 0; while (m[y * w + x] === CARTOON0) x++; expect(Math.abs(x - 40)).toBeLessThanOrEqual(1); }
  });
});
