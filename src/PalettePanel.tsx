import { useEffect, useMemo, useState } from 'react';
import { inkFor } from './color';
import { SYMBOLS, countCells } from './model';
import {
  RefMode, S, addColor, addOutline, deleteColor, emit, loadReferencePhoto, mergeInto, reduceTo, removeReference,
  removeStrays, removeUnusedColors, setColorHex, setColorSymbol, sortPaletteByUse, toggleLock, useStore,
} from './store';

function ReferenceSection() {
  const ref = S.pattern.reference;
  const set = (mode: RefMode) => { S.refMode = mode; emit(false); };
  const picker = (label: string) => (
    <label className="btn small">
      {label}
      <input
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) loadReferencePhoto(f).catch(() => {});
        }}
      />
    </label>
  );
  const options: [RefMode, string][] = [['off', 'Off']];
  if (ref?.photo) options.push(['photo', 'Photo']);
  if (ref?.converted) options.push(['converted', 'First conversion']);

  return (
    <div className="reference">
      <h3>Guide picture</h3>
      {!ref ? (
        <div className="editor-row">{picker('Add a photo to trace')}</div>
      ) : (
        <>
          <div className="seg">
            {options.map(([mode, label]) => (
              <button key={mode} className={S.refMode === mode ? 'on' : ''} onClick={() => set(mode)}>{label}</button>
            ))}
          </div>
          <div className="editor-row">
            <label>Pattern</label>
            <input
              type="range"
              className="fade"
              min={0}
              max={100}
              value={Math.round(S.refOpacity * 100)}
              disabled={S.refMode === 'off'}
              onChange={(e) => { S.refOpacity = Number(e.target.value) / 100; emit(false); }}
            />
            <label>Guide</label>
          </div>
          <p className="note">Hold P to see the guide in full.</p>
          <div className="editor-row">
            {picker(ref.photo ? 'Change photo' : 'Add photo')}
            <button className="btn small" onClick={removeReference}>Remove guide</button>
          </div>
        </>
      )}
    </div>
  );
}

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
      <ReferenceSection />
      <div className="panel-head">
        <h2>Colors <span className="muted">{p.palette.length}</span></h2>
        <span className="editor-row">
          <button className="btn small" title="Put the most-used colors first" onClick={sortPaletteByUse}>Sort</button>
          <button className="btn small" onClick={() => addColor()}>+ Add color</button>
        </span>
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
            <button
              className={'btn small' + (cur.locked ? ' on' : '')}
              title="Locked colors can't be painted over by any tool"
              onClick={() => toggleLock(cur.id)}
            >
              {cur.locked ? 'Locked' : 'Lock'}
            </button>
            <button className="btn small danger" title="Delete this color and its stitches" onClick={() => deleteColor(cur.id)}>
              Delete
            </button>
          </div>
          <div className="editor-row">
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
            {c.locked && <span className="lock" title="Locked">locked</span>}
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
        <div className="editor-row">
          <label>Outline</label>
          <button
            className="btn small push"
            title="Backstitch along the edge between stitches and empty fabric, in the current color"
            onClick={() => setNote(addOutline('backstitch') ? 'Added a backstitch outline.' : 'No edge next to empty fabric to outline.')}
          >
            Backstitch
          </button>
          <button
            className="btn small"
            title="Recolor the outermost stitches next to empty fabric, in the current color"
            onClick={() => setNote(addOutline('stitches') ? 'Outlined with stitches.' : 'No edge next to empty fabric to outline.')}
          >
            Stitches
          </button>
        </div>
        {note && <p className="note">{note}</p>}
      </div>

      <div className="totals">{total.toLocaleString()} stitches · {usedCount} colors in use</div>
    </aside>
  );
}
