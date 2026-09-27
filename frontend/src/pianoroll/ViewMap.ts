// Coordinate transforms between content space (quarter notes / pitch) and
// roll-local pixel space. Pure functions over the ViewState in the store.
import type { ViewState } from '../state/store';

export const KEYS_WIDTH = 64;
export const RULER_HEIGHT = 28;

export function xOfPpq(v: ViewState, ppq: number): number {
  return (ppq - v.scrollXPpq) * v.pxPerPpq;
}

export function ppqAtX(v: ViewState, x: number): number {
  return v.scrollXPpq + x / v.pxPerPpq;
}

export function yOfPitch(v: ViewState, pitch: number): number {
  return (127 - pitch) * v.rowHeight - v.scrollYPx;
}

/** Fractional pitch at y (do not round when zoom anchor stability matters). */
export function floatPitchAtY(v: ViewState, y: number): number {
  return 127 - (y + v.scrollYPx) / v.rowHeight;
}

export function pitchAtY(v: ViewState, y: number): number {
  // The visible row for pitch P spans y ∈ [(127-P)·rh − scrollY, (127-P+1)·rh − scrollY).
  // Floor the CONTENT coordinate (not the pitch) so the entire row maps to P —
  // round() made the lower half of each row hit-test/draw as the pitch below it.
  const p = 127 - Math.floor((y + v.scrollYPx) / v.rowHeight + 1e-9);
  return Math.min(127, Math.max(0, p));
}

export function isBlackPitch(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12);
}

/** "C4" style name (MIDI note 60 = C4). */
export function pitchName(pitch: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`;
}

/** Bar length in quarter notes for a time signature (4/4 -> 4, 6/8 -> 3, 3/4 -> 3). */
export function barPpqOf(sigNum: number, sigDen: number): number {
  if (!sigNum || !sigDen) return 4;
  const bar = (sigNum * 4) / sigDen;
  return bar > 0 && Number.isFinite(bar) ? bar : 4;
}

/** bar.beat.sixteenth for a ppq position (barLen in quarter notes, 4 display beats per bar). */
export function positionString(ppq: number, barLen = 4): string {
  const t = Math.max(0, ppq);
  const bar = Math.floor(t / barLen) + 1;
  const inBar = t % barLen;
  const beatLen = barLen / 4;
  const beat = Math.floor(inBar / beatLen) + 1;
  const sixteenth = Math.floor((inBar % beatLen) / (beatLen / 4)) + 1;
  return `${bar}.${beat}.${sixteenth}`;
}
