import { useEffect, useMemo, useState } from 'react';
import { CanvasView } from './CanvasView';
import { inkFor } from './color';
import { PaletteColor } from './model';
import {
  canKeepAwake, closeStitch, currentRun, currentSection, describeDistance, describeRun, focusColor, measureToSection, route, runDone,
  setMeasuring, setOrderGuide, setOrderMethod, suggestColor, suggestSection, goSection, isFinished, keepAwake, nextColor, nextUnfinished,
  progress, sections, sessionStart, setOnlyFocus, setSectionDone, setStitchSymbols, stepSection, undoFloor,
} from './stitch';
import { S, fitView, openDialog, redo, undo, useStore, zoomBy } from './store';

function Chip({ c, big }: { c: PaletteColor; big?: boolean }) {
  return <span className={'chip' + (big ? ' big' : '')} style={{ background: c.hex, color: inkFor(c.hex) }}>{c.symbol}</span>;
}

function Bar({ done, total }: { done: number; total: number }) {
  return <span className="bar"><span style={{ width: total ? `${(done / total) * 100}%` : 0 }} /></span>;
}

const pct = (done: number, total: number) => (total ? Math.floor((done / total) * 100) : 0);

/**
 * The screen for working through a pattern: pick a color, then go section by section, ticking stitches
 * off as they are done. Laid out side by side on a computer and stacked, thumb-first, on a phone.
 */
export function StitchScreen() {
  useStore();
  const p = S.pattern;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const prog = useMemo(progress, [S.cellsVersion]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const { list } = useMemo(sections, [S.cellsVersion, S.stitchColor]);
  const k = currentSection();
  const sec = k >= 0 ? list[k] : null;
  const all = prog.get(0)!;
  const color = p.palette.find((c) => c.id === S.stitchColor);
  const mine = prog.get(S.stitchColor) ?? { done: 0, total: 0 };
  const colors = p.palette.filter((c) => prog.has(c.id));
  const colorDone = mine.total > 0 && mine.done >= mine.total;
  const following = colorDone ? nextColor() : 0;
  // What to do next: the nearest section of this color, and the color to move on to after it.
  const secTip = !colorDone ? suggestSection() : null;
  const colTip = suggestColor(S.stitchColor);
  const colTipColor = colTip ? p.palette.find((c) => c.id === colTip.id) : undefined;
  const backstitchNote = p.backstitches.length > 0 ? 'Leave the backstitch until every cross stitch is done: it goes on top.' : '';
  const upNext = (secTip || (colTip && colTipColor)) && (
    <div className="upnext">
      <b>Up next</b>
      {secTip && (
        <div className="tip">
          <div className="line">
            <span className="grow">
              {sec && !isFinished(sec) ? 'After this section: ' : ''}<b>Section {secTip.k + 1}</b>
              <span className="muted"> · column {list[secTip.k].x + 1}, row {list[secTip.k].y + 1}</span>
            </span>
            <button className="btn small" onClick={() => { setSheet(null); goSection(secTip.k); }}>Go</button>
          </div>
          <span className={secTip.kind === 'jump' ? 'jump' : 'muted'}>
            {secTip.from >= 0 ? `${secTip.d} square${secTip.d === 1 ? '' : 's'} from where your thread ${sec && !isFinished(sec) ? 'will finish' : 'is'}. ${secTip.advice}` : 'The closest to what you have stitched.'}
          </span>
        </div>
      )}
      {colTip && colTipColor && (
        <div className="tip">
          <div className="line">
            <span className="grow">
              {colorDone ? 'Next color: ' : 'Then the next color: '}<Chip c={colTipColor} /> <b>{colTipColor.hex.toUpperCase()}</b>
            </span>
            <button className="btn small" onClick={() => { setSheet(null); focusColor(colTip.id); }}>Go</button>
          </div>
          <span className="muted">{colTip.why}</span>
        </div>
      )}
      {backstitchNote && <span className="muted">{backstitchNote}</span>}
    </div>
  );
  const sectionsDone = list.filter(isFinished).length;

  // On a phone the lists open as a sheet over the pattern; on a computer they are always showing.
  const [sheet, setSheet] = useState<'colors' | 'sections' | 'options' | null>(null);
  const [tab, setTab] = useState<'colors' | 'sections'>('colors');
  const showing = sheet === 'options' ? tab : sheet ?? tab;
  const toggleSheet = (s: 'colors' | 'sections' | 'options') => { if (s !== 'options') setTab(s); setSheet(sheet === s ? null : s); };
  const [awake, setAwake] = useState(() => { try { return localStorage.getItem('crosspattern.awake') !== '0'; } catch { return true; } });
  useEffect(() => {
    keepAwake(awake);
    try { localStorage.setItem('crosspattern.awake', awake ? '1' : '0'); } catch { /* blocked */ }
    return () => keepAwake(false);
  }, [awake]);

  const pickColor = (id: number) => { focusColor(id); setSheet(null); };
  const toggles = (
    <div className="toggles">
      <label className="check" title="Fade out the other colors, and only tick stitches of this color">
        <input type="checkbox" checked={S.onlyFocus} onChange={(e) => setOnlyFocus(e.target.checked)} /> Only this color
      </label>
      <label className="check" title="Arrows showing where to start in this section, which way to go and where to turn (O)">
        <input type="checkbox" checked={S.orderGuide} onChange={(e) => setOrderGuide(e.target.checked)} /> Stitching order
      </label>
      {canKeepAwake() && (
        <label className="check" title="Stop the screen going dark while you stitch">
          <input type="checkbox" checked={awake} onChange={(e) => setAwake(e.target.checked)} /> Keep screen on
        </label>
      )}
    </div>
  );
  const pickSection = (n: number) => { goSection(n); setSheet(null); };
  const [noStitches, setNoStitches] = useState(false);
  // The order to stitch the current section in, and the row to do next.
  const runs = S.orderGuide && sec ? route() : [];
  const now = runs.length ? currentRun() : -1;
  const step = now >= 0 ? describeRun(now) : null;
  const orderCard = S.orderGuide && sec && !isFinished(sec) && (
    <div className="order-card">
      <div className="line">
        <b>Stitching order</b>
        <select value={S.orderMethod} onChange={(e) => setOrderMethod(e.target.value as 'rows' | 'single')} title="How you work a row">
          <option value="rows">Rows, there and back</option>
          <option value="single">One cross at a time</option>
        </select>
      </div>
      {step && (
        <>
          <span className="step">Next {runs[now].vertical ? 'column' : 'row'}: {step.title}</span>
          <span className="muted">{step.left} {runs[now].vertical ? 'column' : 'row'}{step.left === 1 ? '' : 's'} left in this section, planned from where you are.</span>
          <span className="muted">{step.how}</span>
          <span className={step.jump ? 'jump' : 'muted'}>{step.then}</span>
          <button className="btn small primary" onClick={() => runDone(now)} title="Tick every stitch in this row">
            {runs[now].vertical ? 'Column' : 'Row'} done ✓
          </button>
        </>
      )}
    </div>
  );
  const measureNew = () => { setSheet(null); setNoStitches(!measureToSection()); };
  const m = S.measuring ? S.measure : null;
  // Over the pattern while measuring: what to do next, or the answer.
  const measureBar = S.measuring && (
    <div className="measure-bar" role="status">
      <span className="what">
        {noStitches && !m ? 'Nothing is stitched yet to measure from. ' : ''}
        {!m ? (S.touch ? 'Tap the square to measure from.' : 'Click the square to measure from.')
          : !m.fixed ? (S.touch ? 'Now tap the square to measure to.' : 'Now click the square to measure to.')
          : (
            <>
              <b>{describeDistance(m.b.x - m.a.x, m.b.y - m.a.y)}</b>
              <span className="muted"> · column {m.a.x + 1}, row {m.a.y + 1} → column {m.b.x + 1}, row {m.b.y + 1}</span>
            </>
          )}
      </span>
      {sec && <button className="btn small" title="Measure from the nearest stitch you have done to where this section starts" onClick={measureNew}>From my stitches to this section</button>}
      {m && <button className="btn small" onClick={() => { S.measure = null; setMeasuring(true); }}>Clear</button>}
      <button className="btn small primary" onClick={() => setMeasuring(false)}>Done</button>
    </div>
  );
  const session = Math.max(0, all.done - sessionStart);
  const colorsFinished = colors.filter((c) => { const e = prog.get(c.id)!; return e.done >= e.total; }).length;
  /** Progress over the whole pattern, every color together. */
  const overall = (
    <div className="overall">
      <div className="line">
        <b>Whole pattern</b>
        <span className="muted">{pct(all.done, all.total)}%</span>
      </div>
      <Bar done={all.done} total={all.total} />
      <div className="stats">
        <span><b>{all.done.toLocaleString()}</b> of {all.total.toLocaleString()} stitches done</span>
        <span><b>{(all.total - all.done).toLocaleString()}</b> to go</span>
        <span><b>{colorsFinished}</b> of {colors.length} colors finished</span>
        {session > 0 && <span><b>+{session.toLocaleString()}</b> this session</span>}
      </div>
    </div>
  );

  if (!all.total) {
    return (
      <div className="stitch">
        <header className="stitch-top">
          <button className="btn" onClick={closeStitch}>← Editor</button>
          <b className="grow">{p.name}</b>
        </header>
        <p className="stitch-empty">This pattern has no stitches yet. Draw it or convert a picture in the editor first.</p>
      </div>
    );
  }

  const colorList = (
    <ul className="stitch-list">
      {colors.map((c) => {
        const e = prog.get(c.id)!, finished = e.done >= e.total;
        return (
          <li key={c.id} className={(c.id === S.stitchColor ? 'on ' : '') + (finished ? 'finished' : '')}>
            <button onClick={() => pickColor(c.id)}>
              <Chip c={c} />
              <span className="what">
                <span className="code">{c.hex.toUpperCase()}{colTip?.id === c.id && <span className="tip-badge">Suggested next</span>}</span>
                <Bar done={e.done} total={e.total} />
              </span>
              <span className="nums">{finished ? '✓ done' : `${e.done.toLocaleString()} / ${e.total.toLocaleString()}`}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  const sectionList = (
    <ul className="stitch-list">
      {list.map((s, n) => (
        <li key={n} className={(n === k ? 'on ' : '') + (isFinished(s) ? 'finished' : '')}>
          <button onClick={() => pickSection(n)}>
            <span className="num">{n + 1}</span>
            <span className="what">
              <span>Column {s.x + 1}, row {s.y + 1}{secTip?.k === n && <span className="tip-badge">Next</span>}</span>
              <Bar done={s.done} total={s.cells.length} />
            </span>
            <span className="nums">{isFinished(s) ? '✓ done' : `${s.done} / ${s.cells.length}`}</span>
          </button>
        </li>
      ))}
    </ul>
  );

  return (
    <div className={'stitch' + (sheet ? ' sheet-open' : '')}>
      <header className="stitch-top">
        <button className="btn" onClick={closeStitch} title="Back to the editor">← <span className="label">Editor</span></button>
        <div className="title">
          <b>{p.name}</b>
          <span className="muted long">
            {pct(all.done, all.total)}% · {all.done.toLocaleString()} of {all.total.toLocaleString()} stitches done
            {session > 0 && <> · +{session.toLocaleString()} this session</>}
          </span>
          <span className="muted short">
            {all.done.toLocaleString()} / {all.total.toLocaleString()} stitches · {pct(all.done, all.total)}%
          </span>
        </div>
        <div className="group">
          <button className="btn icon" onClick={undo} disabled={S.undo.length <= undoFloor} title="Undo the last tick (⌘Z)">↶</button>
          <button className="btn icon" onClick={redo} disabled={!S.redo.length} title="Redo (⇧⌘Z)">↷</button>
        </div>
        <div className="group">
          <button className="btn icon" onClick={() => zoomBy(0.8)} title="Zoom out">−</button>
          <button className="btn" onClick={fitView} title="Show the whole pattern">Whole</button>
          <button className="btn icon" onClick={() => zoomBy(1.25)} title="Zoom in">+</button>
        </div>
        <div className="group options">
          <button className={'btn' + (S.measuring ? ' on' : '')} title="Count the squares across and down between two stitches (M)" onClick={() => setMeasuring(!S.measuring)}>Measure</button>
          <button className={'btn' + (S.showSymbols ? ' on' : '')} title="Show each color's chart symbol in its squares" onClick={() => setStitchSymbols(!S.showSymbols)}>Symbols</button>
          <button className="btn" onClick={() => openDialog('send')} title="Open this project, with its progress, on another device">Send</button>
          <button className="btn help-btn" onClick={() => openDialog('help')} title="How this works">Help</button>
        </div>
        <button className={'btn icon phone-only' + (sheet === 'options' ? ' on' : '')} onClick={() => toggleSheet('options')} title="More" aria-label="More">⋯</button>
        <span className="top-progress" style={{ width: `${all.total ? (all.done / all.total) * 100 : 0}%` }} aria-hidden />
      </header>

      <div className="stitch-main">
        <div className="stitch-canvas">
          <CanvasView />
          {measureBar}
        </div>
        <aside className="stitch-side">
          <section className="dock">
            {overall}
            {color && (
              <div className="current">
                <Chip c={color} big />
                <div className="what">
                  <b>{color.hex.toUpperCase()}</b>
                  <span className="muted">
                    {colorDone ? 'All done' : `${mine.done.toLocaleString()} of ${mine.total.toLocaleString()} stitched`}
                    {' · '}{sectionsDone} of {list.length} section{list.length === 1 ? '' : 's'} done
                  </span>
                  <Bar done={mine.done} total={mine.total} />
                </div>
              </div>
            )}

            {colorDone ? (
              <div className="nav">
                <span className="hint grow">Every stitch of this color is done.</span>
                {following ? (
                  <button className="btn primary" onClick={() => focusColor(following)}>Next color →</button>
                ) : (
                  <span className="celebrate">{backstitchNote ? 'Every cross stitch is done! Now the backstitch.' : 'The whole pattern is stitched!'}</span>
                )}
              </div>
            ) : (
              <>
                <div className="where">
                  {sec ? (
                    <>
                      <b>Section {k + 1} of {list.length}</b>
                      <span className="muted">column {sec.x + 1}, row {sec.y + 1} · {sec.done} of {sec.cells.length} stitched</span>
                      <button className="link-btn" title="Count the squares from the nearest stitch you have done to where this section starts" onClick={measureNew}>
                        How far is it from my stitches?
                      </button>
                    </>
                  ) : (
                    <span className="muted">{list.length} section{list.length === 1 ? '' : 's'}. Pick one, or tap a stitch.</span>
                  )}
                </div>
                <div className="nav">
                  <button className="btn" onClick={() => stepSection(-1)} title="Previous section (←)">← Prev</button>
                  {sec && (
                    <button
                      className={'btn grow' + (isFinished(sec) ? '' : ' primary')}
                      title="Tick every stitch in this section (Enter)"
                      onClick={() => {
                        if (isFinished(sec)) setSectionDone(k, false);
                        else { setSectionDone(k, true); nextUnfinished(); }
                      }}
                    >
                      {isFinished(sec) ? 'Untick section' : 'Section done ✓'}
                    </button>
                  )}
                  <button className="btn" onClick={() => (sec && !isFinished(sec) ? stepSection(1) : nextUnfinished() || stepSection(1))} title="Next section (→)">
                    Next →
                  </button>
                </div>
              </>
            )}

            {orderCard}

            {upNext}

            {toggles}

            <div className="tabs">
              <button className={showing === 'colors' ? 'on' : ''} onClick={() => { setTab('colors'); setSheet(sheet === 'colors' ? null : 'colors'); }}>
                Colors <span className="muted">{colorsFinished}/{colors.length}</span>
              </button>
              <button className={showing === 'sections' ? 'on' : ''} onClick={() => { setTab('sections'); setSheet(sheet === 'sections' ? null : 'sections'); }}>
                Sections <span className="muted">{sectionsDone}/{list.length}</span>
              </button>
            </div>
          </section>

          <section className="lists">
            {sheet === 'options' ? (
              <div className="options-sheet">
                {overall}
                {upNext}
                {toggles}
                <div className="row">
                  <button className={'btn' + (S.measuring ? ' on' : '')} onClick={() => { setMeasuring(!S.measuring); setSheet(null); }}>Measure</button>
                  {sec && <button className="btn" onClick={measureNew}>Measure to this section</button>}
                  <button className={'btn' + (S.showSymbols ? ' on' : '')} onClick={() => setStitchSymbols(!S.showSymbols)}>Symbols</button>
                  <button className="btn" onClick={() => { fitView(); setSheet(null); }}>Whole pattern</button>
                  <button className="btn" onClick={() => { setSheet(null); openDialog('send'); }}>Send to another device</button>
                  <button className="btn" onClick={() => { setSheet(null); openDialog('help'); }}>Help</button>
                </div>
              </div>
            ) : showing === 'colors' ? colorList : sectionList}
          </section>

          {/* Phone: the row to do next, just above the bar, when the stitching order is showing. */}
          {step && sec && !isFinished(sec) && (
            <div className="order-strip">
              <span className="what"><b>Next:</b> {step.title}{step.jump ? ' · then a new thread' : ''}</span>
              <button className="btn small primary" onClick={() => runDone(now)}>{runs[now].vertical ? 'Column' : 'Row'} ✓</button>
            </div>
          )}
          {/* Phone: one slim bar. The color opens the colors, the section opens the sections. */}
          <nav className="phonebar" aria-label="Stitching">
            {color && (
              <button className="pb-color" onClick={() => toggleSheet('colors')} aria-label="Choose a color">
                <Chip c={color} />
                <span className="pb-pct">{pct(mine.done, mine.total)}%</span>
              </button>
            )}
            {colorDone ? (
              <>
                <span className="pb-what">{following ? 'This color is done' : 'All stitched!'}</span>
                {following > 0 && <button className="btn primary" onClick={() => focusColor(following)}>Next color →</button>}
              </>
            ) : (
              <>
                <button className="btn icon" onClick={() => stepSection(-1)} aria-label="Previous section">‹</button>
                <button className="pb-what" onClick={() => toggleSheet('sections')}>
                  <b>{sec ? `Section ${k + 1}/${list.length}` : `${list.length} sections`}</b>
                  {sec && <span>{sec.done}/{sec.cells.length} stitched</span>}
                </button>
                <button className="btn icon" onClick={() => (sec && !isFinished(sec) ? stepSection(1) : nextUnfinished() || stepSection(1))} aria-label="Next section">›</button>
                {sec && (
                  <button
                    className={'btn pb-done' + (isFinished(sec) ? '' : ' primary')}
                    onClick={() => { if (isFinished(sec)) setSectionDone(k, false); else { setSectionDone(k, true); nextUnfinished(); } }}
                    aria-label={isFinished(sec) ? 'Untick section' : 'Section done'}
                  >
                    {isFinished(sec) ? '↺' : '✓'}
                  </button>
                )}
              </>
            )}
          </nav>
        </aside>
      </div>

      <footer className="stitch-hint">
        {S.orderGuide && !S.measuring && sec && !isFinished(sec)
          ? 'Start at the green square and follow the arrows: the numbered rows in order, the bold one next. Dotted lines are moves between rows; orange means start a new thread.'
          : S.measuring
          ? (S.touch ? 'Measuring: tap two squares to count the squares between them.' : 'Measuring: click two squares, or drag from one to the other, to count the squares between them. M or Esc stops.')
          : S.touch
          ? 'Tap a stitch to tick it off; tap again to untick. Drag to move, pinch to zoom.'
          : 'Click or drag over stitches to tick them off; Shift-click ticks a whole section. Scroll to move, ⌘/Ctrl-scroll to zoom. ← → change section.'}
      </footer>
    </div>
  );
}
