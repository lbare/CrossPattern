import { describe, expect, it } from 'vitest';
import { hexToRgb, inkFor, oklabToRgb, rgbToHex, rgbToOklab } from './color';
import {
  Pattern, colorSections, connectedCells, contentBounds, countCells, createPattern, cropped, deserialize, despeckle, edgesOf, floodFill, linePoints,
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
