// MIDI Browser modal: browse registered folders, preview (single click),
// load (double click), drag a file straight out to the host.
import { useEffect, useRef, useState } from 'react';
import { getBridge } from '../bridge/bridge';
import { useStore } from '../state/store';
import { t } from '../i18n';

interface FileRow {
  name: string;
  folder: string;
  path: string;
  size: number;
}

export function MidiBrowserModal({ onClose }: { onClose: () => void }) {
  const [folders, setFolders] = useState<string[]>([]);
  const [activeFolder, setActiveFolder] = useState<string>('');
  const [files, setFiles] = useState<FileRow[]>([]);
  const [previewPath, setPreviewPath] = useState<string>('');
  const dragArmed = useRef<{ path: string; x: number; y: number; armed: boolean } | null>(null);

  const refreshFolders = () =>
    getBridge().invoke<string[]>('browser.folders').then((r: unknown) => {
      const folders = (r as unknown as string[]) ?? [];
      setFolders(folders);
      setActiveFolder((cur) => (folders.includes(cur) ? cur : folders[0] ?? ''));
    }).catch(() => {});

  const refreshFiles = (folder: string) => {
    if (!folder) { setFiles([]); return; }
    void getBridge().invoke<{ files: FileRow[] }>('browser.listFiles', { folder }).then((r) => {
      setFiles(((r as { files?: FileRow[] })?.files ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)));
    }).catch(() => setFiles([]));
  };

  useEffect(() => {
    void refreshFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeFolder) refreshFiles(activeFolder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFolder]);

  const preview = (path: string) => {
    setPreviewPath(path);
    void getBridge().invoke('browser.preview', { path }).catch(() => {});
  };

  const load = (path: string) => {
    void getBridge().invoke('browser.load', { path }).then(() => {
      setPreviewPath('');
      useStore.getState().setHint(t('browser.loaded'));
    }).catch(() => {});
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

  const addFolder = () => {
    void getBridge().invoke('browser.addFolder').then(() => refreshFolders()).catch(() => {});
  };
  const removeFolder = (folder: string) => {
    void getBridge().invoke('browser.removeFolder', { path: folder }).then(() => refreshFolders()).catch(() => {});
  };

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal browser-modal">
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
          <div className="browser-files">
            {files.length === 0 && <div className="browser-empty">{t('browser.noFiles')}</div>}
            {files.map((f) => (
              <div key={f.path}
                className={`browser-file ${previewPath === f.path ? 'previewing' : ''}`}
                onClick={(e) => { if ((e as unknown as { detail: number }).detail >= 2) { load(f.path); } else preview(f.path); }}
                onDoubleClick={() => load(f.path)}
                onPointerDown={(e) => armDrag(e, f.path)}
                onPointerMove={(e) => maybeDrag(e)}
                onPointerUp={disarm}
                title={t('browser.rowHint')}>
                <span className="browser-file-icon">♪</span>
                <span className="browser-file-name">{f.name}</span>
                <span className="browser-file-size">{Math.max(1, Math.round(f.size / 1024))} KB</span>
              </div>
            ))}
          </div>
        </div>
        <div className="browser-foot">
          <span className="browser-hint">{t('browser.hint')}</span>
          <span className="foot-spring" />
          {previewPath && (
            <button className="mini-btn" onClick={() => {
              void getBridge().invoke('browser.stopPreview').then(() => setPreviewPath('')).catch(() => {});
            }}>{t('browser.stop')}</button>
          )}
        </div>
      </div>
    </div>
  );
}
