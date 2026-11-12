import { useEffect, useRef, useState } from 'react';
import { CanvasView } from './CanvasView';
import { CONVERTING_KEY, ImportDialog } from './ImportDialog';
import { PalettePanel } from './PalettePanel';
import { ExportDialog, NewDialog, ResizeDialog } from './dialogs';
import { ProjectsDialog, ReconvertDialog } from './extras';
import { GuideDialog } from './guide';
import { StitchScreen } from './StitchScreen';
import { ReceiveDialog, SendDialog } from './sendui';
import { LINK_PREFIX } from './share';
import {
  currentSection, isFinished, nextUnfinished, openStitch, sections, setSectionDone, startScreen, stepSection, syncScreen, undoFloor,
} from './stitch';
import {
  S, Tool, clearPatch, commitFloating, copySelection, patchAction, cutSelection, deleteSelection, emit, fitView, keys, nudgeSelection,
  openDialog, openFile, paste, redo, renamePattern, saveFile, selectAll, setTool, undo, useStore, zoomBy,
} from './store';

const ICONS: Record<string, string> = {
  pencil: 'M3 17l1-4L14 3l3 3L7 16l-4 1zM12 5l3 3',
  eraser: 'M8.5 16.5l-5-5 8-8 6 6-7 7h-2zM7 8l5.5 5.5M3 17h14',
  fill: 'M4.5 10.5l6-6 5.5 5.5-5 5a1.4 1.4 0 0 1-2 0l-4.5-4.5zM10.5 4.5L8 2M4.5 10.5h11M16.5 13.5s1.5 1.8 1.5 2.8a1.5 1.5 0 0 1-3 0c0-1 1.500-2.8 1.500-2.8z',
  picker: 'M11 6l3 3M12.500 4.500l1.500-1.500a1.400 1.400 0 0 1 2 0l1.500 1.500a1.400 1.400 0 0 1 0 2L16 8M12 7l-8 8-1 3 3-1 8-8',
  recolor: 'M3 17c2.500 0 4-1 4-3.500L15 5a1.600 1.600 0 0 1 2.300 2.300L9 15c-2.500 0-3.500 1-6 2zM7 13.500l2 1.500',
  tidy: 'M10 2.500v4M10 13.500v4M2.500 10h4M13.500 10h4M5 5l2.200 2.200M12.800 12.800L15 15M15 5l-2.200 2.200M7.200 12.800L5 15',
  restore: 'M4.500 10a5.500 5.500 0 1 0 1.800-4.100M4 3.500v3.500h3.500M10 7v3.200l2.200 1.500',
  line: 'M4 16L16 4',
  rect: 'M4 5h12v10H4z',
  ellipse: 'M10 4.500c3.600 0 6.500 2.500 6.500 5.500s-2.900 5.500-6.500 5.500S3.500 13 3.500 10 6.400 4.500 10 4.500z',
  select: 'M4 4h3M9 4h3M14 4h2v2M16 8v3M16 13v3h-2M12 16H9M7 16H4v-2M4 12V9M4 7V4',
  shape: 'M4.500 8.500c-.500-3 2-5 5-4.500 2 .300 2.500 1.500 4.500 2 2.500.600 3 3 1.500 5.500-1.200 2-3 3.500-5.500 3.500-3.500 0-5-3-5.500-6.500z',
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
  { id: 'recolor', label: 'Recolor brush', key: 'C', hint: 'Replaces only the color you start on with the current color, leaving everything else alone.' },
  { id: 'tidy', label: 'Tidy brush', key: 'T', hint: 'Brush over a noisy patch to absorb stray stitches into the colors around them.' },
  { id: 'restore', label: 'Restore brush', key: 'O', hint: 'Paints back the stitches from the first conversion. Needs a pattern made from a picture.' },
  { id: 'fill', label: 'Fill', key: 'G', hint: 'Click to fill an area. Shift-click replaces that color everywhere.' },
  { id: 'picker', label: 'Pick color', key: 'I', hint: 'Click a stitch to use its color.' },
  { id: 'line', label: 'Line', key: 'L', hint: 'Drag to draw a straight line of stitches.' },
  { id: 'rect', label: 'Rectangle', key: 'R', hint: 'Drag to draw a rectangle. Hold Shift to fill it.' },
  { id: 'ellipse', label: 'Ellipse', key: 'U', hint: 'Drag to draw an ellipse or circle. Hold Shift to fill it.' },
  { id: 'shape', label: 'Shape select', key: 'S', hint: 'Click a patch of color to select all of it; Shift-click adds more. Then fill, absorb, grow, shrink, smooth or outline it from the bar above.' },
  { id: 'select', label: 'Select', key: 'M', hint: 'Drag to select, drag inside to move. Copy, cut, paste and Delete work. Esc to finish.' },
  { id: 'backstitch', label: 'Backstitch', key: 'K', hint: 'Drag between grid corners to add an outline. Alt-click a line to remove it.' },
  { id: 'pan', label: 'Move view', key: 'H', hint: 'Drag to move around; click a stitch to see its color and count. Space-drag works with any tool.' },
];


export function App() {
  useStore();
  const dialog = S.dialog, setDialog = openDialog;
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
      if (S.screen === 'stitch') {
        // The stitch screen has its own few keys: move between sections, tick one off, undo, zoom.
        if (mod && k === 'z') { if (e.shiftKey) redo(); else if (S.undo.length > undoFloor) undo(); }
        else if (mod && k === 'y') redo();
        else if (mod) return;
        else if (k === 'arrowright' || k === 'arrowdown') stepSection(1);
        else if (k === 'arrowleft' || k === 'arrowup') stepSection(-1);
        else if (k === 'enter') {
          const n = currentSection(), s = sections().list[n];
          if (s) { if (isFinished(s)) setSectionDone(n, false); else { setSectionDone(n, true); nextUnfinished(); } }
        }
        else if (k === '=' || k === '+') zoomBy(1.25);
        else if (k === '-') zoomBy(0.8);
        else if (k === '0') fitView();
        else if (k === '?') openDialog('help');
        else return;
        e.preventDefault();
        return;
      }
      if (k === 'p' && !mod) { if (!S.refPeek) { S.refPeek = true; emit(false); } return; }
      if (mod) {
        if (k === 'z') { e.shiftKey ? redo() : undo(); }
        else if (k === 'y') redo();
        else if (k === 's') saveFile();
        else if (k === 'c') copySelection();
        else if (k === 'x') cutSelection();
        else if (k === 'v') paste();
        else if (k === 'a') selectAll();
        else return;
        e.preventDefault();
        return;
      }
      const tool = TOOLS.find((x) => x.key.toLowerCase() === k);
      if (tool) setTool(tool.id);
      else if (k === '=' || k === '+') zoomBy(1.25);
      else if (k === '-') zoomBy(0.8);
      else if (k === '0') fitView();
      else if (k === '?') openDialog('help');
      else if (k.startsWith('arrow') && (S.selection || S.floating)) {
        nudgeSelection(k === 'arrowleft' ? -1 : k === 'arrowright' ? 1 : 0, k === 'arrowup' ? -1 : k === 'arrowdown' ? 1 : 0);
      }
      else if (k === '[') { S.brush = Math.max(1, S.brush - 1); emit(false); }
      else if (k === ']') { S.brush = Math.min(8, S.brush + 1); emit(false); }
      else if (k === 'delete' || k === 'backspace') { if (S.patch) patchAction('erase'); else deleteSelection(); }
      else if (k === 'escape') { clearPatch(); commitFloating(); S.selection = null; emit(false); }
      else return;
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') { keys.space = false; emit(false); }
      if (e.key.toLowerCase() === 'p' && S.refPeek) { S.refPeek = false; emit(false); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    // The stitch screen lives at #stitch, so the phone's back button leaves it and a refresh stays on it.
    window.addEventListener('hashchange', syncScreen);
    window.addEventListener('popstate', syncScreen);
    // A link from Send to another device: take the project out of the address (so a refresh does not
    // ask again) and offer to open it. Otherwise carry on where the last visit ended.
    const received = () => {
      if (!location.hash.startsWith(LINK_PREFIX)) return false;
      S.incoming = location.hash.slice(LINK_PREFIX.length);
      history.replaceState(null, '', location.pathname + location.search);
      syncScreen();
      openDialog('receive');
      return true;
    };
    if (!received()) startScreen();
    window.addEventListener('hashchange', received);
    // On a phone the natural first thing is to look around, not to draw.
    if (window.matchMedia('(pointer: coarse)').matches && window.innerWidth <= 760) setTool('pan');
    // First visit: open the guide once so new people know where to start.
    try {
      // A conversion that was open when the page was refreshed reopens where it left off.
      const converting = sessionStorage.getItem(CONVERTING_KEY);
      if (converting) openDialog(converting === 'edit' ? 'reimport' : 'import');
      else if (!localStorage.getItem('crosspattern.seenGuide')) {
        localStorage.setItem('crosspattern.seenGuide', '1');
        openDialog('help');
      }
    } catch { /* storage blocked */ }
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('hashchange', syncScreen);
      window.removeEventListener('hashchange', received);
      window.removeEventListener('popstate', syncScreen);
    };
  }, []);

  const p = S.pattern;
  const tool = TOOLS.find((t) => t.id === S.tool)!;

  if (S.screen === 'stitch') {
    return (
      <>
        <StitchScreen />
        {dialog === 'help' && <GuideDialog start="Stitching" onClose={() => setDialog(null)} />}
        {dialog === 'send' && <SendDialog onClose={() => setDialog(null)} />}
      </>
    );
  }

  return (
    <div
      className={'app' + (S.panelOpen ? ' show-panel' : '') + (S.toolsOpen ? '' : ' hide-tools')}
      onDragOver={(e) => { if (!dialog) e.preventDefault(); }}
      onDrop={async (e) => {
        if (dialog) return;
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (!f) return;
        if (f.type.startsWith('image/')) { S.droppedFile = f; setDialog('import'); return; }
        try { await openFile(f); setError(''); } catch (err) { setError((err as Error).message); }
      }}
    >
      <header className="topbar">
        <div className="brand">CrossPattern</div>
        <input
          className="name"
          value={p.name}
          onChange={(e) => renamePattern(e.target.value)}
          aria-label="Pattern name"
        />
        <div className="group g-stitch">
          <button
            className="btn stitch-btn"
            title="Work through the pattern color by color, ticking stitches off as you go"
            onClick={() => { commitFloating(); openStitch(); }}
          >
            Stitch ✓
          </button>
        </div>
        <div className="group g-phone narrow-only">
          <button className={'btn' + (S.panelOpen ? ' on' : '')} onClick={() => { S.panelOpen = !S.panelOpen; emit(false); }}>Colors</button>
          <button
            className={'btn' + (S.toolsOpen ? ' on' : '')}
            title="Show or hide the drawing tools"
            onClick={() => { S.toolsOpen = !S.toolsOpen; if (!S.toolsOpen) setTool('pan'); else emit(false); }}
          >
            Tools
          </button>
        </div>
        <div className="group g-file">
          <button className="btn" onClick={() => setDialog('projects')} title="All your projects in this browser">Projects</button>
          <button className="btn" onClick={() => setDialog('new')}>New</button>
          <button className="btn" onClick={() => fileInput.current?.click()}>Open</button>
          <button className="btn" onClick={saveFile} title="Save a project file (⌘S)">Save</button>
          <button className="btn" onClick={() => setDialog('send')} title="Open this project on your phone or another computer">Send</button>
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
        <div className="group g-convert">
          <button className="btn primary" onClick={() => setDialog('import')}>Convert picture</button>
          <button className="btn" onClick={() => setDialog('export')}>Export</button>
          <button className="btn" onClick={() => setDialog('resize')} title="Change the canvas size">
            {p.width} × {p.height}
          </button>
        </div>
        <div className="group g-undo">
          <button className="btn icon" onClick={undo} disabled={!S.undo.length} title="Undo (⌘Z)"><Icon name="undo" /></button>
          <button className="btn icon" onClick={redo} disabled={!S.redo.length} title="Redo (⇧⌘Z)"><Icon name="redo" /></button>
        </div>
        <div className="group g-zoom">
          <button className="btn icon" onClick={() => zoomBy(0.8)} title="Zoom out (-)">−</button>
          <button className="btn zoom" onClick={fitView} title="Fit to window (0)">{Math.round((S.view.scale / 16) * 100)}%</button>
          <button className="btn icon" onClick={() => zoomBy(1.25)} title="Zoom in (+)">+</button>
        </div>
        <div className="group g-view">
          <button className={'btn' + (S.showSymbols ? ' on' : '')} onClick={() => { S.showSymbols = !S.showSymbols; emit(false); }}>
            Symbols
          </button>
          <button className={'btn' + (S.showGrid ? ' on' : '')} onClick={() => { S.showGrid = !S.showGrid; emit(false); }}>
            Grid
          </button>
          <button
            className={'btn' + (S.mirror ? ' on' : '')}
            title="Paint both sides at once, mirrored across the centre line"
            onClick={() => { S.mirror = !S.mirror; emit(false); }}
          >
            Mirror
          </button>
        </div>
        <div className="group g-help">
          <button className="btn" onClick={() => setDialog('help')} title="How everything works, and keyboard shortcuts (?)">Guide</button>
        </div>
      </header>

      <main>
        <nav className="tools" aria-label="Tools">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={'tool' + (S.tool === t.id ? ' on' : '')}
              disabled={t.id === 'restore' && !p.reference?.converted}
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
        <span>
          {error ? <span className="error">{error}</span>
            : !S.storageOk ? <span className="error">This browser window is not saving projects (private browsing?). Use Save to keep a file.</span>
            : S.info ? <b>{S.info}</b>
            : S.tool === 'pan' && S.touch ? <><b>Looking around</b> — Drag to move, pinch to zoom, tap a stitch to see its color.</>
            : <><b>{tool.label}</b> — {tool.hint}</>}
        </span>
        <span className="grow" />
        <span id="status-pos" />
        <span className="muted">Scroll to move · ⌘/Ctrl-scroll or pinch to zoom · saved automatically in this browser</span>
      </footer>

      {dialog === 'new' && <NewDialog onClose={() => setDialog(null)} />}
      {dialog === 'import' && (
        <ImportDialog initialFile={S.droppedFile} onClose={() => { S.droppedFile = null; setDialog(null); }} />
      )}
      {dialog === 'reimport' && <ImportDialog edit onClose={() => setDialog(null)} />}
      {dialog === 'projects' && <ProjectsDialog onClose={() => setDialog(null)} />}
      {dialog === 'reconvert' && <ReconvertDialog onClose={() => setDialog(null)} />}
      {dialog === 'help' && <GuideDialog onClose={() => setDialog(null)} />}
      {dialog === 'send' && <SendDialog onClose={() => setDialog(null)} />}
      {dialog === 'receive' && S.incoming && <ReceiveDialog text={S.incoming} onClose={() => { S.incoming = ''; setDialog(null); }} />}
      {dialog === 'export' && <ExportDialog onClose={() => setDialog(null)} />}
      {dialog === 'resize' && <ResizeDialog onClose={() => setDialog(null)} />}
    </div>
  );
}
