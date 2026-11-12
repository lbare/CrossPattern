import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './dialogs';
import { CleanupOptions, cleanUp, countCells } from './model';
import { renderExport } from './render';
import { S, applyCleanup, commitFloating } from './store';

const DEFAULT: CleanupOptions = { similar: 2, rare: 8, patch: 3, smooth: 0 };
const KEY = 'crosspattern.cleanup';

function load(): CleanupOptions {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULT; }
}

/** Draws a pattern into a box, scaled to fit, optionally ringing the squares in `mark`. */
function Preview({ pattern, mark }: { pattern: typeof S.pattern; mark?: Uint8Array | null }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const cell = Math.max(2, Math.min(12, Math.floor(900 / Math.max(pattern.width, pattern.height))));
    const c = renderExport(pattern, { cell, symbols: false, grid: false, legend: false });
    if (mark) {
      const g = c.getContext('2d')!;
      g.strokeStyle = '#ff2fd0';
      g.lineWidth = Math.max(1, cell / 5);
      for (let i = 0; i < mark.length; i++) {
        if (!mark[i]) continue;
        const x = i % pattern.width, y = (i / pattern.width) | 0;
        g.strokeRect(x * cell + g.lineWidth / 2, y * cell + g.lineWidth / 2, cell - g.lineWidth, cell - g.lineWidth);
      }
    }
    c.className = 'pixelated';
    el.replaceChildren(c);
  }, [pattern, mark]);
  return <div className="cleanup-preview" ref={box} />;
}

function Slider(props: { label: string; value: number; min: number; max: number; set: (n: number) => void; show: string; hint: string }) {
  return (
    <label>
      <span className="slider-label">{props.label}<b>{props.show}</b></span>
      <input type="range" min={props.min} max={props.max} value={props.value} onChange={(e) => props.set(Number(e.target.value))} />
      <span className="hint">{props.hint}</span>
    </label>
  );
}

/**
 * Tidies up a pattern, usually straight after converting a picture: merges colors that look alike,
 * drops colors hardly used, absorbs little patches and smooths jagged edges. Shows the result before
 * anything changes. Undo brings the old pattern back.
 */
export function CleanupDialog({ onClose, afterConvert }: { onClose: () => void; afterConvert?: boolean }) {
  const [o, setO] = useState<CleanupOptions>(load);
  const [showChanges, setShowChanges] = useState(true);
  const [side, setSide] = useState<'after' | 'before'>('after');
  const set = (patch: Partial<CleanupOptions>) => setO((v) => ({ ...v, ...patch }));
  useEffect(() => { commitFloating(); }, []);
  const d = useDeferredValue(o);
  const source = S.pattern;
  const result = useMemo(() => cleanUp(source, d), [source, d]);
  const colorsBefore = useMemo(() => countCells(source).size, [source]);
  const colorsAfter = useMemo(() => countCells(result.pattern).size, [result]);

  const apply = () => {
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* blocked */ }
    if (result.count) applyCleanup(o);
    onClose();
  };

  return (
    <Modal title={afterConvert ? 'Clean up the new pattern' : 'Clean up'} onClose={onClose} size="wide">
      <div className="cleanup-dialog">
        <div className="controls">
          {afterConvert && <p className="hint">Conversions usually leave a few specks and near-duplicate colors. Tidy them now, or skip and do it later from the color panel.</p>}
          <Slider label="Merge look-alike colors" value={o.similar} min={0} max={10} set={(n) => set({ similar: n })}
            show={o.similar ? String(o.similar) : 'Off'} hint="Colors you could hardly tell apart in thread become one." />
          <Slider label="Drop rarely used colors" value={o.rare} min={0} max={60} set={(n) => set({ rare: n })}
            show={o.rare ? `under ${o.rare}` : 'Off'} hint="A color with fewer stitches than this goes into the closest color left." />
          <Slider label="Absorb small patches" value={o.patch} min={0} max={20} set={(n) => set({ patch: n })}
            show={o.patch > 1 ? `under ${o.patch}` : 'Off'} hint="Little islands of a color take the color around them. Pinholes in the design fill in, and specks on the fabric go." />
          <Slider label="Smooth edges" value={o.smooth} min={0} max={3} set={(n) => set({ smooth: n })}
            show={o.smooth ? String(o.smooth) : 'Off'} hint="Evens out jagged edges and single stray stitches." />
          <p className="summary">
            <b>{result.count.toLocaleString()}</b> stitch{result.count === 1 ? '' : 'es'} change
            <span className="hint">{colorsBefore} colors → {colorsAfter}. Locked colors are never changed.</span>
          </p>
          <label className="check">
            <input type="checkbox" checked={showChanges} onChange={(e) => setShowChanges(e.target.checked)} /> Ring the stitches that change
          </label>
        </div>
        <div className="cleanup-view">
          <div className="seg">
            <button className={side === 'before' ? 'on' : ''} onClick={() => setSide('before')}>Before</button>
            <button className={side === 'after' ? 'on' : ''} onClick={() => setSide('after')}>After</button>
          </div>
          {side === 'after'
            ? <Preview pattern={result.pattern} mark={showChanges ? result.changed : null} />
            : <Preview pattern={source} mark={showChanges ? result.changed : null} />}
        </div>
      </div>
      <footer>
        <span className="hint grow">Undo brings the pattern back as it was.</span>
        <button className="btn" onClick={onClose}>{afterConvert ? 'Skip' : 'Cancel'}</button>
        <button className="btn primary" disabled={!result.count} onClick={apply}>Clean up</button>
      </footer>
    </Modal>
  );
}
