// MidiBrowserModal: addFolder/removeFolder listen for the browserFolders
// push instead of assuming synchronous results; removeFolder updates
// locally (no round trip needed); picking a folder auto-selects it.
import fs from 'node:fs';

const p = new URL('../frontend/src/ui/MidiBrowserModal.tsx', import.meta.url);
let s = fs.readFileSync(p, 'utf8');

// 1) one-shot browserFolders listener + auto-select first folder
const anchor = '  const addFolder = () => {';
if (!s.includes(anchor)) { console.error('addFolder missing'); process.exit(1); }
s = s.replace(anchor, `  const listenFoldersOnce = (cb: (folders: string[]) => void) => {
    const off = getBridge().onEvent((ev: unknown) => {
      const e = ev as { kind?: string; browserFolders?: string[] };
      if (e.kind !== 'browserFolders' || !e.browserFolders) return;
      off();
      setFolders(e.browserFolders);
      cb(e.browserFolders);
    });
  };

  const applyFolders = (folders: string[]) => {
    setFolders(folders);
    setActiveFolder((cur) => (folders.includes(cur) ? cur : folders[0] ?? ''));
    if (folders[0]) refreshFiles(folders[0]);
  };

  const addFolder = () => {`);

// 2) addFolder click: listen then invoke
const oldAdd = `            <div className="browser-folders-head">
              {t('browser.folders')}
              <button className="mini-btn" title={t('browser.addFolder')} onClick={addFolder}>+</button>
            </div>`;
// the click binding is inside addFolder? no — addFolder is invoked from the + button below. Find it:
console.log('phase 1 done (partial)');
fs.writeFileSync(p, s);
