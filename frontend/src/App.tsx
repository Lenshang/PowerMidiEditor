import { useEffect } from 'react';
import { getBridge } from './bridge/bridge';
import { PianoRoll } from './pianoroll/PianoRoll';
import { runAction, zoomFit } from './state/dispatch';
import { bindingFromKeyboard, findAction, resolveShortcuts } from './state/shortcuts';
import { useStore } from './state/store';
import { t } from './i18n';
import { DevHUD } from './ui/DevHUD';
import { ExpressionPanel } from './ui/ExpressionPanel';
import { LanePanel } from './ui/LanePanel';
import { SettingsPanel } from './ui/SettingsPanel';
import { StatusBar } from './ui/StatusBar';
import { Toolbar } from './ui/Toolbar';
import { invalidateThemeCache } from './ui/themes';

export default function App(): React.ReactElement {
  const theme = useStore((s) => s.settings.theme);
  const lang = useStore((s) => s.settings.lang);
  const ready = useStore((s) => s.ready);
  const initError = useStore((s) => s.initError);

  // init bridge + event pump
  useEffect(() => {
    useStore.getState().init().then(() => {
      zoomFit(); // open with the content nicely framed
    }).catch(() => {});
  }, []);

  // theme -> document attribute (CSS custom properties + canvas cache)
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    invalidateThemeCache();
  }, [theme]);

  // t() reads the store non-reactively; a language switch re-renders the whole
  // tree so every t() call resolves in the new language. Canvas repaints are
  // driven by their own effects (theme, doc) plus this remount.
  const treeKey = `lang-${lang}`;

  // global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState();
      if (st.settingsCapture) return; // capture mode owns the keyboard
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      const b = bindingFromKeyboard(e);
      const id = findAction(resolveShortcuts(st.settings.shortcuts), b);
      if (id) {
        e.preventDefault();
        runAction(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // surface async/uncaught errors in the status bar instead of dying silently
  useEffect(() => {
    const show = (msg: string) => {
      console.error(msg);
      useStore.getState().setHint(t('app.uiError', { msg }));
    };
    const onRejection = (e: PromiseRejectionEvent) => show(String(e.reason));
    const onError = (e: ErrorEvent) => show(e.message);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);

  return (
    <div className={`app ${ready ? 'ready' : 'loading'}`} key={treeKey}>
      <Toolbar />
      {ready ? (
        <>
          <PianoRoll />
          <LanePanel />
        </>
      ) : (
        <div className="app-loading">
          {initError
            ? <span className="app-error">{t('app.connectFailed', { err: initError })}</span>
            : t('app.connecting')}
        </div>
      )}
      <StatusBar />
      <SettingsPanel />
      <ExpressionPanel />
      <DevHUD />
    </div>
  );
}
