import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import { t, LANGS } from '../i18n';
import {
  ACTIONS, bindingFromKeyboard, bindingFromWheel, bindingToText, findConflicts,
  resolveShortcuts, type Binding,
} from '../state/shortcuts';
import { THEMES } from './themes';

export function SettingsPanel(): React.ReactElement | null {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const capture = useStore((s) => s.settingsCapture);
  const setCapture = useStore((s) => s.setCaptureAction);
  const setHint = useStore((s) => s.setHint);
  const [tab, setTab] = useState<'shortcuts' | 'edit' | 'theme'>('shortcuts');

  // capture the next key / wheel gesture while in capture mode
  useEffect(() => {
    if (!capture) return;
    const assign = (b: Binding) => {
      const map = resolveShortcuts(settings.shortcuts);
      const conflicts = findConflicts(map, b, capture);
      const next: Record<string, unknown> = { ...settings.shortcuts };
      next[capture] = b;
      for (const c of conflicts) next[c] = { type: 'none' };
      updateSettings({ shortcuts: next });
        setHint(conflicts.length > 0 ? t('set.boundConflicts', { count: conflicts.length }) : t('set.bound'));
      setCapture(null);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { setCapture(null); return; }
      assign(bindingFromKeyboard(e));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      assign(bindingFromWheel(e));
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, [capture, settings.shortcuts, updateSettings, setCapture, setHint]);

  if (!open) return null;

  const user = (settings.shortcuts ?? {}) as Record<string, unknown>;
  const resolved = resolveShortcuts(user);
  // groups are i18n KEYS: ACTIONS carry the same keys in their `group` field,
  // and the heading renders the translation.
  const groups = ['set.group.tool', 'set.group.view', 'set.group.edit', 'set.group.grid', 'set.group.transport'] as const;

  const resetOne = (id: string) => {
    const next = { ...user };
    delete next[id];
    updateSettings({ shortcuts: next });
  };
  const resetAll = () => updateSettings({ shortcuts: {} });

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="modal">
        <div className="modal-head">
          <div className="modal-tabs">
            <button className={tab === 'shortcuts' ? 'active' : ''} onClick={() => setTab('shortcuts')}>{t('set.shortcuts')}</button>
            <button className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>{t('set.edit')}</button>
            <button className={tab === 'theme' ? 'active' : ''} onClick={() => setTab('theme')}>{t('set.theme')}</button>
          </div>
          <button className="tb-btn" onClick={() => setOpen(false)} title={t('set.close')}>✕</button>
        </div>

        {tab === 'shortcuts' && (
          <div className="modal-body">
            <p className="settings-note">
              {t('set.captureNote')}
              
            </p>
            {capture && (
              <div className="capture-banner">
                {t('set.capturingFor', { action: ACTIONS.find((a) => a.id === capture) ? t(ACTIONS.find((a) => a.id === capture)!.label) : '' })}
              </div>
            )}
            {groups.map((g) => (
              <div key={g} className="shortcut-group">
                <h3>{t(g)}</h3>
                <table className="shortcut-table">
                  <tbody>
                    {ACTIONS.filter((a) => a.group === g).map((a) => (
                      <tr key={a.id} className={capture === a.id ? 'capturing' : ''}>
                        <td className="sc-label">{t(a.label)}</td>
                        <td className="sc-binding">{bindingToText(resolved[a.id])}</td>
                        <td className="sc-actions">
                          <button
                            className={`mini-btn ${capture === a.id ? 'capturing' : ''}`}
                            onClick={() => setCapture(capture === a.id ? null : a.id)}
                          >
                            {capture === a.id ? t('set.waiting') : t('set.capture')}
                          </button>
                          {user[a.id] !== undefined && (
                            <button className="mini-btn" title="{t('set.resetOne')}" onClick={() => resetOne(a.id)}>↺</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            <div className="modal-foot">
              <button className="mini-btn" onClick={resetAll}>{t('set.resetAll')}</button>
              <span className="foot-spring" />
              <button className="mini-btn primary" onClick={() => setOpen(false)}>{t('set.done')}</button>
            </div>
          </div>
        )}

        {tab === 'edit' && (
          <div className="modal-body">
            <div className="settings-row">
              <span className="settings-label">{t('set.language')}</span>
              <select
                className="tb-select"
                value={settings.lang ?? 'en'}
                onChange={(e) => updateSettings({ lang: e.target.value })}
              >
                {LANGS.map((l) => (
                  <option key={l.id} value={l.id}>{l.label}</option>
                ))}
              </select>
            </div>
            <div className="settings-row">
              <span className="settings-label">{t('set.snapBypass')}</span>
              <select
                className="tb-select"
                value={settings.snapBypass ?? 'shift'}
                onChange={(e) => updateSettings({ snapBypass: e.target.value })}
              >
                <option value="shift">Shift</option>
                <option value="alt">Alt</option>
                <option value="ctrl">Ctrl</option>
                <option value="none">{t('set.none')}</option>
              </select>
            </div>
            <p className="settings-note">
              {t('set.snapBypassNote')}
            </p>
            <div className="settings-row">
              <span className="settings-label">{t('set.dupModifier')}</span>
              <select
                className="tb-select"
                value={settings.dupModifier ?? 'alt'}
                onChange={(e) => updateSettings({ dupModifier: e.target.value })}
              >
                <option value="alt">Alt</option>
                <option value="ctrl">Ctrl</option>
                <option value="shift">Shift</option>
                <option value="none">{t('set.none')}</option>
              </select>
            </div>
            <p className="settings-note">
              {t('set.dupModifierNote')}
            </p>
            <div className="settings-row">
              <span className="settings-label">{t('set.autoChords')}</span>
              <button className={`mini-btn ${settings.browserAutoChords ? 'on' : ''}`}
                title={t('set.autoChordsNote')}
                onClick={() => updateSettings({ browserAutoChords: !settings.browserAutoChords })}>
                {settings.browserAutoChords ? t('set.on') : t('set.off')}
              </button>
            </div>
            <p className="settings-note">
              {t('set.autoChordsNote')}
            </p>
            <div className="settings-row">
              <span className="settings-label">{t('set.chordSync')}</span>
              <button className={`mini-btn ${settings.chordSync !== false ? 'on' : ''}`}
                title={t('set.chordSyncNote')}
                onClick={() => updateSettings({ chordSync: settings.chordSync === false })}>
                {settings.chordSync !== false ? t('set.on') : t('set.off')}
              </button>
            </div>
            <p className="settings-note">
              {t('set.chordSyncNote')}
            </p>
          </div>
        )}

        {tab === 'theme' && (
          <div className="modal-body">
            <div className="theme-grid">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`theme-card ${settings.theme === t.id ? 'active' : ''}`}
                  data-theme-preview={t.id}
                  onClick={() => updateSettings({ theme: t.id })}
                >
                  <span className="theme-swatch" data-theme-preview={t.id} />
                  <span>{t.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
