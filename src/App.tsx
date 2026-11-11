import { useEffect, useRef, useState } from 'react';
import { CanvasView } from './CanvasView';
import { ImportDialog } from './ImportDialog';
import { PalettePanel } from './PalettePanel';
import { ExportDialog, NewDialog, ResizeDialog } from './dialogs';
import {
  S, Tool, commitFloating, copySelection, cutSelection, deleteSelection, emit, fitView, keys, openFile, paste,
  redo, renamePattern, saveFile, setTool, undo, useStore, zoomBy,
} from './store';

const ICONS: Record<string, string> = {
  pencil: 'M3 17l1-4L14 3l3 3L7 16l-4 1zM12 5l3 3',
  eraser: 'M8.5 16.5l-5-5 8-8 6 6-7 7h-2zM7 8l5.5 5.5M3 17h14',
  fill: 'M4.5 10.5l6-6 5.5 5.5-5 5a1.4 1.4 0 0 1-2 0l-4.5-4.5zM10.5 4.5L8 2M4.5 10.5h11M16.5 13.5s1.5 1.8 1.5 2.8a1.5 1.5 0 0 1-3 0c0-1 1.500-2.8 1.500-2.8z',
  picker: 'M11 6l3 3M12.500 4.500l1.500-1.500a1.400 1.400 0 0 1 2 0l1.500 1.500a1.400 1.400 0 0 1 0 2L16 8M12 7l-8 8-1 3 3-1 8-8',
  line: 'M4 16L16 4',
  rect: 'M4 5h12v10H4z',
  select: 'M4 4h3M9 4h3M14 4h2v2M16 8v3M16 13v3h-2M12 16H9M7 16H4v-2M4 12V9M4 7V4',
  backstitch: 'M3 15l4-9 5 6 5-8',
  pan: 'M10 2v16M2 10h16M10 2L8 4M10 2l2 2M10 18l-2-2M10 18l2-2M2 10l2-2M2 10l2 2M18 10l-2-2M18 10l-2 2',
  undo: 'M7 5L3 9l4 4M3 9h9a4 4 0 0 1 0 8H9',
  redo: 'M13 5l4 4-4 4M17 9H8a4 4 0 0 0 0 8h3',
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

const TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'pencil', label: 'Pencil', key: 'B', hint: 'Click or drag to stitch. Hold Alt to pick up a color.' },
  { id: 'eraser', label: 'Eraser', key: 'E', hint: 'Click or drag to remove stitches.' },
  { id: 'fill', label: 'Fill', key: 'G', hint: 'Click to fill an area. Shift-click replaces that color everywhere.' },
  { id: 'picker', label: 'Pick color', key: 'I', hint: 'Click a stitch to use its color.' },
  { id: 'line', label: 'Line', key: 'L', hint: 'Drag to draw a straight line of stitches.' },
  { id: 'rect', label: 'Rectangle', key: 'R', hint: 'Drag to draw a rectangle. Hold Shift to fill it.' },
  { id: 'select', label: 'Select', key: 'M', hint: 'Drag to select, drag inside to move. Copy, cut, paste and Delete work. Esc to finish.' },
  { id: 'backstitch', label: 'Backstitch', key: 'K', hint: 'Drag between grid corners to add an outline. Alt-click a line to remove it.' },
  { id: 'pan', label: 'Move view', key: 'H', hint: 'Drag to move around. Space-drag works with any tool.' },
];

type Dialog = 'new' | 'import' | 'export' | 'resize' | null;

export function App() {
  useStore();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const dialogOpen = useRef(false);
  dialogOpen.current = dialog !== null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (dialogOpen.current || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (k === ' ') { keys.space = true; emit(false); e.preventDefault(); return; }
      if (mod) {
        if (k === 'z') { e.shiftKey ? redo() : undo(); }
        else if (k === 'y') redo();
        else if (k === 's') saveFile();
        else if (k === 'c') copySelection();
        else if (k === 'x') cutSelection();
        else if (k === 'v') paste();
        else return;
        e.preventDefault();
        return;
      }
      const tool = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (tool) setTool(tool.id);
      else if (k === '=' || k === '+') zoomBy(1.25);
      else if (k === '-') zoomBy(0.8);
      else if (k === '0') fitView();
      else if (k === '[') { S.brush = Math.max(1, S.brush - 1); emit(false); }
      else if (k === ']') { S.brush = Math.min(8, S.brush + 1); emit(false); }
      else if (k === 'delete' || k === 'backspace') deleteSelection();
      else if (k === 'escape') { commitFloating(); S.selection = null; emit(false); }
      else return;
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') { keys.space = false; emit(false); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const p = S.pattern;
  const tool = TOOLS.find((t) => t.id === S.tool)!;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">CrossPattern</div>
        <input
          className="name"
          value={p.name}
          onChange={(e) => renamePattern(e.target.value)}
          aria-label="Pattern name"
        />
        <div className="group">
          <button className="btn" onClick={() => setDialog('new')}>New</button>
          <button className="btn" onClick={() => fileInput.current?.click()}>Open</button>
          <button className="btn" onClick={saveFile} title="Save a project file (⌘S)">Save</button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try { await openFile(f); setError(''); } catch (err) { setError((err as Error).message); }
            }}
          />
        </div>
        <div className="group">
          <button className="btn primary" onClick={() => setDialog('import')}>Convert picture</button>
          <button className="btn" onClick={() => setDialog('export')}>Export PNG</button>
          <button className="btn" onClick={() => setDialog('resize')} title="Change the canvas size">
            {p.width} × {p.height}
          </button>
        </div>
        <div className="group">
          <button className="btn icon" onClick={undo} disabled={!S.undo.length} title="Undo (⌘Z)"><Icon name="undo" /></button>
          <button className="btn icon" onClick={redo} disabled={!S.redo.length} title="Redo (⇧⌘Z)"><Icon name="redo" /></button>
        </div>
        <div className="group">
          <button className="btn icon" onClick={() => zoomBy(0.8)} title="Zoom out (-)">−</button>
          <button className="btn zoom" onClick={fitView} title="Fit to window (0)">{Math.round((S.view.scale / 16) * 100)}%</button>
          <button className="btn icon" onClick={() => zoomBy(1.25)} title="Zoom in (+)">+</button>
        </div>
        <div className="group">
          <button className={'btn' + (S.showSymbols ? ' on' : '')} onClick={() => { S.showSymbols = !S.showSymbols; emit(false); }}>
            Symbols
          </button>
          <button className={'btn' + (S.showGrid ? ' on' : '')} onClick={() => { S.showGrid = !S.showGrid; emit(false); }}>
            Grid
          </button>
        </div>
      </header>

      <main>
        <nav className="tools" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={'tool' + (S.tool === t.id ? ' on' : '')}
              title={`${t.label} (${t.key})`}
              aria-label={t.label}
              onClick={() => setTool(t.id)}
            >
              <Icon name={t.id} />
            </button>
          ))}
          <label className="brush" title="Brush size ([ and ])">
            <span>Size</span>
            <select value={S.brush} onChange={(e) => { S.brush = Number(e.target.value); emit(false); }}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => <option key={n}>{n}</option>)}
            </select>
          </label>
        </nav>
        <CanvasView />
        <PalettePanel />
      </main>

      <footer className="status">
        <span>{error ? <span className="error">{error}</span> : <><b>{tool.label}</b> — {tool.hint}</>}</span>
        <span className="grow" />
        <span id="status-pos" />
        <span className="muted">Scroll to move · ⌘/Ctrl-scroll or pinch to zoom · saved automatically in this browser</span>
      </footer>

      {dialog === 'new' && <NewDialog onClose={() => setDialog(null)} />}
      {dialog === 'import' && <ImportDialog onClose={() => setDialog(null)} />}
      {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} />}
      {dialog === 'resize' && <ResizeDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
