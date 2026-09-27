// Expression map editor (Phase 3): named articulations with keyswitch and/or
// CC output; notes carry an articulation tag and the engine injects the
// keyswitch/CC on articulation changes. Import/export as JSON.
import { useEffect, useState } from 'react';
import { getBridge } from '../bridge/bridge';
import type { EditOp } from '../bridge/protocol';
import { useStore } from '../state/store';
import { t } from '../i18n';

export function ExpressionPanel(): React.ReactElement | null {
  const open = useStore((s) => s.expressionOpen);
  const setOpen = useStore((s) => s.setExpressionOpen);
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const activeArt = useStore((s) => s.activeArticulation);
  const setActiveArt = useStore((s) => s.setActiveArticulation);
  const setHint = useStore((s) => s.setHint);
  const editDoc = useStore((s) => s.editDoc);
  const [rows, setRows] = useState<Array<{ id: number; n: string; ks: number; cc: number; v: number }>>([]);

  useEffect(() => {
    if (open) setRows(doc.articulations.map((a) => ({ ...a })));
  }, [open, doc.articulations]);

  if (!open) return null;

  const save = (rowsToSave = rows) => {
    void getBridge().invoke('map.set', { articulations: rowsToSave }).then(() => {
      setHint(t('exp.saved'));
    }).catch(() => setHint(t('exp.saveFailed')));
  };

  const updateRow = (id: number, patch: Partial<{ id: number; n: string; ks: number; cc: number; v: number }>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    const id = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
    const presetNames = [t('exp.sustain'), t('exp.legato'), t('exp.staccato'), t('exp.tremolo'), t('exp.pizzicato')];
    setRows((rs) => [...rs, { id, n: presetNames[(rs.length) % presetNames.length], ks: Math.min(127, 24 + rs.length), cc: -1, v: 0 }]);
  };

  const applyToSelection = (artId: number) => {
    if (selection.length === 0) { setHint(t('exp.selectNotesFirst')); return; }
    const ops: EditOp[] = selection.map((id) => ({ op: 'update', note: { id, a: artId } }));
    editDoc(ops, t('exp.apply'));
    setHint(t('exp.appliedTo', { count: selection.length }));
  };

  const importMap = () => {
    void getBridge().invoke('map.import').then(() => {
      setTimeout(() => setRows(useStore.getState().doc.articulations.map((a) => ({ ...a }))), 500);
    }).catch(() => {});
  };

  return (
    <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) { save(); setOpen(false); } }}>
      <div className="modal">
        <div className="modal-head">
          <div className="modal-tabs"><button className="active">{t('exp.title')}</button></div>
          <button className="tb-btn" onClick={() => { save(); setOpen(false); }} title={t('exp.saveClose')}>✕</button>
        </div>
        <div className="modal-body">
          <p className="settings-note">
            {t('exp.docNote')}
            {t('exp.docTail')}
          </p>
          <table className="shortcut-table">
            <thead>
              <tr>
                <td style={{ width: '32%' }}>{t('exp.name')}</td>
                <td>Keyswitch {t('exp.ksHint')}</td>
                <td>CC {t('exp.ksHint')}</td>
                <td>CC {t('exp.value')}</td>
                <td></td>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input className="lane-cc-input art-name" value={r.n}
                      onChange={(e) => updateRow(r.id, { n: e.target.value })} />
                  </td>
                  <td><input className="lane-cc-input" type="number" min={-1} max={127} value={r.ks}
                    onChange={(e) => updateRow(r.id, { ks: Math.min(127, Math.max(-1, Number(e.target.value) || 0)) })} /></td>
                  <td><input className="lane-cc-input" type="number" min={-1} max={127} value={r.cc}
                    onChange={(e) => updateRow(r.id, { cc: Math.min(127, Math.max(-1, Number(e.target.value) || 0)) })} /></td>
                  <td><input className="lane-cc-input" type="number" min={0} max={127} value={r.v}
                    onChange={(e) => updateRow(r.id, { v: Math.min(127, Math.max(0, Number(e.target.value) || 0)) })} /></td>
                  <td className="sc-actions">
                    <button className="mini-btn" title={t('exp.applyToSelection')} onClick={() => applyToSelection(r.id)}>{t('exp.apply')}</button>
                    <button className="mini-btn" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>{t('exp.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="modal-foot">
            <button className="mini-btn" onClick={addRow}>+ {t('exp.add')}</button>
            <button className="mini-btn" onClick={() => { setActiveArt(rows[0]?.id ?? null); setHint(rows.length > 0 ? t('exp.setDefault') : t('exp.addFirst')); }}>
              {t('exp.setDefault')}
            </button>
            <span className="foot-spring" />
            <button className="mini-btn" onClick={() => { save(); void getBridge().invoke('map.export').catch(() => {}); }}>{t('exp.exportJson')}</button>
            <button className="mini-btn" onClick={importMap}>{t('exp.importJson')}</button>
            <button className="mini-btn primary" onClick={() => { save(); setOpen(false); }}>{t('exp.done')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
