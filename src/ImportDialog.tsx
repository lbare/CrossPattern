import { PointerEvent as RPointerEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { clamp } from './color';
import { quantize, resultToImageData, sampleImage } from './convert';
import { Modal } from './dialogs';
import {
  Base, Crop, DETAIL, FLAT0, LabelMap, NONE, REMOVE, compose, fillPolygon, fillUnmarked, labelSize, makeBase,
  makeLabels, nextFlatId, remapLabels, stamp, stampLine, wand,
} from './marks';
import { MAX_SIZE, paletteFromHexes } from './model';
import { FABRIC } from './render';
import { openAsNewProject, photoDataUrl } from './store';

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file could not be read as an image.'));
    img.src = URL.createObjectURL(file);
  });
}

const validSize = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_SIZE;

/** A crop of the given shape, keeping the old crop's centre and height where the photo allows. */
function cropForAspect(img: HTMLImageElement, aspect: number, around?: Crop): Crop {
  const iw = img.naturalWidth, ih = img.naturalHeight;
  let h = around ? around.h : ih, w = h * aspect;
  if (w > iw) { w = iw; h = w / aspect; }
  if (h > ih) { h = ih; w = h * aspect; }
  const cx = around ? around.x + around.w / 2 : iw / 2, cy = around ? around.y + around.h / 2 : ih / 2;
  return { x: clamp(cx - w / 2, 0, iw - w), y: clamp(cy - h / 2, 0, ih - h), w, h };
}

/** CSS that makes a box as large as fits while keeping its shape. */
const fitStyle = (aspect: number, maxVh: number) => ({
  aspectRatio: String(aspect),
  width: `min(100%, calc(${maxVh}vh * ${aspect}))`,
});

function Slider(props: { label: string; value: number; min: number; max: number; set: (n: number) => void; hint?: string }) {
  return (
    <label>
      <span className="slider-label">{props.label}<b>{props.value}</b></span>
      <input type="range" min={props.min} max={props.max} value={props.value} onChange={(e) => props.set(Number(e.target.value))} />
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
}

function Segmented<T extends string>(props: { value: T; options: [T, string][]; set: (v: T) => void }) {
  return (
    <div className="seg">
      {props.options.map(([v, label]) => (
        <button key={v} className={v === props.value ? 'on' : ''} onClick={() => props.set(v)}>{label}</button>
      ))}
    </div>
  );
}

// ---- Step 1: crop -------------------------------------------------------

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se';

function CropBox(props: { img: HTMLImageElement; crop: Crop; aspect: number; onChange: (c: Crop) => void }) {
  const { img, crop, aspect } = props;
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: Handle; sx: number; sy: number; start: Crop } | null>(null);

  const down = (kind: Handle) => (e: RPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    box.current!.setPointerCapture(e.pointerId);
    drag.current = { kind, sx: e.clientX, sy: e.clientY, start: crop };
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const s = iw / box.current!.getBoundingClientRect().width;
    const dx = (e.clientX - d.sx) * s, dy = (e.clientY - d.sy) * s, c = d.start;
    if (d.kind === 'move') {
      props.onChange({ ...c, x: clamp(c.x + dx, 0, iw - c.w), y: clamp(c.y + dy, 0, ih - c.h) });
      return;
    }
    // Resize from a corner: the opposite corner stays put and the shape stays locked.
    const left = d.kind.includes('w'), top = d.kind.includes('n');
    const ax = left ? c.x + c.w : c.x, ay = top ? c.y + c.h : c.y;
    const maxW = Math.min(left ? ax : iw - ax, (top ? ay : ih - ay) * aspect);
    const want = Math.max(left ? c.w - dx : c.w + dx, (top ? c.h - dy : c.h + dy) * aspect);
    const w = clamp(want, Math.min(24, maxW), maxW), h = w / aspect;
    props.onChange({ x: left ? ax - w : ax, y: top ? ay - h : ay, w, h });
  };
  const pct = (v: number, of: number) => (v / of) * 100 + '%';

  return (
    <div
      className="cropbox"
      ref={box}
      style={fitStyle(iw / ih, 58)}
      onPointerMove={move}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <img src={img.src} alt="" draggable={false} />
      <div
        className="croprect"
        style={{ left: pct(crop.x, iw), top: pct(crop.y, ih), width: pct(crop.w, iw), height: pct(crop.h, ih) }}
        onPointerDown={down('move')}
      >
        {(['nw', 'ne', 'sw', 'se'] as Handle[]).map((k) => (
          <span key={k} className={'handle ' + k} onPointerDown={down(k)} />
        ))}
      </div>
    </div>
  );
}

// ---- Step 2: mark areas -------------------------------------------------

type Mode = 'detail' | 'flat' | 'remove' | 'erase';
type MarkTool = 'brush' | 'lasso' | 'wand';

const MODE_HELP: Record<Mode, string> = {
  detail: 'Protected from simplifying, and given priority when colors are chosen. Use on eyes, nose and edges that must stay crisp.',
  flat: 'Each area you mark becomes one solid color. Start inside an existing area to add to it.',
  remove: 'Left as empty fabric. Use for the background so the subject keeps a clean outline.',
  erase: 'Clears marks, returning the area to normal conversion.',
};

function MarkCanvas(props: {
  base: Base; labels: LabelMap; mode: Mode; tool: MarkTool; brush: number; tol: number; version: number;
  onBefore: () => void; onChange: () => void;
}) {
  const { base, labels, mode, tool, brush } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const st = useRef({
    drawing: false, label: 0, lx: 0, ly: 0, pts: [] as [number, number][], hover: null as [number, number] | null,
    out: null as ImageData | null,
  });

  const paint = () => {
    const c = ref.current;
    if (!c) return;
    const s = st.current, g = c.getContext('2d')!;
    if (!s.out || s.out.width !== labels.w || s.out.height !== labels.h) s.out = new ImageData(labels.w, labels.h);
    compose(base, labels, s.out);
    g.putImageData(s.out, 0, 0);
    const outline = (draw: () => void) => {
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.7)'; draw();
      g.lineWidth = 1.25; g.strokeStyle = '#fff'; draw();
    };
    if (s.pts.length > 1) {
      outline(() => {
        g.beginPath();
        s.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.stroke();
      });
    }
    if (s.hover && tool === 'brush') {
      const [hx, hy] = s.hover;
      outline(() => { g.beginPath(); g.arc(hx, hy, brush, 0, Math.PI * 2); g.stroke(); });
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(paint, [base, labels, props.version, tool, brush]);

  const at = (e: RPointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [((e.clientX - r.left) * labels.w) / r.width, ((e.clientY - r.top) * labels.h) / r.height];
  };
  const labelAt = (x: number, y: number) => {
    if (mode === 'remove') return REMOVE;
    if (mode === 'detail') return DETAIL;
    if (mode === 'erase') return NONE;
    const ix = clamp(Math.floor(x), 0, labels.w - 1), iy = clamp(Math.floor(y), 0, labels.h - 1);
    const under = labels.data[iy * labels.w + ix];
    return under >= FLAT0 ? under : nextFlatId(labels);
  };

  const down = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    const [x, y] = at(e), s = st.current;
    ref.current!.setPointerCapture(e.pointerId);
    props.onBefore();
    s.label = labelAt(x, y);
    if (tool === 'wand') {
      wand(labels, base, x, y, props.tol * 0.003, s.label);
      props.onChange();
      return paint();
    }
    s.drawing = true;
    s.lx = x; s.ly = y;
    if (tool === 'brush') stamp(labels, x, y, brush, s.label);
    else s.pts = [[x, y]];
    paint();
  };
  const move = (e: RPointerEvent) => {
    const [x, y] = at(e), s = st.current;
    s.hover = [x, y];
    if (s.drawing) {
      if (tool === 'brush') stampLine(labels, s.lx, s.ly, x, y, brush, s.label);
      else s.pts.push([x, y]);
      s.lx = x; s.ly = y;
    }
    paint();
  };
  const up = () => {
    const s = st.current;
    if (!s.drawing) return;
    if (tool === 'lasso' && s.pts.length > 2) fillPolygon(labels, s.pts, s.label);
    s.drawing = false;
    s.pts = [];
    props.onChange();
    paint();
  };

  return (
    <canvas
      ref={ref}
      className="mark-canvas"
      width={labels.w}
      height={labels.h}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={() => { st.current.hover = null; paint(); }}
    />
  );
}

// ---- The dialog ---------------------------------------------------------

export function ImportDialog({ onClose, initialFile }: { onClose: () => void; initialFile?: File | null }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [step, setStep] = useState<'crop' | 'areas'>('crop');

  const [w, setW] = useState(80);
  const [h, setH] = useState(80);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, w: 1, h: 1 });
  const [fabric, setFabric] = useState(14);

  const [colors, setColors] = useState(10);
  const [smooth, setSmooth] = useState(2);
  const [clean, setClean] = useState(1);

  const [mode, setMode] = useState<Mode>('remove');
  const [tool, setTool] = useState<MarkTool>('brush');
  const [brush, setBrush] = useState(16);
  const [tol, setTol] = useState(30);
  const marks = useRef<{ labels: LabelMap; crop: Crop } | null>(null);
  const history = useRef<Uint8Array[]>([]);
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const out = useRef<HTMLCanvasElement>(null);

  const take = async (file?: Blob | null, fileName = '') => {
    if (!file) return;
    try {
      const im = await loadImage(file);
      const nh = clamp(Math.round((80 * im.naturalHeight) / im.naturalWidth), 1, MAX_SIZE);
      setImg(im);
      setW(80);
      setH(nh);
      setCrop(cropForAspect(im, 80 / nh));
      marks.current = null;
      history.current = [];
      setStep('crop');
      setName(fileName.replace(/\.[^.]+$/, ''));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const undoMark = () => {
    const prev = history.current.pop();
    if (prev && marks.current) { marks.current.labels.data.set(prev); bump(); }
  };

  useEffect(() => {
    if (initialFile) take(initialFile, initialFile.name);
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      if (item) take(item.getAsFile(), 'Pasted image');
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoMark(); }
    };
    window.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sizeOk = validSize(w) && validSize(h);

  const changeSize = (nw: number, nh: number) => {
    setW(nw);
    setH(nh);
    if (img && validSize(nw) && validSize(nh)) setCrop(cropForAspect(img, nw / nh, crop));
  };
  const wholePhoto = () => {
    if (!img || !validSize(w)) return;
    const nh = clamp(Math.round((w * img.naturalHeight) / img.naturalWidth), 1, MAX_SIZE);
    setH(nh);
    setCrop(cropForAspect(img, w / nh));
  };

  const goAreas = () => {
    const prev = marks.current;
    const same = prev && (['x', 'y', 'w', 'h'] as const).every((k) => Math.abs(prev.crop[k] - crop[k]) < 0.5);
    if (!same) {
      marks.current = { labels: prev ? remapLabels(prev.labels, prev.crop, crop) : makeLabels(crop.w / crop.h), crop };
      history.current = [];
    }
    setStep('areas');
  };

  const labels = step === 'areas' ? marks.current?.labels ?? null : null;
  const base = useMemo(
    () => (img && labels ? makeBase(img, crop, labels.w, labels.h) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [img, labels],
  );
  const sampled = useMemo(
    () => (img && labels ? sampleImage(img, crop, w, h, labels) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [img, labels, version, w, h],
  );
  // Sliders stay responsive while the conversion catches up.
  const dColors = useDeferredValue(colors), dSmooth = useDeferredValue(smooth), dClean = useDeferredValue(clean);
  const result = useMemo(
    () => (sampled ? quantize(sampled, { colors: dColors, smooth: dSmooth, clean: dClean }) : null),
    [sampled, dColors, dSmooth, dClean],
  );

  useEffect(() => {
    const c = out.current;
    if (!c || !result) return;
    c.width = result.width;
    c.height = result.height;
    c.getContext('2d')!.putImageData(resultToImageData(result), 0, 0);
  }, [result, step]);

  const edit = (fn: (m: LabelMap) => void) => {
    if (!labels) return;
    pushHistory();
    fn(labels);
    bump();
  };
  const pushHistory = () => {
    if (!labels) return;
    history.current.push(labels.data.slice());
    if (history.current.length > 40) history.current.shift();
  };

  const create = () => {
    if (!result) return;
    openAsNewProject({
      name: name || 'Imported pattern',
      width: result.width,
      height: result.height,
      cells: result.cells.slice(),
      palette: paletteFromHexes(result.palette),
      backstitches: [],
      // Kept with the pattern so the editor can show the photo, or this first conversion, as a guide.
      reference: {
        photo: img ? photoDataUrl(img, crop.x, crop.y, crop.w, crop.h) : undefined,
        rect: { x: 0, y: 0, w: result.width, h: result.height },
        converted: { width: result.width, height: result.height, hexes: result.palette, cells: result.cells.slice() },
      },
    });
    onClose();
  };

  const stitches = result ? result.cells.reduce((n, v) => n + (v ? 1 : 0), 0) : 0;
  const filePicker = (label: string, cls: string) => (
    <label className={cls}>
      {label}
      <input type="file" accept="image/*" hidden onChange={(e) => take(e.target.files?.[0], e.target.files?.[0]?.name)} />
    </label>
  );

  return (
    <Modal title="Convert a picture" onClose={onClose} size={img ? 'xl' : 'wide'}>
      {!img && (
        <label
          className="drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); take(e.dataTransfer.files[0], e.dataTransfer.files[0]?.name); }}
        >
          <input type="file" accept="image/*" hidden onChange={(e) => take(e.target.files?.[0], e.target.files?.[0]?.name)} />
          <strong>Choose a picture</strong>
          <span>or drop one here, or paste from the clipboard</span>
          {error && <span className="error">{error}</span>}
        </label>
      )}

      {img && (
        <ol className="steps">
          <li className={step === 'crop' ? 'on' : ''}><button onClick={() => setStep('crop')}>1. Crop and size</button></li>
          <li className={step === 'areas' ? 'on' : ''}><button disabled={!sizeOk} onClick={goAreas}>2. Areas and colors</button></li>
        </ol>
      )}

      {img && step === 'crop' && (
        <>
          <div className="split">
            <div className="controls">
              <div className="fields tight">
                <label>Width (stitches)
                  <input type="number" min={1} max={MAX_SIZE} value={w || ''} onChange={(e) => changeSize(Number(e.target.value), h)} />
                </label>
                <label>Height (stitches)
                  <input type="number" min={1} max={MAX_SIZE} value={h || ''} onChange={(e) => changeSize(w, Number(e.target.value))} />
                </label>
              </div>
              {sizeOk ? (
                <p className="summary">
                  <b>{(w * h).toLocaleString()}</b> stitches in total
                  <span className="hint">
                    About {(w / fabric).toFixed(1)} × {(h / fabric).toFixed(1)} in ({((w / fabric) * 2.54).toFixed(1)} × {((h / fabric) * 2.54).toFixed(1)} cm) on{' '}
                    <select value={fabric} onChange={(e) => setFabric(Number(e.target.value))}>
                      {[11, 14, 16, 18, 22].map((n) => <option key={n} value={n}>{n}-count</option>)}
                    </select>
                  </span>
                </p>
              ) : (
                <p className="error">Sizes must be between 1 and {MAX_SIZE}.</p>
              )}
              <p className="hint">
                The crop box always has the shape of your canvas. Drag it to choose what goes in, and drag a corner to
                take in more or less of the photo.
              </p>
              <div className="row">
                <button className="btn small" onClick={() => changeSize(h, w)}>Swap width and height</button>
                <button className="btn small" onClick={wholePhoto} title="Sets the height so the whole photo fits">Use whole photo</button>
              </div>
              {filePicker('Choose a different picture', 'pick-other btn small')}
            </div>
            <div className="stage">
              <CropBox img={img} crop={crop} aspect={sizeOk ? w / h : crop.w / crop.h} onChange={setCrop} />
            </div>
          </div>
          <footer>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!sizeOk} onClick={goAreas}>Next: areas and colors</button>
          </footer>
        </>
      )}

      {img && step === 'areas' && labels && base && (
        <>
          <div className="areas">
            <div className="controls">
              <div className="block">
                <h3>Mark areas on the photo</h3>
                <Segmented
                  value={mode}
                  set={setMode}
                  options={[['remove', 'Remove'], ['flat', 'One color'], ['detail', 'Keep detail'], ['erase', 'Unmark']]}
                />
                <p className="hint mode-help">{MODE_HELP[mode]}</p>
                <Segmented value={tool} set={setTool} options={[['brush', 'Brush'], ['lasso', 'Lasso'], ['wand', 'Magic wand']]} />
                {tool === 'brush' && <Slider label="Brush size" value={brush} min={3} max={60} set={setBrush} />}
                {tool === 'lasso' && <p className="hint">Draw around an area; everything inside is marked.</p>}
                {tool === 'wand' && (
                  <Slider label="Tolerance" value={tol} min={2} max={100} set={setTol}
                    hint="Click a spot to mark the connected area of similar color. Higher reaches further." />
                )}
                <div className="row">
                  <button className="btn small" disabled={!history.current.length} onClick={undoMark}>Undo</button>
                  <button className="btn small" onClick={() => edit((m) => m.data.fill(NONE))}>Clear all</button>
                </div>
                {mode !== 'erase' && (
                  <button
                    className="btn small"
                    title="Applies the chosen mark to everything you have not marked yet"
                    onClick={() => edit((m) => fillUnmarked(m, mode === 'remove' ? REMOVE : mode === 'detail' ? DETAIL : nextFlatId(m)))}
                  >
                    {mode === 'remove' ? 'Remove everything unmarked' : mode === 'detail' ? 'Keep detail everywhere unmarked' : 'Make everything unmarked one color'}
                  </button>
                )}
              </div>
              <div className="block">
                <h3>Colors and simplifying</h3>
                <Slider label="Colors" value={colors} min={2} max={40} set={setColors}
                  hint={result ? `${result.palette.length} colors used` : undefined} />
                <Slider label="Flatten unmarked areas" value={smooth} min={0} max={4} set={setSmooth}
                  hint="Smooths texture and shading. Keep-detail areas are not touched." />
                <Slider label="Remove stray stitches" value={clean} min={0} max={3} set={setClean} />
              </div>
            </div>
            <figure>
              <div className="fit" style={fitStyle(labels.w / labels.h, 56)}>
                <MarkCanvas
                  base={base} labels={labels} mode={mode} tool={tool} brush={brush} tol={tol} version={version}
                  onBefore={pushHistory} onChange={bump}
                />
              </div>
              <figcaption>Photo: paint here to mark areas</figcaption>
            </figure>
            <figure>
              <div className="fit" style={{ ...fitStyle(w / h, 56), background: FABRIC }}>
                <canvas ref={out} className="pixelated" />
              </div>
              <figcaption>Pattern: {w} × {h}, {stitches.toLocaleString()} stitches</figcaption>
            </figure>
          </div>
          <footer>
            <span className="hint grow">Opens as a new project. Your current one stays in Projects.</span>
            <button className="btn" onClick={() => setStep('crop')}>Back</button>
            <button className="btn primary" disabled={!result?.palette.length} onClick={create}>Create pattern</button>
          </footer>
        </>
      )}
    </Modal>
  );
}
