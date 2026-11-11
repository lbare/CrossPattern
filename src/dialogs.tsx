import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { MAX_SIZE, createPattern } from './model';
import { renderExport } from './render';
import { S, commitFloating, download, fileBase, resizePattern, setPattern } from './store';

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; size?: 'wide' | 'xl' }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className={'modal ' + (props.size ?? '')} role="dialog" aria-label={props.title}>
        <header>
          <h2>{props.title}</h2>
          <button className="btn ghost" onClick={props.onClose} aria-label="Close">✕</button>
        </header>
        {props.children}
      </div>
    </div>
  );
}

function SizeFields(props: { w: number; h: number; setW: (n: number) => void; setH: (n: number) => void }) {
  return (
    <div className="fields">
      <label>Width (stitches)
        <input type="number" min={1} max={MAX_SIZE} value={props.w} onChange={(e) => props.setW(Number(e.target.value))} />
      </label>
      <label>Height (stitches)
        <input type="number" min={1} max={MAX_SIZE} value={props.h} onChange={(e) => props.setH(Number(e.target.value))} />
      </label>
    </div>
  );
}

const validSize = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_SIZE;

export function NewDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('Untitled pattern');
  const [w, setW] = useState(60);
  const [h, setH] = useState(60);
  return (
    <Modal title="New pattern" onClose={onClose}>
      <div className="fields">
        <label className="full">Name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
      </div>
      <SizeFields w={w} h={h} setW={setW} setH={setH} />
      <p className="hint">Up to {MAX_SIZE} × {MAX_SIZE}. Your current pattern can be brought back with Undo.</p>
      <footer>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!validSize(w) || !validSize(h)}
          onClick={() => { setPattern(createPattern(w, h, name.trim() || 'Untitled pattern')); onClose(); }}
        >
          Create
        </button>
      </footer>
    </Modal>
  );
}

export function ResizeDialog({ onClose }: { onClose: () => void }) {
  const [w, setW] = useState(S.pattern.width);
  const [h, setH] = useState(S.pattern.height);
  return (
    <Modal title="Resize canvas" onClose={onClose}>
      <SizeFields w={w} h={h} setW={setW} setH={setH} />
      <p className="hint">The top-left corner stays put. Making the canvas smaller trims the right and bottom edges.</p>
      <footer>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          disabled={!validSize(w) || !validSize(h)}
          onClick={() => { resizePattern(w, h); onClose(); }}
        >
          Resize
        </button>
      </footer>
    </Modal>
  );
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const [cell, setCell] = useState(20);
  const [symbols, setSymbols] = useState(true);
  const [grid, setGrid] = useState(true);
  const [legend, setLegend] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  const canvas = useMemo(() => {
    commitFloating();
    return renderExport(S.pattern, { cell, symbols, grid, legend });
  }, [cell, symbols, grid, legend]);

  useEffect(() => {
    const el = box.current!;
    el.replaceChildren(canvas);
  }, [canvas]);

  return (
    <Modal title="Export PNG" onClose={onClose} size="wide">
      <div className="split">
        <div className="controls">
          <label>Square size: {cell}px
            <input type="range" min={4} max={40} value={cell} onChange={(e) => setCell(Number(e.target.value))} />
          </label>
          <label className="check"><input type="checkbox" checked={symbols} onChange={(e) => setSymbols(e.target.checked)} /> Symbols</label>
          <label className="check"><input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} /> Grid and numbers</label>
          <label className="check"><input type="checkbox" checked={legend} onChange={(e) => setLegend(e.target.checked)} /> Color key</label>
          <p className="hint">Image size: {canvas.width} × {canvas.height}px{symbols && cell < 8 ? '. Symbols need squares of at least 8px.' : ''}</p>
        </div>
        <div className="preview export-preview" ref={box} />
      </div>
      <footer>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn primary"
          onClick={() => canvas.toBlob((b) => { if (b) download(b, fileBase() + '.png'); onClose(); }, 'image/png')}
        >
          Download PNG
        </button>
      </footer>
    </Modal>
  );
}
