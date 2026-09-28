import { useState, useEffect } from 'react';
import { getBridge } from '../bridge/bridge';
import type { EditOp } from '../bridge/protocol';
import { runAction } from '../state/dispatch';
import { resolveShortcuts } from '../state/shortcuts';
import { useStore, type ToolId } from '../state/store';
import { t } from '../i18n';
import { CHORD_QUALITIES, NOTE_NAMES } from '../pianoroll/render';
import {
  IconAudition, IconEraser, IconGear, IconLogo, IconMagnet, IconPencil,
  IconRange, IconRazor, IconRedo, IconSelect, IconSpray, IconStep, IconUndo,
} from './icons';

const TOOLS: Array<{ id: ToolId; icon: React.FC; label: string; num: string }> = [
  { id: 'select', icon: IconSelect, label: 'tb.tool.select', num: '1' },
  { id: 'range', icon: IconRange, label: 'tb.tool.range', num: '2' },
  { id: 'pencil', icon: IconPencil, label: 'tb.tool.pencil', num: '3' },
  { id: 'spray', icon: IconSpray, label: 'tb.tool.spray', num: '4' },
  { id: 'razor', icon: IconRazor, label: 'tb.tool.razor', num: '5' },
  { id: 'eraser', icon: IconEraser, label: 'tb.tool.eraser', num: '6' },
  { id: 'audition', icon: IconAudition, label: 'tb.tool.audition', num: '7' },
  { id: 'step', icon: IconStep, label: 'tb.tool.step', num: '8' },
];

const GRID_OPTIONS: Array<{ label: string; v: number }> = [
  { label: '1/1', v: 4 }, { label: '1/2', v: 2 }, { label: '1/4', v: 1 },
  { label: '1/8', v: 0.5 }, { label: '1/16', v: 0.25 }, { label: '1/32', v: 0.125 },
  { label: '1/64', v: 0.0625 },
];

export function Toolbar(): React.ReactElement {
  const activeTool = useStore((s) => s.activeTool);
  const setTool = useStore((s) => s.setTool);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const openSettings = useStore((s) => s.setSettingsOpen);
  const openExpression = useStore((s) => s.setExpressionOpen);
  const setHint = useStore((s) => s.setHint);
  const doc = useStore((s) => s.doc);
  const chordSelection = useStore((s) => s.chordSelection);
  const recordArmed = useStore((s) => s.recordArmed);
  const setRecordArmed = useStore((s) => s.setRecordArmed);
  const followPlayhead = useStore((s) => s.followPlayhead);
  const setFollow = useStore((s) => s.setFollow);
  const drumMode = useStore((s) => s.drumMode);
  const toggleDrumMode = useStore((s) => s.toggleDrumMode);
  const internalPlaying = useStore((s) => s.transport.internalPlaying);
  const activeArticulation = useStore((s) => s.activeArticulation);
  const selection = useStore((s) => s.selection);
  const editCursorPpq = useStore((s) => s.editCursorPpq);
  const chordAssist = useStore((s) => s.chordAssist);
  const drumMap = useStore((s) => s.drumMap);
  const drumMapName = useStore((s) => s.drumMap.name);
  const drumModeActive = useStore((s) => s.drumMode);
  const [drumMapEditorOpen, setDrumMapEditorOpen] = useState(false);
  const [drumModalName, setDrumModalName] = useState('Custom');
  const [drumDraft, setDrumDraft] = useState<Array<{ i: number; o: number; c: number; name: string }>>([]);
  // while the editor is open, keep the draft in sync with the store — the
  // import file chooser completes asynchronously and lands via a drummap push
  useEffect(() => {
    if (!drumMapEditorOpen) return;
    const entries = useStore.getState().drumMap.entries ?? [];
    if (entries.length > 0) setDrumDraft(entries.map((e) => ({ ...e })));
  }, [drumMapEditorOpen, drumMap]);

  const noteOpts = Array.from({ length: 128 }, (_, n) => ({ n, label: `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1} (${n})` }));
  const chOpts = [{ c: 0, label: 'ALL' }, ...Array.from({ length: 16 }, (_, k) => ({ c: k + 1, label: String(k + 1) }))];
  const chLabel = (c: number) => (c === 0 ? 'ALL' : String(c));

  const openDrumMapEditor = () => {
    const entries = useStore.getState().drumMap.entries ?? [];
    setDrumDraft(entries.length > 0 ? entries.map((e) => ({ ...e })) : [{ i: 36, o: 36, c: 0, name: '' }]);
    setDrumMapEditorOpen(true);
  };
  const applyDrumDraft = () => {
    const clean = drumDraft
      .filter((r) => r.name.trim() !== '' && Number.isFinite(r.i) && r.i >= 0 && r.i <= 127)
      .map((r) => ({ i: Math.round(r.i), o: Math.round(r.o), c: Math.round(r.c), name: r.name.trim() }));
    const st = useStore.getState();
    st.editDoc === undefined; // noop guard
    void getBridge().invoke('drummap.set', { name: drumModalName || 'Custom', entries: clean }).then(() => {
      setHint(`鼓组映射已应用（${clean.length} 条）`);
    }).catch(() => setHint('映射应用失败'));
    setDrumMapEditorOpen(false);
  };
  const toggleChordAssist = useStore((s) => s.toggleChordAssist);
  const updateChord = (patch: { r?: number; q?: number }) => {
    const st = useStore.getState();
    const ops = st.chordSelection.map((id) => ({ op: 'updateManyChords' as const, chords: [{ id, ...patch }] }));
    // merge into a single op per chord id
    const merged = Object.values(ops.reduce((acc, op) => {
      const chord = op.chords[0];
      acc[chord.id] = acc[chord.id] ?? { op: 'updateManyChords' as const, chords: [] as Array<{ id: number; r?: number; q?: number }> };
      acc[chord.id].chords.push(chord);
      return acc;
    }, {} as Record<number, { op: 'updateManyChords'; chords: Array<{ id: number; r?: number; q?: number }> }>));
    st.editDoc(merged, t('disp.transposeChord'));
  };

  const shortcutText = (id: string) => {
    const b = resolveShortcuts(settings.shortcuts)[id];
    if (!b || b.type !== 'key') return '';
    const mods = [b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift'].filter(Boolean).join('+');
    return mods ? `${mods}+${b.code}` : b.code;
  };

  return (
    <div className="toolbar">
      <div className="toolbar-brand" title="PowerMidiEditor">
        <IconLogo size={17} />
        <span>PowerMIDI</span>
      </div>

      <div className="toolbar-sep" />

      <div className="toolbar-tools">
        {TOOLS.map((tool) => {
          const Icon = tool.icon;
          const active = activeTool === tool.id;
          return (
            <button
              key={tool.id}
              className={`tb-btn tool-btn ${active ? 'active' : ''}`}
              title={`${t(tool.label)}（${tool.num}）`}
              onClick={() => setTool(tool.id)}
            >
              <Icon />
              <span className="tool-num">{tool.num}</span>
            </button>
          );
        })}
      </div>

      <div className="toolbar-sep" />

      <button
        className={`tb-btn ${settings.snap ? 'active' : ''}`}
        title={t('tb.snap')}
        onClick={() => updateSettings({ snap: !settings.snap })}
      >
        <IconMagnet />
      </button>

      <select
        className="tb-select"
        value={String(settings.gridPpq)}
        title={t('tb.gridPrecision')}
        onChange={(e) => updateSettings({ gridPpq: Number(e.target.value) })}
      >
        {GRID_OPTIONS.map((o) => (
          <option key={o.v} value={String(o.v)}>{o.label}</option>
        ))}
      </select>

      <button
        className={`tb-btn ${settings.triplet ? 'active' : ''}`}
        title={t('tb.tripletTitle')}
        onClick={() => updateSettings({ triplet: !settings.triplet })}
      >
        <span className="tb-text">{t('tb.triplet')}</span>
      </button>

      <select
        className="tb-select"
        value={settings.lengthQuantize}
        title={t('tb.lengthTitle')}
        onChange={(e) => updateSettings({ lengthQuantize: e.target.value })}
      >
        <option value="off">{t('tb.lengthOff')}</option>
        <option value="grid">{t('tb.lengthGrid')}</option>
      </select>

      <div className="toolbar-sep" />

      <button className="tb-btn" disabled={!canUndo} title={t('tb.undo')} onClick={() => undo()}>
        <IconUndo />
      </button>
      <button className="tb-btn" disabled={!canRedo} title={t('tb.redo')} onClick={() => redo()}>
        <IconRedo />
      </button>

      <div className="toolbar-sep" />

      <button className="tb-btn" title={t('tb.quantizeTitle')} onClick={() => runAction('edit.quantize')}>
        <span className="tb-text">{t('tb.quantize')}</span>
      </button>
      <button className="tb-btn" title={t('tb.quantizeLengthTitle')} onClick={() => runAction('edit.quantizeLength')}>
        <span className="tb-text">{t('tb.quantizeLength')}</span>
      </button>
      <button className="tb-btn" title={t('tb.humanizeTitle')} onClick={() => runAction('edit.humanize')}>
        <span className="tb-text">{t('tb.humanize')}</span>
      </button>
      <button className="tb-btn" title={t('tb.legatoTitle')} onClick={() => runAction('edit.legato')}>
        <span className="tb-text">{t('tb.legato')}</span>
      </button>

      <div className="toolbar-sep" />

      <button
        className={`tb-btn play-btn ${internalPlaying ? 'active' : ''}`}
        title={internalPlaying ? t('tb.stopTitle') : t('tb.playTitle')}
        onClick={() => {
          const st = useStore.getState();
          if (st.transport.internalPlaying)
            void getBridge().invoke('transport.stop').catch(() => {});
          else
            void getBridge().invoke('transport.play', { ppq: st.editCursorPpq }).catch(() => {});
        }}
      >
        <span className="tb-text">{internalPlaying ? '■' : '▶'}</span>
      </button>

      <button
        className={`tb-btn record-btn ${recordArmed ? 'recording' : ''}`}
        title={t('tb.record')}
        onClick={() => setRecordArmed(!recordArmed)}
      >
        <span className="rec-dot" />
      </button>
      <button className={`tb-btn ${followPlayhead ? 'active' : ''}`} title={t('tb.followTitle')} onClick={() => setFollow(!followPlayhead)}>
        <span className="tb-text">{t('tb.follow')}</span>
      </button>
      <button className={`tb-btn ${drumMode ? 'active' : ''}`} title={t('tb.drumTitle')} onClick={toggleDrumMode}>
        <span className="tb-text">{t('tb.drum')}</span>
      </button>
      {drumModeActive && (
        <button className="tb-btn" title="鼓组映射编辑器：自定义各键位名称，支持 .bwdrm / .drm 导入导出"
          onClick={openDrumMapEditor}>
          <span className="tb-text">{t('tb.drumMap')}</span>
        </button>
      )}
      <button className={`tb-btn ${chordAssist ? 'active' : ''}`} title={t('tb.chordAssistTitle')} onClick={toggleChordAssist}>
        <span className="tb-text">{t('tb.chordAssist')}</span>
      </button>
      <button className="tb-btn" title={t('tb.abTitle')} onClick={() => {
        void getBridge().invoke<{ active: string }>('ab.toggle').then((r) => setHint(t('tb.switchedSnapshot', { slot: r.active }))).catch(() => {});
      }}>
        <span className="tb-text">{t('tb.ab')}</span>
      </button>

      {/* hard wrap point: row 1 = tools/grid/edit ops, row 2 = everything else */}
      <div className="toolbar-break" />

      {chordSelection.length > 0 && (
        <>
          <select
            className="tb-select"
            title={t('tb.chordRoot')}
            value={String(doc.chords?.find((c) => c.id === chordSelection[0])?.r ?? 0)}
            onChange={(e) => updateChord({ r: Number(e.target.value) })}
          >
            {NOTE_NAMES.map((n, i) => (
              <option key={n} value={String(i)}>{n}</option>
            ))}
          </select>
          <select
            className="tb-select"
            title={t('tb.chordQuality')}
            value={String(doc.chords?.find((c) => c.id === chordSelection[0])?.q ?? 0)}
            onChange={(e) => updateChord({ q: Number(e.target.value) })}
          >
            {CHORD_QUALITIES.map((q, i) => (
              <option key={q.label} value={String(i)}>{q.label}</option>
            ))}
          </select>
          <button className="tb-btn" title={t('tb.arpeggioTitle')} onClick={() => {
            const st = useStore.getState();
            const chord = st.doc.chords.find((c) => c.id === st.chordSelection[0]);
            if (!chord) { setHint(t('tb.selectChordFirst')); return; }
            const q = CHORD_QUALITIES[chord.q] ?? CHORD_QUALITIES[0];
            const step = settings.triplet ? settings.gridPpq * (2 / 3) : settings.gridPpq;
            const ops = [];
            let i = 0;
            for (let t = chord.s; t < chord.s + chord.l - 1e-9; t += step, i++) {
              const pitch = 60 + chord.r + q.intervals[i % q.intervals.length] + 12 * Math.floor(i / q.intervals.length);
              ops.push({ op: 'add' as const, note: { p: Math.min(127, pitch), s: +t.toFixed(6), l: step, v: 0.8, m: false, c: 1, a: -1 } });
            }
            st.editDoc(ops, t('tb.arpeggio'));
            setHint(t('tb.arpeggioDone', { chord: NOTE_NAMES[chord.r] + (CHORD_QUALITIES[chord.q] ?? CHORD_QUALITIES[0]).label, count: ops.length }));
          }}>
            <span className="tb-text">{t('tb.arpeggio')}</span>
          </button>
          <div className="toolbar-sep" />
        </>
      )}

      {(doc.articulations ?? []).length > 0 && (() => {
        // display follows the selection: uniform articulation → that one; all
        // untagged → none; mixed or empty selection → the new-note default
        const selNotes = doc.notes.filter((n) => selection.includes(n.id));
        const selArts = selNotes.map((n) => n.a);
        const uniform = selNotes.length > 0 && selArts.every((a) => a === selArts[0]);
        const shownValue = selNotes.length > 0 && uniform
          ? String(selArts[0])
          : String(activeArticulation ?? -1);
        return (
          <select
            className="tb-select"
            title={t('tb.pickArticulation')}
            value={shownValue}
            onChange={(e) => {
              const v = Number(e.target.value);
              const st = useStore.getState();
              st.setActiveArticulation(v >= 0 ? v : null);
              (e.target as HTMLSelectElement).blur(); // Space must reach the roll, not reopen this dropdown
              // with a selection, the switch retags the selected notes too
              if (st.selection.length > 0) {
                const ops: EditOp[] = st.selection.map((id) => ({ op: 'update', note: { id, a: v >= 0 ? v : -1 } }));
                st.editDoc(ops, t('exp.apply'));
                setHint(t('exp.appliedTo', { count: st.selection.length }));
              }
            }}
          >
            {!doc.articulations.some((a) => String(a.id) === shownValue) && shownValue !== '-1' && (
              <option value={shownValue}>#{shownValue}</option>
            )}
            <option value="-1">{t('tb.noArticulation')}</option>
            {doc.articulations.map((a) => (
              <option key={a.id} value={String(a.id)}>{a.n}</option>
            ))}
          </select>
        );
      })()}

      <button
        className="tb-btn"
        title={t('tb.autoQuantizeTitle')}
        onClick={() => setHint(t('tb.autoQuantizeHint'))}
      >
        <span className={`tb-text ${settings.autoQuantizeInput ? 'accent' : ''}`}>{t('tb.autoQuantize')}</span>
      </button>

      <div className="toolbar-sep" />

      <button className="tb-btn" title={t('tb.exportTitle')} onClick={() => {
        void getBridge().invoke('file.exportMidi', { name: 'PowerMidiEditor' }).catch(() => {});
      }}>
        <span className="tb-text">{t('tb.export')}</span>
      </button>
      <button className="tb-btn" title={t('tb.importTitle')} onClick={() => {
        void getBridge().invoke('file.importMidi').catch(() => {});
      }}>
        <span className="tb-text">{t('tb.import')}</span>
      </button>
      {/* OLE drag must start while the mouse button is still held (DoDragDrop
          cancels immediately otherwise), so trigger on pointerdown, not click. */}
      <button className="tb-btn" title={t('tb.dragOutTitle')}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          void getBridge().invoke('file.dragMidiOut').catch(() => {});
        }}>
        <span className="tb-text">{t('tb.dragOut')}</span>
      </button>
      <button className="tb-btn" title={t('tb.saveTitle')} onClick={() => {
        void getBridge().invoke('file.saveProject').catch(() => {});
      }}>
        <span className="tb-text">{t('tb.save')}</span>
      </button>
      <button className="tb-btn" title={t('tb.openTitle')} onClick={() => {
        void getBridge().invoke('file.openProject').catch(() => {});
      }}>
        <span className="tb-text">{t('tb.open')}</span>
      </button>

      <div className="toolbar-sep" />

      <button className="tb-btn" title={t('tb.expressionTitle')} onClick={() => openExpression(true)}>
        <span className="tb-text">{t('tb.expression')}</span>
      </button>
      <div className="toolbar-sep" />

      <button className="tb-btn" title={t('tb.settingsTitle')} onClick={() => openSettings(true)}>
        <IconGear />
      </button>
      {drumMapEditorOpen && (
        <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) setDrumMapEditorOpen(false); }}>
          <div className="modal drummap-modal">
            <div className="modal-head">
              <strong>{t('tb.drumMapEditor')}</strong>
              <span className="foot-spring" />
              <div className="dm-badges">
                <div className="dm-badge">
                  <span className="dm-badge-num">{drumDraft.length}</span>
                  <span className="dm-badge-cap">RULES</span>
                </div>
                <div className="dm-badge">
                  <span className="dm-badge-cap">UNMATCHED</span>
                  <span className="dm-badge-cap">pass through</span>
                </div>
              </div>
              <button className="tb-btn" onClick={() => setDrumMapEditorOpen(false)} title={t('set.close')}>✕</button>
            </div>
            <div className="modal-body dm-table-wrap">
              <table className="dm-table">
                <thead>
                  <tr>
                    <th>NAME</th>
                    <th>SOURCE NOTE</th>
                    <th>SRC CH</th>
                    <th>TARGET NOTE</th>
                    <th>TGT CH</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {drumDraft.map((r, i) => (
                    <tr key={i}>
                      <td><input className="dm-name" value={r.name}
                        onChange={(e) => setDrumDraft((d) => d.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></td>
                      <td>
                        <select className="dm-select" value={String(r.i)}
                          onChange={(e) => setDrumDraft((d) => d.map((x, j) => j === i ? { ...x, i: Number(e.target.value) } : x))}>
                          {noteOpts.map((o) => <option key={o.n} value={String(o.n)}>{o.label}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="dm-select dm-ch" value={String(r.c)}
                          onChange={(e) => setDrumDraft((d) => d.map((x, j) => j === i ? { ...x, c: Number(e.target.value) } : x))}>
                          {chOpts.map((o) => <option key={o.c} value={String(o.c)}>{o.label}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="dm-select" value={String(r.o)}
                          onChange={(e) => setDrumDraft((d) => d.map((x, j) => j === i ? { ...x, o: Number(e.target.value) } : x))}>
                          {noteOpts.map((o) => <option key={o.n} value={String(o.n)}>{o.label}</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="dm-select dm-ch" value={String(r.c)}
                          onChange={(e) => setDrumDraft((d) => d.map((x, j) => j === i ? { ...x, c: Number(e.target.value) } : x))}>
                          {chOpts.map((o) => <option key={o.c} value={String(o.c)}>{o.label}</option>)}
                        </select>
                      </td>
                      <td className="dm-del">
                        <button className="mini-btn" onClick={() => setDrumDraft((d) => d.filter((_, j) => j !== i))}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="dm-foot">
              <button className="dm-foot-btn" onClick={() => {
                const off = getBridge().onEvent((ev: unknown) => {
                  const e = ev as { kind?: string; drummapDraft?: { name: string; entries: Array<{ i: number; o: number; c: number; name: string }> } };
                  if (e.kind !== 'drummapDraft' || !e.drummapDraft) return;
                  off();
                  setDrumDraft(e.drummapDraft.entries.map((x) => ({ ...x })));
                  setDrumModalName(e.drummapDraft.name || 'Custom');
                  setHint(`已导入: ${e.drummapDraft.name}（确认后生效）`);
                });
                void getBridge().invoke('drummap.load').catch(() => off());
              }}>Import…</button>
              <button className="dm-foot-btn" onClick={() => {
                void getBridge().invoke('drummap.export', {
                  name: drumModalName || 'Custom',
                  entries: drumDraft.filter((r) => r.name.trim() !== ''),
                }).then(() => setHint('已导出 .bwdrm')).catch(() => setHint('导出失败'));
              }}>Export…</button>
              <span className="dm-count">{drumDraft.length} rules</span>
              <span className="foot-spring" />
              <button className="dm-foot-btn" onClick={() => {
                setDrumDraft([{ i: 36, o: 36, c: 0, name: '' }]);
                setDrumModalName('Custom');
              }}>Clear</button>
              <button className="dm-add" onClick={() => setDrumDraft((d) => [...d, { i: 36, o: 36, c: 0, name: '' }])}>
                + Add
              </button>
              <span className="foot-spring" />
              <button className="dm-foot-btn" onClick={() => setDrumMapEditorOpen(false)}>取消</button>
              <button className="dm-add" onClick={() => { applyDrumDraft(); setDrumMapEditorOpen(false); }}>完成</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}