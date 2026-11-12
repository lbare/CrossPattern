import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { hexToOklab } from './color';
import { quantize, sampleImage } from './convert';
import { ProjectRecord } from './db';
import { Modal } from './dialogs';
import { REMOVE } from './marks';
import { FABRIC } from './render';
import {
  S, applyConverted, duplicateProject, libraryProjects, openDialog, openFile, removeProject, selectedRect,
  switchProject,
} from './store';

// ---- Project library ----------------------------------------------------

export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<ProjectRecord[] | null>(null);
  const [confirming, setConfirming] = useState('');
  const [error, setError] = useState('');
  const reload = () => libraryProjects().then(setList).catch(() => setError('The project library could not be read in this browser.'));
  useEffect(() => { reload(); }, []);

  const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <Modal title="Projects" onClose={onClose} size="wide">
      <div className="lib-actions">
        <button className="btn primary" onClick={() => openDialog('new')}>New project</button>
        <label className="btn">
          Open a project file
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try { await openFile(f); onClose(); } catch (err) { setError((err as Error).message); }
            }}
          />
        </label>
        <span className="hint grow">Projects are kept in this browser on this computer. Use Save for a file you can back up or move.</span>
      </div>
      {error && <p className="error lib-error">{error}</p>}
      <ul className="library">
        {list?.map((p) => (
          <li key={p.id} className={p.id === S.projectId ? 'current' : ''}>
            <button className="thumb" onClick={async () => { await switchProject(p.id); onClose(); }} title="Open this project">
              <img src={p.thumb} alt="" />
            </button>
            <div className="meta">
              <b>{p.name || 'Untitled pattern'}</b>
              <span className="hint">{p.width} × {p.height} · {when(p.updatedAt)}{p.id === S.projectId ? ' · open now' : ''}</span>
            </div>
            <div className="row">
              <button className="btn small" onClick={async () => { await duplicateProject(p.id); reload(); }}>Duplicate</button>
              {confirming === p.id ? (
                <button className="btn small danger" onClick={async () => { setConfirming(''); await removeProject(p.id); reload(); }}>
                  Delete for good
                </button>
              ) : (
                <button className="btn small" onClick={() => setConfirming(p.id)}>Delete</button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <footer>
        <button className="btn" onClick={onClose}>Close</button>
      </footer>
    </Modal>
  );
}

// ---- Re-convert part of the photo ---------------------------------------

export function ReconvertDialog({ onClose }: { onClose: () => void }) {
  const p = S.pattern, ref = p.reference;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [colors, setColors] = useState(6);
  const [smooth, setSmooth] = useState(1);
  const [clean, setClean] = useState(1);
  const [snap, setSnap] = useState(false);
  const [keepEmpty, setKeepEmpty] = useState(true);
  const out = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!ref?.photo) return;
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = ref.photo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The part of the selection that the photo actually covers, in whole squares.
  const area = useMemo(() => {
    const sel = selectedRect();
    if (!sel || !ref) return null;
    const x0 = Math.max(sel.x, Math.ceil(ref.rect.x - 1e-6)), y0 = Math.max(sel.y, Math.ceil(ref.rect.y - 1e-6));
    const x1 = Math.min(sel.x + sel.w, Math.floor(ref.rect.x + ref.rect.w + 1e-6));
    const y1 = Math.min(sel.y + sel.h, Math.floor(ref.rect.y + ref.rect.h + 1e-6));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sampled = useMemo(() => {
    if (!img || !area || !ref) return null;
    const kx = img.naturalWidth / ref.rect.w, ky = img.naturalHeight / ref.rect.h;
    const crop = { x: (area.x - ref.rect.x) * kx, y: (area.y - ref.rect.y) * ky, w: area.w * kx, h: area.h * ky };
    // Squares that are empty now (a removed background, say) stay empty and don't use up any of the colors.
    const empty = new Uint8Array(area.w * area.h);
    if (keepEmpty) {
      for (let y = 0; y < area.h; y++) for (let x = 0; x < area.w; x++) {
        if (!p.cells[(area.y + y) * p.width + area.x + x]) empty[y * area.w + x] = REMOVE;
      }
    }
    return sampleImage(img, crop, area.w, area.h, { w: area.w, h: area.h, data: empty });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, area, keepEmpty]);

  const dColors = useDeferredValue(colors), dSmooth = useDeferredValue(smooth), dClean = useDeferredValue(clean);
  const result = useMemo(
    () => (sampled ? quantize(sampled, { colors: dColors, smooth: dSmooth, clean: dClean }) : null),
    [sampled, dColors, dSmooth, dClean],
  );

  /** For each new color: the palette color it will use, or 0 if it will be added as a new one. */
  const plan = useMemo(() => {
    if (!result) return null;
    const labs = p.palette.map((c) => ({ c, lab: hexToOklab(c.hex) }));
    const ids = result.palette.map((hex) => {
      const same = p.palette.find((c) => c.hex === hex);
      if (same) return same.id;
      if (!snap || !labs.length) return 0;
      const a = hexToOklab(hex);
      let best = labs[0], bd = Infinity;
      for (const l of labs) {
        const d = (a[0] - l.lab[0]) ** 2 + (a[1] - l.lab[1]) ** 2 + (a[2] - l.lab[2]) ** 2;
        if (d < bd) { bd = d; best = l; }
      }
      return best.c.id;
    });
    const shown = ids.map((id, k) => (id ? p.palette.find((c) => c.id === id)!.hex : result.palette[k]));
    return { ids, shown, added: ids.filter((id) => !id).length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, snap]);

  useEffect(() => {
    const c = out.current;
    if (!c || !result || !plan) return;
    c.width = result.width;
    c.height = result.height;
    const g = c.getContext('2d')!;
    for (let y = 0; y < result.height; y++) {
      for (let x = 0; x < result.width; x++) {
        const v = result.cells[y * result.width + x];
        g.fillStyle = v ? plan.shown[v - 1] : FABRIC;
        g.fillRect(x, y, 1, 1);
      }
    }
  }, [result, plan]);

  const slider = (label: string, value: number, min: number, max: number, set: (n: number) => void) => (
    <label>
      <span className="slider-label">{label}<b>{value}</b></span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => set(Number(e.target.value))} />
    </label>
  );

  return (
    <Modal title="Re-convert selection" onClose={onClose} size="wide">
      {!area ? (
        <p className="hint">The selection is outside the guide photo, so there is nothing to convert.</p>
      ) : (
        <div className="split">
          <div className="controls">
            {slider('Colors', colors, 2, 24, setColors)}
            {slider('Flatten detail', smooth, 0, 4, setSmooth)}
            {slider('Remove stray stitches', clean, 0, 3, setClean)}
            <label className="check">
              <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
              Only use colors already in the palette
            </label>
            <label className="check">
              <input type="checkbox" checked={keepEmpty} onChange={(e) => setKeepEmpty(e.target.checked)} />
              Keep empty squares empty
            </label>
            <p className="hint">
              {area.w} × {area.h} squares.{' '}
              {plan ? (plan.added ? `Adds ${plan.added} new color${plan.added === 1 ? '' : 's'} to the palette.` : 'No new colors are added.') : ''}
              {' '}Locked colors are left as they are.
            </p>
          </div>
          <div className="stage">
            <div className="fit" style={{ aspectRatio: String(area.w / area.h), width: `min(100%, calc(46vh * ${area.w / area.h}))` }}>
              <canvas ref={out} className="pixelated" />
            </div>
          </div>
        </div>
      )}
      <footer>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!area || !result || !plan}
          onClick={() => { if (area && result && plan) applyConverted(area, result.palette, result.cells, plan.ids); onClose(); }}
        >
          Replace selection
        </button>
      </footer>
    </Modal>
  );
}

// ---- Keyboard shortcuts -------------------------------------------------

export const SHORTCUTS: [string, [string, string][]][] = [
  ['Tools', [
    ['B', 'Pencil'], ['E', 'Eraser'], ['C', 'Recolor brush'], ['T', 'Tidy brush'], ['O', 'Restore brush'], ['G', 'Fill'],
    ['I', 'Pick color'], ['L', 'Line'], ['R', 'Rectangle'], ['U', 'Ellipse'], ['S', 'Shape select'], ['M', 'Select'], ['K', 'Backstitch'], ['H', 'Move view'],
  ]],
  ['While painting', [
    ['[ and ]', 'Brush smaller / larger'], ['Alt-click', 'Pick up the color under the cursor'],
    ['Shift-click with Pick color', 'Take the exact shade from the guide photo'],
    ['Shift-click with Fill', 'Replace that color everywhere'], ['Shift-drag with Rectangle or Ellipse', 'Filled shape'],
    ['Alt-click with Backstitch', 'Remove a backstitch line'], ['Hold P', 'Show the guide picture in full'],
  ]],
  ['Selection', [
    ['⌘/Ctrl A', 'Select everything'], ['Arrow keys', 'Nudge the selection one square'], ['⌘/Ctrl C, X, V', 'Copy, cut, paste'],
    ['Delete', 'Clear the selection'], ['Esc', 'Finish and deselect'],
  ]],
  ['Stitch screen', [
    ['← and →', 'Previous / next section'], ['Enter', 'Tick the current section off (or untick it)'],
    ['Shift-click', 'Tick a whole section'], ['⌘/Ctrl Z', 'Undo the last tick'],
  ]],
  ['View and file', [
    ['Scroll', 'Move around'], ['⌘/Ctrl-scroll or pinch', 'Zoom'], ['+ and −', 'Zoom in / out'], ['0', 'Fit to window'],
    ['Space-drag', 'Move the view with any tool'], ['⌘/Ctrl Z', 'Undo'], ['⇧⌘Z or Ctrl Y', 'Redo'], ['⌘/Ctrl S', 'Save a project file'],
    ['?', 'Open the guide'],
  ]],
];
