import qrcode from 'qrcode-generator';
import { useEffect, useRef, useState } from 'react';
import { Modal } from './dialogs';
import { renderExport } from './render';
import { Shared, mergeProgress, projectLink, unpackProject } from './share';
import { S, commitFloating, hasProject, receiveProject } from './store';
import { openStitch } from './stitch';

/** Draws a QR code for `text`, or returns false if it is too long for one. */
function drawQR(canvas: HTMLCanvasElement, text: string): boolean {
  let qr: ReturnType<typeof qrcode>;
  try {
    qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
  } catch {
    return false;
  }
  const n = qr.getModuleCount(), quiet = 4, cell = Math.max(2, Math.floor(400 / (n + quiet * 2)));
  canvas.width = canvas.height = (n + quiet * 2) * cell;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
  return true;
}

export function SendDialog({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [qrOk, setQrOk] = useState(true);
  const [copied, setCopied] = useState(false);
  const qr = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    commitFloating();
    projectLink(S.projectId, S.pattern).then(setLink, () => setError('This browser cannot make links. Use Save to send a project file instead.'));
  }, []);
  useEffect(() => { if (link && qr.current) setQrOk(drawQR(qr.current, link)); }, [link]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2500); }
    catch { setError('Copying was blocked by the browser. Select the link below and copy it yourself.'); }
  };
  const share = () => navigator.share?.({ title: S.pattern.name, text: `${S.pattern.name} — CrossPattern`, url: link }).catch(() => {});

  return (
    <Modal title="Send to another device" onClose={onClose}>
      <div className="send">
        {!link && !error && <p className="hint">Making the link…</p>}
        {link && (
          <>
            <canvas ref={qr} className="qr" hidden={!qrOk} aria-label="QR code for the link" />
            <p className="hint">
              {qrOk
                ? 'Point your phone\'s camera at the code and open the link it finds. Or copy the link and send it to yourself.'
                : 'This pattern is too big to fit in a QR code. Copy the link or share it, and open it on the other device.'}
            </p>
            <div className="row">
              <button className="btn primary" onClick={copy}>{copied ? 'Copied ✓' : 'Copy link'}</button>
              {'share' in navigator && <button className="btn" onClick={share}>Share…</button>}
            </div>
            <input className="link" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="The link" />
            <p className="hint small">
              The project, with its progress, travels inside the link itself; nothing is uploaded anywhere. The guide
              photo stays on this device. Opening the link on a device that already has this project updates it, and
              keeps stitches ticked on either one. To bring progress back, send it from the other device the same way.
            </p>
          </>
        )}
        {error && <p className="error">{error}</p>}
      </div>
      <footer>
        <button className="btn" onClick={onClose}>Close</button>
      </footer>
    </Modal>
  );
}

/** Shown when the site is opened from a link made by Send to another device. */
export function ReceiveDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const [shared, setShared] = useState<Shared | null>(null);
  const [exists, setExists] = useState(false);
  const [error, setError] = useState('');
  const [stitch, setStitch] = useState(S.touch);
  const [busy, setBusy] = useState(false);
  const thumb = useRef<HTMLDivElement>(null);

  useEffect(() => {
    unpackProject(text).then(async (s) => {
      setShared(s);
      setExists(s.id ? await hasProject(s.id) : false);
    }, (e: Error) => setError(e.message));
  }, [text]);
  useEffect(() => {
    if (!shared || !thumb.current) return;
    const p = shared.pattern;
    const c = renderExport(p, { cell: Math.max(1, Math.floor(220 / Math.max(p.width, p.height))), symbols: false, grid: false, legend: false });
    thumb.current.replaceChildren(c);
  }, [shared]);

  const take = async (asCopy: boolean) => {
    if (!shared) return;
    setBusy(true);
    await receiveProject(shared.id, shared.pattern, mergeProgress, asCopy);
    onClose();
    if (stitch) openStitch();
  };

  const p = shared?.pattern;
  const total = p ? p.cells.reduce((a, v) => a + (v ? 1 : 0), 0) : 0;
  const done = p?.done ? p.done.reduce((a: number, v) => a + v, 0) : 0;

  return (
    <Modal title="Project from another device" onClose={onClose}>
      <div className="send">
        {!shared && !error && <p className="hint">Opening the link…</p>}
        {error && <p className="error">{error}</p>}
        {shared && p && (
          <>
            <div className="received">
              <div className="thumb" ref={thumb} />
              <div>
                <b>{p.name}</b>
                <p className="hint">{p.width} × {p.height} · {total.toLocaleString()} stitches · {total ? Math.floor((done / total) * 100) : 0}% stitched</p>
              </div>
            </div>
            <p className="hint">
              {exists
                ? 'You already have this project here. Updating it brings in the pattern from the link, and keeps every stitch ticked on either device.'
                : 'It will be added to your projects in this browser.'}
            </p>
            <label className="check">
              <input type="checkbox" checked={stitch} onChange={(e) => setStitch(e.target.checked)} /> Go straight to stitching
            </label>
          </>
        )}
      </div>
      <footer>
        <button className="btn" onClick={onClose}>Cancel</button>
        {shared && exists && <button className="btn" disabled={busy} onClick={() => take(true)}>Keep both</button>}
        {shared && (
          <button className="btn primary" disabled={busy} onClick={() => take(false)}>{exists ? 'Update my copy' : 'Open it'}</button>
        )}
      </footer>
    </Modal>
  );
}
