// MIDI Library modal: folders on the left, files of the SELECTED folder on
// the right (recursive, so kit subfolders are included). Search + sort,
// lazily-probed note/bar columns, keyboard navigation, drag a row straight
// out to the host — and a preview player below the list: piano-roll thumbnail
// with a live progress cursor, play/pause/stop and a project-vs-file tempo
// switch (the cursor is in ppq, so the speed can change mid-preview).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getBridge } from '../bridge/bridge';
import { useStore } from '../state/store';
import { t } from '../i18n';

interface FileRow {
  name: string;
  rel: string;
  folder: string;
  path: string;
  size: number;
  mtime: number;
}

interface ProbeInfo {
  ok: boolean;
  notes: number;
  bars: number;
}

interface ThumbNote { p: number; s: number; l: number; }

interface Thumb {
  notes: ThumbNote[];
  len: number;      // ppq
  fileBpm: number;
}

type SortKey = 'name' | 'size' | 'date';

const PROBE_CHUNK = 50;

export function MidiBrowserModal({ onClose }: { onClose: () => void }) {
  const [folders, setFolders] = useState<string[]>([]);
  const [activeFolder, setActiveFolder] = useState<string>('');
  const [files, setFiles] = useState<FileRow[]>([]);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('name');
  const [info, setInfo] = useState<Record<string, ProbeInfo>>({});
  const [previewPath, setPreviewPath] = useState('');
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [paused, setPaused] = useState(false);
  const [useFileTempo, setUseFileTempo] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadBusy, setLoadBusy] = useState<string | null>(null);
  const dragArmed = useRef<{ path: string; x: number; y: number; armed: boolean } | null>(null);
  const infoCache = useRef<Record<string, ProbeInfo>>({});
  const foldersRef = useRef<string[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const posRef = useRef(0);

  const refreshFolders = async (): Promise<string[]> => {
    try {
      const r = await getBridge().invoke<string[]>('browser.folders');
      const fs = (r as unknown as string[]) ?? [];
      foldersRef.current = fs;
      setFolders(fs);
      return fs;
    } catch {
      return foldersRef.current;
    }
  };

  // Probe note/bar info in chunks (each invoke stays fast, even on network
  // drives); results are cached per absolute path.
  const probeFiles = async (paths: string[], cancelled: () => boolean) => {
    const pending = paths.filter((p) => !(p in infoCache.current));
    for (let i = 0; i < pending.length; i += PROBE_CHUNK) {
      const chunk = pending.slice(i, i + PROBE_CHUNK);
      try {
        const res = await getBridge().invoke<{ info: Array<{ path: string } & ProbeInfo> }>(
          'browser.probe', { paths: chunk });
        for (const e of res?.info ?? [])
          infoCache.current[e.path] = { ok: e.ok, notes: e.notes, bars: e.bars };
        if (!cancelled()) setInfo({ ...infoCache.current });
      } catch {
        return;  // bridge trouble: leave the columns blank instead of retrying
      }
      if (cancelled()) return;
    }
  };

  // On open: restore folders + the last selected folder from prefs.
  useEffect(() => {
    void (async () => {
      const fs = await refreshFolders();
      let last = '';
      try {
        const r = await getBridge().invoke<{ path?: string }>('browser.lastFolder');
        last = (r as { path?: string })?.path ?? '';
      } catch { /* prefs unavailable: fall through to first folder */ }
      setActiveFolder((cur) => (cur ? cur : fs.includes(last) ? last : fs[0] ?? ''));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the library stops any running preview so notes don't keep
  // sounding after the window is gone.
  useEffect(() => () => {
    void getBridge().invoke('browser.stopPreview').catch(() => {});
  }, []);

  // Live preview state: the backend pushes {active, paused, pos} at 30 Hz
  // while a preview runs. Position lands in a ref + direct canvas redraw so
  // the cursor stays smooth without re-rendering the whole modal.
  const thumbRef = useRef<Thumb | null>(null);
  const drawThumb = useCallback(() => {
    const cv = canvasRef.current;
    const th = thumbRef.current;
    if (! cv || ! th || th.len <= 0) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d');
    if (! g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const css = getComputedStyle(cv);
    const accent = css.getPropertyValue('--accent').trim() || '#8a7bff';
    const dim = css.getPropertyValue('--text-faint').trim() || '#888';

    let lo = 127, hi = 0;
    for (const n of th.notes) { lo = Math.min(lo, n.p); hi = Math.max(hi, n.p); }
    if (lo > hi) { lo = 60; hi = 72; }
    const span = Math.max(12, hi - lo + 1);
    const rowH = h / span;
    const x = (ppq: number) => (ppq / th.len) * w;

    g.fillStyle = 'rgba(128,128,128,0.12)';
    for (let bar = 0; bar <= th.len / 4; ++bar) {
      const bx = Math.round(x(bar * 4)) + 0.5;
      g.fillRect(bx, 0, 1, h);
    }
    g.fillStyle = accent;
    for (const n of th.notes) {
      const y = (hi - n.p) * rowH;
      g.fillRect(x(n.s), y + 0.5, Math.max(1.5, x(n.l)), Math.max(1, rowH - 1));
    }
    // progress: dim the played region + bright cursor
    const px = (posRef.current / th.len) * w;
    g.fillStyle = 'rgba(128,128,128,0.25)';
    g.fillRect(0, 0, px, h);
    g.fillStyle = dim;
    g.fillRect(Math.min(w - 2, Math.max(0, px)), 0, 2, h);
  }, []);
  useEffect(() => { thumbRef.current = thumb; drawThumb(); }, [thumb, drawThumb]);

  useEffect(() => {
    // Wire format: push() nests the payload under a property named by the
    // kind: { kind: 'preview', preview: { active, paused, pos } }.
    const off = getBridge().onEvent((ev: unknown) => {
      const e = ev as { kind?: string;
        preview?: { active: boolean; paused: boolean; pos: number };
        browserLoaded?: { ok: boolean; path: string } };
      if (e.kind === 'browserLoaded') {
        setLoadBusy(null);
        if (e.browserLoaded?.ok) useStore.getState().setHint(t('browser.loaded'));
        return;
      }
      if (e.kind !== 'preview' || ! e.preview) return;
      const p = e.preview;
      if (! p.active) { setPaused(false); return; }   // final push on stop
      setPaused(!! p.paused);
      posRef.current = p.pos ?? 0;
      drawThumb();
    });
    return off;
  }, [drawThumb]);

  // On folder switch (or refresh): list that folder only, then probe lazily.
  // A spinner overlay covers the list while the scan runs (big network
  // folders take a while); the previous rows stay visible underneath.
  useEffect(() => {
    if (!activeFolder) { setFiles([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void getBridge().invoke<{ files: FileRow[] }>('browser.listFiles', { folder: activeFolder }, { timeoutMs: 20000 }).then((r) => {
      if (cancelled) return;
      const rows = ((r as { files?: FileRow[] })?.files ?? []);
      setFiles(rows);
      setCursor(0);
      setLoading(false);
      void getBridge().invoke('browser.setLastFolder', { path: activeFolder }).catch(() => {});
      void probeFiles(rows.map((f) => f.path), () => cancelled);
    }).catch(() => { if (!cancelled) { setFiles([]); setLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFolder, refreshKey]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (f: FileRow) =>
      !q || f.name.toLowerCase().includes(q) || f.rel.toLowerCase().includes(q);
    const cmp: Record<SortKey, (a: FileRow, b: FileRow) => number> = {
      name: (a, b) => a.name.localeCompare(b.name) || a.rel.localeCompare(b.rel),
      size: (a, b) => b.size - a.size,
      date: (a, b) => b.mtime - a.mtime,
    };
    return files.filter(match).sort(cmp[sortBy]);
  }, [files, query, sortBy]);

  const preview = (path: string) => {
    setPreviewPath(path);
    setPaused(false);
    posRef.current = 0;
    void getBridge().invoke<{ ok: boolean; fileBpm: number; len: number; notes: ThumbNote[] }>(
      'browser.preview', { path, useFileTempo }).then((r) => {
      if (r?.ok && (r.notes?.length ?? 0) > 0) setThumb({ notes: r.notes, len: r.len, fileBpm: r.fileBpm });
      else setThumb(null);
    }).catch(() => setThumb(null));
  };

  const stopPreview = () => {
    void getBridge().invoke('browser.stopPreview').then(() => {
      setPreviewPath('');
      setThumb(null);
      setPaused(false);
      posRef.current = 0;
    }).catch(() => {});
  };

  const togglePause = () => {
    const next = !paused;
    setPaused(next);
    void getBridge().invoke('browser.previewControl', { action: next ? 'pause' : 'resume' })
      .catch(() => setPaused(!next));
  };

  const switchTempo = (file: boolean) => {
    setUseFileTempo(file);
    void getBridge().invoke('browser.setPreviewTempoMode', { useFileTempo: file }).catch(() => {});
  };

  // Load starts the background job (no double-click — accidental loads were
  // too easy) and returns immediately; completion arrives via the
  // 'browserLoaded' push, with a safety timeout if the push is lost.
  const load = (path: string) => {
    if (loadBusy) return;
    setLoadBusy(path);
    void getBridge().invoke('browser.load', { path }).catch(() => setLoadBusy(null));
    window.setTimeout(() => setLoadBusy((cur) => (cur === path ? null : cur)), 30000);
  };

  const rowAt = (i: number) => shown[Math.min(i, shown.length - 1)];

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (shown.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.min(shown.length - 1, Math.max(0, c + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === ' ') {
      e.preventDefault();
      const f = rowAt(cursor);
      if (f) preview(f.path);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const f = rowAt(cursor);
      if (f) load(f.path);
    }
  };

  const armDrag = (e: React.PointerEvent, path: string) => {
    if (e.button !== 0) return;
    dragArmed.current = { path, x: e.clientX, y: e.clientY, armed: false };
  };
  const maybeDrag = (e: React.PointerEvent) => {
    const d = dragArmed.current;
    if (!d || d.armed) return;
    // OLE drag must start with the button held; arm after 5px of movement
    if (Math.abs(e.clientX - d.x) > 5 || Math.abs(e.clientY - d.y) > 5) {
      d.armed = true;
      void getBridge().invoke('browser.dragFile', { path: d.path }).catch(() => {});
    }
  };
  const disarm = () => { dragArmed.current = null; };

  // The directory chooser completes asynchronously: listen once for the
  // browserFolders push, refresh and select the newly added folder.
  const addFolder = () => {
    const before = new Set(foldersRef.current);
    const off = getBridge().onEvent((ev: unknown) => {
      const e = ev as { kind?: string; browserFolders?: string[] };
      if (e.kind !== 'browserFolders' || !e.browserFolders) return;
      off();
      foldersRef.current = e.browserFolders;
      setFolders(e.browserFolders);
      const added = e.browserFolders.find((f) => !before.has(f));
      setActiveFolder(added ?? e.browserFolders[0] ?? '');
    });
    void getBridge().invoke('browser.addFolder').catch(() => off());
  };

  const removeFolder = (folder: string) => {
    const rest = folders.filter((x) => x !== folder);
    foldersRef.current = rest;
    setFolders(rest);
    void getBridge().invoke('browser.removeFolder', { path: folder }).catch(() => {});
    if (activeFolder === folder) {
      setActiveFolder(rest[0] ?? '');
      if (rest[0] === undefined)
        void getBridge().invoke('browser.setLastFolder', { path: '' }).catch(() => {});
    }
  };

  const fmtBars = (bars: number) => (bars >= 1 ? String(Math.round(bars)) : bars > 0 ? '<1' : '');
  const bpmLabel = useFileTempo && thumb ? `${Math.round(thumb.fileBpm)} BPM` : '';

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal browser-modal">
        {loadBusy && (
          <div className="browser-loading">
            <div className="browser-spinner" />
            <span>{t('browser.loadingFile')}</span>
          </div>
        )}
        <div className="modal-head">
          <strong>{t('browser.title')}</strong>
          <span className="foot-spring" />
          <button className="tb-btn" onClick={onClose} title={t('set.close')}>✕</button>
        </div>
        <div className="browser-main">
          <div className="browser-folders">
            <div className="browser-folders-head">
              {t('browser.folders')}
              <button className="mini-btn" title={t('browser.addFolder')} onClick={addFolder}>+</button>
            </div>
            {folders.length === 0 && <div className="browser-empty">{t('browser.noFolders')}</div>}
            {folders.map((f) => (
              <div key={f} className={`browser-folder ${f === activeFolder ? 'sel' : ''}`}>
                <button className="browser-folder-btn" onClick={() => setActiveFolder(f)}
                  title={f}>{f.split(/[\\/]/).filter(Boolean).pop()}</button>
                <button className="browser-folder-del" title={t('browser.removeFolderBtn')}
                  onClick={() => removeFolder(f)}>✕</button>
              </div>
            ))}
          </div>
          <div className="browser-files-pane">
            <div className="browser-tools">
              <input className="browser-search" type="text" value={query} spellCheck={false}
                placeholder={t('browser.search')}
                onChange={(e) => { setQuery(e.target.value); setCursor(0); }} />
              <select className="browser-sort" value={sortBy} title={t('browser.sort')}
                onChange={(e) => setSortBy(e.target.value as SortKey)}>
                <option value="name">{t('browser.sortName')}</option>
                <option value="size">{t('browser.sortSize')}</option>
                <option value="date">{t('browser.sortDate')}</option>
              </select>
              <button className="mini-btn browser-refresh" title={t('browser.refresh')}
                onClick={() => { infoCache.current = {}; setInfo({}); setRefreshKey((k) => k + 1); }}>⟳</button>
            </div>
            <div className="browser-files-wrap">
              <div className="browser-files" tabIndex={0} onKeyDown={onKeyDown}>
                {activeFolder && files.length === 0 && !loading && <div className="browser-empty">{t('browser.noFiles')}</div>}
                {files.length > 0 && shown.length === 0 && <div className="browser-empty">{t('browser.noMatch')}</div>}
                {shown.map((f, i) => {
                  const pi = info[f.path];
                  return (
                    <div key={f.path}
                      className={`browser-file ${previewPath === f.path ? 'previewing' : ''} ${i === cursor ? 'cursor' : ''}`}
                      onClick={(e) => { setCursor(i); if ((e as unknown as { detail: number }).detail < 2) preview(f.path); }}
                      onPointerDown={(e) => armDrag(e, f.path)}
                      onPointerMove={(e) => maybeDrag(e)}
                      onPointerUp={disarm}
                      title={f.rel ? `${f.rel}\n${t('browser.rowHint')}` : t('browser.rowHint')}>
                      <span className="browser-file-icon">♪</span>
                      <span className="browser-file-name">
                        {f.name}
                        {f.rel && f.rel !== f.name && <span className="browser-file-rel">{f.rel.slice(0, -f.name.length - 1)}</span>}
                      </span>
                      <span className="browser-file-meta">
                        {pi && pi.ok && <span title={t('browser.colNotes')}>{pi.notes}♪</span>}
                        {pi && pi.ok && pi.bars > 0 && <span title={t('browser.colBars')}>{fmtBars(pi.bars)} bars</span>}
                        <span>{Math.max(1, Math.round(f.size / 1024))} KB</span>
                      </span>
                      <button className="mini-btn browser-file-load"
                        disabled={loadBusy !== null}
                        title={t('browser.loadBtn')}
                        onClick={(e) => { e.stopPropagation(); load(f.path); }}>
                        {t('browser.loadBtn')}
                      </button>
                    </div>
                  );
                })}
              </div>
              {loading && (
                <div className="browser-loading">
                  <div className="browser-spinner" />
                  <span>{t('browser.loading')}</span>
                </div>
              )}
            </div>
            {thumb && (
              <div className="browser-player">
                <canvas ref={canvasRef} className="browser-thumb" />
                <div className="browser-transport">
                  <button className="mini-btn" onClick={togglePause}
                    title={paused ? t('browser.play') : t('browser.pause')}>
                    {paused ? '▶' : '⏸'}
                  </button>
                  <button className="mini-btn" onClick={stopPreview} title={t('browser.stop')}>⏹</button>
                  <span className="foot-spring" />
                  <span className="browser-bpm">{bpmLabel}</span>
                  <span className="browser-tempo-seg" title={t('browser.tempoTitle')}>
                    <button className={`mini-btn ${!useFileTempo ? 'on' : ''}`}
                      onClick={() => switchTempo(false)}>{t('browser.tempoProject')}</button>
                    <button className={`mini-btn ${useFileTempo ? 'on' : ''}`}
                      onClick={() => switchTempo(true)}>{t('browser.tempoFile')}</button>
                  </span>
                </div>
              </div>
            )}
            <div className="browser-count">
              {files.length > 0 ? t('browser.fileCount', { n: shown.length }) : ''}
            </div>
          </div>
        </div>
        <div className="browser-foot">
          <span className="browser-hint">{t('browser.hint')}</span>
          <span className="foot-spring" />
          {previewPath && !thumb && (
            <button className="mini-btn" onClick={stopPreview}>{t('browser.stop')}</button>
          )}
        </div>
      </div>
    </div>
  );
}
