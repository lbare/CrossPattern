import { describe, expect, it } from 'vitest';
import { hexToRgb, inkFor, oklabToRgb, rgbToHex, rgbToOklab } from './color';
import {
  MAX_CARRY, Pattern, Run, carry, cleanUp, colorSections, perStitch, planThread, stitchRoute, threadAfter, connectedCells, contentBounds, countCells, createPattern, cropped, deserialize, despeckle, edgesOf, floodFill, linePoints, mergeSmallPatches,
  mergeColor, outlineCells, outlineEdges, paletteFromHexes, reduceColors, removeColor, removeUnused, replaceAll,
  resized, serialize, tidyCell,
} from './model';

/** Builds a pattern from rows of digits: '0' is empty, '1'-'9' are palette ids. */
function grid(rows: string[], hexes = ['#000000', '#ffffff', '#ff0000', '#00ff00']): Pattern {
  const p = createPattern(rows[0].length, rows.length);
  p.palette = paletteFromHexes(hexes);
  rows.forEach((row, y) => [...row].forEach((ch, x) => { p.cells[y * p.width + x] = Number(ch); }));
  return p;
}
const rowsOf = (p: Pattern) =>
  Array.from({ length: p.height }, (_, y) => Array.from(p.cells.subarray(y * p.width, (y + 1) * p.width)).join(''));

describe('color', () => {
  it('converts hex to rgb and back', () => {
    expect(hexToRgb('#c8372d')).toEqual([200, 55, 45]);
    expect(rgbToHex(200, 55, 45)).toBe('#c8372d');
    expect(rgbToHex(-5, 300, 12.4)).toBe('#00ff0c');
  });
  it('round-trips through Oklab', () => {
    for (const rgb of [[0, 0, 0], [255, 255, 255], [200, 55, 45], [12, 180, 90]] as const) {
      const [r, g, b] = oklabToRgb(...rgbToOklab(rgb[0], rgb[1], rgb[2]));
      expect([Math.round(r), Math.round(g), Math.round(b)]).toEqual([...rgb]);
    }
  });
  it('picks readable ink', () => {
    expect(inkFor('#ffffff')).toBe('#000000');
    expect(inkFor('#101010')).toBe('#ffffff');
  });
});

describe('drawing helpers', () => {
  it('lists every square on a line, ends included', () => {
    const pts = linePoints(0, 0, 3, 3);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([3, 3]);
    expect(linePoints(2, 2, 2, 2)).toEqual([[2, 2]]);
    expect(linePoints(0, 0, 4, 0)).toHaveLength(5);
  });
  it('flood fills only the connected area', () => {
    const p = grid(['11011', '11011', '00000']);
    expect(floodFill(p.cells, p.width, p.height, 0, 0, 3)).toBe(true);
    expect(rowsOf(p)).toEqual(['33011', '33011', '00000']);
    expect(floodFill(p.cells, p.width, p.height, 0, 0, 3)).toBe(false);
  });
  it('replaces a color everywhere', () => {
    const p = grid(['1212', '2121']);
    expect(replaceAll(p.cells, 1, 3)).toBe(true);
    expect(rowsOf(p)).toEqual(['3232', '2323']);
    expect(replaceAll(p.cells, 9, 3)).toBe(false);
  });
  it('counts stitches per color, ignoring empty squares', () => {
    const counts = countCells(grid(['1102', '0002']));
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBe(2);
    expect(counts.has(0)).toBe(false);
  });
});

describe('tidying', () => {
  it('removes an isolated stitch', () => {
    const p = grid(['11111', '11211', '11111']);
    expect(despeckle(p.cells, p.width, p.height, 1)).toBe(1);
    expect(rowsOf(p)).toEqual(['11111', '11111', '11111']);
  });
  it('leaves solid areas alone', () => {
    const p = grid(['1122', '1122', '1122']);
    expect(despeckle(p.cells, p.width, p.height, 1)).toBe(0);
  });
  it('tidies one square on request', () => {
    const p = grid(['111', '121', '111']);
    tidyCell(p.cells, 3, 3, 1, 1);
    expect(p.cells[4]).toBe(1);
  });
});

describe('palette operations', () => {
  it('merges one color into another, including backstitches', () => {
    const p = grid(['1212']);
    p.backstitches.push({ x1: 0, y1: 0, x2: 1, y2: 0, colorId: 2 });
    mergeColor(p, 2, 1);
    expect(rowsOf(p)).toEqual(['1111']);
    expect(p.backstitches[0].colorId).toBe(1);
    expect(p.palette.some((c) => c.id === 2)).toBe(false);
  });
  it('removes a color and its stitches', () => {
    const p = grid(['1212']);
    removeColor(p, 2);
    expect(rowsOf(p)).toEqual(['1010']);
  });
  it('drops unused colors but keeps ones used only by backstitch', () => {
    const p = grid(['1100']);
    p.backstitches.push({ x1: 0, y1: 0, x2: 1, y2: 0, colorId: 3 });
    removeUnused(p);
    expect(p.palette.map((c) => c.id)).toEqual([1, 3]);
  });
  it('reduces to a number of colors by merging the least used', () => {
    const p = grid(['111111', '222223', '444444'], ['#000000', '#ff0000', '#fa0505', '#00ff00']);
    reduceColors(p, 3);
    expect(p.palette).toHaveLength(3);
    // The single near-red stitch joins red, its nearest color.
    expect(rowsOf(p)[1]).toBe('222222');
  });
  it('never merges away a locked color', () => {
    const p = grid(['111111', '222223'], ['#000000', '#ff0000', '#fa0505']);
    p.palette[2].locked = true;
    reduceColors(p, 1);
    expect(p.palette.some((c) => c.id === 3)).toBe(true);
    expect(p.cells[11]).toBe(3);
  });
});

describe('canvas changes', () => {
  it('resizes keeping the top-left corner', () => {
    const p = grid(['12', '34']);
    expect(rowsOf(resized(p, 3, 1))).toEqual(['120']);
    expect(rowsOf(resized(p, 1, 3))).toEqual(['1', '3', '0']);
  });
  it('carries stitch progress through a resize and a crop', () => {
    const p = grid(['12', '34']);
    p.done = Uint8Array.from([1, 0, 0, 1]);
    expect(Array.from(resized(p, 3, 2).done!)).toEqual([1, 0, 0, 0, 1, 0]);
    expect(Array.from(cropped(p, { x: 1, y: 1, w: 1, h: 1 }).done!)).toEqual([1]);
  });
  it('crops, shifting backstitches and dropping those outside', () => {
    const p = grid(['1111', '1111', '1111']);
    p.backstitches.push({ x1: 1, y1: 1, x2: 3, y2: 1, colorId: 1 }, { x1: 0, y1: 0, x2: 1, y2: 0, colorId: 1 });
    const c = cropped(p, { x: 1, y: 1, w: 3, h: 2 });
    expect([c.width, c.height]).toEqual([3, 2]);
    expect(c.backstitches).toEqual([{ x1: 0, y1: 0, x2: 2, y2: 0, colorId: 1 }]);
  });
  it('finds the bounds of the design', () => {
    expect(contentBounds(grid(['0000', '0110', '0010', '0000']))).toEqual({ x: 1, y: 1, w: 2, h: 2 });
    expect(contentBounds(grid(['00', '00']))).toBeNull();
  });
});

describe('outlines', () => {
  it('traces a block as four joined edges', () => {
    const edges = outlineEdges(grid(['0000', '0110', '0110', '0000']));
    expect(edges).toHaveLength(4);
    expect(edges).toContainEqual({ x1: 1, y1: 1, x2: 3, y2: 1 });
    expect(edges).toContainEqual({ x1: 3, y1: 1, x2: 3, y2: 3 });
  });
  it('traces any region given as a test', () => {
    expect(edgesOf(3, 3, (x, y) => x === 1 && y === 1)).toHaveLength(4);
  });
  it('lists stitches that touch empty fabric', () => {
    const p = grid(['111', '111', '111', '000']);
    expect(outlineCells(p).sort((a, b) => a - b)).toEqual([6, 7, 8]);
  });
});

describe('saving and loading', () => {
  it('round-trips a whole pattern', () => {
    const p = grid(['1200', '0034']);
    p.name = 'Test';
    p.fabric = '#112233';
    p.palette[0].locked = true;
    p.backstitches.push({ x1: 0, y1: 0, x2: 2, y2: 1, colorId: 1 });
    p.done = Uint8Array.from([1, 0, 0, 0, 0, 0, 1, 0]);
    p.reference = {
      photo: 'data:image/png;base64,AAAA',
      rect: { x: 0, y: 0, w: 4, h: 2 },
      converted: { width: 4, height: 2, hexes: ['#000000', '#ffffff'], cells: Uint16Array.from([1, 2, 0, 0, 0, 0, 2, 1]) },
    };
    const q = deserialize(serialize(p));
    expect(q.name).toBe('Test');
    expect(rowsOf(q)).toEqual(rowsOf(p));
    expect(q.palette).toEqual(p.palette);
    expect(q.backstitches).toEqual(p.backstitches);
    expect(q.fabric).toBe('#112233');
    expect(Array.from(q.done!)).toEqual(Array.from(p.done));
    expect(q.reference!.photo).toBe(p.reference.photo);
    expect(Array.from(q.reference!.converted!.cells)).toEqual(Array.from(p.reference.converted!.cells));
  });
  it('can leave the photo out', () => {
    const p = grid(['12']);
    p.reference = { photo: 'data:image/png;base64,AAAA', rect: { x: 0, y: 0, w: 2, h: 1 } };
    expect(deserialize(serialize(p, false)).reference).toBeUndefined();
  });
  it('rejects files that are not patterns', () => {
    expect(() => deserialize('{"hello":1}')).toThrow();
    expect(() => deserialize('not json')).toThrow();
    expect(() => deserialize(JSON.stringify({ app: 'crosspattern', width: 99999, height: 1, cells: [] }))).toThrow();
  });
  it('clears stitches whose color is missing from the palette', () => {
    const data = JSON.parse(serialize(grid(['12'])));
    data.palette = data.palette.filter((c: { id: number }) => c.id !== 2);
    expect(rowsOf(deserialize(JSON.stringify(data)))).toEqual(['10']);
  });
});

describe('sections', () => {
  it('joins stitches corner to corner, or only side by side when asked', () => {
    const p = grid(['1000', '0100', '0010']);
    expect(connectedCells(p.cells, 4, 3, 0)).toHaveLength(3);
    expect(connectedCells(p.cells, 4, 3, 0, false)).toHaveLength(1);
  });
  it('splits one color into separate patches in reading order', () => {
    const p = grid(['1100022', '1100022', '0000000', '0111000']);
    const { list, at } = colorSections(p, 1);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ x: 0, y: 0, w: 2, h: 2 });
    expect(list[1]).toMatchObject({ x: 1, y: 3, w: 3, h: 1 });
    expect(at[0]).toBe(0);
    expect(at[3 * 7 + 2]).toBe(1);
    expect(at[5]).toBe(-1);
  });
  it('orders patches on the same row left to right', () => {
    const { list } = colorSections(grid(['01010']), 1);
    expect(list.map((s) => s.x)).toEqual([1, 3]);
  });
  it('counts how much of each patch is stitched', () => {
    const p = grid(['110', '001']);
    p.done = Uint8Array.from([1, 0, 0, 0, 0, 1]);
    expect(colorSections(p, 1).list.map((s) => s.done)).toEqual([2]);
  });
});

describe('cleaning up', () => {
  const pat = (rows: string[], hexes: string[]) => {
    const p = createPattern(rows[0].length, rows.length);
    p.palette = hexes.map((hex, k) => ({ id: k + 1, hex, symbol: String(k) }));
    rows.forEach((r, y) => [...r].forEach((ch, x) => { p.cells[y * p.width + x] = ch === '.' ? 0 : Number(ch); }));
    return p;
  };
  it('merges small patches into what surrounds them, and fills pinholes', () => {
    const p = pat(['11111', '11211', '11111', '1.111', '11111'], ['#ff0000', '#00ff00']);
    expect(mergeSmallPatches(p.cells, 5, 5, 3)).toBe(2);
    expect([...p.cells].every((v) => v === 1)).toBe(true);
  });
  it('keeps patches of locked colors and big patches', () => {
    const p = pat(['11111', '11211', '11111'], ['#ff0000', '#00ff00']);
    expect(mergeSmallPatches(p.cells, 5, 3, 3, new Set([2]))).toBe(0);
    expect(mergeSmallPatches(p.cells, 5, 3, 1)).toBe(0);
  });
  it('merges look-alike colors into the more used one, and drops rare colors', () => {
    const p = pat(['111122', '111122', '333333'], ['#808080', '#828282', '#0000ff']);
    const r = cleanUp(p, { similar: 2, rare: 0, patch: 0, smooth: 0 });
    expect(r.pattern.palette.map((c) => c.id)).toEqual([1, 3]);
    expect(r.count).toBe(4);
    expect(p.palette.length).toBe(3); // the original is untouched
    const q = pat(['111111', '111113'], ['#808080', '#000000', '#0000ff']);
    expect(cleanUp(q, { similar: 0, rare: 2, patch: 0, smooth: 0 }).pattern.palette.map((c) => c.id)).toEqual([1]);
  });
  it('never merges a locked color away', () => {
    const p = pat(['111122', '111122'], ['#808080', '#828282']);
    p.palette[1].locked = true;
    const r = cleanUp(p, { similar: 2, rare: 0, patch: 0, smooth: 0 });
    expect(r.pattern.palette.map((c) => c.id)).toEqual([2]);
  });
});

describe('stitching order', () => {
  /** The squares marked '#' in some rows of text, as indexes. */
  const shape = (rows: string[]) => {
    const w = rows[0].length, out: number[] = [];
    rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch === '#') out.push(y * w + x); }));
    return { w, cells: out.sort(() => 0.5 - Math.random()) };
  };
  const xy = (i: number, w: number) => [i % w, (i / w) | 0];

  it('works rows from the top down, starting top left, every row left to right when going there and back', () => {
    const { w, cells } = shape(['.####.', '######', '######', '.####.']);
    const r = stitchRoute(cells, w, 'rows');
    expect(r.length).toBe(4);
    expect(r.every((run) => !run.vertical)).toBe(true);
    expect(r.map((run) => xy(run.cells[0], w))).toEqual([[1, 0], [0, 1], [0, 2], [1, 3]]);
    expect(r.flatMap((run) => run.cells).sort((a, b) => a - b)).toEqual([...cells].sort((a, b) => a - b));
  });

  it('snakes back and forth when each cross is finished as you go', () => {
    const { w, cells } = shape(['####', '####', '####']);
    const r = stitchRoute(cells, w, 'single');
    expect(r.map((run) => xy(run.cells[0], w)[0])).toEqual([0, 3, 0]);
    expect(r.map((run) => xy(run.cells[run.cells.length - 1], w)[0])).toEqual([3, 0, 3]);
  });

  it('uses columns for a tall thin shape', () => {
    const { w, cells } = shape(['.#..', '.#..', '.##.', '.##.', '.#..']);
    const r = stitchRoute(cells, w, 'rows');
    expect(r[0].vertical).toBe(true);
    expect(r[0].cells.map((i) => xy(i, w))).toEqual([[1, 0], [1, 1], [1, 2], [1, 3], [1, 4]]);
    expect(r.length).toBe(2);
  });

  it('finishes one arm of a U before going back up for the other', () => {
    const { w, cells } = shape(['##...##', '##...##', '##...##', '#######']);
    const r = stitchRoute(cells, w, 'rows');
    const tops = r.map((run) => xy(run.cells[0], w));
    // Left arm top to bottom, the bottom row, then the right arm.
    expect(tops.slice(0, 4)).toEqual([[0, 0], [0, 1], [0, 2], [0, 3]]);
    expect(tops.slice(4).every(([x]) => x >= 5)).toBe(true);
    expect(carry(threadAfter(r[3], 'rows'), r[4].cells[0], w)).toBeGreaterThan(MAX_CARRY);
  });

  it('plans only what is left: a row broken by finished stitches becomes two pieces', () => {
    // Row 0 has its middle two squares done already.
    const { w, cells } = shape(['##..##', '######']);
    const r = stitchRoute(cells, w, 'single');
    expect(r.length).toBe(3);
    expect(r.flatMap((run) => run.cells).length).toBe(cells.length);
  });

  it('starts from where the thread is, not the top left', () => {
    const { w, cells } = shape(['####', '####', '####', '####']);
    const r = stitchRoute(cells, w, 'rows', 3 * w + 3); // thread at the bottom right
    expect(xy(r[0].cells[0], w)).toEqual([3, 3]);
    expect(xy(r[0].cells[r[0].cells.length - 1], w)).toEqual([0, 3]);
  });

  it('handles a single square', () => {
    expect(stitchRoute([7], 5, 'rows')).toEqual([{ cells: [7], vertical: false }]);
  });
});

describe('thread estimate', () => {
  const o = { count: 14, maxLength: 450, method: 'rows' as const };
  /** Rows of `n` stitches, one under another, starting at the left. */
  const rowsOf = (rows: number, n: number, w = 40): Run[] =>
    Array.from({ length: rows }, (_, y) => ({ cells: Array.from({ length: n }, (_, x) => y * w + x), vertical: false }));

  it('uses about 13 mm a stitch on 14-count, less on finer fabric', () => {
    expect(perStitch(14, 'rows')).toBeCloseTo(13.1, 0);
    expect(perStitch(18, 'rows')).toBeLessThan(perStitch(14, 'rows'));
    expect(perStitch(14, 'single')).toBeGreaterThan(perStitch(14, 'rows'));
  });

  it('a small section needs one length, cut short', () => {
    const r = planThread(rowsOf(2, 5), 40, o);
    expect(r.lengths.length).toBe(1);
    expect(r.lengths[0].mm).toBe(250); // 10 stitches ≈ 131 mm + 100 to start and finish, rounded up
    expect(r.lengths[0].endRun).toBe(1);
  });

  it('a long section is split into lengths that end at the end of a row', () => {
    const r = planThread(rowsOf(10, 10), 40, o); // 100 stitches ≈ 1.3 m
    expect(r.lengths.length).toBe(5); // two rows (≈ 263 mm) to a 45 cm length
    expect(r.lengths.slice(0, -1).every((l) => l.mm <= 450 && l.endStitch === 9)).toBe(true);
    expect(r.total).toBeGreaterThan(1300);
  });

  it('a row too long for one length is split part way along', () => {
    const r = planThread(rowsOf(1, 40), 40, o);
    expect(r.lengths.length).toBeGreaterThan(1);
    expect(r.lengths[0].endStitch).toBeLessThan(39);
  });

  it('starts a new length before a move too long to carry', () => {
    const runs: Run[] = [{ cells: [0, 1], vertical: false }, { cells: [30, 31], vertical: false }];
    expect(planThread(runs, 40, o).lengths.length).toBe(2);
  });
});
