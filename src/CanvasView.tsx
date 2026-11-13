import { useEffect, useRef } from 'react';
import { clamp, hexToRgb, inkFor, rgbToHex } from './color';
import {
  currentRun, currentSection, describeDistance, measureClick, measureMove, measureRelease, moveBetween, route, sectionCells, suggestSection, sections, tickable, ticked,
} from './stitch';
import { floodFill, linePoints, nextId, nextSymbol, replaceAll, threadAfter, tidyCell } from './model';
import { FABRIC, buildCellImage, convertedImage, drawOverlay } from './render';
import {
  S, Tool, PatchAction, addColor, clearPatch, patchAction, selectPatch, selectSameColors, commitFloating, copySelection, cropToSelection, cutSelection, deleteSelection, doneMap, dropUndo, emit,
  fitView, keys, liftSelection, lockedIds, openDialog, pushUndo, refImage, samplePhoto, selectedRect, subscribe, transformSelection,
  showRect, undo, useStore, zoomAt,
} from './store';

type CellFn = (x: number, y: number) => void;
const BRUSH_TOOLS: Tool[] = ['pencil', 'eraser', 'recolor', 'tidy', 'restore', 'line'];

type Drag =
  | { mode: 'pan'; px: number; py: number; ox: number; oy: number; tap: { x: number; y: number } | null; far: boolean }
  | { mode: 'paint'; fn: CellFn; size: number; lx: number; ly: number }
  | { mode: 'shape' }
  | { mode: 'move'; sx: number; sy: number; fx: number; fy: number }
  | { mode: 'select'; x0: number; y0: number; moved: boolean }
  | { mode: 'done'; value: number; lx: number; ly: number }
  | { mode: 'measure' };

interface Preview { kind: 'line' | 'rect' | 'ellipse' | 'backstitch'; x0: number; y0: number; x1: number; y1: number; filled: boolean }

export function CanvasView() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!, wrap = canvas.parentElement!, ctx = canvas.getContext('2d')!;
    let raf = 0;
    let img: HTMLCanvasElement | null = null, imgKey = '';
    let preview: Preview | null = null;
    let hover: { x: number; y: number } | null = null;
    let drag: Drag | null = null;

    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };

    const resize = () => {
      const w = wrap.clientWidth, h = wrap.clientHeight, dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const was = S.viewport;
      S.viewport = { w, h };
      const onStitch = !!wrap.closest('.stitch');
      // A section waiting to be shown belongs to the stitch screen's canvas, not the editor's.
      if (S.pendingRect && w > 0 && onStitch) { const r = S.pendingRect; S.pendingRect = null; showRect(r); }
      else if (S.autoFit && w > 0) fitView();
      else if (w > 0 && was.w > 0) {
        // The space changed size (a phone turned round, a window resized): keep the same part of the
        // pattern in the middle, and on the stitch screen re-fit the section if the space changed a lot.
        const k = onStitch ? currentSection() : -1;
        if (k >= 0 && Math.abs(w - was.w) > was.w * 0.25) showRect(sections().list[k]);
        else { S.view.ox += Math.round((w - was.w) / 2); S.view.oy += Math.round((h - was.h) / 2); }
      }
      schedule();
    };

    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < S.pattern.width && y < S.pattern.height;

    const hexOf = (id: number) => S.pattern.palette.find((c) => c.id === id)?.hex ?? '#000000';

    /** Squares covered by the brush when its centre is at x, y. */
    const brushCells = (x: number, y: number, fn: CellFn, b = S.brush) => {
      const off = Math.floor((b - 1) / 2);
      for (let dy = 0; dy < b; dy++) for (let dx = 0; dx < b; dx++) {
        const xx = x - off + dx, yy = y - off + dy;
        if (inside(xx, yy)) fn(xx, yy);
      }
    };
    /** The tidy brush needs neighbours to judge by, so it never works on a single square. */
    const sizeFor = (tool: Tool) => (tool === 'tidy' ? Math.max(3, S.brush) : S.brush);

    /** With mirror on, everything done to a square is also done to its twin across the centre line. */
    const mirrored = (fn: CellFn): CellFn => (x, y) => {
      fn(x, y);
      const mx = S.pattern.width - 1 - x;
      if (S.mirror && mx !== x) fn(mx, y);
    };

    /** What one brush does to one square. `target` is the color that was under the cursor when the stroke began. */
    const cellAction = (tool: Tool, target: number): CellFn => {
      const p = S.pattern, cv = p.reference?.converted;
      const ids = new Map(p.palette.map((c) => [c.hex, c.id]));
      const locked = lockedIds();
      return (x, y) => {
        const i = y * p.width + x;
        if (locked.has(p.cells[i])) return;
        if (tool === 'pencil') p.cells[i] = S.colorId;
        else if (tool === 'eraser') p.cells[i] = 0;
        else if (tool === 'recolor') { if (p.cells[i] === target) p.cells[i] = S.colorId; }
        else if (tool === 'tidy') tidyCell(p.cells, p.width, p.height, x, y);
        else if (tool === 'restore' && cv && x < cv.width && y < cv.height) {
          const v = cv.cells[y * cv.width + x];
          if (!v) { p.cells[i] = 0; return; }
          const hex = cv.hexes[v - 1];
          let id = ids.get(hex);
          if (id === undefined) {
            // The color was merged or deleted since converting, so bring it back.
            id = nextId(p.palette);
            p.palette.push({ id, hex, symbol: nextSymbol(p.palette) });
            ids.set(hex, id);
          }
          p.cells[i] = id;
        }
      };
    };

    const shapeCells = (p: Preview, fn: CellFn) => {
      if (p.kind === 'line') {
        for (const [x, y] of linePoints(p.x0, p.y0, p.x1, p.y1)) brushCells(x, y, fn);
        return;
      }
      const xa = Math.min(p.x0, p.x1), xb = Math.max(p.x0, p.x1);
      const ya = Math.min(p.y0, p.y1), yb = Math.max(p.y0, p.y1);
      if (p.kind === 'ellipse') {
        // A square belongs to the ellipse when its centre is inside; the outline is the squares on its rim.
        const rx = (xb - xa + 1) / 2, ry = (yb - ya + 1) / 2, cx = xa + rx, cy = ya + ry;
        const within = (x: number, y: number) => ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1;
        for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
          if (!within(x, y) || !inside(x, y)) continue;
          if (p.filled || !within(x - 1, y) || !within(x + 1, y) || !within(x, y - 1) || !within(x, y + 1)) fn(x, y);
        }
        return;
      }
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        if ((p.filled || x === xa || x === xb || y === ya || y === yb) && inside(x, y)) fn(x, y);
      }
    };

    function draw() {
      raf = 0;
      const dpr = window.devicePixelRatio || 1;
      const { w, h } = S.viewport, p = S.pattern, { scale, ox, oy } = S.view;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const pw = p.width * scale, ph = p.height * scale;
      ctx.fillStyle = p.fabric ?? FABRIC;
      ctx.fillRect(ox, oy, pw, ph);

      const key = S.cellsVersion + ':' + S.highlight + ':' + S.stitchMode;
      if (!img || key !== imgKey) { img = buildCellImage(p, S.highlight, img ?? undefined, S.stitchMode); imgKey = key; }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, ox, oy, pw, ph);

      // Guide picture over the stitches: the photo or the first conversion, faded, or in full while peeking.
      const ref = p.reference;
      const showing = S.refPeek && S.refMode === 'off' ? (ref?.photo ? 'photo' : 'converted') : S.refMode;
      if (ref && showing !== 'off') {
        ctx.save();
        ctx.beginPath();
        ctx.rect(ox, oy, pw, ph);
        ctx.clip();
        ctx.globalAlpha = S.refPeek ? 1 : S.refOpacity;
        if (showing === 'photo' && ref.photo) {
          const photo = refImage(ref.photo);
          if (photo) {
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(photo, ox + ref.rect.x * scale, oy + ref.rect.y * scale, ref.rect.w * scale, ref.rect.h * scale);
          }
        } else if (showing === 'converted' && ref.converted) {
          ctx.fillStyle = FABRIC;
          ctx.fillRect(ox, oy, pw, ph);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(convertedImage(ref.converted), ox, oy, ref.converted.width * scale, ref.converted.height * scale);
        }
        ctx.restore();
      }

      ctx.save();
      ctx.translate(ox, oy);

      const f = S.floating;
      if (f) {
        for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
          const v = f.data[y * f.w + x];
          if (!v) continue;
          ctx.fillStyle = hexOf(v);
          ctx.fillRect((f.x + x) * scale, (f.y + y) * scale, scale + 0.5, scale + 0.5);
        }
      }
      if (preview && preview.kind !== 'backstitch') {
        ctx.fillStyle = hexOf(S.colorId);
        ctx.globalAlpha = 0.75;
        shapeCells(preview, mirrored((x, y) => ctx.fillRect(x * scale, y * scale, scale, scale)));
        ctx.globalAlpha = 1;
      }

      drawOverlay(ctx, p, scale, {
        x0: clamp(Math.floor(-ox / scale), 0, p.width),
        y0: clamp(Math.floor(-oy / scale), 0, p.height),
        x1: clamp(Math.ceil((w - ox) / scale), 0, p.width),
        y1: clamp(Math.ceil((h - oy) / scale), 0, p.height),
      }, {
        grid: S.showGrid, symbols: S.showSymbols, rulers: true, dimDone: S.stitchMode,
        ink: getComputedStyle(wrap).color, highlight: S.highlight,
      });

      if (S.mirror) {
        const mx = Math.round((p.width / 2) * scale) + 0.5;
        ctx.strokeStyle = '#e11d74';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(mx, 0);
        ctx.lineTo(mx, ph);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (preview?.kind === 'backstitch') {
        ctx.strokeStyle = hexOf(S.colorId);
        ctx.lineWidth = Math.max(1.5, scale * 0.2);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(preview.x0 * scale, preview.y0 * scale);
        ctx.lineTo(preview.x1 * scale, preview.y1 * scale);
        ctx.stroke();
        ctx.lineCap = 'butt';
      }

      // The part of the pattern on screen, in squares.
      const vx0 = clamp(Math.floor(-ox / scale), 0, p.width), vx1 = clamp(Math.ceil((w - ox) / scale), 0, p.width);
      const vy0 = clamp(Math.floor(-oy / scale), 0, p.height), vy1 = clamp(Math.ceil((h - oy) / scale), 0, p.height);
      /** The line around the edge of a set of squares. */
      const edgeOf = (mask: Uint8Array, wash: string | null) => {
        const on = (x: number, y: number) => x >= 0 && y >= 0 && x < p.width && y < p.height && mask[y * p.width + x] === 1;
        const edge = new Path2D();
        if (wash) ctx.fillStyle = wash;
        for (let y = vy0; y < vy1; y++) for (let x = vx0; x < vx1; x++) {
          if (!on(x, y)) continue;
          if (wash) ctx.fillRect(x * scale, y * scale, scale, scale);
          const l = x * scale + 0.5, t = y * scale + 0.5, r = (x + 1) * scale + 0.5, b = (y + 1) * scale + 0.5;
          if (!on(x, y - 1)) { edge.moveTo(l, t); edge.lineTo(r, t); }
          if (!on(x, y + 1)) { edge.moveTo(l, b); edge.lineTo(r, b); }
          if (!on(x - 1, y)) { edge.moveTo(l, t); edge.lineTo(l, b); }
          if (!on(x + 1, y)) { edge.moveTo(r, t); edge.lineTo(r, b); }
        }
        return edge;
      };

      if (S.stitchMode && p.done && scale >= 6) {
        // Stitched squares get a cross, in dark or light ink, whichever shows up on that color.
        // Judged on the lighter shade a stitched square is drawn in, not on the color itself.
        const [fr, fg, fb] = hexToRgb(p.fabric ?? FABRIC);
        const shade = (hex: string) => { const [r, g, b] = hexToRgb(hex); return rgbToHex(r * 0.55 + fr * 0.45, g * 0.55 + fg * 0.45, b * 0.55 + fb * 0.45); };
        const lightInk = new Set(p.palette.filter((c) => inkFor(shade(c.hex)) === '#ffffff').map((c) => c.id));
        const m = scale * 0.24, dark = new Path2D(), light = new Path2D();
        for (let y = vy0; y < vy1; y++) for (let x = vx0; x < vx1; x++) {
          const i = y * p.width + x;
          if (!p.done[i] || !p.cells[i] || (S.highlight && p.cells[i] !== S.highlight)) continue;
          const path = lightInk.has(p.cells[i]) ? light : dark;
          const l = x * scale + m, t = y * scale + m, r = (x + 1) * scale - m, b = (y + 1) * scale - m;
          path.moveTo(l, t); path.lineTo(r, b); path.moveTo(r, t); path.lineTo(l, b);
        }
        ctx.lineWidth = Math.max(1.2, scale * 0.08); ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(20,18,16,0.6)'; ctx.stroke(dark);
        ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke(light);
        ctx.lineCap = 'butt';
      }

      const section = S.sectionMask;
      if (S.stitchMode && section && section.length === p.cells.length) {
        // The section being worked: a bold two-tone line around it.
        const edge = edgeOf(section, null);
        ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.stroke(edge);
        ctx.lineWidth = 2; ctx.strokeStyle = '#e11d74'; ctx.stroke(edge);
      }

      if (S.stitchMode && S.orderGuide && scale >= 4) drawOrder(scale);

      const m = S.stitchMode && S.measuring ? S.measure : null;
      if (m && inside(m.a.x, m.a.y) && inside(m.b.x, m.b.y)) {
        // The measurement: both squares ringed, and an L-shaped path between them, across then down,
        // labelled with how many squares each way.
        const { a, b } = m, dx = b.x - a.x, dy = b.y - a.y;
        const cx = (x: number) => (x + 0.5) * scale, cy = (y: number) => (y + 0.5) * scale;
        const ring = (q: { x: number; y: number }) => {
          ctx.lineWidth = 4; ctx.strokeStyle = '#fff'; ctx.strokeRect(q.x * scale, q.y * scale, scale, scale);
          ctx.lineWidth = 2; ctx.strokeStyle = '#0a84ff'; ctx.strokeRect(q.x * scale, q.y * scale, scale, scale);
        };
        const path = new Path2D();
        path.moveTo(cx(a.x), cy(a.y));
        path.lineTo(cx(b.x), cy(a.y));
        path.lineTo(cx(b.x), cy(b.y));
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke(path);
        ctx.lineWidth = 2; ctx.strokeStyle = '#0a84ff'; ctx.setLineDash([6, 4]); ctx.stroke(path); ctx.setLineDash([]);
        ring(a);
        ring(b);
        const label = (text: string, x: number, y: number) => {
          ctx.font = '600 12px system-ui, sans-serif';
          const w = ctx.measureText(text).width + 12, h = 20;
          ctx.fillStyle = '#0a84ff';
          ctx.beginPath();
          ctx.roundRect(x - w / 2, y - h / 2, w, h, 5);
          ctx.fill();
          ctx.fillStyle = '#fff';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(text, x, y + 0.5);
          ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
        };
        if (dx) label(`${Math.abs(dx)} ${dx > 0 ? '→' : '←'}`, (cx(a.x) + cx(b.x)) / 2, cy(a.y) - (dy < 0 ? -14 : 14));
        if (dy) label(`${Math.abs(dy)} ${dy > 0 ? '↓' : '↑'}`, cx(b.x) + (dx < 0 ? -22 : 22), (cy(a.y) + cy(b.y)) / 2);
      }

      const patch = S.patch;
      if (patch && patch.mask.length === p.cells.length) {
        // The selected shape: a light wash over its squares and a two-tone line around its edge.
        const edge = edgeOf(patch.mask, 'rgba(255,255,255,0.22)');
        ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke(edge);
        ctx.lineWidth = 1.25; ctx.strokeStyle = '#111'; ctx.setLineDash([4, 3]); ctx.stroke(edge); ctx.setLineDash([]);
      }

      const sel = S.floating ?? S.selection;
      if (sel) {
        const r = [sel.x * scale + 0.5, sel.y * scale + 0.5, sel.w * scale, sel.h * scale] as const;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#fff';
        ctx.strokeRect(...r);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#111';
        ctx.strokeRect(...r);
        ctx.setLineDash([]);
      }

      if (hover && !drag) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        if (S.tool === 'backstitch') {
          const gx = clamp(Math.round(hover.x), 0, p.width), gy = clamp(Math.round(hover.y), 0, p.height);
          ctx.fillStyle = hexOf(S.colorId);
          ctx.beginPath();
          ctx.arc(gx * scale, gy * scale, Math.max(3, scale * 0.18), 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (S.tool !== 'pan' && S.tool !== 'select') {
          const cx = Math.floor(hover.x), cy = Math.floor(hover.y);
          const b = !S.stitchMode && BRUSH_TOOLS.includes(S.tool) ? sizeFor(S.tool) : 1;
          const off = Math.floor((b - 1) / 2);
          if (inside(cx, cy)) ctx.strokeRect((cx - off) * scale + 0.5, (cy - off) * scale + 0.5, b * scale, b * scale);
        }
      }
      ctx.restore();
    }

    /**
     * The order to stitch the current section in: a numbered arrow along each row, a dotted line for each
     * move to the next row (orange where the thread should be finished off rather than carried), Start and
     * End markers, and the row to do next drawn boldly with its way back shown.
     */
    const drawOrder = (scale: number) => {
      const runs = route();
      if (!runs.length) return;
      const p = S.pattern, w = p.width, method = S.orderMethod, now = currentRun();
      const cx = (i: number) => ((i % w) + 0.5) * scale, cy = (i: number) => (((i / w) | 0) + 0.5) * scale;
      const finished = (k: number) => runs[k].cells.every((i) => p.done?.[i]);
      const head = (x0: number, y0: number, x1: number, y1: number, size: number) => {
        const a = Math.atan2(y1 - y0, x1 - x0);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - size * Math.cos(a - 0.5), y1 - size * Math.sin(a - 0.5));
        ctx.lineTo(x1 - size * Math.cos(a + 0.5), y1 - size * Math.sin(a + 0.5));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      };
      const badge = (text: string, x: number, y: number, fill: string) => {
        ctx.font = `600 ${Math.round(clamp(scale * 0.42, 10, 13))}px system-ui, sans-serif`;
        const bw = Math.max(ctx.measureText(text).width + 10, 18), bh = clamp(scale * 0.6, 15, 19);
        ctx.fillStyle = fill;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.roundRect(x - bw / 2, y - bh / 2, bw, bh, bh / 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(text, x, y + 0.5);
        ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
      };
      const INK = '#1b1b1f', NOW = '#7c3aed', JUMP = '#f97316', START = '#16a34a';

      // Moves between rows, underneath everything else.
      ctx.lineCap = 'round';
      const passed = new Set<number>();
      for (let k = 0; k + 1 < runs.length; k++) {
        for (const i of runs[k].cells) passed.add(i);
        const from = threadAfter(runs[k], method), to = runs[k + 1].cells[0];
        const { kind } = moveBetween(from, to, passed), jump = kind === 'jump';
        ctx.globalAlpha = finished(k + 1) ? 0.3 : 1;
        ctx.setLineDash([Math.max(2, scale * 0.15), Math.max(3, scale * 0.2)]);
        ctx.lineWidth = Math.max(1.5, scale * 0.08);
        ctx.strokeStyle = jump ? JUMP : 'rgba(27,27,31,0.7)';
        ctx.beginPath();
        // A short move turns the corner square by square; a long one goes straight.
        const short = kind === 'step' || kind === 'carry';
        ctx.moveTo(cx(from), cy(from));
        if (short && runs[k].vertical) ctx.lineTo(cx(to), cy(from)); else if (short) ctx.lineTo(cx(from), cy(to));
        ctx.lineTo(cx(to), cy(to));
        ctx.stroke();
        ctx.setLineDash([]);
        if (jump && scale >= 10) {
          const mx = (cx(from) + cx(to)) / 2, my = (cy(from) + cy(to)) / 2;
          badge('✂ new thread', mx, my, JUMP);
        }
      }
      ctx.globalAlpha = 1;

      // Each row: an arrow from its first stitch to its last.
      runs.forEach((run, k) => {
        const a = run.cells[0], b = run.cells[run.cells.length - 1], isNow = k === now;
        ctx.globalAlpha = finished(k) ? 0.3 : 1;
        const lw = isNow ? Math.max(3, scale * 0.16) : Math.max(1.5, scale * 0.09);
        const size = isNow ? clamp(scale * 0.5, 7, 16) : clamp(scale * 0.38, 5, 12);
        const color = isNow ? NOW : INK;
        if (a === b) {
          ctx.fillStyle = color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(cx(a), cy(a), Math.max(2.5, scale * (isNow ? 0.2 : 0.14)), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        } else {
          // Stop the shaft short of the last square's middle so the arrowhead points into it.
          const len = Math.hypot(cx(b) - cx(a), cy(b) - cy(a)), ux = (cx(b) - cx(a)) / len, uy = (cy(b) - cy(a)) / len;
          const ex = cx(b) + ux * scale * 0.3, ey = cy(b) + uy * scale * 0.3;
          for (const [style, width] of [['#fff', lw + 2.5], [color, lw]] as const) {
            ctx.strokeStyle = style; ctx.lineWidth = width;
            ctx.beginPath(); ctx.moveTo(cx(a), cy(a)); ctx.lineTo(ex - ux * size * 0.6, ey - uy * size * 0.6); ctx.stroke();
          }
          ctx.fillStyle = color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
          head(cx(a), cy(a), ex, ey, size);
          if (isNow && method === 'rows') {
            // The way back along the same row, crossing each half stitch: a thinner arrow alongside.
            const off = scale * 0.32, px = -uy * off, py = ux * off;
            ctx.setLineDash([Math.max(3, scale * 0.25), Math.max(2, scale * 0.15)]);
            ctx.strokeStyle = NOW; ctx.lineWidth = Math.max(1.5, scale * 0.07);
            ctx.beginPath(); ctx.moveTo(cx(b) + px, cy(b) + py); ctx.lineTo(cx(a) + px - ux * scale * 0.1, cy(a) + py - uy * scale * 0.1); ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = NOW;
            head(cx(b) + px, cy(b) + py, cx(a) + px - ux * scale * 0.3, cy(a) + py - uy * scale * 0.3, size * 0.75);
          }
        }
        if (scale >= 14 || isNow) {
          const bx = cx(a) - (run.vertical ? 0 : scale * 0.5), by = cy(a) - (run.vertical ? scale * 0.5 : 0);
          badge(String(k + 1), bx, by, isNow ? NOW : INK);
        }
      });
      ctx.globalAlpha = 1;

      // Where to begin and where the section ends.
      const first = runs[0].cells[0], last = threadAfter(runs[runs.length - 1], method);
      ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
      ctx.strokeRect(((first % w)) * scale + 1, ((first / w) | 0) * scale + 1, scale - 2, scale - 2);
      ctx.lineWidth = 2; ctx.strokeStyle = START;
      ctx.strokeRect(((first % w)) * scale + 1, ((first / w) | 0) * scale + 1, scale - 2, scale - 2);
      if (scale >= 8) {
        badge('Start', cx(first), cy(first) - scale * 0.5 - 12, START);
        if ((runs.length > 1 || runs[0].cells.length > 1) && last !== first) badge('End', cx(last) + scale * 0.5, cy(last) - scale * 0.5 - 10, INK);
      }
      // Where to go after this section: a line to the nearest square of the suggested next one.
      const tip = suggestSection();
      if (tip && tip.from >= 0) {
        const NEXT = tip.kind === 'jump' ? JUMP : '#0d9488';
        ctx.setLineDash([Math.max(4, scale * 0.3), Math.max(3, scale * 0.2)]);
        ctx.lineWidth = Math.max(2, scale * 0.09);
        ctx.strokeStyle = NEXT;
        ctx.beginPath(); ctx.moveTo(cx(tip.from), cy(tip.from)); ctx.lineTo(cx(tip.to), cy(tip.to)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 3; ctx.strokeStyle = '#fff';
        ctx.strokeRect((tip.to % w) * scale + 1, ((tip.to / w) | 0) * scale + 1, scale - 2, scale - 2);
        ctx.lineWidth = 2; ctx.strokeStyle = NEXT;
        ctx.strokeRect((tip.to % w) * scale + 1, ((tip.to / w) | 0) * scale + 1, scale - 2, scale - 2);
        if (scale >= 8) badge(`Next: section ${tip.k + 1}${tip.kind === 'jump' ? ' ✂' : ''}`, cx(tip.to), cy(tip.to) + scale * 0.5 + 11, NEXT);
      }
      ctx.lineCap = 'butt';
    };

    const pos = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const { scale, ox, oy } = S.view;
      const fx = (px - ox) / scale, fy = (py - oy) / scale;
      return { px, py, fx, fy, x: Math.floor(fx), y: Math.floor(fy) };
    };
    const gridPoint = (c: { fx: number; fy: number }) => ({
      x: clamp(Math.round(c.fx), 0, S.pattern.width),
      y: clamp(Math.round(c.fy), 0, S.pattern.height),
    });

    const removeBackstitchNear = (fx: number, fy: number) => {
      const list = S.pattern.backstitches;
      let best = -1, bestD = 0.45;
      list.forEach((b, i) => {
        const dx = b.x2 - b.x1, dy = b.y2 - b.y1;
        const t = clamp(((fx - b.x1) * dx + (fy - b.y1) * dy) / (dx * dx + dy * dy), 0, 1);
        const d = Math.hypot(fx - (b.x1 + t * dx), fy - (b.y1 + t * dy));
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best < 0) return;
      pushUndo();
      list.splice(best, 1);
      emit();
    };

    // Touch: two fingers always pinch-zoom and move the view, whatever tool is chosen.
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; cx: number; cy: number } | null = null;
    const pinchState = () => {
      const [a, b] = [...touches.values()], r = canvas.getBoundingClientRect();
      return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2 - r.left, cy: (a.y + b.y) / 2 - r.top };
    };

    /** A tap or click that did not turn into a drag while looking around. */
    const tapped = (x: number, y: number) => {
      const p = S.pattern;
      if (!inside(x, y)) return;
      if (S.stitchMode && S.measuring) return measureClick(x, y);
      const i = y * p.width + x, id = p.cells[i];
      if (!id) return;
      if (S.stitchMode) {
        if (!tickable(i)) return;
        pushUndo();
        const done = doneMap();
        done[i] = done[i] ? 0 : 1;
        ticked(i);
        return emit();
      }
      // Say what the stitch is, and make it the current color so it is lit up in the color list.
      const color = p.palette.find((c) => c.id === id);
      if (!color) return;
      let total = 0, stitched = 0;
      for (let k = 0; k < p.cells.length; k++) if (p.cells[k] === id) { total++; if (p.done?.[k]) stitched++; }
      S.colorId = id;
      S.info = `${color.symbol}  ${color.hex.toUpperCase()} · ${total.toLocaleString()} stitches${stitched ? `, ${stitched.toLocaleString()} stitched` : ''} · column ${x + 1}, row ${y + 1}`;
      emit(false);
    };

    const down = (e: PointerEvent) => {
      const c = pos(e), p = S.pattern;
      canvas.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          // The first finger may have started a stroke; take it back, it was the start of a pinch.
          if (drag?.mode === 'paint' || drag?.mode === 'done') undo();
          drag = null;
          preview = null;
          pinch = pinchState();
          return;
        }
        if (touches.size > 2) return;
      }
      if (S.info) { S.info = null; emit(false); }
      // Moving the view: the middle button, Space, or the Move view tool. In stitch mode a click ticks a
      // square instead, except on a touch screen, where a drag moves the view and a tap ticks.
      const touch = e.pointerType === 'touch';
      const pans = keys.space || (S.stitchMode ? touch : S.tool === 'pan');
      if (e.button === 1 || (e.button === 0 && pans)) {
        const tap = e.button === 0 && !keys.space ? { x: c.x, y: c.y } : null;
        drag = { mode: 'pan', px: e.clientX, py: e.clientY, ox: S.view.ox, oy: S.view.oy, tap, far: false };
        canvas.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;
      if (S.stitchMode && S.measuring) {
        // Measuring: a click sets the start, and the next click (or letting go after a drag) sets the end.
        if (!inside(c.x, c.y)) return;
        measureClick(c.x, c.y);
        drag = { mode: 'measure' };
        return;
      }
      if (S.stitchMode) {
        // Stitch mode: tick squares off as stitched (or untick them) instead of editing the pattern.
        if (!inside(c.x, c.y) || !tickable(c.y * p.width + c.x)) return;
        pushUndo();
        const done = doneMap(), i = c.y * p.width + c.x, value = done[i] ? 0 : 1;
        ticked(i);
        if (e.shiftKey) {
          // Shift ticks off the whole section: the patch of this color, joined corner to corner.
          for (const j of sectionCells(i)) done[j] = value;
        } else {
          done[i] = value;
          drag = { mode: 'done', value, lx: c.x, ly: c.y };
        }
        emit();
        return;
      }
      let tool = S.tool;
      if (e.altKey && tool !== 'backstitch' && tool !== 'select') tool = 'picker';

      if (tool === 'shape') {
        if (inside(c.x, c.y)) selectPatch(c.x, c.y, e.shiftKey); else clearPatch();
        return;
      }
      switch (tool) {
        case 'pencil':
        case 'eraser':
        case 'recolor':
        case 'tidy':
        case 'restore': {
          if (tool === 'restore' && !p.reference?.converted) break;
          const target = inside(c.x, c.y) ? p.cells[c.y * p.width + c.x] : -1;
          pushUndo();
          const fn = mirrored(cellAction(tool, target)), size = sizeFor(tool);
          brushCells(c.x, c.y, fn, size);
          drag = { mode: 'paint', fn, size, lx: c.x, ly: c.y };
          emit();
          break;
        }
        case 'fill': {
          if (!inside(c.x, c.y) || lockedIds().has(p.cells[c.y * p.width + c.x])) break;
          pushUndo();
          const changed = e.shiftKey
            ? replaceAll(p.cells, p.cells[c.y * p.width + c.x], S.colorId)
            : floodFill(p.cells, p.width, p.height, c.x, c.y, S.colorId);
          if (changed) emit(); else dropUndo();
          break;
        }
        case 'picker': {
          if (e.shiftKey) {
            // Shift picks the exact shade from the guide photo instead of from the stitches.
            const hex = inside(c.x, c.y) ? samplePhoto(c.x, c.y) : null;
            if (!hex) break;
            const have = p.palette.find((col) => col.hex === hex);
            if (have) { S.colorId = have.id; emit(false); } else addColor(hex);
            if (S.tool === 'picker') { S.tool = 'pencil'; emit(false); }
            break;
          }
          const id = inside(c.x, c.y) ? p.cells[c.y * p.width + c.x] : 0;
          if (id) {
            S.colorId = id;
            if (S.tool === 'picker') S.tool = 'pencil';
            emit(false);
          }
          break;
        }
        case 'line':
        case 'rect':
        case 'ellipse':
          drag = { mode: 'shape' };
          preview = { kind: tool, x0: c.x, y0: c.y, x1: c.x, y1: c.y, filled: e.shiftKey };
          schedule();
          break;
        case 'backstitch': {
          if (e.altKey) { removeBackstitchNear(c.fx, c.fy); break; }
          const g = gridPoint(c);
          drag = { mode: 'shape' };
          preview = { kind: 'backstitch', x0: g.x, y0: g.y, x1: g.x, y1: g.y, filled: false };
          schedule();
          break;
        }
        case 'select': {
          const r = S.floating ?? S.selection;
          if (r && c.x >= r.x && c.y >= r.y && c.x < r.x + r.w && c.y < r.y + r.h) {
            liftSelection();
            const f = S.floating!;
            drag = { mode: 'move', sx: c.x, sy: c.y, fx: f.x, fy: f.y };
          } else {
            commitFloating();
            S.selection = null;
            drag = { mode: 'select', x0: clamp(c.x, 0, p.width - 1), y0: clamp(c.y, 0, p.height - 1), moved: false };
            emit(false);
          }
          break;
        }
      }
    };

    const status = document.getElementById('status-pos');
    // On the stitch screen, a label beside the mouse says which square it is over, in printed-chart numbers.
    const tip = wrap.closest('.stitch') ? document.createElement('div') : null;
    if (tip) { tip.className = 'hover-tip'; tip.hidden = true; wrap.appendChild(tip); }
    let tipAt: { pointerType: string; clientX: number; clientY: number; x: number; y: number } | null = null;
    const showTip = (e: { pointerType: string; clientX: number; clientY: number }, x: number, y: number) => {
      if (!tip) return;
      tipAt = { pointerType: e.pointerType, clientX: e.clientX, clientY: e.clientY, x, y };
      const p = S.pattern;
      if (e.pointerType !== 'mouse' || drag?.mode === 'pan' || !inside(x, y)) { tip.hidden = true; return; }
      const i = y * p.width + x, c = p.palette.find((k) => k.id === p.cells[i]);
      const done = !!(c && p.done?.[i]);
      tip.replaceChildren();
      const pos = document.createElement('b');
      pos.textContent = `Column ${x + 1}, row ${y + 1}`;
      tip.append(pos);
      if (c) {
        const chip = document.createElement('span');
        chip.className = 'tip-chip';
        chip.style.background = c.hex;
        chip.style.color = inkFor(c.hex);
        chip.textContent = c.symbol;
        const what = document.createElement('span');
        what.textContent = c.hex.toUpperCase() + (done ? ' · stitched' : '');
        tip.append(chip, what);
      } else {
        const what = document.createElement('span');
        what.textContent = 'empty';
        tip.append(what);
      }
      const m = S.measuring ? S.measure : null;
      if (m) {
        const d = document.createElement('em');
        d.textContent = m.fixed ? describeDistance(m.b.x - m.a.x, m.b.y - m.a.y) : `${describeDistance(x - m.a.x, y - m.a.y)} from the start`;
        tip.append(d);
      }
      tip.hidden = false;
      // Beside the pointer, flipping to the other side near the right or bottom edge.
      const r = wrap.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = `${px + 16 + tw > r.width ? px - 12 - tw : px + 16}px`;
      tip.style.top = `${py + 18 + th > r.height ? py - 10 - th : py + 18}px`;
    };

    const move = (e: PointerEvent) => {
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && touches.size === 2) {
          const now = pinchState();
          S.view.ox += Math.round(now.cx - pinch.cx);
          S.view.oy += Math.round(now.cy - pinch.cy);
          zoomAt(now.cx, now.cy, now.dist / pinch.dist);
          pinch = now;
          return;
        }
      }
      const c = pos(e), p = S.pattern;
      hover = { x: c.fx, y: c.fy };
      if (status) status.textContent = inside(c.x, c.y) ? `${c.x + 1}, ${c.y + 1}` : '';
      if (S.stitchMode && S.measuring && e.pointerType !== 'touch' && inside(c.x, c.y)) measureMove(c.x, c.y);
      showTip(e, c.x, c.y);
      if (!drag) return schedule();
      switch (drag.mode) {
        case 'done': {
          const done = doneMap();
          for (const [x, y] of linePoints(drag.lx, drag.ly, c.x, c.y)) {
            if (inside(x, y) && tickable(y * p.width + x)) { done[y * p.width + x] = drag.value; ticked(y * p.width + x); }
          }
          drag.lx = c.x;
          drag.ly = c.y;
          emit();
          break;
        }
        case 'pan':
          if (Math.hypot(e.clientX - drag.px, e.clientY - drag.py) > 6) drag.far = true;
          if (!drag.far) break;
          S.view.ox = drag.ox + e.clientX - drag.px;
          S.view.oy = drag.oy + e.clientY - drag.py;
          S.autoFit = false;
          schedule();
          break;
        case 'paint':
          for (const [x, y] of linePoints(drag.lx, drag.ly, c.x, c.y)) brushCells(x, y, drag.fn, drag.size);
          drag.lx = c.x;
          drag.ly = c.y;
          emit();
          break;
        case 'shape':
          if (!preview) break;
          if (preview.kind === 'backstitch') {
            const g = gridPoint(c);
            preview.x1 = g.x;
            preview.y1 = g.y;
          } else {
            preview.x1 = c.x;
            preview.y1 = c.y;
            preview.filled = e.shiftKey;
          }
          schedule();
          break;
        case 'move': {
          const f = S.floating;
          if (!f) break;
          f.x = drag.fx + c.x - drag.sx;
          f.y = drag.fy + c.y - drag.sy;
          schedule();
          break;
        }
        case 'select': {
          const x1 = clamp(c.x, 0, p.width - 1), y1 = clamp(c.y, 0, p.height - 1);
          if (x1 !== drag.x0 || y1 !== drag.y0) drag.moved = true;
          if (drag.moved) {
            S.selection = {
              x: Math.min(drag.x0, x1), y: Math.min(drag.y0, y1),
              w: Math.abs(x1 - drag.x0) + 1, h: Math.abs(y1 - drag.y0) + 1,
            };
            emit(false);
          }
          break;
        }
      }
    };

    const up = (e?: PointerEvent) => {
      if (e) touches.delete(e.pointerId);
      if (pinch) {
        if (touches.size < 2) pinch = null;
        return;
      }
      const p = S.pattern;
      if (drag?.mode === 'shape' && preview) {
        const pv = preview;
        if (pv.kind === 'backstitch') {
          if ((pv.x0 !== pv.x1 || pv.y0 !== pv.y1) && S.colorId) {
            pushUndo();
            p.backstitches.push({ x1: pv.x0, y1: pv.y0, x2: pv.x1, y2: pv.y1, colorId: S.colorId });
          }
        } else {
          pushUndo();
          const locked = lockedIds();
          shapeCells(pv, mirrored((x, y) => { if (!locked.has(p.cells[y * p.width + x])) p.cells[y * p.width + x] = S.colorId; }));
        }
        preview = null;
        emit();
      }
      if (drag?.mode === 'move') emit();
      if (drag?.mode === 'measure' && hover) {
        const x = clamp(Math.floor(hover.x), 0, p.width - 1), y = clamp(Math.floor(hover.y), 0, p.height - 1);
        measureRelease(x, y);
      }
      if (drag?.mode === 'pan' && drag.tap && !drag.far) tapped(drag.tap.x, drag.tap.y);
      drag = null;
      preview = null;
      updateCursor();
      schedule();
    };

    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const c = pos(e);
        zoomAt(c.px, c.py, Math.exp(-e.deltaY * 0.01));
      } else {
        S.view.ox -= Math.round(e.deltaX);
        S.view.oy -= Math.round(e.deltaY);
        S.autoFit = false;
        schedule();
      }
    };

    const updateCursor = () => {
      if (drag?.mode === 'pan') return;
      canvas.style.cursor = S.tool === 'pan' || keys.space ? 'grab' : 'crosshair';
    };
    const leave = () => { hover = null; if (status) status.textContent = ''; if (tip) tip.hidden = true; tipAt = null; schedule(); };
    const noMenu = (e: Event) => e.preventDefault();

    // A tick, scroll or zoom changes what the label says, so it is redrawn whenever anything changes.
    const unsub = subscribe(() => { updateCursor(); schedule(); if (tipAt && tip && !tip.hidden) { const c = pos(tipAt as unknown as MouseEvent); showTip(tipAt, c.x, c.y); } });
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', leave);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('contextmenu', noMenu);
    resize();

    return () => {
      unsub();
      tip?.remove();
      ro.disconnect();
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerleave', leave);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('contextmenu', noMenu);
    };
  }, []);

  return (
    <div className="canvas-wrap">
      <canvas ref={ref} />
      <SelectionBar />
      <PatchBar />
    </div>
  );
}

/** Actions for the current selection, shown over the canvas while something is selected. */
function SelectionBar() {
  useStore();
  const r = S.floating ?? S.selection;
  if (!r) return null;
  const reconvert = () => {
    // Put any piece that is being moved back down first, so the dialog works on what is really there.
    const rect = selectedRect();
    commitFloating();
    S.selection = rect;
    openDialog('reconvert');
  };
  return (
    <div className="selbar">
      <span className="muted">{r.w} × {r.h}</span>
      <button className="btn small" onClick={() => transformSelection('flipH')}>Flip ↔</button>
      <button className="btn small" onClick={() => transformSelection('flipV')}>Flip ↕</button>
      <button className="btn small" onClick={() => transformSelection('rotate')}>Rotate ↻</button>
      <button className="btn small" onClick={() => copySelection()}>Copy</button>
      <button className="btn small" onClick={cutSelection}>Cut</button>
      <button className="btn small" onClick={deleteSelection}>Delete</button>
      <button className="btn small" title="Trim the canvas down to the selection" onClick={cropToSelection}>Crop canvas</button>
      {S.pattern.reference?.photo && (
        <button className="btn small" title="Convert this part of the photo again with different settings" onClick={reconvert}>
          Re-convert…
        </button>
      )}
      <button className="btn small primary" onClick={() => { commitFloating(); S.selection = null; emit(false); }}>Done</button>
    </div>
  );
}

/** Actions for the shape picked with the Shape select tool. */
function PatchBar() {
  useStore();
  const sel = S.patch;
  if (!sel) return null;
  const hex = S.pattern.palette.find((c) => c.id === S.colorId)?.hex;
  const act = (kind: PatchAction, label: string, title: string) => (
    <button className="btn small" title={title} onClick={() => patchAction(kind)}>{label}</button>
  );
  return (
    <div className="selbar">
      <span className="muted">{sel.count.toLocaleString()} stitches</span>
      <button className="btn small" title="Recolor the whole shape with the current color" onClick={() => patchAction('fill')}>
        <span className="dot" style={{ background: hex }} /> Fill
      </button>
      {act('absorb', 'Absorb', 'Give the shape the color that surrounds it most, so it disappears into its surroundings')}
      {act('erase', 'Erase', 'Remove the stitches in the shape')}
      {act('grow', 'Grow', 'Make the shape one stitch bigger all round')}
      {act('shrink', 'Shrink', 'Make the shape one stitch smaller all round')}
      {act('smooth', 'Smooth edge', 'Trim squares that stick out and fill in notches')}
      {act('outline', 'Outline', 'Backstitch around the shape in the current color')}
      <button className="btn small" title="Select every stitch of this color, anywhere in the pattern" onClick={selectSameColors}>All of this color</button>
      <button className="btn small primary" onClick={clearPatch}>Done</button>
    </div>
  );
}
