import { useStore } from '../state/store';
import { t } from '../i18n';
import { barPpqOf, positionString } from '../pianoroll/ViewMap';

export function StatusBar(): React.ReactElement {
  const transport = useStore((s) => s.transport);
  const editCursor = useStore((s) => s.editCursorPpq);
  const doc = useStore((s) => s.doc);
  const mode = useStore((s) => s.mode);
  const hint = useStore((s) => s.statusHint);
  const selection = useStore((s) => s.selection);
  const view = useStore((s) => s.view);
  const recordArmed = useStore((s) => s.recordArmed);

  const shownPpq = transport.playing && transport.ppqValid ? transport.ppq : editCursor;
  const posStr = positionString(shownPpq, barPpqOf(transport.sigNum, transport.sigDen));

  return (
    <div className="statusbar">
      <span className={`sb-pos ${transport.playing ? 'playing' : ''}`}>
        {transport.playing ? '▶ ' : ''}{recordArmed ? '● ' : ''}{posStr}
      </span>
      <span className="sb-sep" />
      <span>{transport.tempo.toFixed(1)} BPM · {transport.sigNum}/{transport.sigDen}</span>
      <span className="sb-sep" />
      <span className="sb-mono" title="{t('sb.monitorTitle')}">
        {t('lane.pb')} {transport.lastPb >= 0 ? transport.lastPb : '—'}
        {transport.lastCcNumber >= 0 ? ` · CC${transport.lastCcNumber} ${transport.lastCcValue}` : ''}
      </span>
      <span className="sb-sep" />
      <span>{(doc.notes ?? []).length} {t('sb.note')}{selection.length > 0 ? ` · t('sb.notesSelected', { count: selection.length })` : ''}</span>
      <span className="sb-sep" />
      {recordArmed && <span className="sb-rec">● {t('sb.recordArmed')}</span>}
      {hint && <span className="sb-hint">{hint}</span>}
      <span className="sb-spring" />
      <span className={`sb-mode ${mode === 'mock' ? 'mock' : ''}`}>
        {mode === 'mock' ? ('MOCK ' + t('sb.backend')) : t('sb.pluginBackend')}
      </span>
    </div>
  );
}
