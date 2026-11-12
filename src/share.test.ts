import { describe, expect, it } from 'vitest';
import { createPattern, paletteFromHexes } from './model';
import { mergeProgress, packProject, unpackProject } from './share';

function sample() {
  const p = createPattern(40, 30, 'Kitten');
  p.palette = paletteFromHexes(['#c8372d', '#4c9a52', '#3b7dc4']);
  p.palette[1].locked = true;
  for (let i = 0; i < p.cells.length; i++) p.cells[i] = (i % 40 < 20 ? 1 : 2) * (i < 1100 ? 1 : 0);
  p.cells[5] = 3;
  p.backstitches.push({ x1: 0, y1: 0, x2: 5, y2: 3, colorId: 3 });
  p.fabric = '#203050';
  p.done = new Uint8Array(p.cells.length);
  for (let i = 0; i < 300; i++) p.done[i] = 1;
  p.reference = { photo: 'data:image/jpeg;base64,AAAA', rect: { x: 0, y: 0, w: 40, h: 30 } };
  return p;
}

describe('send to device', () => {
  it('round-trips a project through a link', async () => {
    const p = sample();
    const back = await unpackProject(await packProject('abc', p));
    expect(back.id).toBe('abc');
    const q = back.pattern;
    expect([q.name, q.width, q.height, q.fabric]).toEqual(['Kitten', 40, 30, '#203050']);
    expect(q.palette.map((c) => [c.hex, c.symbol, !!c.locked])).toEqual(p.palette.map((c) => [c.hex, c.symbol, !!c.locked]));
    // Ids may be renumbered, so compare colors square by square.
    const hex = (pat: typeof p, i: number) => pat.palette.find((c) => c.id === pat.cells[i])?.hex ?? '';
    for (let i = 0; i < p.cells.length; i++) expect(hex(q, i)).toBe(hex(p, i));
    expect(Array.from(q.done!)).toEqual(Array.from(p.done!));
    expect(q.backstitches).toHaveLength(1);
    expect(q.palette.find((c) => c.id === q.backstitches[0].colorId)?.hex).toBe('#3b7dc4');
    expect(q.reference).toBeUndefined();
  });
  it('makes links short enough for a QR code for a typical pattern', async () => {
    expect((await packProject('abc', sample())).length).toBeLessThan(600);
  });
  it('rejects damaged and foreign links', async () => {
    const good = await packProject('abc', sample());
    await expect(unpackProject(good.slice(0, good.length / 2))).rejects.toThrow();
    await expect(unpackProject('aGVsbG8')).rejects.toThrow();
  });
  it('keeps stitches ticked on either device, where the square is unchanged', () => {
    const here = sample(), incoming = sample();
    here.done = new Uint8Array(here.cells.length); here.done[500] = 1; here.done[490] = 1;
    incoming.done = new Uint8Array(incoming.cells.length); incoming.done[0] = 1;
    incoming.cells[490] = 2; // recolored since, so its tick no longer applies
    const m = mergeProgress(incoming, here);
    expect([m.done![0], m.done![500], m.done![490]]).toEqual([1, 1, 0]);
    expect(m.reference).toBe(here.reference);
  });
  it('drops progress and the photo when the size changed', () => {
    const here = sample(), incoming = { ...sample(), width: 41 };
    expect(mergeProgress(incoming, here).reference).toBeUndefined();
  });
});
