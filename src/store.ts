import { useSyncExternalStore } from 'react';
import { clamp, hslToHex } from './color';
import {
  Backstitch, MAX_SIZE, PaletteColor, Pattern, Reference, createPattern, deserialize, despeckle, mergeColor,
  nextId, nextSymbol, reduceColors, removeColor, removeUnused, resized, serialize,
} from './model';

export type Tool =
  | 'pencil' | 'eraser' | 'recolor' | 'tidy' | 'restore' | 'fill' | 'picker' | 'line' | 'rect' | 'select' | 'backstitch' | 'pan';
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
}

const AUTOSAVE_KEY = 'crosspattern.autosave';
const UNDO_LIMIT = 100;

function loadAutosave(): Pattern | null {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    return text ? deserialize(text) : null;
  } catch {
    return null;
  }
}

const initial = loadAutosave() ?? createPattern(60, 60);

export const S = {
  pattern: initial,
  tool: 'pencil' as Tool,
  colorId: initial.palette[0]?.id ?? 0,
  brush: 1,
  showSymbols: false,
  showGrid: true,
  /** Palette id to spotlight (others are faded), or 0. */
  highlight: 0,
  /** Paint both halves at once, mirrored left to right. */
  mirror: false,
  /** Which guide picture is shown over the pattern, how strongly, and whether it is being peeked at in full. */
  refMode: 'off' as RefMode,
  refOpacity: 0.5,
  refPeek: false,
  selection: null as Rect | null,
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

function autosave(): void {
  if (!unsaved) return;
  clearTimeout(saveTimer);
  unsaved = false;
  const p = patternForSaving();
  try {
    localStorage.setItem(AUTOSAVE_KEY, serialize(p));
  } catch {
    // Most likely the reference photo made it too big for browser storage; the pattern itself matters more.
    try { localStorage.setItem(AUTOSAVE_KEY, serialize(p, false)); } catch { /* storage full or blocked */ }
  }
}
// Don't lose the last half second of work when the tab is closed or reloaded.
window.addEventListener('pagehide', autosave);
document.addEventListener('visibilitychange', () => { if (document.hidden) autosave(); });
/** Tell the UI something changed. Pass false when the pattern itself is untouched (tool, zoom, selection). */
export function emit(patternChanged = true): void {
  S.version++;
  if (patternChanged) {
    S.cellsVersion++;
    unsaved = true;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(autosave, 500);
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
  };
}

function restore(s: Snapshot): void {
  S.pattern = { ...s };
  fixCurrentColor();
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
  S.undo.push(snapshot());
  restore(s);
  emit();
}

// ---- View ---------------------------------------------------------------

export function fitView(): void {
  const { w, h } = S.viewport, p = S.pattern;
  const scale = clamp(Math.min((w - 80) / p.width, (h - 80) / p.height), 1, 40);
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

export function zoomBy(factor: number): void {
  zoomAt(S.viewport.w / 2, S.viewport.h / 2, factor);
}

// ---- Tools and selection ------------------------------------------------

export function setTool(tool: Tool): void {
  if (tool === 'restore' && !S.pattern.reference?.converted) return;
  if (tool !== 'select') { commitFloating(); S.selection = null; }
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
  const p = S.pattern;
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const v = f.data[y * f.w + x], px = f.x + x, py = f.y + y;
      if (v && px >= 0 && py >= 0 && px < p.width && py < p.height) p.cells[py * p.width + px] = v;
    }
  }
  S.floating = null;
  S.selection = null;
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
  const p = S.pattern;
  const n = despeckle(p.cells, p.width, p.height, level);
  if (n) emit(); else dropUndo();
  return n;
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
  setPattern(deserialize(await file.text()));
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
