import { useEffect, useRef } from 'react';
import { clamp } from './color';
import { floodFill, linePoints, replaceAll } from './model';
import { FABRIC, buildCellImage, drawOverlay } from './render';
import {
  S, commitFloating, dropUndo, emit, fitView, keys, liftSelection, pushUndo, subscribe, zoomAt,
} from './store';

type Drag =
  | { mode: 'pan'; px: number; py: number; ox: number; oy: number }
  | { mode: 'paint'; id: number; lx: number; ly: number }
  | { mode: 'shape' }
  | { mode: 'move'; sx: number; sy: number; fx: number; fy: number }
  | { mode: 'select'; x0: number; y0: number; moved: boolean };

interface Preview { kind: 'line' | 'rect' | 'backstitch'; x0: number; y0: number; x1: number; y1: number; filled: boolean }

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
      S.viewport = { w, h };
      if (S.autoFit && w > 0) fitView();
      schedule();
    };

    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < S.pattern.width && y < S.pattern.height;

    const hexOf = (id: number) => S.pattern.palette.find((c) => c.id === id)?.hex ?? '#000000';

    /** Squares covered by the brush when its centre is at x, y. */
    const brushCells = (x: number, y: number, fn: (x: number, y: number) => void) => {
      const b = S.brush, off = Math.floor((b - 1) / 2);
      for (let dy = 0; dy < b; dy++) for (let dx = 0; dx < b; dx++) {
        const xx = x - off + dx, yy = y - off + dy;
        if (inside(xx, yy)) fn(xx, yy);
      }
    };
    const paint = (x: number, y: number, id: number) =>
      brushCells(x, y, (xx, yy) => { S.pattern.cells[yy * S.pattern.width + xx] = id; });
    const stroke = (x0: number, y0: number, x1: number, y1: number, id: number) => {
      for (const [x, y] of linePoints(x0, y0, x1, y1)) paint(x, y, id);
    };
    const shapeCells = (p: Preview, fn: (x: number, y: number) => void) => {
      if (p.kind === 'line') {
        for (const [x, y] of linePoints(p.x0, p.y0, p.x1, p.y1)) brushCells(x, y, fn);
        return;
      }
      const xa = Math.min(p.x0, p.x1), xb = Math.max(p.x0, p.x1);
      const ya = Math.min(p.y0, p.y1), yb = Math.max(p.y0, p.y1);
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
      ctx.fillStyle = FABRIC;
      ctx.fillRect(ox, oy, pw, ph);

      const key = S.cellsVersion + ':' + S.highlight;
      if (!img || key !== imgKey) { img = buildCellImage(p, S.highlight, img ?? undefined); imgKey = key; }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, ox, oy, pw, ph);

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
        shapeCells(preview, (x, y) => ctx.fillRect(x * scale, y * scale, scale, scale));
        ctx.globalAlpha = 1;
      }

      drawOverlay(ctx, p, scale, {
        x0: clamp(Math.floor(-ox / scale), 0, p.width),
        y0: clamp(Math.floor(-oy / scale), 0, p.height),
        x1: clamp(Math.ceil((w - ox) / scale), 0, p.width),
        y1: clamp(Math.ceil((h - oy) / scale), 0, p.height),
      }, {
        grid: S.showGrid, symbols: S.showSymbols, rulers: true,
        ink: getComputedStyle(wrap).color, highlight: S.highlight,
      });

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
          const b = S.tool === 'pencil' || S.tool === 'eraser' || S.tool === 'line' ? S.brush : 1;
          const off = Math.floor((b - 1) / 2);
          if (inside(cx, cy)) ctx.strokeRect((cx - off) * scale + 0.5, (cy - off) * scale + 0.5, b * scale, b * scale);
        }
      }
      ctx.restore();
    }

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

    const down = (e: PointerEvent) => {
      const c = pos(e), p = S.pattern;
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 1 || (e.button === 0 && (S.tool === 'pan' || keys.space))) {
        drag = { mode: 'pan', px: e.clientX, py: e.clientY, ox: S.view.ox, oy: S.view.oy };
        canvas.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;
      let tool = S.tool;
      if (e.altKey && tool !== 'backstitch' && tool !== 'select') tool = 'picker';

      switch (tool) {
        case 'pencil':
        case 'eraser': {
          const id = tool === 'pencil' ? S.colorId : 0;
          pushUndo();
          paint(c.x, c.y, id);
          drag = { mode: 'paint', id, lx: c.x, ly: c.y };
          emit();
          break;
        }
        case 'fill': {
          if (!inside(c.x, c.y)) break;
          pushUndo();
          const changed = e.shiftKey
            ? replaceAll(p.cells, p.cells[c.y * p.width + c.x], S.colorId)
            : floodFill(p.cells, p.width, p.height, c.x, c.y, S.colorId);
          if (changed) emit(); else dropUndo();
          break;
        }
        case 'picker': {
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

    const move = (e: PointerEvent) => {
      const c = pos(e), p = S.pattern;
      hover = { x: c.fx, y: c.fy };
      if (status) status.textContent = inside(c.x, c.y) ? `${c.x + 1}, ${c.y + 1}` : '';
      if (!drag) return schedule();
      switch (drag.mode) {
        case 'pan':
          S.view.ox = drag.ox + e.clientX - drag.px;
          S.view.oy = drag.oy + e.clientY - drag.py;
          S.autoFit = false;
          schedule();
          break;
        case 'paint':
          stroke(drag.lx, drag.ly, c.x, c.y, drag.id);
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

    const up = () => {
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
          shapeCells(pv, (x, y) => { p.cells[y * p.width + x] = S.colorId; });
        }
        preview = null;
        emit();
      }
      if (drag?.mode === 'move') emit();
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
    const leave = () => { hover = null; if (status) status.textContent = ''; schedule(); };
    const noMenu = (e: Event) => e.preventDefault();

    const unsub = subscribe(() => { updateCursor(); schedule(); });
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
    </div>
  );
}
