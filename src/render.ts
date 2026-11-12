import { hexToRgb, inkFor } from './color';
import { Converted, Pattern, countCells } from './model';

export const FABRIC = '#faf7f0';

export interface Range { x0: number; y0: number; x1: number; y1: number }

/** Paints the pattern at one pixel per square. Scaling this up is much faster than drawing every square. */
export function buildCellImage(p: Pattern, highlight: number, target?: HTMLCanvasElement, fadeDone = false): HTMLCanvasElement {
  const c = target ?? document.createElement('canvas');
  c.width = p.width;
  c.height = p.height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(p.width, p.height);
  const out = new Uint32Array(img.data.buffer);
  const lut = new Map<number, number>(), faded = new Map<number, number>();
  const [fr, fg, fb] = hexToRgb(p.fabric ?? FABRIC);
  const pack = (r: number, g: number, b: number) => (0xff000000 | (Math.round(b) << 16) | (Math.round(g) << 8) | Math.round(r)) >>> 0;
  const toward = (r: number, g: number, b: number, k: number) => pack(r * (1 - k) + fr * k, g * (1 - k) + fg * k, b * (1 - k) + fb * k);
  for (const col of p.palette) {
    const [r, g, b] = hexToRgb(col.hex);
    lut.set(col.id, highlight && col.id !== highlight ? toward(r, g, b, 0.85) : pack(r, g, b));
    // Stitched squares go a lighter shade of their own color: what is left to do stands out, but each
    // stitched square still shows which color it is.
    faded.set(col.id, toward(r, g, b, 0.45));
  }
  const done = fadeDone ? p.done : undefined;
  for (let i = 0; i < out.length; i++) {
    const v = p.cells[i];
    out[i] = v ? (done?.[i] ? faded : lut).get(v) ?? 0 : 0;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export interface OverlayOptions {
  grid: boolean;
  symbols: boolean;
  rulers: boolean;
  ink: string;
  highlight?: number;
  /** Where ruler numbers are drawn: along the top and left of this range (default: the whole pattern). */
  rulerRange?: Range;
  /** Squares whose symbols are drawn faintly (stitch mode). */
  dimDone?: boolean;
}

/** Draws symbols, grid lines, ruler numbers and backstitches. Expects the context origin at the pattern's top-left. */
export function drawOverlay(ctx: CanvasRenderingContext2D, p: Pattern, scale: number, r: Range, o: OverlayOptions): void {
  const W = p.width * scale, H = p.height * scale;

  if (o.symbols && scale >= 8) {
    const info = new Map(p.palette.map((c) => [c.id, { symbol: c.symbol, ink: inkFor(c.hex) }]));
    ctx.font = `${Math.floor(scale * 0.68)}px "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const v = p.cells[y * p.width + x];
        if (!v) continue;
        const c = info.get(v);
        if (!c) continue;
        // A stitched square shows a cross instead of its symbol (drawn by the stitch screen).
        if (o.dimDone && p.done?.[y * p.width + x]) continue;
        ctx.fillStyle = o.highlight && v !== o.highlight ? '#b8b4ac' : c.ink;
        ctx.fillText(c.symbol, (x + 0.5) * scale, (y + 0.54) * scale);
      }
    }
  }

  if (o.grid && scale >= 4) {
    const lines = (step: number, style: string, width: number) => {
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let x = Math.ceil(r.x0 / step) * step; x <= r.x1; x += step) {
        const px = Math.round(x * scale) + 0.5;
        ctx.moveTo(px, r.y0 * scale);
        ctx.lineTo(px, r.y1 * scale);
      }
      for (let y = Math.ceil(r.y0 / step) * step; y <= r.y1; y += step) {
        const py = Math.round(y * scale) + 0.5;
        ctx.moveTo(r.x0 * scale, py);
        ctx.lineTo(r.x1 * scale, py);
      }
      ctx.stroke();
    };
    // Grid lines flip to white on dark fabric so they stay visible.
    const line = inkFor(p.fabric ?? FABRIC) === '#000000' ? '0,0,0' : '255,255,255';
    if (scale >= 6) lines(1, `rgba(${line},0.16)`, 1);
    lines(10, `rgba(${line},0.55)`, 1);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W, H);

  if (o.rulers && scale * 10 >= 26) {
    ctx.fillStyle = o.ink;
    ctx.font = '10px "Helvetica Neue", Arial, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'center';
    const rr = o.rulerRange ?? { x0: 0, y0: 0, x1: p.width, y1: p.height };
    for (let x = Math.ceil((rr.x0 + 1) / 10) * 10; x <= rr.x1; x += 10) ctx.fillText(String(x), x * scale, rr.y0 * scale - 4);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let y = Math.ceil((rr.y0 + 1) / 10) * 10; y <= rr.y1; y += 10) ctx.fillText(String(y), rr.x0 * scale - 5, y * scale);
  }

  if (p.backstitches.length) {
    const hex = new Map(p.palette.map((c) => [c.id, c.hex]));
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.5, scale * 0.2);
    for (const b of p.backstitches) {
      ctx.strokeStyle = hex.get(b.colorId) ?? '#000';
      ctx.beginPath();
      ctx.moveTo(b.x1 * scale, b.y1 * scale);
      ctx.lineTo(b.x2 * scale, b.y2 * scale);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }
}

export interface ExportOptions {
  cell: number;
  symbols: boolean;
  grid: boolean;
  legend: boolean;
}

/** Renders the whole pattern, optionally with a color key underneath, for saving as an image. */
export function renderExport(p: Pattern, o: ExportOptions): HTMLCanvasElement {
  const margin = o.grid ? 28 : 0;
  const W = p.width * o.cell, H = p.height * o.cell;
  const counts = countCells(p);
  const used = p.palette.filter((c) => counts.has(c.id) || p.backstitches.some((b) => b.colorId === c.id));
  const colW = 190, rowH = 26, titleH = o.legend ? 34 : 0;
  const cols = Math.max(1, Math.floor((W + margin) / colW));
  const rows = Math.ceil(used.length / cols);
  const legendH = o.legend ? rows * rowH + 44 : 0;

  const c = document.createElement('canvas');
  c.width = Math.max(W + margin * 2, o.legend ? colW + margin * 2 : 0);
  c.height = titleH + H + margin * 2 + legendH;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);

  if (o.legend) {
    ctx.fillStyle = '#222';
    ctx.font = 'bold 16px "Helvetica Neue", Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${p.name}  (${p.width} × ${p.height})`, Math.max(margin, 10), 20);
  }

  ctx.save();
  ctx.translate(margin, titleH + margin);
  ctx.fillStyle = p.fabric ?? FABRIC;
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buildCellImage(p, 0), 0, 0, W, H);
  drawOverlay(ctx, p, o.cell, { x0: 0, y0: 0, x1: p.width, y1: p.height }, {
    grid: o.grid, symbols: o.symbols, rulers: o.grid, ink: '#444',
  });
  ctx.restore();

  if (o.legend) {
    const top = titleH + H + margin * 2 + 14;
    const left = Math.max(margin, 10);
    ctx.textBaseline = 'middle';
    used.forEach((col, i) => {
      const x = left + (i % cols) * colW, y = top + Math.floor(i / cols) * rowH;
      ctx.fillStyle = col.hex;
      ctx.fillRect(x, y, 20, 20);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.strokeRect(x + 0.5, y + 0.5, 20, 20);
      ctx.fillStyle = inkFor(col.hex);
      ctx.font = '13px "Helvetica Neue", Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(col.symbol, x + 10, y + 11);
      ctx.fillStyle = '#222';
      ctx.textAlign = 'left';
      ctx.fillText(`${col.hex.toUpperCase()}   ${counts.get(col.id) ?? 0} stitches`, x + 28, y + 11);
    });
  }
  return c;
}

const convertedCache = new WeakMap<Converted, HTMLCanvasElement>();

/** The first conversion painted at one pixel per square, for showing over the edited pattern. */
export function convertedImage(cv: Converted): HTMLCanvasElement {
  let c = convertedCache.get(cv);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = cv.width;
  c.height = cv.height;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(cv.width, cv.height);
  const out = new Uint32Array(img.data.buffer);
  const lut = cv.hexes.map((hex) => {
    const [r, g, b] = hexToRgb(hex);
    return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  });
  for (let i = 0; i < out.length; i++) {
    const v = cv.cells[i];
    out[i] = v ? lut[v - 1] : 0;
  }
  ctx.putImageData(img, 0, 0);
  convertedCache.set(cv, c);
  return c;
}

/** One page of a printed chart: a block of the pattern with symbols, grid and its own row and column numbers. */
export function renderPage(p: Pattern, r: Range, cell: number): HTMLCanvasElement {
  const margin = 30, w = (r.x1 - r.x0) * cell, h = (r.y1 - r.y0) * cell;
  const c = document.createElement('canvas');
  c.width = w + margin + 2;
  c.height = h + margin + 2;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.translate(margin - r.x0 * cell, margin - r.y0 * cell);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x0 * cell, r.y0 * cell, w + 1, h + 1);
  ctx.clip();
  ctx.fillStyle = p.fabric ?? FABRIC;
  ctx.fillRect(r.x0 * cell, r.y0 * cell, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buildCellImage(p, 0), r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, r.x0 * cell, r.y0 * cell, w, h);
  drawOverlay(ctx, p, cell, r, { grid: true, symbols: true, rulers: false, ink: '#333' });
  ctx.restore();
  // Row and column numbers for just this block, drawn outside the clipped area.
  drawOverlay(ctx, { ...p, backstitches: [] }, cell, { x0: 0, y0: 0, x1: 0, y1: 0 }, { grid: false, symbols: false, rulers: true, ink: '#333', rulerRange: r });
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(r.x0 * cell + 0.5, r.y0 * cell + 0.5, w, h);
  return c;
}
