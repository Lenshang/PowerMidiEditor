// Internal note clipboard (per-plugin-instance, not the OS clipboard).
import type { DocumentState, EditOp, NoteDraft } from '../bridge/protocol';

interface Clip {
  notes: NoteDraft[];
  span: number; // ppq from earliest start to latest end
}

let clip: Clip | null = null;

export function hasClipboard(): boolean {
  return clip != null && clip.notes.length > 0;
}

export function copySelected(doc: DocumentState, selection: number[]): number {
  const selected = doc.notes.filter((n) => selection.includes(n.id));
  if (selected.length === 0) return 0;
  const minStart = Math.min(...selected.map((n) => n.s));
  const span = Math.max(...selected.map((n) => n.s + n.l)) - minStart;
  clip = {
    span,
    notes: selected.map((n) => ({ p: n.p, s: n.s - minStart, l: n.l, v: n.v, m: n.m, c: n.c, a: n.a })),
  };
  return selected.length;
}

export function pasteOpsAt(cursorPpq: number): EditOp[] | null {
  if (clip == null || clip.notes.length === 0) return null;
  return clip.notes.map((n) => ({ op: 'add' as const, note: { ...n, s: n.s + cursorPpq } }));
}

export function clipboardSpan(): number {
  return clip?.span ?? 0;
}
