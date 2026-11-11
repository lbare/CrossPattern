import { PointerEvent as RPointerEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { clamp } from './color';
import { quantize, resultToImageData, sampleImage } from './convert';
import { Modal } from './dialogs';
import { ConversionRecord, DRAFT, deleteConversion, getConversion, putConversion } from './db';
import {
  Base, CARTOON0, Crop, FLAT0, LabelMap, NONE, REMOVE, Shapes, areaIds, areaTint, compose, fillPolygon, fillShape,
  fillUnmarked, findShapes, makeBase, makeLabels, nextCartoonId, remapLabels, snapStroke, stamp, stampLine,
} from './marks';
import { MAX_SIZE, paletteFromHexes } from './model';
import { FABRIC } from './render';
import { S, openAsNewProject, photoDataUrl, setPattern } from './store';

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

function Segmented<T extends string>(props: { value: T; options: [T, string][]; set: (v: T) => void; wrap?: boolean }) {
  return (
    <div className={'seg' + (props.wrap ? ' wrap' : '')}>
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

type Mode = 'area' | 'remove' | 'erase';
type MarkTool = 'shapes' | 'brush' | 'lasso';

const MODE_HELP: Record<Mode, string> = {
  area: 'An area is one thing in the picture: the cat, a leaf, the pot. Each area gets colors of its own, and you choose how much detail it keeps.',
  remove: 'Left as empty fabric. Use for the background so the subject keeps a clean outline.',
  erase: 'Clears marks, returning that part to normal conversion.',
};

interface View { z: number; x: number; y: number }

function MarkCanvas(props: {
  base: Base; labels: LabelMap; shapes: Shapes | null; target: number; tool: MarkTool; brush: number; tol: number;
  snap: boolean; version: number; onBefore: () => void; onChange: () => void;
}) {
  const { base, labels, shapes, target, tool, brush } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ z: 1, x: 0, y: 0 });
  const st = useRef({
    drawing: false, lx: 0, ly: 0, pts: [] as [number, number][], hover: null as [number, number] | null,
    out: null as ImageData | null, pan: null as { sx: number; sy: number; x: number; y: number } | null,
    // For a snapping stroke: where the brush has been, and the marks as they were before it began.
    path: [] as [number, number][], before: null as Uint8Array | null,
    // For the shapes tool: the shape under the cursor and the last one marked in this drag.
    hoverShape: -1, lastShape: -1, entered: [0, 0] as [number, number],
  });

  /** Keeps the picture covering the box: no zooming out past 1 and no dragging it off the edge. */
  const fix = (v: View): View => {
    const r = wrap.current!.getBoundingClientRect(), z = clamp(v.z, 1, 8);
    return { z, x: clamp(v.x, r.width * (1 - z), 0), y: clamp(v.y, r.height * (1 - z), 0) };
  };
  const zoomAt = (v: View, cx: number, cy: number, factor: number): View => {
    const z = clamp(v.z * factor, 1, 8);
    return fix({ z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z });
  };
  const zoomBy = (factor: number) => {
    const r = wrap.current!.getBoundingClientRect();
    setView((v) => zoomAt(v, r.width / 2, r.height / 2, factor));
  };

  useEffect(() => {
    const el = wrap.current!;
    // Pinch or ⌘/Ctrl-scroll zooms toward the cursor; plain scrolling moves around when zoomed in.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top;
      setView((v) => (e.ctrlKey || e.metaKey ? zoomAt(v, cx, cy, Math.exp(-e.deltaY * 0.01)) : fix({ z: v.z, x: v.x - e.deltaX, y: v.y - e.deltaY })));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paint = () => {
    const c = ref.current;
    if (!c) return;
    const s = st.current, g = c.getContext('2d')!;
    if (!s.out || s.out.width !== labels.w || s.out.height !== labels.h) s.out = new ImageData(labels.w, labels.h);
    compose(base, labels, s.out, tool === 'shapes' ? shapes : null, s.hoverShape);
    g.putImageData(s.out, 0, 0);
    const outline = (draw: () => void) => {
      g.lineWidth = 3 / view.z; g.strokeStyle = 'rgba(0,0,0,0.7)'; draw();
      g.lineWidth = 1.25 / view.z; g.strokeStyle = '#fff'; draw();
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
  useEffect(paint, [base, labels, shapes, props.version, tool, brush, view.z]);

  const at = (e: RPointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [((e.clientX - r.left) * labels.w) / r.width, ((e.clientY - r.top) * labels.h) / r.height];
  };
  const shapeAt = (x: number, y: number) =>
    shapes ? shapes.id[clamp(Math.floor(y), 0, labels.h - 1) * labels.w + clamp(Math.floor(x), 0, labels.w - 1)] : -1;

  const down = (e: RPointerEvent) => {
    const s = st.current;
    ref.current!.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || e.altKey) {
      s.pan = { sx: e.clientX, sy: e.clientY, x: view.x, y: view.y };
      return;
    }
    if (e.button !== 0) return;
    const [x, y] = at(e);
    props.onBefore();
    s.drawing = true;
    s.lx = x; s.ly = y;
    if (tool === 'shapes') {
      if (shapes) { fillShape(labels, shapes, x, y, target); s.lastShape = shapeAt(x, y); }
    } else if (tool === 'brush' && props.snap) {
      s.before = labels.data.slice();
      s.path = [[x, y]];
      snapStroke(labels, base, s.path, brush, props.tol * 0.003, target);
    } else if (tool === 'brush') stamp(labels, x, y, brush, target);
    else s.pts = [[x, y]];
    paint();
  };
  const move = (e: RPointerEvent) => {
    const s = st.current;
    if (s.pan) {
      const p = s.pan;
      setView((v) => fix({ z: v.z, x: p.x + e.clientX - p.sx, y: p.y + e.clientY - p.sy }));
      return;
    }
    const [x, y] = at(e);
    s.hover = [x, y];
    const was = s.hoverShape;
    s.hoverShape = tool === 'shapes' ? shapeAt(x, y) : -1;
    if (s.hoverShape !== was) s.entered = [x, y];
    if (s.drawing) {
      if (tool === 'shapes') {
        // Dragging across shapes marks each one, once the cursor is properly inside it. Brushing a
        // neighbour's edge on the way past does not count.
        const deep = Math.hypot(x - s.entered[0], y - s.entered[1]) >= 6;
        if (shapes && deep && s.hoverShape !== s.lastShape) { fillShape(labels, shapes, x, y, target); s.lastShape = s.hoverShape; }
      } else if (tool === 'brush' && s.before) {
        // Redo the whole stroke from the saved marks each time, so the snapped edge follows the brush live.
        if (Math.hypot(x - s.lx, y - s.ly) < Math.max(1, brush / 4)) return paint();
        s.path.push([x, y]);
        labels.data.set(s.before);
        snapStroke(labels, base, s.path, brush, props.tol * 0.003, target);
      } else if (tool === 'brush') stampLine(labels, s.lx, s.ly, x, y, brush, target);
      else s.pts.push([x, y]);
      s.lx = x; s.ly = y;
    }
    paint();
  };
  const up = () => {
    const s = st.current;
    s.pan = null;
    if (!s.drawing) return;
    if (tool === 'lasso' && s.pts.length > 2) fillPolygon(labels, s.pts, target);
    s.drawing = false;
    s.pts = [];
    s.path = [];
    s.before = null;
    s.lastShape = -1;
    props.onChange();
    paint();
  };

  return (
    <div className="zoomwrap" ref={wrap}>
      <canvas
        ref={ref}
        className="mark-canvas"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}
        width={labels.w}
        height={labels.h}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={() => { st.current.hover = null; st.current.hoverShape = -1; paint(); }}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div className="zoombar">
        <button onClick={() => zoomBy(1 / 1.5)} disabled={view.z <= 1} title="Zoom out">−</button>
        <button onClick={() => setView({ z: 1, x: 0, y: 0 })} disabled={view.z <= 1} title="Show the whole picture">{Math.round(view.z * 100)}%</button>
        <button onClick={() => zoomBy(1.5)} disabled={view.z >= 8} title="Zoom in">+</button>
      </div>
    </div>
  );
}

// ---- The dialog ---------------------------------------------------------

const DEFAULTS = {
  colors: 10, smooth: 2, clean: 1, brightness: 0, contrast: 0, saturation: 0, lift: 0, tones: 3, outline: true, evenLight: true,
  /** Detail chosen for each area: 1-6 flat tones, or 0 for full detail. */
  areaTones: {} as Record<number, number>,
};
type Settings = typeof DEFAULTS;

const DETAIL_CHOICES: [number, string][] = [
  [1, '1 flat color'], [2, '2 tones'], [3, '3 tones'], [4, '4 tones'], [5, '5 tones'], [6, '6 tones'], [0, 'Full detail'],
];

/** Remembered across a refresh so an unfinished conversion reopens by itself. */
export const CONVERTING_KEY = 'crosspattern.converting';

/**
 * Converts a picture into a pattern. Everything done here is saved as it happens, so closing the dialog
 * or refreshing the page loses nothing. With `edit`, it reopens the conversion the current project was
 * made from and updates that project instead of making a new one.
 */
export function ImportDialog({ onClose, initialFile, edit }: { onClose: () => void; initialFile?: File | null; edit?: boolean }) {
  const key = edit ? S.projectId : DRAFT;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [step, setStep] = useState<'crop' | 'areas'>('crop');

  const [w, setW] = useState(80);
  const [h, setH] = useState(80);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, w: 1, h: 1 });
  const [fabric, setFabric] = useState(14);
  const [set, setSet] = useState<Settings>(DEFAULTS);
  const change = (patch: Partial<Settings>) => setSet((s) => ({ ...s, ...patch }));

  const [mode, setMode] = useState<Mode>('area');
  const [tool, setTool] = useState<MarkTool>('shapes');
  /** The area new marks are added to, or null to start a new one with the next mark. */
  const [current, setCurrent] = useState<number | null>(null);
  const [shapeSize, setShapeSize] = useState(5);
  const [brush, setBrush] = useState(16);
  const [tol, setTol] = useState(30);
  const [snap, setSnap] = useState(true);
  const blob = useRef<Blob | null>(null);
  const marks = useRef<{ labels: LabelMap; crop: Crop } | null>(null);
  const history = useRef<Uint8Array[]>([]);
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const out = useRef<HTMLCanvasElement>(null);

  const close = () => {
    try { sessionStorage.removeItem(CONVERTING_KEY); } catch { /* blocked */ }
    onClose();
  };

  const take = async (file?: Blob | null, fileName = '') => {
    if (!file) return;
    try {
      const im = await loadImage(file);
      const nh = clamp(Math.round((80 * im.naturalHeight) / im.naturalWidth), 1, MAX_SIZE);
      blob.current = file;
      setImg(im);
      setW(80);
      setH(nh);
      setCrop(cropForAspect(im, 80 / nh));
      setSet(DEFAULTS);
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

  // On opening: a dropped picture starts fresh; otherwise pick up the saved conversion, if there is one.
  useEffect(() => {
    try { sessionStorage.setItem(CONVERTING_KEY, edit ? 'edit' : 'new'); } catch { /* blocked */ }
    (async () => {
      if (initialFile) {
        await take(initialFile, initialFile.name);
      } else {
        try {
          const rec = await getConversion(key);
          if (rec) {
            const im = await loadImage(rec.photo);
            blob.current = rec.photo;
            marks.current = rec.labels && { labels: { w: rec.labels.w, h: rec.labels.h, data: rec.labels.data }, crop: rec.labels.crop };
            setImg(im);
            setName(rec.name);
            setW(rec.w);
            setH(rec.h);
            setCrop(rec.crop);
            setSet({ ...DEFAULTS, ...(rec.settings as Partial<Settings>) });
            setStep(rec.labels ? rec.step : 'crop');
          }
        } catch { /* nothing saved, or the library is unavailable */ }
      }
      setLoading(false);
    })();
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

  // Save the conversion shortly after anything changes, and straight away when the dialog goes.
  const record = (): ConversionRecord | null =>
    blob.current && {
      photo: blob.current, name, w, h, crop, step,
      labels: marks.current && { ...marks.current.labels, crop: marks.current.crop },
      settings: set, updatedAt: Date.now(),
    };
  const latest = useRef(record);
  latest.current = record;
  useEffect(() => {
    if (loading || !img) return;
    let pending = true;
    const save = () => {
      if (!pending) return;
      pending = false;
      const rec = latest.current();
      if (rec) putConversion(key, rec).catch(() => {});
    };
    const t = setTimeout(save, 400);
    return () => { clearTimeout(t); save(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, img, name, w, h, crop, step, version, set]);

  const startOver = () => {
    deleteConversion(key).catch(() => {});
    blob.current = null;
    marks.current = null;
    history.current = [];
    setImg(null);
  };

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
  const dShapeSize = useDeferredValue(shapeSize);
  const shapes = useMemo(() => (base && labels ? findShapes(base, labels.w, labels.h, dShapeSize) : null), [base, labels, dShapeSize]);
  const sampled = useMemo(
    () => (img && labels ? sampleImage(img, crop, w, h, labels) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [img, labels, version, w, h],
  );
  // Sliders stay responsive while the conversion catches up.
  const dSet = useDeferredValue(set);
  const result = useMemo(() => (sampled ? quantize(sampled, dSet) : null), [sampled, dSet]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const areas = useMemo(() => (labels ? areaIds(labels) : []), [labels, version]);
  const tonesOf = (id: number) => set.areaTones[id] ?? (id < CARTOON0 ? 1 : set.tones);
  // What the next mark paints: the chosen area (a fresh one if none is chosen), removal, or nothing.
  const target = !labels ? NONE : mode === 'remove' ? REMOVE : mode === 'erase' ? NONE : current ?? nextCartoonId(labels);
  const marked = () => {
    if (mode === 'area' && current === null) setCurrent(target);
    bump();
  };

  useEffect(() => {
    const c = out.current;
    if (!c || !result) return;
    c.width = result.width;
    c.height = result.height;
    c.getContext('2d')!.putImageData(resultToImageData(result), 0, 0);
  }, [result, step]);

  const edit_ = (fn: (m: LabelMap) => void) => {
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
  const removeArea = (id: number) => {
    edit_((m) => { for (let i = 0; i < m.data.length; i++) if (m.data[i] === id) m.data[i] = NONE; });
    if (current === id) setCurrent(null);
  };

  const create = async () => {
    if (!result) return;
    const pattern = {
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
    };
    if (edit) setPattern(pattern);
    else await openAsNewProject(pattern);
    // The conversion now belongs to the project it made, so it can be reopened and changed later.
    const rec = record();
    if (rec) putConversion(S.projectId, rec).catch(() => {});
    if (!edit) deleteConversion(DRAFT).catch(() => {});
    close();
  };

  const stitches = result ? result.cells.reduce((n, v) => n + (v ? 1 : 0), 0) : 0;
  const filePicker = (label: string, cls: string) => (
    <label className={cls}>
      {label}
      <input type="file" accept="image/*" hidden onChange={(e) => take(e.target.files?.[0], e.target.files?.[0]?.name)} />
    </label>
  );
  const adjusted = set.brightness || set.contrast || set.saturation || set.lift;

  return (
    <Modal title={edit ? 'Edit conversion' : 'Convert a picture'} onClose={close} size={img ? 'xl' : 'wide'}>
      {loading && <p className="hint loading">Loading…</p>}
      {!loading && !img && (
        <label
          className="drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); take(e.dataTransfer.files[0], e.dataTransfer.files[0]?.name); }}
        >
          <input type="file" accept="image/*" hidden onChange={(e) => take(e.target.files?.[0], e.target.files?.[0]?.name)} />
          <strong>Choose a picture</strong>
          <span>or drop one here, or paste from the clipboard</span>
          {edit && <span>The conversion for this project was not saved, so start from the picture again.</span>}
          {error && <span className="error">{error}</span>}
        </label>
      )}

      {img && (
        <ol className="steps">
          <li className={step === 'crop' ? 'on' : ''}><button onClick={() => setStep('crop')}>1. Crop and size</button></li>
          <li className={step === 'areas' ? 'on' : ''}><button disabled={!sizeOk} onClick={goAreas}>2. Areas and colors</button></li>
          <li className="saved">Saved as you go. Closing or refreshing keeps your work.</li>
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
              <div className="row">
                {filePicker('Choose a different picture', 'btn small')}
                {!edit && <button className="btn small danger" title="Throws away this conversion" onClick={startOver}>Start over</button>}
              </div>
            </div>
            <div className="stage">
              <CropBox img={img} crop={crop} aspect={sizeOk ? w / h : crop.w / crop.h} onChange={setCrop} />
            </div>
          </div>
          <footer>
            <button className="btn" onClick={close}>Close</button>
            <button className="btn primary" disabled={!sizeOk} onClick={goAreas}>Next: areas and colors</button>
          </footer>
        </>
      )}

      {img && step === 'areas' && labels && base && (
        <>
          <div className="areas">
            <div className="controls">
              <div className="block">
                <h3>1. What are you marking?</h3>
                <Segmented value={mode} set={setMode} options={[['area', 'An area'], ['remove', 'Remove'], ['erase', 'Unmark']]} />
                <p className="hint">{MODE_HELP[mode]}</p>
                {(areas.length > 0 || mode === 'area') && (
                  <ul className="arealist">
                    {areas.map((id, n) => {
                      const [r, g, b] = areaTint(id);
                      return (
                        <li key={id} className={mode === 'area' && current === id ? 'on' : ''} onClick={() => { setMode('area'); setCurrent(id); }}>
                          <span className="chip" style={{ background: `rgb(${r},${g},${b})` }} />
                          <span className="grow">Area {n + 1}</span>
                          <select
                            value={tonesOf(id)}
                            title="How much detail this area keeps"
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => change({ areaTones: { ...set.areaTones, [id]: Number(e.target.value) } })}
                          >
                            {DETAIL_CHOICES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                          </select>
                          <button className="btn ghost small" title="Unmark this area" onClick={(e) => { e.stopPropagation(); removeArea(id); }}>✕</button>
                        </li>
                      );
                    })}
                    <li className={'new' + (mode === 'area' && current === null ? ' on' : '')} onClick={() => { setMode('area'); setCurrent(null); }}>
                      <span className="chip plus">+</span>
                      <span className="grow">{areas.length ? 'New area' : 'Your first area: mark it on the photo'}</span>
                    </li>
                  </ul>
                )}
              </div>
              <div className="block">
                <h3>2. Mark it on the photo</h3>
                <Segmented value={tool} set={setTool} options={[['shapes', 'Shapes'], ['brush', 'Brush'], ['lasso', 'Lasso']]} />
                {tool === 'shapes' && (
                  <Slider label="Shape size" value={shapeSize} min={1} max={10} set={setShapeSize}
                    hint="Click a shape on the photo, or drag across several. Smaller shapes follow finer edges." />
                )}
                {tool === 'brush' && <Slider label="Brush size" value={brush} min={2} max={60} set={setBrush} />}
                {tool === 'brush' && (
                  <label className="check" title="The mark spreads to the edges of what you paint on, and pulls back from what you overshoot">
                    <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} /> Snap to edges
                  </label>
                )}
                {tool === 'brush' && snap && (
                  <Slider label="Edge sensitivity" value={tol} min={2} max={100} set={setTol}
                    hint="Lower stops at fainter edges; higher spreads further." />
                )}
                {tool === 'lasso' && <p className="hint">Draw around something; everything inside is marked.</p>}
                <div className="row">
                  <button className="btn small" disabled={!history.current.length} onClick={undoMark}>Undo</button>
                  <button className="btn small" onClick={() => { edit_((m) => m.data.fill(NONE)); setCurrent(null); }}>Clear all</button>
                  {mode !== 'erase' && (
                    <button
                      className="btn small"
                      title="Applies this to everything you have not marked yet"
                      onClick={() => { edit_((m) => fillUnmarked(m, target)); marked(); }}
                    >
                      {mode === 'remove' ? 'Remove the rest' : 'Add the rest'}
                    </button>
                  )}
                </div>
              </div>
              <div className="block">
                <h3>3. Colors and simplifying</h3>
                <Slider label={areas.length ? 'Colors for unmarked parts' : 'Colors'} value={set.colors} min={2} max={40} set={(n) => change({ colors: n })}
                  hint={result ? `${result.palette.length} colors in the pattern` : undefined} />
                <Slider label="Flatten unmarked parts" value={set.smooth} min={0} max={4} set={(n) => change({ smooth: n })} />
                <Slider label="Remove stray stitches" value={set.clean} min={0} max={3} set={(n) => change({ clean: n })} />
                {areas.length > 0 && (
                  <>
                    <label className="check">
                      <input type="checkbox" checked={set.outline} onChange={(e) => change({ outline: e.target.checked })} /> Dark outline around each area
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={set.evenLight} onChange={(e) => change({ evenLight: e.target.checked })} /> Brighten areas that are in shadow
                    </label>
                  </>
                )}
                <details className="adjust">
                  <summary>Adjust the photo{adjusted ? ' (changed)' : ''}</summary>
                  <Slider label="Lift shadows" value={set.lift} min={0} max={100} set={(n) => change({ lift: n })}
                    hint="Brightens dark parts and brings their color back." />
                  <Slider label="Brightness" value={set.brightness} min={-100} max={100} set={(n) => change({ brightness: n })} />
                  <Slider label="Contrast" value={set.contrast} min={-100} max={100} set={(n) => change({ contrast: n })} />
                  <Slider label="Color strength" value={set.saturation} min={-100} max={100} set={(n) => change({ saturation: n })} />
                  <button className="btn small" onClick={() => change({ lift: 0, brightness: 0, contrast: 0, saturation: 0 })}>Reset</button>
                </details>
              </div>
            </div>
            <figure>
              <div className="fit" style={fitStyle(labels.w / labels.h, 56)}>
                <MarkCanvas
                  base={base} labels={labels} shapes={shapes} target={target} tool={tool} brush={brush} tol={tol} snap={snap}
                  version={version} onBefore={pushHistory} onChange={marked}
                />
              </div>
              <figcaption>Photo: mark things here. Pinch or ⌘/Ctrl-scroll to zoom, scroll or Alt-drag to move.</figcaption>
            </figure>
            <figure>
              <div className="fit" style={{ ...fitStyle(w / h, 56), background: FABRIC }}>
                <canvas ref={out} className="pixelated" />
              </div>
              <figcaption>Pattern: {w} × {h}, {stitches.toLocaleString()} stitches</figcaption>
            </figure>
          </div>
          <footer>
            <span className="hint grow">
              {edit ? 'Replaces this project\'s pattern, including edits made since. Undo brings it back.' : 'Opens as a new project. Your current one stays in Projects.'}
            </span>
            <button className="btn" onClick={() => setStep('crop')}>Back</button>
            <button className="btn primary" disabled={!result?.palette.length} onClick={create}>{edit ? 'Update pattern' : 'Create pattern'}</button>
          </footer>
        </>
      )}
    </Modal>
  );
}
