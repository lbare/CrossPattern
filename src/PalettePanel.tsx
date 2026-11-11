import { useEffect, useMemo, useState } from 'react';
import { inkFor } from './color';
import { SYMBOLS, countCells } from './model';
import {
  S, addColor, deleteColor, emit, mergeInto, reduceTo, removeStrays, removeUnusedColors, setColorHex,
  setColorSymbol, useStore,
} from './store';

export function PalettePanel() {
  useStore();
  const p = S.pattern;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const counts = useMemo(() => countCells(p), [S.cellsVersion]);
  const cur = p.palette.find((c) => c.id === S.colorId);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const usedCount = p.palette.filter((c) => counts.has(c.id)).length;

  const [hexText, setHexText] = useState(cur?.hex ?? '');
  useEffect(() => setHexText(cur?.hex ?? ''), [cur?.hex, cur?.id]);
  const [target, setTarget] = useState(10);
  const [level, setLevel] = useState(1);
  const [note, setNote] = useState('');

  return (
    <aside className="panel">
      <div className="panel-head">
        <h2>Colors <span className="muted">{p.palette.length}</span></h2>
        <button className="btn small" onClick={() => addColor()}>+ Add color</button>
      </div>

      {cur && (
        <div className="editor">
          <div className="editor-row">
            <input
              type="color"
              className="swatch-input"
              value={cur.hex}
              onChange={(e) => setColorHex(cur.id, e.target.value)}
              title="Change this color"
            />
            <input
              className="hex"
              value={hexText}
              spellCheck={false}
              onChange={(e) => {
                setHexText(e.target.value);
                if (/^#[0-9a-f]{6}$/i.test(e.target.value)) setColorHex(cur.id, e.target.value);
              }}
              onBlur={() => setHexText(cur.hex)}
            />
            <select
              className="symbol"
              value={cur.symbol}
              title="Chart symbol"
              onChange={(e) => setColorSymbol(cur.id, e.target.value)}
            >
              {SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="editor-row">
            <button
              className={'btn small' + (S.highlight === cur.id ? ' on' : '')}
              title="Fade every other color so this one stands out"
              onClick={() => { S.highlight = S.highlight === cur.id ? 0 : cur.id; emit(false); }}
            >
              Highlight
            </button>
            <select
              className="merge"
              value=""
              title="Replace this color everywhere with another one"
              onChange={(e) => e.target.value && mergeInto(cur.id, Number(e.target.value))}
            >
              <option value="">Merge into…</option>
              {p.palette.filter((c) => c.id !== cur.id).map((c) => (
                <option key={c.id} value={c.id}>{c.symbol} {c.hex}</option>
              ))}
            </select>
            <button className="btn small danger" title="Delete this color and its stitches" onClick={() => deleteColor(cur.id)}>
              Delete
            </button>
          </div>
        </div>
      )}

      <ul className="colors">
        {p.palette.map((c) => (
          <li
            key={c.id}
            className={c.id === S.colorId ? 'current' : ''}
            onClick={() => {
              S.colorId = c.id;
              if (S.highlight) S.highlight = c.id;
              emit(false);
            }}
          >
            <span className="swatch" style={{ background: c.hex, color: inkFor(c.hex) }}>{c.symbol}</span>
            <span className="code">{c.hex}</span>
            <span className="count">{counts.get(c.id) ?? 0}</span>
          </li>
        ))}
      </ul>

      <div className="cleanup">
        <h3>Simplify</h3>
        <div className="editor-row">
          <label>Reduce to</label>
          <input type="number" min={1} max={99} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
          <label>colors</label>
          <button
            className="btn small push"
            disabled={usedCount <= target}
            onClick={() => { reduceTo(target); setNote(`Merged down to ${target} colors.`); }}
          >
            Apply
          </button>
        </div>
        <div className="editor-row">
          <label>Stray stitches</label>
          <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
            <option value={1}>Light</option>
            <option value={2}>Medium</option>
            <option value={3}>Strong</option>
          </select>
          <button
            className="btn small push"
            onClick={() => {
              const n = removeStrays(level);
              setNote(n ? `Tidied ${n} stray stitch${n === 1 ? '' : 'es'}.` : 'No stray stitches found.');
            }}
          >
            Remove
          </button>
        </div>
        <div className="editor-row">
          <button className="btn small" onClick={() => { removeUnusedColors(); setNote('Removed unused colors.'); }}>
            Remove unused colors
          </button>
        </div>
        {note && <p className="note">{note}</p>}
      </div>

      <div className="totals">{total.toLocaleString()} stitches · {usedCount} colors in use</div>
    </aside>
  );
}
