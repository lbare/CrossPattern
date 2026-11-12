/**
 * Sending a project to another device as a link. The whole project travels inside the link, after the
 * '#', which browsers never send to the server: nothing is uploaded anywhere. The guide photo is left out
 * to keep links short enough for a QR code.
 */
import { Backstitch, Pattern, paletteFromHexes } from './model';

/** The part of the address that marks a link carrying a project. */
export const LINK_PREFIX = '#get=';

/** What a link carries: the pattern, its stitch progress, and which project it is, to update it next time. */
export interface Shared { id: string; pattern: Pattern }

const MAGIC = [0x43, 0x50, 1]; // "CP", format 1

// ---- Bytes and text -----------------------------------------------------

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Base64 using only characters that are safe in an address. */
function toText(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromText(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---- Packing a project ----------------------------------------------------

/**
 * Packs a project into as few bytes as possible: a small description (name, size, colors, backstitch),
 * then one byte per square giving its color, then one bit per square for progress. Long runs of the same
 * color compress to almost nothing.
 */
export async function packProject(id: string, p: Pattern): Promise<string> {
  const index = new Map(p.palette.map((c, k) => [c.id, k + 1]));
  const wide = p.palette.length > 254;
  const head = new TextEncoder().encode(JSON.stringify({
    id, name: p.name, w: p.width, h: p.height, fabric: p.fabric,
    colors: p.palette.map((c) => [c.hex, c.symbol, c.locked ? 1 : 0]),
    back: p.backstitches.map((b) => [b.x1, b.y1, b.x2, b.y2, index.get(b.colorId) ?? 0]),
    wide: wide ? 1 : 0,
  }));
  const n = p.cells.length, cellBytes = wide ? n * 2 : n, doneBytes = Math.ceil(n / 8);
  const out = new Uint8Array(MAGIC.length + 4 + head.length + cellBytes + doneBytes);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(3, head.length);
  out.set(head, 7);
  let o = 7 + head.length;
  for (let i = 0; i < n; i++) {
    const v = p.cells[i] ? index.get(p.cells[i]) ?? 0 : 0;
    if (wide) { out[o++] = v & 255; out[o++] = v >> 8; } else out[o++] = v;
  }
  if (p.done) for (let i = 0; i < n; i++) if (p.done[i] && p.cells[i]) out[o + (i >> 3)] |= 1 << (i & 7);
  return toText(await deflate(out));
}

/** Unpacks a project from a link. Throws if the link is damaged or not from CrossPattern. */
export async function unpackProject(text: string): Promise<Shared> {
  let bytes: Uint8Array;
  try { bytes = await inflate(fromText(text)); } catch { throw new Error('This link is damaged or incomplete.'); }
  if (bytes.length < 7 || bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) throw new Error('This is not a CrossPattern link.');
  if (bytes[2] !== MAGIC[2]) throw new Error('This link was made by a newer version of CrossPattern. Reload the page and try again.');
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(3);
  const h = JSON.parse(new TextDecoder().decode(bytes.subarray(7, 7 + len)));
  const w = h.w, ht = h.h, n = w * ht;
  if (!Number.isInteger(w) || !Number.isInteger(ht) || w < 1 || ht < 1 || w > 400 || ht > 400) throw new Error('This link is damaged.');
  const colors: [string, string, number][] = Array.isArray(h.colors) ? h.colors : [];
  const palette = paletteFromHexes(colors.map((c) => (/^#[0-9a-f]{6}$/i.test(c[0]) ? c[0].toLowerCase() : '#000000')));
  palette.forEach((c, k) => { c.symbol = String(colors[k][1] ?? c.symbol); if (colors[k][2]) c.locked = true; });
  const cells = new Uint16Array(n), done = new Uint8Array(n);
  let o = 7 + len;
  const need = o + (h.wide ? n * 2 : n) + Math.ceil(n / 8);
  if (bytes.length < need) throw new Error('This link is incomplete. It may have been cut short when it was copied.');
  for (let i = 0; i < n; i++) {
    const v = h.wide ? bytes[o++] | (bytes[o++] << 8) : bytes[o++];
    cells[i] = v >= 1 && v <= palette.length ? v : 0;
  }
  for (let i = 0; i < n; i++) if (cells[i] && bytes[o + (i >> 3)] & (1 << (i & 7))) done[i] = 1;
  const backstitches: Backstitch[] = (Array.isArray(h.back) ? h.back : [])
    .filter((b: number[]) => b.length === 5 && b[4] >= 1 && b[4] <= palette.length)
    .map((b: number[]) => ({ x1: b[0], y1: b[1], x2: b[2], y2: b[3], colorId: b[4] }));
  return {
    id: String(h.id || ''),
    pattern: {
      name: String(h.name ?? 'Shared pattern'), width: w, height: ht, cells, palette, backstitches,
      fabric: typeof h.fabric === 'string' && /^#[0-9a-f]{6}$/i.test(h.fabric) ? h.fabric : undefined,
      done: done.some((v) => v) ? done : undefined,
    },
  };
}

/** The full address of a link carrying this project. */
export async function projectLink(id: string, p: Pattern): Promise<string> {
  return location.origin + location.pathname + LINK_PREFIX + (await packProject(id, p));
}

/**
 * Combines a project arriving by link with the copy already here. The pattern, colors and backstitch come
 * from the link. Progress from both is kept: a stitch counts as done if it was ticked on either device,
 * as long as that square is still the same color.
 */
export function mergeProgress(incoming: Pattern, here: Pattern): Pattern {
  // The guide photo is not in links, so keep the one here if it still fits the pattern.
  const sameSize = here.width === incoming.width && here.height === incoming.height;
  const out: Pattern = { ...incoming, reference: sameSize ? here.reference : undefined };
  if (!sameSize || !here.done) return out;
  const hexHere = new Map(here.palette.map((c) => [c.id, c.hex]));
  const hexIn = new Map(incoming.palette.map((c) => [c.id, c.hex]));
  const done = incoming.done ? incoming.done.slice() : new Uint8Array(incoming.cells.length);
  for (let i = 0; i < done.length; i++) {
    if (here.done[i] && incoming.cells[i] && hexHere.get(here.cells[i]) === hexIn.get(incoming.cells[i])) done[i] = 1;
  }
  out.done = done.some((v) => v) ? done : undefined;
  return out;
}
