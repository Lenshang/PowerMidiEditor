import { useEffect, useState } from 'react';
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
  const ctrlPressed = useStore((s) => s.ctrlPressed);

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
    // Alt is the horizontal-scroll modifier: if its keydown/keyup reach the
    // host window unconsumed, Windows enters menu mode and the next Space
    // becomes Alt+Space (system menu) instead of Play. Swallow both phases.
    const swallowAlt = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', swallowAlt, true);
    window.addEventListener('keyup', swallowAlt, true);
    // Focus probe: a bare Ctrl/Cmd keydown that reaches the page means the
    // plugin has focus — pulse the window so the user learns to check for
    // the flash before hitting Ctrl+Z (a missed flash = focus is in the DAW).
    const ctrlProbe = (e: KeyboardEvent) => {
      if (e.key !== 'Control' && e.key !== 'Meta') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === 'keydown') useStore.getState().setCtrlPressed(true);
      else if (e.type === 'keyup') useStore.getState().setCtrlPressed(false);
      if (useStore.getState().settingsCapture) return;
    };
    window.addEventListener('keydown', ctrlProbe, true);
    window.addEventListener('keyup', ctrlProbe, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', swallowAlt, true);
      window.removeEventListener('keyup', swallowAlt, true);
      window.removeEventListener('keydown', ctrlProbe, true);
    };
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
      <div className={ctrlPressed ? 'ctrl-chip on' : 'ctrl-chip'} aria-hidden="true">CTRL</div>

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
