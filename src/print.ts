import { inkFor } from './color';
import { Pattern, countCells } from './model';
import { renderExport, renderPage } from './render';

/** Squares per printed page. Sized so symbols stay readable on A4 or Letter paper. */
const COLS = 50, ROWS = 70, CELL = 24;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

/**
 * Lays the pattern out as printable pages (a cover with a preview and color key, then the chart in
 * blocks) and opens the browser's print dialog, where it can also be saved as a PDF.
 */
export function printChart(p: Pattern): void {
  document.getElementById('print-root')?.remove();
  const root = el('div');
  root.id = 'print-root';

  const counts = countCells(p);
  const used = p.palette.filter((c) => counts.has(c.id) || p.backstitches.some((b) => b.colorId === c.id));
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const across = Math.ceil(p.width / COLS), down = Math.ceil(p.height / ROWS);
  // Split evenly, so a 60-wide pattern prints as 30 + 30 rather than 50 + 10.
  const cols = Math.ceil(p.width / across), rows = Math.ceil(p.height / down);

  // Cover page: what it is, how big it comes out, and which colors are needed.
  const cover = el('section', '', 'print-page');
  cover.append(el('h1', p.name || 'Untitled pattern'));
  cover.append(el('p', `${p.width} × ${p.height} stitches · ${total.toLocaleString()} stitches · ${used.length} colors · ${across * down} chart page${across * down === 1 ? '' : 's'}`));
  const sizes = [14, 16, 18].map((n) => `${n}-count: ${((p.width / n) * 2.54).toFixed(1)} × ${((p.height / n) * 2.54).toFixed(1)} cm (${(p.width / n).toFixed(1)} × ${(p.height / n).toFixed(1)} in)`);
  cover.append(el('p', 'Finished size on ' + sizes.join(' · '), 'print-small'));
  const preview = renderExport(p, { cell: Math.max(2, Math.floor(640 / Math.max(p.width, p.height))), symbols: false, grid: false, legend: false });
  preview.className = 'print-preview';
  cover.append(preview);

  const table = el('table', '', 'print-key');
  const head = el('tr');
  ['', 'Color', 'Stitches', '', 'Color', 'Stitches'].forEach((t) => head.append(el('th', t)));
  table.append(head);
  for (let i = 0; i < used.length; i += 2) {
    const row = el('tr');
    for (const c of used.slice(i, i + 2)) {
      const sw = el('td');
      const chip = el('span', c.symbol, 'print-chip');
      chip.style.background = c.hex;
      chip.style.color = inkFor(c.hex);
      sw.append(chip);
      row.append(sw, el('td', c.hex.toUpperCase()), el('td', (counts.get(c.id) ?? 0).toLocaleString()));
    }
    table.append(row);
  }
  cover.append(table);
  root.append(cover);

  // Chart pages, left to right then top to bottom.
  let n = 0;
  for (let y0 = 0; y0 < p.height; y0 += rows) {
    for (let x0 = 0; x0 < p.width; x0 += cols) {
      const r = { x0, y0, x1: Math.min(p.width, x0 + cols), y1: Math.min(p.height, y0 + rows) };
      const page = el('section', '', 'print-page');
      page.append(el('p', `${p.name} · page ${++n} of ${across * down} · columns ${r.x0 + 1}–${r.x1}, rows ${r.y0 + 1}–${r.y1}`, 'print-small'));
      page.append(renderPage(p, r, CELL));
      root.append(page);
    }
  }

  document.body.append(root);
  const cleanup = () => { root.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => window.print(), 50);
}
