import { useSyncExternalStore } from 'react';
import { clamp, hslToHex, rgbToHex } from './color';
import { ProjectRecord, deleteProject, getProject, listProjects, putProject } from './db';
import { FABRIC, buildCellImage } from './render';
import {
  Backstitch, CleanupOptions, MAX_SIZE, PaletteColor, cleanUp, Pattern, Reference, contentBounds, createPattern, cropped, deserialize, edgesOf, despeckle, mergeColor,
  outlineCells, outlineEdges,
  nextId, nextSymbol, reduceColors, removeColor, removeUnused, resized, serialize,
} from './model';

export type Tool =
  | 'pencil' | 'eraser' | 'recolor' | 'tidy' | 'restore' | 'fill' | 'picker' | 'line' | 'rect' | 'ellipse' | 'select' | 'shape' | 'backstitch' | 'pan';
export type RefMode = 'off' | 'photo' | 'converted';

export interface Rect { x: number; y: number; w: number; h: number }
/** A piece of the pattern that has been picked up and is being moved or pasted. */
export interface Floating extends Rect { data: Uint16Array }

interface Snapshot {
  name: string;
  width: number;
  height: number;
  cells: Uint16Array;
  palette: PaletteColor[];
  backstitches: Backstitch[];
  reference?: Reference;
  fabric?: string;
  done?: Uint8Array;
}

const AUTOSAVE_KEY = 'crosspattern.autosave';
const UNDO_LIMIT = 100;

const CURRENT_KEY = 'crosspattern.current';
const DRAFT_KEY = 'crosspattern.draft';
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

const initial = createPattern(60, 60);

export const S = {
  pattern: initial,
  /** Which project in the library is open. */
  projectId: newId(),
  /** Name of the dialog that is open, if any. */
  dialog: null as string | null,
  /** A picture dropped onto the window, waiting to be converted. */
  droppedFile: null as File | null,
  /** A project arriving from another device: the packed text from the link, waiting to be opened. */
  incoming: '',
  tool: 'pencil' as Tool,
  colorId: initial.palette[0]?.id ?? 0,
  brush: 1,
  showSymbols: false,
  showGrid: true,
  /** Palette id to spotlight (others are faded), or 0. */
  highlight: 0,
  /** Stitch mode: clicking squares ticks them off as stitched instead of editing the pattern. */
  stitchMode: false,
  /** Which screen is showing: the editor, or the screen for working through a pattern stitch by stitch. */
  screen: 'edit' as 'edit' | 'stitch',
  /** On the stitch screen: the color being worked, a square in the section being worked (-1 for none),
   *  whether other colors are faded out and locked against ticking, and that section's squares. */
  stitchColor: 0,
  stitchCell: -1,
  onlyFocus: true,
  sectionMask: null as Uint8Array | null,
  /** On the stitch screen: measuring the distance between two squares. `a` is where it starts, `b` where it ends,
   *  and `fixed` is true once both ends are chosen (until then `b` follows the mouse). */
  measuring: false,
  /** On the stitch screen: arrows showing the order to stitch the current section in, and how it is worked. */
  orderGuide: false,
  orderMethod: 'rows' as 'rows' | 'single',
  /** Draw the whole plan in full, rather than only the rows for the thread in use. */
  orderAll: false,
  /** For estimating thread: fabric count, the longest length to cut (mm), strands used, and how to show lengths. */
  thread: { count: 14, maxLength: 450, strands: 2, unit: 'cm' as 'cm' | 'in' },
  measure: null as { a: { x: number; y: number }; b: { x: number; y: number }; fixed: boolean } | null,
  /** A rectangle to bring into view as soon as a newly shown canvas knows its size. */
  pendingRect: null as Rect | null,
  /** On narrow screens the color panel is a drawer; this is whether it is open. */
  panelOpen: false,
  /** Paint both halves at once, mirrored left to right. */
  mirror: false,
  /** Which guide picture is shown over the pattern, how strongly, and whether it is being peeked at in full. */
  refMode: 'off' as RefMode,
  refOpacity: 0.5,
  refPeek: false,
  selection: null as Rect | null,
  /** Stitches picked with the Shape select tool: 1 per selected square, and how many there are. */
  patch: null as { mask: Uint8Array; count: number } | null,
  /** On a phone the drawing tools are tucked away until asked for; this is whether they are showing. */
  toolsOpen: false,
  /** A line about the stitch that was last tapped while looking around, shown in the status bar. */
  info: null as string | null,
  /** False when the browser refuses to store projects (some private windows), so the user can be told. */
  storageOk: true,
  /** True on touch-first devices such as phones and tablets. */
  touch: typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches,
  floating: null as Floating | null,
  view: { scale: 16, ox: 40, oy: 40 },
  /** True while the view is still the automatic fit, so it can follow window resizes. */
  autoFit: true,
  viewport: { w: 800, h: 600 },
  undo: [] as Snapshot[],
  redo: [] as Snapshot[],
  version: 0,
  cellsVersion: 0,
};

export const keys = { space: false };

const listeners = new Set<() => void>();
export const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

let saveTimer = 0;
let unsaved = false;

/** The pattern as it should be saved: a piece that is mid-move counts as placed where it is. */
function patternForSaving(): Pattern {
  const f = S.floating, p = S.pattern;
  if (!f) return p;
  const cells = p.cells.slice();
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const v = f.data[y * f.w + x], px = f.x + x, py = f.y + y;
      if (v && px >= 0 && py >= 0 && px < p.width && py < p.height) cells[py * p.width + px] = v;
    }
  }
  return { ...p, cells };
}

function thumbnail(p: Pattern): string {
  const k = 200 / Math.max(p.width, p.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(p.width * k));
  c.height = Math.max(1, Math.round(p.height * k));
  const g = c.getContext('2d')!;
  g.fillStyle = p.fabric ?? FABRIC;
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = k < 1;
  g.drawImage(buildCellImage(p, 0), 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function currentRecord(): ProjectRecord {
  const p = patternForSaving();
  return {
    id: S.projectId, name: p.name, updatedAt: Date.now(), width: p.width, height: p.height,
    thumb: thumbnail(p), data: serialize(p),
  };
}

/**
 * Saves the open project to the library. With `leaving`, a copy is also written synchronously to
 * localStorage, because the library write may not finish before the tab closes.
 */
function autosave(leaving = false): Promise<unknown> {
  if (!unsaved) return Promise.resolve();
  clearTimeout(saveTimer);
  unsaved = false;
  const rec = currentRecord();
  if (leaving) {
    const draft = (data: string) => JSON.stringify({ id: rec.id, updatedAt: rec.updatedAt, data });
    try {
      localStorage.setItem(DRAFT_KEY, draft(rec.data));
    } catch {
      // Too big for localStorage, most likely the guide photo; the pattern itself matters more.
      try { localStorage.setItem(DRAFT_KEY, draft(serialize(patternForSaving(), false))); } catch { /* blocked */ }
    }
  }
  return putProject(rec).then(
    () => { S.storageOk = true; },
    () => { if (S.storageOk) { S.storageOk = false; emit(false); } },
  );
}
// Don't lose the last half second of work when the tab is closed or reloaded.
window.addEventListener('pagehide', () => { autosave(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden) autosave(true); });

/** Loads the project that was open last time. Call once before showing the app. */
export async function initStore(): Promise<void> {
  let id = localStorage.getItem(CURRENT_KEY);
  let data: string | undefined;
  let migrated = false;
  try {
    const rec = id ? await getProject(id) : undefined;
    data = rec?.data;
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
    if (draft && draft.id === id && (!rec || draft.updatedAt >= rec.updatedAt)) { data = draft.data; migrated = true; }
    if (!data) {
      // Work saved by the first version of the app, before there was a library.
      const legacy = localStorage.getItem(AUTOSAVE_KEY);
      if (legacy) { data = legacy; migrated = true; id = null; localStorage.removeItem(AUTOSAVE_KEY); }
    }
    if (!data) {
      const latest = (await listProjects())[0];
      if (latest) { id = latest.id; data = latest.data; }
    }
  } catch { S.storageOk = false; /* library unavailable; start blank */ }
  try { if (data) S.pattern = deserialize(data); } catch { /* damaged save; start blank */ }
  S.projectId = id ?? newId();
  localStorage.setItem(CURRENT_KEY, S.projectId);
  fixCurrentColor();
  if (migrated) { unsaved = true; autosave(); }
}
/** Tell the UI something changed. Pass false when the pattern itself is untouched (tool, zoom, selection). */
export function emit(patternChanged = true): void {
  S.version++;
  if (patternChanged) {
    S.cellsVersion++;
    unsaved = true;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => autosave(), 500);
  }
  listeners.forEach((fn) => fn());
}

export function useStore(): number {
  return useSyncExternalStore(subscribe, () => S.version);
}

// ---- Undo ---------------------------------------------------------------

function snapshot(): Snapshot {
  const p = S.pattern;
  return {
    name: p.name,
    width: p.width,
    height: p.height,
    cells: p.cells.slice(),
    palette: p.palette.map((c) => ({ ...c })),
    backstitches: p.backstitches.map((b) => ({ ...b })),
    reference: p.reference,
    fabric: p.fabric,
    done: p.done?.slice(),
  };
}

function restore(s: Snapshot): void {
  const resized = s.width !== S.pattern.width || s.height !== S.pattern.height;
  S.pattern = { ...s };
  fixCurrentColor();
  // Stepping back over a crop or resize changes the canvas size, so the old zoom no longer shows it.
  if (resized) fitView();
}

function fixCurrentColor(): void {
  const ref = S.pattern.reference;
  if ((S.refMode === 'photo' && !ref?.photo) || (S.refMode === 'converted' && !ref?.converted)) S.refMode = 'off';
  if (S.tool === 'restore' && !ref?.converted) S.tool = 'pencil';
  const pal = S.pattern.palette;
  if (!pal.some((c) => c.id === S.colorId)) S.colorId = pal[0]?.id ?? 0;
  if (S.highlight && !pal.some((c) => c.id === S.highlight)) S.highlight = 0;
}

let lastTag = '', lastTagTime = 0;
/** Call before changing the pattern. A tag groups rapid repeats (e.g. dragging a color picker) into one step. */
export function pushUndo(tag = ''): void {
  const now = Date.now();
  if (tag && tag === lastTag && now - lastTagTime < 1500) { lastTagTime = now; return; }
  lastTag = tag;
  lastTagTime = now;
  S.undo.push(snapshot());
  if (S.undo.length > UNDO_LIMIT) S.undo.shift();
  S.redo.length = 0;
}

/** Discards the last undo step, for actions that turned out to change nothing. */
export function dropUndo(): void {
  S.undo.pop();
  lastTag = '';
}

export function undo(): void {
  S.floating = null;
  S.selection = null;
  S.patch = null;
  const s = S.undo.pop();
  if (!s) return emit(false);
  S.redo.push(snapshot());
  restore(s);
  lastTag = '';
  emit();
}

export function redo(): void {
  const s = S.redo.pop();
  if (!s) return;
  S.floating = null;
  S.selection = null;
  S.patch = null;
  S.undo.push(snapshot());
  restore(s);
  emit();
}

// ---- View ---------------------------------------------------------------

export function fitView(): void {
  const { w, h } = S.viewport, p = S.pattern;
  // Leave room for the row and column numbers, but not much of a small screen.
  const margin = Math.min(80, Math.max(36, w * 0.1));
  const scale = clamp(Math.min((w - margin) / p.width, (h - margin) / p.height), 1, 40);
  S.view = {
    scale,
    ox: Math.round((w - p.width * scale) / 2),
    oy: Math.round((h - p.height * scale) / 2),
  };
  S.autoFit = true;
  emit(false);
}

export function zoomAt(px: number, py: number, factor: number): void {
  const v = S.view;
  const scale = clamp(v.scale * factor, 1, 80);
  v.ox = Math.round(px - ((px - v.ox) * scale) / v.scale);
  v.oy = Math.round(py - ((py - v.oy) * scale) / v.scale);
  v.scale = scale;
  S.autoFit = false;
  emit(false);
}

/** Zooms and moves the view so a rectangle of squares fills most of it. */
export function showRect(r: Rect, maxScale = 36): void {
  const { w, h } = S.viewport;
  const pad = Math.min(48, Math.max(16, Math.min(w, h) * 0.08));
  const scale = clamp(Math.min((w - pad * 2) / r.w, (h - pad * 2) / r.h), 1, maxScale);
  S.view = {
    scale,
    ox: Math.round(w / 2 - (r.x + r.w / 2) * scale),
    oy: Math.round(h / 2 - (r.y + r.h / 2) * scale),
  };
  S.autoFit = false;
  emit(false);
}

export function zoomBy(factor: number): void {
  zoomAt(S.viewport.w / 2, S.viewport.h / 2, factor);
}

// ---- Tools and selection ------------------------------------------------

export function setTool(tool: Tool): void {
  if (tool === 'restore' && !S.pattern.reference?.converted) return;
  if (tool !== 'select') { commitFloating(); S.selection = null; }
  if (tool !== 'shape') S.patch = null;
  S.info = null;
  S.tool = tool;
  emit(false);
}

/** Picks the selected squares up off the pattern so they can be moved. */
export function liftSelection(): void {
  const s = S.selection;
  if (!s || S.floating) return;
  pushUndo();
  const p = S.pattern;
  const data = new Uint16Array(s.w * s.h);
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = (s.y + y) * p.width + s.x + x;
      data[y * s.w + x] = p.cells[i];
      p.cells[i] = 0;
    }
  }
  S.floating = { ...s, data };
  emit();
}

/** Drops the floating piece back onto the pattern. Empty squares in it don't overwrite anything. */
export function commitFloating(): void {
  const f = S.floating;
  if (!f) return;
  const p = S.pattern, locked = lockedIds();
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const v = f.data[y * f.w + x], px = f.x + x, py = f.y + y;
      if (!v || px < 0 || py < 0 || px >= p.width || py >= p.height) continue;
      if (!locked.has(p.cells[py * p.width + px])) p.cells[py * p.width + px] = v;
    }
  }
  S.floating = null;
  S.selection = null;
  emit();
}

/** Ids of colors the user has locked against being painted over. */
export function lockedIds(): Set<number> {
  return new Set(S.pattern.palette.filter((c) => c.locked).map((c) => c.id));
}

export function selectAll(): void {
  commitFloating();
  S.patch = null;
  S.tool = 'select';
  S.selection = { x: 0, y: 0, w: S.pattern.width, h: S.pattern.height };
  emit(false);
}

/** Flips or turns the selected stitches in place. */
export function transformSelection(kind: 'flipH' | 'flipV' | 'rotate'): void {
  if (!S.floating) liftSelection();
  const f = S.floating;
  if (!f) return;
  const { w, h, data } = f;
  const out = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      if (kind === 'flipH') out[y * w + (w - 1 - x)] = v;
      else if (kind === 'flipV') out[(h - 1 - y) * w + x] = v;
      else out[x * h + (h - 1 - y)] = v; // quarter turn clockwise; the result is h wide and w tall
    }
  }
  f.data = out;
  if (kind === 'rotate') {
    f.x += Math.round((w - h) / 2);
    f.y += Math.round((h - w) / 2);
    f.w = h;
    f.h = w;
  }
  S.selection = { x: f.x, y: f.y, w: f.w, h: f.h };
  emit();
}

export function nudgeSelection(dx: number, dy: number): void {
  if (!S.floating) liftSelection();
  const f = S.floating;
  if (!f) return;
  f.x += dx;
  f.y += dy;
  emit();
}

/** The selected rectangle, clipped to the canvas, or null. */
export function selectedRect(): Rect | null {
  const r = S.floating ?? S.selection;
  if (!r) return null;
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const x1 = Math.min(S.pattern.width, r.x + r.w), y1 = Math.min(S.pattern.height, r.y + r.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Trims away empty rows and columns around the design. */
export function trimEmpty(): boolean {
  commitFloating();
  const p = S.pattern, r = contentBounds(p);
  if (!r || (r.w === p.width && r.h === p.height)) return false;
  setPattern(cropped(p, r));
  return true;
}

export function setFabric(hex: string | undefined): void {
  if (S.pattern.fabric === hex) return;
  pushUndo('fabric');
  S.pattern.fabric = hex;
  emit();
}

/** The progress map, created on first use. */
export function doneMap(): Uint8Array {
  const p = S.pattern;
  if (!p.done || p.done.length !== p.cells.length) p.done = new Uint8Array(p.cells.length);
  return p.done;
}

export function clearProgress(): void {
  if (!S.pattern.done) return;
  pushUndo();
  S.pattern.done = undefined;
  emit();
}

export function cropToSelection(): void {
  const r = selectedRect();
  if (!r) return;
  commitFloating();
  setPattern(cropped(S.pattern, r));
}

/** Removes backstitch: every line in one color, or all of it. Returns how many lines went. Undoable. */
export function removeBackstitch(colorId?: number): number {
  commitFloating();
  const all = S.pattern.backstitches, keep = colorId === undefined ? [] : all.filter((b) => b.colorId !== colorId);
  const gone = all.length - keep.length;
  if (!gone) return 0;
  pushUndo();
  S.pattern.backstitches = keep;
  emit();
  return gone;
}

/** Outlines the subject in the current color, as backstitch along its edge or as its outermost stitches. */
export function addOutline(kind: 'backstitch' | 'stitches'): number {
  if (!S.colorId) return 0;
  commitFloating();
  const p = S.pattern;
  pushUndo();
  let n = 0;
  if (kind === 'backstitch') {
    const edges = outlineEdges(p);
    p.backstitches.push(...edges.map((e) => ({ ...e, colorId: S.colorId })));
    n = edges.length;
  } else {
    const locked = lockedIds();
    for (const i of outlineCells(p)) if (!locked.has(p.cells[i])) { p.cells[i] = S.colorId; n++; }
  }
  if (n) emit(); else dropUndo();
  return n;
}

/** Writes freshly converted stitches into a rectangle, e.g. after re-converting part of the photo. */
export function applyConverted(rect: Rect, hexes: string[], cells: Uint16Array, ids: number[]): void {
  commitFloating();
  pushUndo();
  const p = S.pattern, locked = lockedIds();
  const map = ids.map((id, k) => {
    if (id) return id;
    const made = nextId(p.palette);
    p.palette.push({ id: made, hex: hexes[k], symbol: nextSymbol(p.palette) });
    return made;
  });
  for (let y = 0; y < rect.h; y++) {
    for (let x = 0; x < rect.w; x++) {
      const v = cells[y * rect.w + x], i = (rect.y + y) * p.width + rect.x + x;
      if (!locked.has(p.cells[i])) p.cells[i] = v ? map[v - 1] : 0;
    }
  }
  S.selection = rect;
  emit();
}

let clipboard: Floating | null = null;

export function copySelection(): boolean {
  if (S.floating) {
    clipboard = { ...S.floating, data: S.floating.data.slice() };
    return true;
  }
  const s = S.selection;
  if (!s) return false;
  const p = S.pattern;
  const data = new Uint16Array(s.w * s.h);
  for (let y = 0; y < s.h; y++) {
    data.set(p.cells.subarray((s.y + y) * p.width + s.x, (s.y + y) * p.width + s.x + s.w), y * s.w);
  }
  clipboard = { ...s, data };
  return true;
}

export function deleteSelection(): void {
  if (S.floating) {
    S.floating = null;
    S.selection = null;
    return emit();
  }
  const s = S.selection;
  if (!s) return;
  pushUndo();
  const p = S.pattern;
  for (let y = 0; y < s.h; y++) p.cells.fill(0, (s.y + y) * p.width + s.x, (s.y + y) * p.width + s.x + s.w);
  emit();
}

export function cutSelection(): void {
  if (copySelection()) deleteSelection();
}

export function paste(): void {
  if (!clipboard) return;
  commitFloating();
  pushUndo();
  const ids = new Set(S.pattern.palette.map((c) => c.id));
  const data = clipboard.data.map((v) => (ids.has(v) ? v : 0));
  const x = Math.max(0, Math.floor(-S.view.ox / S.view.scale) + 1);
  const y = Math.max(0, Math.floor(-S.view.oy / S.view.scale) + 1);
  S.floating = { x, y, w: clipboard.w, h: clipboard.h, data };
  S.selection = { x, y, w: clipboard.w, h: clipboard.h };
  S.patch = null;
  S.tool = 'select';
  emit(false);
}

// ---- Palette ------------------------------------------------------------

export function addColor(hex?: string): void {
  const p = S.pattern;
  pushUndo();
  const id = nextId(p.palette);
  const color = hex ?? hslToHex((p.palette.length * 137.5) % 360, 0.6, 0.55);
  p.palette.push({ id, hex: color, symbol: nextSymbol(p.palette) });
  S.colorId = id;
  emit();
}

export function setColorHex(id: number, hex: string): void {
  const c = S.pattern.palette.find((c) => c.id === id);
  if (!c || c.hex === hex) return;
  pushUndo('hex:' + id);
  c.hex = hex.toLowerCase();
  emit();
}

export function setColorSymbol(id: number, symbol: string): void {
  const c = S.pattern.palette.find((c) => c.id === id);
  if (!c) return;
  pushUndo();
  c.symbol = symbol;
  emit();
}

export function toggleLock(id: number): void {
  const c = S.pattern.palette.find((c) => c.id === id);
  if (!c) return;
  c.locked = c.locked ? undefined : true;
  emit();
}

export function sortPaletteByUse(): void {
  const p = S.pattern, counts = new Map<number, number>();
  for (let i = 0; i < p.cells.length; i++) if (p.cells[i]) counts.set(p.cells[i], (counts.get(p.cells[i]) ?? 0) + 1);
  pushUndo();
  p.palette.sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
  emit();
}

export function deleteColor(id: number): void {
  pushUndo();
  removeColor(S.pattern, id);
  fixCurrentColor();
  emit();
}

export function mergeInto(from: number, to: number): void {
  if (from === to) return;
  pushUndo();
  mergeColor(S.pattern, from, to);
  S.colorId = to;
  fixCurrentColor();
  emit();
}

export function reduceTo(count: number): void {
  pushUndo();
  reduceColors(S.pattern, count);
  fixCurrentColor();
  emit();
}

export function removeStrays(level: number): number {
  commitFloating();
  pushUndo();
  const p = S.pattern, locked = lockedIds(), before = locked.size ? p.cells.slice() : null;
  let n = despeckle(p.cells, p.width, p.height, level);
  if (before) {
    for (let i = 0; i < before.length; i++) {
      if (p.cells[i] !== before[i] && locked.has(before[i])) { p.cells[i] = before[i]; n--; }
    }
  }
  if (n > 0) emit(); else dropUndo();
  return Math.max(0, n);
}

/** Tidies the pattern with the cleanup settings (see cleanUp), as one undoable step. */
export function applyCleanup(o: CleanupOptions): number {
  commitFloating();
  const r = cleanUp(S.pattern, o);
  if (!r.count) return 0;
  pushUndo();
  S.patch = null;
  S.pattern = r.pattern;
  fixCurrentColor();
  emit();
  return r.count;
}

export function removeUnusedColors(): void {
  pushUndo();
  removeUnused(S.pattern);
  fixCurrentColor();
  emit();
}

// ---- Document -----------------------------------------------------------

/** Replaces the whole pattern. Still undoable, so an accidental import or "New" can be reversed. */
export function setPattern(p: Pattern): void {
  pushUndo();
  S.floating = null;
  S.selection = null;
  S.patch = null;
  S.highlight = 0;
  S.pattern = p;
  fixCurrentColor();
  emit();
  fitView();
}

export function renamePattern(name: string): void {
  S.pattern.name = name;
  emit();
}

export function resizePattern(width: number, height: number): void {
  commitFloating();
  setPattern(resized(S.pattern, clamp(width, 1, MAX_SIZE), clamp(height, 1, MAX_SIZE)));
}

export function download(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function fileBase(): string {
  return S.pattern.name.trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-') || 'pattern';
}

export function saveFile(): void {
  commitFloating();
  download(new Blob([serialize(S.pattern)], { type: 'application/json' }), fileBase() + '.crosspattern.json');
}

export async function openFile(file: File): Promise<void> {
  await openAsNewProject(deserialize(await file.text()));
}

// ---- Project library ----------------------------------------------------

function isBlank(): boolean {
  const p = S.pattern;
  return !p.reference && !p.backstitches.length && p.cells.every((v) => v === 0);
}

function activate(id: string, p: Pattern): void {
  S.projectId = id;
  localStorage.setItem(CURRENT_KEY, id);
  S.pattern = p;
  S.undo = [];
  S.redo = [];
  S.floating = null;
  S.selection = null;
  S.patch = null;
  S.highlight = 0;
  fixCurrentColor();
  emit();
  fitView();
}

/** Opens a pattern as its own project, leaving the current one in the library. An untouched blank project is reused. */
export async function openAsNewProject(p: Pattern): Promise<void> {
  if (isBlank()) return setPattern(p);
  await autosave();
  activate(newId(), p);
}

/**
 * Takes in a project that arrived by link from another device. With `asCopy` it becomes a new project;
 * otherwise it goes in as the same project, updating the copy here if there is one (see mergeProgress).
 */
export async function receiveProject(id: string, incoming: Pattern, merge: (incoming: Pattern, here: Pattern) => Pattern, asCopy: boolean): Promise<void> {
  if (asCopy || !id) { await openAsNewProject({ ...incoming, name: incoming.name + (asCopy ? ' (copy)' : '') }); return; }
  await autosave();
  const rec = await getProject(id).catch(() => undefined);
  const here = id === S.projectId ? S.pattern : rec ? deserialize(rec.data) : null;
  activate(id, here ? merge(incoming, here) : incoming);
  unsaved = true;
  await autosave();
}

/** Whether a project is already in the library here. */
export async function hasProject(id: string): Promise<boolean> {
  return id === S.projectId || !!(await getProject(id).catch(() => undefined));
}

export async function switchProject(id: string): Promise<void> {
  if (id === S.projectId) return;
  await autosave();
  const rec = await getProject(id);
  if (rec) activate(id, deserialize(rec.data));
}

/** Everything in the library, newest first, with the open project saved first so it is up to date. */
export async function libraryProjects(): Promise<ProjectRecord[]> {
  unsaved = true;
  await autosave();
  return listProjects();
}

export async function duplicateProject(id: string): Promise<void> {
  const rec = await getProject(id);
  if (rec) await putProject({ ...rec, id: newId(), name: rec.name + ' copy', updatedAt: Date.now() });
}

export async function removeProject(id: string): Promise<void> {
  await deleteProject(id);
  if (id !== S.projectId) return;
  // The open project was deleted: move to the most recent other one, or a fresh blank.
  unsaved = false;
  clearTimeout(saveTimer);
  const next = (await listProjects())[0];
  activate(next?.id ?? newId(), next ? deserialize(next.data) : createPattern(60, 60));
}

export function openDialog(name: string | null): void {
  S.dialog = name;
  emit(false);
}

let photoPixels: { src: string; w: number; h: number; data: Uint8ClampedArray } | null = null;

/** The guide photo's average color over one square, for picking exact shades from the picture. */
export function samplePhoto(cx: number, cy: number): string | null {
  const ref = S.pattern.reference;
  const img = ref?.photo ? refImage(ref.photo) : null;
  if (!ref?.photo || !img) return null;
  if (photoPixels?.src !== ref.photo) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0);
    photoPixels = { src: ref.photo, w: c.width, h: c.height, data: g.getImageData(0, 0, c.width, c.height).data };
  }
  const { w, h, data } = photoPixels;
  const x0 = Math.max(0, Math.floor(((cx - ref.rect.x) / ref.rect.w) * w)), x1 = Math.min(w, Math.ceil(((cx + 1 - ref.rect.x) / ref.rect.w) * w));
  const y0 = Math.max(0, Math.floor(((cy - ref.rect.y) / ref.rect.h) * h)), y1 = Math.min(h, Math.ceil(((cy + 1 - ref.rect.y) / ref.rect.h) * h));
  if (x1 <= x0 || y1 <= y0) return null;
  let r = 0, g = 0, b = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * w + x) * 4; r += data[o]; g += data[o + 1]; b += data[o + 2]; }
  const n = (x1 - x0) * (y1 - y0);
  return rgbToHex(r / n, g / n, b / n);
}

// ---- Reference pictures -------------------------------------------------

let refCache: { src: string; img: HTMLImageElement; ready: boolean } | null = null;

/** The reference photo as a drawable image, or null while it is still loading. */
export function refImage(src: string): HTMLImageElement | null {
  if (refCache?.src !== src) {
    const entry = { src, img: new Image(), ready: false };
    entry.img.onload = () => { entry.ready = true; emit(false); };
    entry.img.src = src;
    refCache = entry;
  }
  return refCache.ready ? refCache.img : null;
}

/** Shrinks a picture (or part of one) to a size that is cheap to store alongside the pattern. */
export function photoDataUrl(img: HTMLImageElement, sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight): string {
  const k = Math.min(1, 1200 / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

/** Adds a photo to trace over, fitted inside the canvas. */
export async function loadReferencePhoto(file: Blob): Promise<void> {
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  const p = S.pattern;
  const k = Math.min(p.width / img.naturalWidth, p.height / img.naturalHeight);
  const w = img.naturalWidth * k, h = img.naturalHeight * k;
  pushUndo();
  p.reference = {
    ...p.reference,
    photo: photoDataUrl(img),
    rect: { x: (p.width - w) / 2, y: (p.height - h) / 2, w, h },
  };
  URL.revokeObjectURL(img.src);
  S.refMode = 'photo';
  emit();
}

export function removeReference(): void {
  pushUndo();
  S.pattern.reference = undefined;
  fixCurrentColor();
  emit();
}

// ---- Shape select: work on whole patches of color -----------------------

/** Selects the connected patch of one color under a square. With `add`, it joins what is already selected. */
export function selectPatch(x: number, y: number, add: boolean): void {
  const p = S.pattern, n = p.cells.length, start = y * p.width + x, color = p.cells[start];
  const mask = add && S.patch?.mask.length === n ? S.patch.mask.slice() : new Uint8Array(n);
  const stack = [start];
  mask[start] = 1;
  while (stack.length) {
    const i = stack.pop()!, cx = i % p.width;
    for (const j of [cx > 0 ? i - 1 : -1, cx < p.width - 1 ? i + 1 : -1, i - p.width, i + p.width]) {
      if (j >= 0 && j < n && !mask[j] && p.cells[j] === color) { mask[j] = 1; stack.push(j); }
    }
  }
  S.patch = { mask, count: mask.reduce((a, v) => a + v, 0) };
  emit(false);
}

export function clearPatch(): void {
  if (!S.patch) return;
  S.patch = null;
  emit(false);
}

/** Widens the selection to every stitch, anywhere, of the colors it already contains. */
export function selectSameColors(): void {
  const p = S.pattern, sel = S.patch;
  if (!sel) return;
  const colors = new Set<number>();
  for (let i = 0; i < sel.mask.length; i++) if (sel.mask[i]) colors.add(p.cells[i]);
  const mask = new Uint8Array(p.cells.length);
  for (let i = 0; i < mask.length; i++) if (colors.has(p.cells[i])) mask[i] = 1;
  S.patch = { mask, count: mask.reduce((a, v) => a + v, 0) };
  emit(false);
}

export type PatchAction = 'fill' | 'erase' | 'absorb' | 'grow' | 'shrink' | 'smooth' | 'outline';

/** Does something to the whole selected shape at once. Locked colors are left alone. */
export function patchAction(kind: PatchAction): void {
  const sel = S.patch, p = S.pattern;
  if (!sel || sel.mask.length !== p.cells.length) return;
  const { width: w, height: h, cells } = p, n = cells.length, mask = sel.mask;
  const locked = lockedIds();
  const write = (i: number, v: number) => { if (!locked.has(cells[i])) cells[i] = v; };
  const around = (i: number, eight: boolean) => {
    const x = i % w, y = (i / w) | 0, out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || (!eight && dx && dy)) continue;
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) out.push(yy * w + xx);
    }
    return out;
  };
  const before = mask.slice(), was = cells.slice();
  /** The most common color among the given squares that are on the wanted side of the selection. */
  const commonest = (squares: number[], inside: boolean) => {
    const tally = new Map<number, number>();
    let best = -1, bestN = 0;
    for (const j of squares) {
      if (!!before[j] !== inside) continue;
      const c = (tally.get(was[j]) ?? 0) + 1;
      tally.set(was[j], c);
      if (c > bestN) { bestN = c; best = was[j]; }
    }
    return best;
  };
  pushUndo();

  if (kind === 'fill') { for (let i = 0; i < n; i++) if (mask[i]) write(i, S.colorId); }
  else if (kind === 'erase') { for (let i = 0; i < n; i++) if (mask[i]) write(i, 0); }
  else if (kind === 'absorb') {
    // The shape takes on whichever color surrounds it most.
    const rim: number[] = [];
    for (let i = 0; i < n; i++) if (mask[i]) for (const j of around(i, false)) if (!mask[j]) rim.push(j);
    const c = commonest(rim, false);
    if (c >= 0) for (let i = 0; i < n; i++) if (mask[i]) write(i, c);
  } else if (kind === 'grow') {
    for (let i = 0; i < n; i++) {
      if (before[i]) continue;
      const c = commonest(around(i, false), true);
      if (c >= 0) { write(i, c); mask[i] = 1; }
    }
  } else if (kind === 'shrink') {
    for (let i = 0; i < n; i++) {
      if (!before[i]) continue;
      const c = commonest(around(i, false), false);
      if (c >= 0) { write(i, c); mask[i] = 0; }
    }
  } else if (kind === 'smooth') {
    // Nibble off squares that stick out and fill in notches, judging each by its eight neighbours.
    for (let i = 0; i < n; i++) {
      const nb = around(i, true);
      let inside = 0;
      for (const j of nb) inside += before[j];
      if (before[i] && inside <= Math.min(2, nb.length - 3)) {
        const c = commonest(nb, false);
        if (c >= 0) { write(i, c); mask[i] = 0; }
      } else if (!before[i] && inside >= 6) {
        const c = commonest(nb, true);
        if (c >= 0) { write(i, c); mask[i] = 1; }
      }
    }
  } else if (kind === 'outline' && S.colorId) {
    // Selected empty fabric is outlined only where it meets stitches, not along the edge of the canvas.
    let fabricOnly = true;
    for (let i = 0; i < n && fabricOnly; i++) if (mask[i] && was[i]) fabricOnly = false;
    const inSel = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] === 1 : fabricOnly);
    p.backstitches.push(...edgesOf(w, h, inSel).map((e) => ({ ...e, colorId: S.colorId })));
  }
  sel.count = mask.reduce((a, v) => a + v, 0);
  if (!sel.count) S.patch = null;
  emit();
}
