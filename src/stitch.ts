/** Working through a pattern: one color at a time, one section of that color at a time. */
import { Section, colorSections, connectedCells } from './model';
import { S, doneMap, emit, fitView, pushUndo, showRect } from './store';

// ---- Sections of the color being worked ---------------------------------

let cache: { key: string; data: { list: Section[]; at: Int32Array } } | null = null;

/** The sections of the color being worked, kept until the pattern or the color changes. */
export function sections(): { list: Section[]; at: Int32Array } {
  const key = `${S.cellsVersion}:${S.stitchColor}:${S.pattern.cells.length}`;
  if (cache?.key !== key) cache = { key, data: colorSections(S.pattern, S.stitchColor) };
  return cache.data;
}

/** Number of the section being worked, or -1. */
export function currentSection(): number {
  const { at } = sections();
  return S.stitchCell >= 0 && S.stitchCell < at.length ? at[S.stitchCell] : -1;
}

export const isFinished = (s: Section) => s.done >= s.cells.length;

/** Stitched and total squares for every color, plus the whole pattern under id 0. */
export function progress(): Map<number, { done: number; total: number }> {
  const p = S.pattern, out = new Map<number, { done: number; total: number }>([[0, { done: 0, total: 0 }]]);
  for (let i = 0; i < p.cells.length; i++) {
    const v = p.cells[i];
    if (!v) continue;
    let e = out.get(v);
    if (!e) out.set(v, (e = { done: 0, total: 0 }));
    const all = out.get(0)!;
    e.total++; all.total++;
    if (p.done?.[i]) { e.done++; all.done++; }
  }
  return out;
}

// ---- Moving between colors and sections ---------------------------------

/** Outlines the current section on the canvas. */
function outline(): void {
  const k = currentSection();
  if (k < 0) { S.sectionMask = null; return; }
  const mask = new Uint8Array(S.pattern.cells.length);
  for (const i of sections().list[k].cells) mask[i] = 1;
  S.sectionMask = mask;
}

function remember(): void {
  try {
    localStorage.setItem('crosspattern.stitch.' + S.projectId, JSON.stringify({ color: S.stitchColor, cell: S.stitchCell, only: S.onlyFocus }));
  } catch { /* storage blocked */ }
}

/** Makes a section the current one, and (unless `stay`) brings it into view. */
export function goSection(k: number, stay = false): void {
  const { list } = sections();
  if (!list.length) { S.stitchCell = -1; outline(); emit(false); return; }
  k = ((k % list.length) + list.length) % list.length;
  S.stitchCell = list[k].cells[0];
  outline();
  remember();
  if (stay) emit(false); else showRect(list[k]);
}

export function stepSection(delta: number): void {
  const k = currentSection();
  goSection(k < 0 ? (delta > 0 ? 0 : -1) : k + delta);
}

/** Goes to the next section that is not finished. Returns false when the whole color is done. */
export function nextUnfinished(): boolean {
  const { list } = sections(), start = currentSection();
  for (let n = 1; n <= list.length; n++) {
    const k = (Math.max(start, -1) + n) % list.length;
    if (!isFinished(list[k])) { goSection(k); return true; }
  }
  return false;
}

/** Starts work on a color, at its first unfinished section. */
export function focusColor(id: number): void {
  S.stitchColor = id;
  S.colorId = id;
  S.highlight = S.onlyFocus ? id : 0;
  S.stitchCell = -1;
  const { list } = sections();
  const k = list.findIndex((s) => !isFinished(s));
  if (list.length) goSection(k < 0 ? 0 : k);
  else { outline(); remember(); emit(false); }
}

/** The next color (in palette order, after the current one) that still has stitches to do, or 0. */
export function nextColor(): number {
  const prog = progress(), pal = S.pattern.palette.filter((c) => prog.has(c.id));
  const at = pal.findIndex((c) => c.id === S.stitchColor);
  for (let n = 1; n <= pal.length; n++) {
    const c = pal[(Math.max(at, -1) + n) % pal.length], e = prog.get(c.id)!;
    if (e.done < e.total) return c.id;
  }
  return 0;
}

export function setOnlyFocus(on: boolean): void {
  S.onlyFocus = on;
  S.highlight = on ? S.stitchColor : 0;
  remember();
  emit(false);
}

/** Ticks a whole section off as stitched, or unticks it. */
export function setSectionDone(k: number, value: boolean): void {
  const s = sections().list[k];
  if (!s) return;
  pushUndo();
  const done = doneMap();
  for (const i of s.cells) done[i] = value ? 1 : 0;
  S.stitchCell = s.cells[0];
  emit();
  outline();
}

/** Ticks squares on the canvas. Squares of other colors are skipped while only one color is being worked. */
export function tickable(i: number): boolean {
  const v = S.pattern.cells[i];
  return v !== 0 && (!S.onlyFocus || !S.stitchColor || v === S.stitchColor);
}

/** After squares are ticked on the canvas: the section they are in becomes the current one. */
export function ticked(i: number): void {
  if (S.screen !== 'stitch' || S.pattern.cells[i] !== S.stitchColor) return;
  if (S.stitchCell >= 0 && sections().at[S.stitchCell] === sections().at[i]) return;
  S.stitchCell = i;
  outline();
  remember();
}

/** The whole section a square is in, for ticking a patch at once. */
export function sectionCells(i: number): number[] {
  const p = S.pattern;
  return connectedCells(p.cells, p.width, p.height, i);
}

// ---- Opening and closing the stitch screen ------------------------------

/** How far back Undo may go on the stitch screen, so it cannot reach into edits made in the editor. */
export let undoFloor = 0;
/** Squares already stitched when the screen opened, to count this session's work. */
export let sessionStart = 0;

/** Opens the stitch screen as a new page in the browser's history, so the phone's back button closes it. */
export function openStitch(): void {
  history.pushState({ crosspatternStitch: true }, '', '#stitch');
  syncScreen();
}

/** Leaves the stitch screen: back through history if it was opened from the editor, otherwise in place. */
export function closeStitch(): void {
  if ((history.state as { crosspatternStitch?: boolean } | null)?.crosspatternStitch) { history.back(); return; }
  history.replaceState(null, '', location.pathname + location.search);
  syncScreen();
}

/** Follows the address: #stitch shows the stitch screen. */
export function syncScreen(): void {
  const want = location.hash === '#stitch';
  if (want && S.screen !== 'stitch') enterStitch();
  else if (!want && S.screen === 'stitch') leaveStitch();
}

let editorSymbols = false;

/** Chart symbols on the stitch screen: on unless turned off there, and remembered separately from the editor. */
export function setStitchSymbols(on: boolean): void {
  S.showSymbols = on;
  try { localStorage.setItem('crosspattern.stitchSymbols', on ? '1' : '0'); } catch { /* blocked */ }
  emit(false);
}

function enterStitch(): void {
  editorSymbols = S.showSymbols;
  try { S.showSymbols = localStorage.getItem('crosspattern.stitchSymbols') !== '0'; } catch { S.showSymbols = true; }
  S.floating = null;
  S.selection = null;
  S.patch = null;
  S.info = null;
  S.screen = 'stitch';
  S.stitchMode = true;
  undoFloor = S.undo.length;
  sessionStart = progress().get(0)!.done;
  try { localStorage.setItem('crosspattern.screen', 'stitch'); } catch { /* blocked */ }
  let saved: { color?: number; cell?: number; only?: boolean } = {};
  try { saved = JSON.parse(localStorage.getItem('crosspattern.stitch.' + S.projectId) ?? '{}'); } catch { /* none */ }
  S.onlyFocus = saved.only ?? true;
  const prog = progress();
  const color = saved.color && prog.has(saved.color) ? saved.color : nextColor() || S.pattern.palette.find((c) => prog.has(c.id))?.id || 0;
  S.stitchColor = color;
  S.highlight = S.onlyFocus ? color : 0;
  S.stitchCell = saved.cell !== undefined && S.pattern.cells[saved.cell] === color ? saved.cell : -1;
  // Work on the saved section, or the color's first unfinished one. The canvas is about to be shown
  // afresh, so it brings that section into view once it knows its own size.
  if (currentSection() < 0) {
    const { list } = sections(), k = list.findIndex((s) => !isFinished(s));
    if (list.length) S.stitchCell = list[k < 0 ? 0 : k].cells[0];
  }
  const k = currentSection();
  S.autoFit = k < 0;
  S.pendingRect = k >= 0 ? sections().list[k] : null;
  outline();
  emit(false);
}

function leaveStitch(): void {
  S.showSymbols = editorSymbols;
  S.screen = 'edit';
  S.stitchMode = false;
  S.highlight = 0;
  S.sectionMask = null;
  S.pendingRect = null;
  S.autoFit = true;
  try { localStorage.setItem('crosspattern.screen', 'edit'); } catch { /* blocked */ }
  emit(false);
}

/** On opening the site, go back to the stitch screen if that is where the last visit ended. */
export function startScreen(): void {
  let last = '';
  try { last = localStorage.getItem('crosspattern.screen') ?? ''; } catch { /* blocked */ }
  if (location.hash !== '#stitch' && last === 'stitch' && S.pattern.cells.some((v) => v)) {
    history.replaceState(null, '', '#stitch');
  }
  syncScreen();
}

// ---- Keeping the screen awake -------------------------------------------

type Lock = { release(): Promise<void> };
let lock: Lock | null = null, wantAwake = false;

export const canKeepAwake = () => typeof navigator !== 'undefined' && 'wakeLock' in navigator;

async function acquire(): Promise<void> {
  if (!wantAwake || lock || document.hidden || !canKeepAwake()) return;
  try {
    lock = await (navigator as unknown as { wakeLock: { request(t: string): Promise<Lock> } }).wakeLock.request('screen');
    (lock as unknown as EventTarget).addEventListener?.('release', () => { lock = null; });
  } catch { lock = null; }
}

/** Stops the phone's screen going dark while stitching. The browser drops this when the tab is hidden. */
export function keepAwake(on: boolean): void {
  wantAwake = on;
  if (on) acquire();
  else if (lock) { lock.release().catch(() => {}); lock = null; }
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { acquire(); });

// ---- Measuring ------------------------------------------------------------
// Counting squares between two points: how far across and how far down to go from one stitch to the next.

export function setMeasuring(on: boolean): void {
  S.measuring = on;
  if (!on) S.measure = null;
  emit(false);
}

/** A click while measuring: the first sets the start, the second the end; a third starts again. */
export function measureClick(x: number, y: number): void {
  const m = S.measure;
  if (!m || m.fixed) S.measure = { a: { x, y }, b: { x, y }, fixed: false };
  else S.measure = { ...m, b: { x, y }, fixed: true };
  emit(false);
}

/** The mouse moved: until the end is chosen, it follows the mouse. */
export function measureMove(x: number, y: number): void {
  const m = S.measure;
  if (!m || m.fixed || (m.b.x === x && m.b.y === y)) return;
  S.measure = { ...m, b: { x, y } };
  emit(false);
}

/** Ends a drag: if the mouse moved to another square, that square is the end. */
export function measureRelease(x: number, y: number): void {
  const m = S.measure;
  if (m && !m.fixed && (m.a.x !== x || m.a.y !== y)) { S.measure = { ...m, b: { x, y }, fixed: true }; emit(false); }
}

/** How far it is from the start to the end, in squares: positive is right and down. */
export function measured(): { dx: number; dy: number } | null {
  const m = S.measure;
  return m ? { dx: m.b.x - m.a.x, dy: m.b.y - m.a.y } : null;
}

/** "12 right, 5 down", or "Same square". */
export function describeDistance(dx: number, dy: number): string {
  const parts: string[] = [];
  if (dx) parts.push(`${Math.abs(dx)} ${dx > 0 ? 'right' : 'left'}`);
  if (dy) parts.push(`${Math.abs(dy)} ${dy > 0 ? 'down' : 'up'}`);
  return parts.length ? parts.join(', ') : 'Same square';
}

/**
 * For starting a new section: measures from the nearest stitch already done (of any color) to the first
 * stitch of the current section, and brings both into view. Returns false if nothing is stitched yet.
 */
export function measureToSection(): boolean {
  const k = currentSection(), sec = sections().list[k];
  const p = S.pattern, done = p.done;
  if (!sec || !done) return false;
  const start = Math.min(...sec.cells), sx = start % p.width, sy = (start / p.width) | 0;
  const mine = new Set(sec.cells);
  let best = -1, bestD = Infinity;
  for (let i = 0; i < done.length; i++) {
    if (!done[i] || !p.cells[i] || mine.has(i)) continue;
    const d = Math.abs((i % p.width) - sx) + Math.abs(((i / p.width) | 0) - sy);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return false;
  const ax = best % p.width, ay = (best / p.width) | 0;
  S.measuring = true;
  S.measure = { a: { x: ax, y: ay }, b: { x: sx, y: sy }, fixed: true };
  const x0 = Math.min(ax, sx), y0 = Math.min(ay, sy);
  showRect({ x: x0 - 2, y: y0 - 2, w: Math.abs(ax - sx) + 5, h: Math.abs(ay - sy) + 5 });
  return true;
}
