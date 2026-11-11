import { describe, expect, it } from 'vitest';
import { hexToOklab, hexToRgb, rgbToOklab } from './color';
import { Sampled, quantize } from './convert';
import {
  Base, CARTOON0, FLAT0, LabelMap, NONE, REMOVE, areaIds, fillHoles, fillShape, findShapes, fillUnmarked, makeLabels,
  nextCartoonId, remapLabels, snapStroke, stamp, stampLine,
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
  it('snaps a brush stroke to the edge it runs along', () => {
    const base = halves(), m = blank();
    // A stroke just left of the boundary, with a brush wide enough to spill over it.
    snapStroke(m, base, [[16, 5], [16, 25]], 5, 0.09, 9);
    expect(m.data[15 * 40 + 16]).toBe(9);
    expect(m.data[15 * 40 + 18]).toBe(9);  // spreads up to the edge
    expect(m.data[15 * 40 + 22]).toBe(NONE); // and stops there
    expect(m.data[15 * 40 + 1]).toBe(NONE);  // without running away across the picture
  });
});
