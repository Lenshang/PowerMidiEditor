// Executes shortcut actions against the store. Zooming/scrolling from
// keyboard anchors at the viewport center; wheel zoom anchors at the mouse
// (handled in PianoRoll).
import { getBridge } from '../bridge/bridge';
import { gridStepPpq, snapPpq, useStore } from './store';
import { t } from '../i18n';
import { copySelected, hasClipboard, pasteOpsAt } from './clipboard';
import { chordPcsAt } from '../pianoroll/render';
import type { EditOp } from '../bridge/protocol';

const HZOOM = 1.25;
const VZOOM = 1.2;

export function runAction(id: string): void {
  const s = useStore.getState();
  const { view, settings } = s;

  switch (id) {
    // --- tools --------------------------------------------------------------
    case 'tool.select': s.setTool('select'); break;
    case 'tool.range': s.setTool('range'); s.setHint(t('hint.range')); break;
    case 'tool.pencil': s.setTool('pencil'); s.setHint(t('hint.pencil')); break;
    case 'tool.spray': s.setTool('spray'); s.setHint(t('hint.spray')); break;
    case 'tool.razor': s.setTool('razor'); s.setHint(t('hint.razor')); break;
    case 'tool.eraser': s.setTool('eraser'); s.setHint(t('hint.eraser')); break;
    case 'tool.audition': s.setTool('audition'); s.setHint(t('hint.audition')); break;
    case 'tool.step': s.setTool('step'); s.setHint(t('hint.step')); break;

    // --- view -----------------------------------------------------------------
    case 'view.zoomHIn': {
      const cx = view.scrollXPpq + view.width / 2 / view.pxPerPpq;
      const px = Math.min(200, view.pxPerPpq * HZOOM);
      s.setView({ pxPerPpq: px, scrollXPpq: cx - view.width / 2 / px });
      break;
    }
    case 'view.zoomHOut': {
      const cx = view.scrollXPpq + view.width / 2 / view.pxPerPpq;
      const px = Math.max(0.02, view.pxPerPpq / HZOOM);
      s.setView({ pxPerPpq: px, scrollXPpq: cx - view.width / 2 / px });
      break;
    }
    case 'view.zoomVIn': {
      const cy = view.scrollYPx + view.height / 2;
      const rh = Math.min(64, view.rowHeight * VZOOM);
      s.setView({ rowHeight: rh, scrollYPx: cy - view.height / 2 });
      break;
    }
    case 'view.zoomVOut': {
      const cy = view.scrollYPx + view.height / 2;
      const rh = Math.max(4, view.rowHeight / VZOOM);
      s.setView({ rowHeight: rh, scrollYPx: cy - view.height / 2 });
      break;
    }
    case 'view.zoomFit': zoomFit(); break;
    case 'view.scrollUp': s.setView({ scrollYPx: view.scrollYPx - view.rowHeight * 4 }); break;
    case 'view.scrollDown': s.setView({ scrollYPx: view.scrollYPx + view.rowHeight * 4 }); break;
    case 'view.scrollLeft': s.setView({ scrollXPpq: view.scrollXPpq - 80 / view.pxPerPpq }); break;
    case 'view.scrollRight': s.setView({ scrollXPpq: view.scrollXPpq + 80 / view.pxPerPpq }); break;

    // --- edit -----------------------------------------------------------------
    case 'edit.undo': s.undo(); break;
    case 'edit.redo': s.redo(); break;
    case 'edit.selectAll': s.setSelection(s.doc.notes.map((n) => n.id)); break;
    case 'edit.delete':
    case 'edit.deleteBksp': {
      if (s.chordSelection.length > 0) {
        s.editDoc([{ op: 'removeManyChords', ids: [...s.chordSelection] }], t('disp.deletedChord'));
        s.setChordSelection([]);
        break;
      }
      const lane = s.laneMode;
      const laneSel = s.laneSelection;
      if (lane === 'cc' && laneSel.length > 0) {
        s.editDoc([{ op: 'removeManyCC', ids: [...laneSel] }], t('disp.deletedCcPoint'));
      } else if (lane === 'pb' && laneSel.length > 0) {
        s.editDoc([{ op: 'removeManyPB', ids: [...laneSel] }], t('disp.deletedPbPoint'));
      } else if (s.selection.length > 0) {
        s.editDoc([{ op: 'removeMany', ids: [...s.selection] }], t('disp.deleted'));
      }
      break;
    }
    case 'edit.copy': {
      const n = copySelected(s.doc, s.selection);
      s.setHint(n > 0 ? `t('disp.copied', { count: n })` : t('disp.noSelection'));
      break;
    }
    case 'edit.cut': {
      const n = copySelected(s.doc, s.selection);
      if (n > 0) s.editDoc([{ op: 'removeMany', ids: [...s.selection] }], t('disp.cut', { count: n }).slice(0, 0) === '' ? 'Cut' : 'Cut');
      s.setHint(n > 0 ? `t('disp.cut', { count: n })` : t('disp.noSelection'));
      break;
    }
    case 'edit.paste': {
      const ops = pasteOpsAt(snapPpq(s.editCursorPpq, s.settings, 'floor'));
      if (!hasClipboard() || ops == null) { s.setHint(t('disp.clipboardEmpty')); break; }
      s.editDoc(ops, t('disp.paste'));
      s.setHint(t('disp.pasted'));
      break;
    }
    case 'edit.duplicate': {
      if (s.selection.length === 0) { s.setHint(t('disp.noSelection')); break; }
      const sel = s.doc.notes.filter((n) => s.selection.includes(n.id));
      const minStart = Math.min(...sel.map((n) => n.s));
      const span = Math.max(...sel.map((n) => n.s + n.l)) - minStart;
      const beforeIds = new Set(s.doc.notes.map((n) => n.id));
      const ops: EditOp[] = sel.map((n) => ({
        op: 'add' as const,
        note: { p: n.p, s: n.s + span, l: n.l, v: n.v, m: n.m, c: n.c, a: n.a, ly: n.ly },
      }));
      // selection moves to the copies once the doc push lands, so repeated
      // Ctrl+D keeps duplicating the newest copies
      const off = getBridge().onEvent((ev: unknown) => {
        const e = ev as { kind?: string };
        if (e.kind !== 'doc') return;
        off();
        const st = useStore.getState();
        st.setSelection(st.doc.notes.filter((n) => !beforeIds.has(n.id)).map((n) => n.id));
      });
      s.editDoc(ops, t('disp.duplicated'));
      break;
    }

    // --- grid -----------------------------------------------------------------
    case 'grid.toggleSnap': s.updateSettings({ snap: !settings.snap }); break;
    case 'transport.toggle': {
      const st = useStore.getState();
      if (st.transport.internalPlaying)
        void getBridge().invoke('transport.stop').catch(() => {});
      else
        void getBridge().invoke('transport.play', { ppq: st.editCursorPpq }).catch(() => {});
      break;
    }
    case 'edit.quantize': {
      if (s.selection.length === 0) { s.setHint(t('disp.selectFirst')); break; }
      const step = gridStepPpq(settings);
      const ops: EditOp[] = s.doc.notes
        .filter((n) => s.selection.includes(n.id))
        .filter((n) => Math.round(n.s / step) * step !== n.s)
        .map((n) => ({ op: 'update' as const, note: { id: n.id, s: Math.round(n.s / step) * step } }));
      if (ops.length === 0) { s.setHint(t('disp.alreadyOnGrid')); break; }
      s.editDoc(ops, t('disp.quantize'));
      s.setHint(t('disp.quantized', { count: ops.length }));
      break;
    }
    case 'edit.quantizeLength': {
      if (s.selection.length === 0) { s.setHint(t('disp.selectFirst')); break; }
      const step = gridStepPpq(settings);
      const ops: EditOp[] = s.doc.notes
        .filter((n) => s.selection.includes(n.id))
        .map((n) => {
          const l = Math.max(step, Math.round(n.l / step) * step);
          return { op: 'update' as const, note: { id: n.id, l } };
        })
        .filter((op) => {
          const n = s.doc.notes.find((x) => x.id === op.note.id);
          return n != null && n.l !== op.note.l;
        });
      if (ops.length === 0) { s.setHint(t('disp.lengthAlreadyQuantized')); break; }
      s.editDoc(ops, t('disp.quantizeLength'));
      s.setHint(t('disp.quantizedLength', { count: ops.length }));
      break;
    }

    case 'edit.legato': {
      if (s.selection.length === 0) { s.setHint(t('disp.selectFirst')); break; }
      // Legato chains the selection in time order: notes starting at the same
      // moment (chords) are one group, and every note in a group extends to
      // the start of the next group — pitch is irrelevant.
      const sorted = s.doc.notes
        .filter((n) => s.selection.includes(n.id))
        .sort((a, b) => a.s - b.s || a.p - b.p);
      const groups: Array<typeof sorted> = [];
      for (const n of sorted) {
        const g = groups[groups.length - 1];
        if (g && Math.abs(g[0].s - n.s) < 1e-9) g.push(n);
        else groups.push([n]);
      }
      const ops: EditOp[] = [];
      for (let i = 0; i + 1 < groups.length; i++) {
        const nextStart = groups[i + 1][0].s;
        for (const n of groups[i]) {
          const l = nextStart - n.s;
          if (l > 1e-9 && Math.abs(l - n.l) > 1e-9)
            ops.push({ op: 'update', note: { id: n.id, l } });
        }
      }
      if (ops.length === 0) { s.setHint(t('disp.legatoNone')); break; }
      s.editDoc(ops, 'Legato');
      s.setHint(t('disp.legatoDone', { count: ops.length }));
      break;
    }
    case 'edit.humanize': {
      if (s.selection.length === 0) { s.setHint(t('disp.selectFirst')); break; }
      const ops: EditOp[] = s.doc.notes
        .filter((n) => s.selection.includes(n.id))
        .map((n) => ({
          op: 'update' as const,
          note: { id: n.id, v: Math.min(1, Math.max(0.05, n.v * (0.85 + Math.random() * 0.3))) },
        }));
      s.editDoc(ops, t('disp.humanize'));
      s.setHint(t('disp.humanizeDone'));
      break;
    }
    case 'edit.toggleMute': {
      if (s.selection.length === 0) { s.setHint(t('disp.selectFirst')); break; }
      const anyUnmuted = s.doc.notes.some((n) => s.selection.includes(n.id) && !n.m);
      const ops: EditOp[] = s.selection.map((id) => ({ op: 'update' as const, note: { id, m: anyUnmuted } }));
      s.editDoc(ops, anyUnmuted ? t('disp.muted') : t('disp.unmuted'));
      break;
    }
    case 'edit.nudgeUp':
    case 'edit.nudgeDown':
    case 'edit.octaveUp':
    case 'edit.octaveDown':
    case 'edit.transposeUp':
    case 'edit.transposeDown': {
      if (s.selection.length === 0) break;
      const delta =
        id === 'edit.nudgeUp' ? 1 : id === 'edit.nudgeDown' ? -1 :
        id === 'edit.octaveUp' ? 12 : id === 'edit.octaveDown' ? -12 :
        id === 'edit.transposeUp' ? 1 : -1;
      const ops: EditOp[] = s.doc.notes
        .filter((n) => {
          if (!s.selection.includes(n.id)) return false;
          const np = n.p + delta;
          return np >= 0 && np <= 127;
        })
        .map((n) => ({ op: 'update' as const, note: { id: n.id, p: n.p + delta } }));
      if (ops.length === 0) { s.setHint(t('disp.pitchOutOfRange')); break; }
      s.editDoc(ops, delta > 0 ? t('disp.pitchUp') : t('disp.pitchDown'));
      break;
    }

    default:
      break;
  }
}

export function zoomFit(): void {
  const s = useStore.getState();
  const { view, doc } = s;
  const notes = doc.notes;
  let maxEnd = 0;
  let minP = 127;
  let maxP = 0;
  for (const n of notes) {
    maxEnd = Math.max(maxEnd, n.s + n.l);
    minP = Math.min(minP, n.p);
    maxP = Math.max(maxP, n.p);
  }
  if (notes.length === 0) {
    maxEnd = 32; // 8 bars of 4/4
    minP = 48;
    maxP = 72;
  }
  const span = Math.max(4, maxEnd + 1); // + 1 bar padding
  const px = (view.width - 16) / span;
  const pitchSpan = Math.max(12, maxP - minP + 3);
  const rh = Math.min(64, Math.max(4, (view.height - 8) / pitchSpan));
  const midPitch = (minP + maxP) / 2;
  const scrollY = (127 - midPitch) * rh - (view.height - 8) / 2;
  s.setView({ pxPerPpq: px, rowHeight: rh, scrollXPpq: 0, scrollYPx: scrollY });
}

/** Quantize the start (and optionally length) of the selected notes. */
export function quantizeSelection(_alsoLength: boolean): void {
  const s = useStore.getState();
  if (s.selection.length === 0) {
    s.setHint(t('disp.selectFirst'));
    return;
  }
  const step = gridStepPpq(s.settings);
  const ops: EditOp[] = [];
  for (const n of s.doc.notes) {
    if (!s.selection.includes(n.id)) continue;
    const qStart = Math.round(n.s / step) * step;
    if (qStart !== n.s) ops.push({ op: 'update', note: { id: n.id, s: qStart } });
  }
  if (ops.length > 0) s.editDoc(ops, t('disp.quantize'));
}

/** Transpose every note (or the selection, if any) to the nearest chord tone
 *  of the chord sounding at its start. Notes outside the chord track and
 *  already-fitting notes are left untouched; one undoable transaction. */
export function fitToChords(): void {
  const s = useStore.getState();
  if (s.doc.chords.length === 0) {
    s.setHint(t('disp.noChords'));
    return;
  }
  const selected = s.selection.length > 0;
  let changed = 0, matched = 0;
  const ops: EditOp[] = [];
  for (const n of s.doc.notes) {
    if (selected && !s.selection.includes(n.id)) continue;
    const pcs = chordPcsAt(s.doc.chords, n.s);
    if (!pcs || pcs.size === 0) continue;
    matched++;
    const pc = ((n.p % 12) + 12) % 12;
    // nearest chord tone as a pitch-class delta in [-6, +5]; ties go downward
    let delta = 0, bestAbs = 13;
    for (const tone of pcs) {
      const d = (((tone - pc + 6 + 12) % 12) + 12) % 12 - 6;
      const a = Math.abs(d);
      if (a < bestAbs || (a === bestAbs && d < delta)) { delta = d; bestAbs = a; }
    }
    if (delta === 0) continue;
    let p = n.p + delta;
    if (p < 0 || p > 127) {
      const alt = delta > 0 ? delta - 12 : delta + 12;
      p = n.p + alt;
      if (p < 0 || p > 127) continue;  // cannot fit inside the pitch range
    }
    ops.push({ op: 'update', note: { id: n.id, p } });
    changed++;
  }
  if (ops.length > 0) s.editDoc(ops, t('disp.fitChords'));
  s.setHint(changed > 0
    ? t('disp.chordsApplied', { count: changed })
    : matched > 0 ? t('disp.alreadyFit') : t('disp.noChordHere'));
}
