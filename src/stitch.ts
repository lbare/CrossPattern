/** Working through a pattern: one color at a time, one section of that color at a time. */
import {
  MAX_CARRY, Run, Section, StitchMethod, ThreadLength, carry, colorSections, connectedCells, perStitch, planThread, stitchRoute, threadAfter,
} from './model';
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

/**
 * Goes to the next section that is not finished: the one suggested from where the thread is (see
 * suggestSection), or the next by number. Returns false when the whole color is done.
 */
export function nextUnfinished(): boolean {
  const tip = suggestSection();
  if (tip) { goSection(tip.k); return true; }
  const { list } = sections(), start = currentSection();
  for (let n = 1; n <= list.length; n++) {
    const k = (Math.max(start, -1) + n) % list.length;
    if (!isFinished(list[k])) { goSection(k); return true; }
  }
  return false;
}

/** Starts work on a color, at the section suggested for it (nearest your finished work), or its first unfinished one. */
export function focusColor(id: number): void {
  S.stitchColor = id;
  S.colorId = id;
  S.highlight = S.onlyFocus ? id : 0;
  S.stitchCell = -1;
  const { list } = sections();
  const tip = suggestSection();
  const k = tip ? tip.k : list.findIndex((s) => !isFinished(s));
  if (list.length) goSection(k < 0 ? 0 : k);
  else { outline(); remember(); emit(false); }
}

/** The color to do next (see suggestColor), or 0 when everything is stitched. */
export function nextColor(): number {
  const tip = suggestColor(S.stitchColor);
  if (tip) return tip.id;
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
  // Worked top to bottom, so the thread ends near the section's last square.
  if (value) lastStitch = { color: S.stitchColor, at: Math.max(...s.cells) };
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
  if (!(S.stitchCell >= 0 && sections().at[S.stitchCell] === sections().at[i])) {
    S.stitchCell = i;
    outline();
    remember();
  }
  // The thread is where the last stitch was made, so the plan for what is left carries on from here.
  threadAt(i);
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
  try { S.thread = { ...S.thread, ...JSON.parse(localStorage.getItem('crosspattern.thread') ?? '{}') }; } catch { /* none */ }
  try {
    const o = JSON.parse(localStorage.getItem('crosspattern.order') ?? '{}');
    S.orderGuide = !!o.on;
    S.orderMethod = o.method === 'single' ? 'single' : 'rows';
    S.orderAll = !!o.all;
  } catch { /* none */ }
  const prog = progress();
  const color = saved.color && prog.has(saved.color) ? saved.color : suggestColor(0)?.id || S.pattern.palette.find((c) => prog.has(c.id))?.id || 0;
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

// ---- The order to stitch a section in -------------------------------------

function saveOrder(): void {
  try { localStorage.setItem('crosspattern.order', JSON.stringify({ on: S.orderGuide, method: S.orderMethod, all: S.orderAll })); } catch { /* blocked */ }
}

export function setOrderGuide(on: boolean): void {
  S.orderGuide = on;
  saveOrder();
  emit(false);
}

export function setOrderAll(on: boolean): void {
  S.orderAll = on;
  saveOrder();
  emit(false);
}

export function setOrderMethod(m: StitchMethod): void {
  S.orderMethod = m;
  saveOrder();
  emit(false);
}

let routeCache: { key: string; runs: Run[] } | null = null;
/** Where the thread is: the square last ticked in the section being worked, or -1 before anything is. */
let thread = { section: '', at: -1 };

const sectionKey = () => {
  const sec = sections().list[currentSection()];
  return sec ? `${S.projectId}:${S.stitchColor}:${sec.cells[0]}:${sec.cells.length}` : '';
};

/** Remembers where the thread is, so the plan for what is left carries on from there. */
function threadAt(i: number): void {
  thread = { section: sectionKey(), at: i };
  lastStitch = { color: S.stitchColor, at: i };
}
/** The last stitch made in the color being worked, wherever it was, for choosing the next section. */
let lastStitch = { color: 0, at: -1 };

/**
 * The current section's rows still to stitch, in order. Only squares not yet ticked are planned, so
 * stitches done out of order, or a section half finished some other way, are fine: the plan covers what
 * is left, starting from where the thread last was. Empty when no section is chosen or it is all done.
 */
export function route(): Run[] {
  const k = currentSection(), sec = sections().list[k];
  if (!sec) return [];
  const done = S.pattern.done, left = done ? sec.cells.filter((i) => !done[i]) : sec.cells;
  const from = thread.section === sectionKey() ? thread.at : -1;
  let sig = 0;
  for (const i of left) sig = (sig * 31 + i) | 0;
  const key = `${sectionKey()}:${left.length}:${sig}:${from}:${S.orderMethod}`;
  if (routeCache?.key !== key) routeCache = { key, runs: stitchRoute(left, S.pattern.width, S.orderMethod, from) };
  return routeCache.runs;
}

/** The row to stitch next (always the first of what is left), or -1 when nothing is. */
export function currentRun(): number {
  return route().length ? 0 : -1;
}

/**
 * How the thread gets from one row to the next. A step is to the next row; a carry is a short way
 * across the back; "under" is a longer way that only passes over stitches already done, so the thread
 * can be slipped under them on the back; a jump is too far, and needs a new thread.
 */
export function moveBetween(from: number, to: number, passed?: Set<number>): { kind: 'step' | 'carry' | 'under' | 'jump'; d: number } {
  const p = S.pattern, w = p.width, d = carry(from, to, w);
  if (d <= 1) return { kind: 'step', d };
  if (d <= MAX_CARRY) return { kind: 'carry', d };
  // Check every square on the straight way across, not counting the two ends.
  const x0 = from % w, y0 = (from / w) | 0, x1 = to % w, y1 = (to / w) | 0;
  let under = true;
  for (let s = 1; s < d && under; s++) {
    const x = Math.round(x0 + ((x1 - x0) * s) / d), y = Math.round(y0 + ((y1 - y0) * s) / d), i = y * w + x;
    // Done already, or done by then: earlier rows of the plan will be finished by the time the thread gets here.
    if (!p.cells[i] || !(p.done?.[i] || passed?.has(i))) under = false;
  }
  return { kind: under ? 'under' : 'jump', d };
}

/** Ticks off one row of the plan. When that finishes the section, moves on to the next unfinished one. */
export function runDone(k: number): void {
  const runs = route(), run = runs[k];
  if (!run) return;
  pushUndo();
  const done = doneMap();
  for (const i of run.cells) done[i] = 1;
  threadAt(threadAfter(run, S.orderMethod));
  emit();
  if (currentRun() < 0) nextUnfinished();
}

/** A plain description of one row of the plan and what comes after it. */
export function describeRun(k: number): { title: string; left: number; how: string; then: string; jump: boolean } {
  const runs = route(), run = runs[k], w = S.pattern.width, m = S.orderMethod;
  if (!run) return { title: '', left: 0, how: '', then: '', jump: false };
  const a = run.cells[0], b = run.cells[run.cells.length - 1], n = run.cells.length;
  const ax = (a % w) + 1, ay = ((a / w) | 0) + 1, bx = (b % w) + 1, by = ((b / w) | 0) + 1;
  const word = run.vertical ? 'Column' : 'Row';
  const there = run.vertical ? (by > ay ? 'down' : 'up') : bx > ax ? 'left to right' : 'right to left';
  const back = run.vertical ? (by > ay ? 'up' : 'down') : bx > ax ? 'right to left' : 'left to right';
  const where = n === 1 ? `column ${ax}, row ${ay}` : run.vertical ? `column ${ax}, rows ${ay} to ${by}` : `row ${ay}, columns ${ax} to ${bx}`;
  const left = runs.length - k;
  const title = `${n} stitch${n === 1 ? '' : 'es'}, ${where}`;
  const how = n === 1
    ? 'A single cross: stitch it in full.'
    : m === 'rows'
      ? `Work the half stitches ${there}, then come back ${back} crossing each one.`
      : `Finish each cross before the next, working ${there}.`;
  const next = runs[k + 1];
  if (!next) {
    const tip = suggestSection();
    const then = tip
      ? `That is the last of this section. Next: section ${tip.k + 1}, ${tip.d} square${tip.d === 1 ? '' : 's'} away. ${tip.advice}`
      : 'That is the last of this section.';
    return { title, left, how, then, jump: tip?.kind === 'jump' };
  }
  const passed = new Set(runs.slice(0, k + 1).flatMap((r) => r.cells));
  const { kind, d } = moveBetween(threadAfter(run, m), next.cells[0], passed);
  const jump = kind === 'jump', next_ = `the next ${word.toLowerCase()}`;
  const then = kind === 'jump'
    ? `${next_[0].toUpperCase() + next_.slice(1)} is ${d} squares away: finish off the thread and start again there, rather than carrying it across the back.`
    : kind === 'under'
      ? `Then slip the thread under the finished stitches on the back, ${d} squares over to ${next_}.`
      : kind === 'step'
        ? `Then step ${run.vertical ? 'across' : 'down'} to ${next_}.`
        : `Then carry the thread ${d} squares to ${next_}.`;
  return { title, left, how, then, jump };
}

// ---- Which section, and which color, to do next ----------------------------

/** Advice for getting the thread from one place to the next. */
function adviceFor(kind: 'step' | 'carry' | 'under' | 'jump' | 'none'): string {
  return kind === 'step' || kind === 'carry'
    ? 'Carry the thread straight over.'
    : kind === 'under'
      ? 'Slip the thread under the finished stitches on the back to get there.'
      : kind === 'jump'
        ? 'Too far to carry: finish off and start a new thread there.'
        : '';
}

export interface SectionTip {
  /** The section to do next. */
  k: number;
  /** How far it is, in squares, and how to get there. */
  d: number;
  kind: 'step' | 'carry' | 'under' | 'jump' | 'none';
  advice: string;
  /** From where the thread will be, to the nearest square of that section (-1 when not known). */
  from: number;
  to: number;
}

/**
 * The section of this color to do after the current one. Stitchers go to the nearest one, so the thread
 * can often be carried or slipped under finished work instead of being finished off. Distance is measured
 * from where the thread will be: the end of the current section's plan if it is unfinished, otherwise the
 * last stitch made in this color. With nothing to go on, it is the section nearest your finished work, or
 * the middle of the pattern.
 */
export function suggestSection(): SectionTip | null {
  const { list } = sections(), cur = currentSection(), p = S.pattern, w = p.width;
  const curSec = list[cur];
  let from = -1, passed: Set<number> | undefined;
  if (curSec && !isFinished(curSec)) {
    const runs = route();
    if (runs.length) from = threadAfter(runs[runs.length - 1], S.orderMethod);
    passed = new Set(curSec.cells);
  } else if (lastStitch.color === S.stitchColor && lastStitch.at >= 0) from = lastStitch.at;
  let best: SectionTip | null = null, bestCost = Infinity;
  const near = from < 0 ? nearness() : null;
  list.forEach((sec, k) => {
    if (k === cur || isFinished(sec)) return;
    for (const i of sec.cells) {
      if (p.done?.[i]) continue;
      let cost: number;
      if (from >= 0) {
        // Going back up the fabric costs a little more, as within a section.
        const up = Math.max(0, ((from / w) | 0) - ((i / w) | 0));
        cost = carry(from, i, w) + up * 0.5;
      } else cost = near![i];
      if (cost < bestCost) { bestCost = cost; best = { k, d: 0, kind: 'none', advice: '', from, to: i }; }
    }
  });
  if (!best) return null;
  const b: SectionTip = best;
  if (from >= 0) {
    const m = moveBetween(from, b.to, passed);
    b.d = m.d;
    b.kind = m.kind;
  } else b.d = Math.round(bestCost);
  b.advice = adviceFor(b.kind);
  return b;
}

let nearCache: { key: number; map: Uint16Array; anyDone: boolean } | null = null;

/**
 * How far every square is from the stitches already done (counting diagonal steps as one), or from the
 * middle of the pattern when nothing is done yet.
 */
function nearnessMap(): { map: Uint16Array; anyDone: boolean } {
  if (nearCache?.key === S.cellsVersion) return nearCache;
  const p = S.pattern, w = p.width, h = p.height, n = w * h, map = new Uint16Array(n).fill(65535), q = new Int32Array(n);
  let qt = 0;
  for (let i = 0; i < n; i++) if (p.done?.[i] && p.cells[i]) { map[i] = 0; q[qt++] = i; }
  const anyDone = qt > 0;
  if (!anyDone) {
    // Nothing stitched yet: measure from the middle.
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    for (let i = 0; i < n; i++) map[i] = Math.round(Math.max(Math.abs((i % w) - cx), Math.abs(((i / w) | 0) - cy)));
  } else {
    for (let qh = 0; qh < qt; qh++) {
      const i = q[qh], x = i % w, y = (i / w) | 0, d = map[i] + 1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (map[j] > d) { map[j] = d; q[qt++] = j; }
      }
    }
  }
  nearCache = { key: S.cellsVersion, map, anyDone };
  return nearCache;
}
const nearness = () => nearnessMap().map;

export interface ColorTip { id: number; why: string }

/**
 * The color to stitch next (other than `except`). Before anything is stitched, the color nearest the
 * middle: starting in the middle keeps the design centred on the fabric. After that, the color with the
 * most stitches right beside finished ones, so you can count from finished work, then the one closest
 * to it, then the one with the most left to do.
 */
export function suggestColor(except: number): ColorTip | null {
  const p = S.pattern, { map, anyDone } = nearnessMap(), prog = progress();
  const stats = new Map<number, { touch: number; dist: number; left: number }>();
  for (let i = 0; i < p.cells.length; i++) {
    const v = p.cells[i];
    if (!v || v === except || p.done?.[i]) continue;
    let st = stats.get(v);
    if (!st) stats.set(v, (st = { touch: 0, dist: 65535, left: 0 }));
    st.left++;
    if (map[i] < st.dist) st.dist = map[i];
    if (anyDone && map[i] === 1) st.touch++;
  }
  let best = 0, b: { touch: number; dist: number; left: number } | null = null;
  for (const [id, st] of stats) {
    if (!prog.has(id)) continue;
    const better = !b
      || (anyDone && st.touch !== b.touch ? st.touch > b.touch : st.dist !== b.dist ? st.dist < b.dist : st.left > b.left);
    if (better) { best = id; b = st; }
  }
  if (!b) return null;
  const why = !anyDone
    ? 'It is in the middle of the design. Starting in the middle keeps the design centred on your fabric.'
    : b.touch
      ? `${b.touch.toLocaleString()} of its stitches are right beside ones you have finished, so you can count from them.`
      : `It is the closest to what you have stitched, ${b.dist} squares away.`;
  return { id: best, why };
}

// ---- Thread -----------------------------------------------------------------

export function setThread(patch: Partial<typeof S.thread>): void {
  S.thread = { ...S.thread, ...patch };
  try { localStorage.setItem('crosspattern.thread', JSON.stringify(S.thread)); } catch { /* blocked */ }
  emit(false);
}

/** A length of thread, written the way the user measures. */
export function showLength(mm: number): string {
  if (S.thread.unit === 'in') {
    const inches = mm / 25.4;
    return inches >= 36 ? `${(inches / 36).toFixed(1)} yd` : `${Math.round(inches)} in`;
  }
  return mm >= 1000 ? `${(mm / 1000).toFixed(1)} m` : `${Math.round(mm / 10)} cm`;
}

let threadCache: { key: string; plan: { total: number; lengths: ThreadLength[] } } | null = null;

/**
 * The thread for what is left of the current section, following the stitching order: how much, and how
 * to cut it into lengths, each ending where it runs out. Adapts as stitches are ticked.
 */
export function threadPlan(): { total: number; lengths: ThreadLength[] } | null {
  const runs = route();
  if (!runs.length) return null;
  const t = S.thread, key = `${runs.length}:${runs[0].cells[0]}:${runs.reduce((a, r) => a + r.cells.length, 0)}:${S.orderMethod}:${t.count}:${t.maxLength}`;
  if (threadCache?.key !== key) {
    threadCache = { key, plan: planThread(runs, S.pattern.width, { count: t.count, maxLength: t.maxLength, method: S.orderMethod }) };
  }
  return threadCache.plan;
}

/** Thread for everything left in a color, and how many skeins that is (8 m of six strands each). */
export function colorThread(id: number): { mm: number; skeins: number } {
  const p = S.pattern;
  let n = 0;
  for (let i = 0; i < p.cells.length; i++) if (p.cells[i] === id && !p.done?.[i]) n++;
  // Each stitch, plus a share of starting and finishing off: roughly one length per thirty stitches.
  const mm = n * perStitch(S.thread.count, S.orderMethod) * 1.1 + Math.ceil(n / 30) * 100;
  return { mm, skeins: (mm * S.thread.strands) / (6 * 8000) };
}

// ---- Starting somewhere else --------------------------------------------------

export function setPickingStart(on: boolean): void {
  S.pickingStart = on;
  emit(false);
}

/**
 * Starts the plan for a section on a square of your choosing instead of the suggested one. A square in
 * another section of the color makes that section the current one. Returns false for a square that is
 * not of the color being worked, or already stitched.
 */
export function setStart(i: number): boolean {
  const p = S.pattern;
  if (p.cells[i] !== S.stitchColor || p.done?.[i]) return false;
  if (!(S.stitchCell >= 0 && sections().at[S.stitchCell] === sections().at[i])) {
    S.stitchCell = i;
    outline();
    remember();
  }
  thread = { section: sectionKey(), at: i };
  S.pickingStart = false;
  S.orderGuide = true;
  emit(false);
  return true;
}

/** Whether the current section's plan starts from a square chosen by hand. */
export function startChosen(): boolean {
  return thread.section === sectionKey() && thread.at >= 0 && !S.pattern.done?.[thread.at];
}

/** Goes back to the suggested start for the current section. */
export function clearStart(): void {
  if (thread.section === sectionKey()) thread = { section: '', at: -1 };
  emit(false);
}
