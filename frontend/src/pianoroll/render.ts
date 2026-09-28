// Canvas painting routines. All functions receive an already-DPR-scaled 2d
// context whose (0,0) is the layer's top-left; transforms come from ViewState.
import type { ChordEvent, DocumentState, Note } from '../bridge/protocol';
import type { ViewState } from '../state/store';
import type { ThemeColors } from '../ui/themes';
import {
  isBlackPitch, pitchName, ppqAtX, xOfPpq, yOfPitch,
} from './ViewMap';

const BLACK = [1, 3, 6, 8, 10];

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Chord quality table (name + semitone intervals from the root). */
export const CHORD_QUALITIES: Array<{ label: string; intervals: number[] }> = [
  { label: 'maj', intervals: [0, 4, 7] },
  { label: 'min', intervals: [0, 3, 7] },
  { label: 'dim', intervals: [0, 3, 6] },
  { label: 'aug', intervals: [0, 4, 8] },
  { label: '7', intervals: [0, 4, 7, 10] },
  { label: 'maj7', intervals: [0, 4, 7, 11] },
  { label: 'min7', intervals: [0, 3, 7, 10] },
  { label: 'sus4', intervals: [0, 5, 7] },
];

export function chordName(c: { r: number; q: number }): string {
  const q = CHORD_QUALITIES[c.q] ?? CHORD_QUALITIES[0];
  return `${NOTE_NAMES[((c.r % 12) + 12) % 12]}${q.label}`;
}

/** Pitch classes of the chord sounding at the given time (or null). */
export function chordPcsAt(chords: ChordEvent[], t: number): Set<number> | null {
  for (const c of chords) {
    if (t >= c.s && t < c.s + c.l) {
      const q = CHORD_QUALITIES[c.q] ?? CHORD_QUALITIES[0];
      return new Set(q.intervals.map((iv) => (((c.r + iv) % 12) + 12) % 12));
    }
  }
  return null;
}

export interface GridInfo {
  gridStep: number;
  showSub: boolean;
}

/** Visible ppq range for a viewport. */
export function visiblePpqRange(v: ViewState): [number, number] {
  return [v.scrollXPpq, ppqAtX(v, v.width)];
}

export function drawRollBackground(
  ctx: CanvasRenderingContext2D, v: ViewState, c: ThemeColors,
): void {
  ctx.fillStyle = c['roll-bg'];
  ctx.fillRect(0, 0, v.width, v.height);

  const firstPitch = Math.max(0, Math.floor(127 - (v.scrollYPx + v.height) / v.rowHeight));
  const lastPitch = Math.min(127, Math.ceil(127 - v.scrollYPx / v.rowHeight));
  for (let p = firstPitch; p <= lastPitch; p++) {
    const y = yOfPitch(v, p);
    ctx.fillStyle = BLACK.includes(((p % 12) + 12) % 12) ? c['lane-black'] : c['lane-white'];
    ctx.fillRect(0, Math.floor(y), v.width, Math.ceil(v.rowHeight));
    // subtle row separator
    if (v.rowHeight >= 6) {
      ctx.fillStyle = c['grid-sub'];
      ctx.globalAlpha = 0.18;
      ctx.fillRect(0, Math.floor(y + v.rowHeight) - 1, v.width, 1);
      ctx.globalAlpha = 1;
    }
    // octave line
    if (((p % 12) + 12) % 12 === 0) {
      ctx.fillStyle = c['grid-beat'];
      ctx.globalAlpha = 0.55;
      ctx.fillRect(0, Math.floor(y + v.rowHeight) - 1, v.width, 1);
      ctx.globalAlpha = 1;
    }
  }
}

export function drawGridLines(
  ctx: CanvasRenderingContext2D, v: ViewState, c: ThemeColors, gridStep: number,
  h = v.height, barPpq = 4,
): void {
  const [startPpq, endPpq] = visiblePpqRange(v);

  const drawLines = (step: number, color: string, alpha: number, width = 1) => {
    if (step * v.pxPerPpq < 5) return;
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.beginPath();
    const first = Math.floor(startPpq / step) * step;
    for (let t = first; t <= endPpq; t += step) {
      const x = Math.round(xOfPpq(v, t)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  drawLines(gridStep, c['grid-sub'], 0.35);
  drawLines(1, c['grid-beat'], 0.7);
  drawLines(barPpq, c['grid-bar'], 0.9);
}

const GM_DRUMS: Record<number, string> = {
  35: 'Kick', 36: 'Kick', 37: 'Stick', 38: 'Snare', 40: 'Snare2',
  41: 'Fl.Tom', 42: 'CHH', 43: 'Fl.Tom', 44: 'PHH', 45: 'Tom',
  46: 'OHH', 47: 'Tom', 48: 'Tom', 49: 'Crash', 50: 'Tom',
  51: 'Ride', 52: 'China', 53: 'Bell', 54: 'Tamb', 55: 'Splash',
  56: 'Cowbell', 57: 'Crash2', 59: 'Ride2',
};

let customDrumNames: Record<number, string> | null = null;

/** Install a loaded drum kit name map (from a .bwdrm/.drm file). */
export function setCustomDrumNames(names: Record<number, string> | null): void {
  customDrumNames = names;
}

export function drumName(pitch: number): string {
  if (customDrumNames && customDrumNames[pitch]) return customDrumNames[pitch];
  return GM_DRUMS[pitch] ?? '';
}

export function drawKeys(
  ctx: CanvasRenderingContext2D, v: ViewState, c: ThemeColors,
  w: number, h: number, pressed: Set<number>, drumMode = false,
): void {
  ctx.fillStyle = c['key-white'];
  ctx.fillRect(0, 0, w, h);

  const firstPitch = Math.max(0, Math.floor(127 - (v.scrollYPx + h) / v.rowHeight));
  const lastPitch = Math.min(127, Math.ceil(127 - v.scrollYPx / v.rowHeight));
  const blackKeyW = Math.max(10, Math.min(34, w * 0.55));

  for (let p = firstPitch; p <= lastPitch; p++) {
    const y = Math.floor(yOfPitch(v, p));
    const rh = Math.ceil(v.rowHeight);
    const black = isBlackPitch(p);
    const isPressed = pressed.has(p);

    if (drumMode) {
      ctx.fillStyle = isPressed ? c['key-pressed'] : c['lane-black'];
      ctx.fillRect(0, y, w, rh);
      ctx.fillStyle = c['key-border'];
      ctx.globalAlpha = 0.25;
      ctx.fillRect(0, y + rh - 1, w, 1);
      ctx.globalAlpha = 1;
      const name = drumName(p);
      if (name && v.rowHeight >= 8) {
        ctx.fillStyle = isPressed ? c['note-text'] : c['key-label'];
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, 3, y + rh / 2 + 0.5);
      }
      continue;
    }

    if (black && v.rowHeight >= 5) {
      // black key: dark block on the right portion, white gap at left
      ctx.fillStyle = c['key-white'];
      ctx.fillRect(0, y, w, rh);
      if (isPressed) {
        ctx.fillStyle = c['key-pressed'];
        ctx.fillRect(0, y, w, rh);
      }
      ctx.fillStyle = c['key-black'];
      ctx.fillRect(w - blackKeyW, y, blackKeyW, rh);
      ctx.fillStyle = c['key-border'];
      ctx.globalAlpha = 0.5;
      ctx.fillRect(w - blackKeyW, y, 1, rh);
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = isPressed ? c['key-pressed'] : c['key-white'];
      ctx.fillRect(0, y, w, rh);
    }

    // bottom border / octave emphasis
    ctx.fillStyle = c['key-border'];
    ctx.globalAlpha = ((p % 12) + 12) % 12 === 0 ? 0.8 : 0.25;
    ctx.fillRect(0, y + rh - 1, w, 1);
    ctx.globalAlpha = 1;

    // C labels
    if (((p % 12) + 12) % 12 === 0 && v.rowHeight >= 9) {
      ctx.fillStyle = c['key-label'];
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(pitchName(p), 3, y + rh - 1);
    }
  }
}

export function drawRuler(
  ctx: CanvasRenderingContext2D, v: ViewState, c: ThemeColors,
  w: number, h: number,
  loop: { valid: boolean; start: number; end: number },
  barPpq = 4,
  cursorPpq: number | null = null,
): void {
  ctx.fillStyle = c['ruler-bg'];
  ctx.fillRect(0, 0, w, h);

  const [startPpq, endPpq] = visiblePpqRange(v);
  const pxPerBar = barPpq * v.pxPerPpq;
  const barStep = pxPerBar >= 30 ? 1 : pxPerBar >= 14 ? 2 : pxPerBar >= 7 ? 4 : 8;

  // loop band
  if (loop.valid && loop.end > loop.start) {
    const x0 = xOfPpq(v, loop.start);
    const x1 = xOfPpq(v, loop.end);
    ctx.fillStyle = c['loop-band'];
    ctx.globalAlpha = 0.5;
    ctx.fillRect(x0, h - 5, Math.max(2, x1 - x0), 4);
    ctx.globalAlpha = 1;
  }

  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';

  // beat ticks
  ctx.strokeStyle = c['ruler-tick'];
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  if (v.pxPerPpq >= 14) {
    const firstBeat = Math.floor(startPpq);
    for (let t = firstBeat; t <= endPpq; t++) {
      if (Math.abs(t / barPpq - Math.round(t / barPpq)) < 1e-9) continue; // skip bar lines
      const x = Math.round(xOfPpq(v, t)) + 0.5;
      ctx.moveTo(x, h - 8);
      ctx.lineTo(x, h);
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // bar lines + numbers
  const firstBar = Math.floor(startPpq / barPpq / barStep) * barStep;
  ctx.textAlign = 'left';
  for (let bar = firstBar; bar * barPpq <= endPpq; bar += barStep) {
    const x = Math.round(xOfPpq(v, bar * barPpq)) + 0.5;
    ctx.strokeStyle = c['ruler-tick'];
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(x, h - 14);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = c['ruler-text'];
    ctx.fillText(String(bar + 1), x + 3, h - 15);
  }

  // edit cursor marker
  if (cursorPpq != null) {
    const cx = xOfPpq(v, cursorPpq);
    ctx.fillStyle = c['edit-cursor'];
    ctx.beginPath();
    ctx.moveTo(cx - 4, 2);
    ctx.lineTo(cx + 4, 2);
    ctx.lineTo(cx, 9);
    ctx.closePath();
    ctx.fill();
  }
}

export function drawNotes(
  ctx: CanvasRenderingContext2D, v: ViewState, c: ThemeColors,
  doc: DocumentState, selection: Set<number>,
  ghosts: Note[] = [],
  drumMode = false,
  artNames: Map<number, string> = new Map(),
): void {
  ctx.clearRect(0, 0, v.width, v.height);
  const [startPpq, endPpq] = visiblePpqRange(v);
  const pcs = chordPcsAt(doc.chords, startPpq + v.width / v.pxPerPpq / 2); // viewport midpoint
  // two passes so selected notes are never hidden behind unselected ones
  const drawPass = (wantSelected: boolean) => {
    for (const n of doc.notes) {
      if (n.s + n.l < startPpq || n.s > endPpq) continue;
      if (selection.has(n.id) !== wantSelected) continue;
      drawNote(ctx, v, c, n, wantSelected, pcs != null && pcs.has(((n.p % 12) + 12) % 12), drumMode, artNames, n.ly);
    }
  };
  drawPass(false);
  drawPass(true);
  // uncommitted drag ghosts
  for (const g of ghosts) {
    const fake: Note = { id: g.id, p: g.p, s: g.s, l: g.l, v: g.v, m: false, c: g.c, a: -1 };
    drawNote(ctx, v, c, fake, true, false, drumMode, artNames);
  }
}

function drawNote(
  ctx: CanvasRenderingContext2D, v: ViewState, c: ThemeColors,
  n: Note, selected: boolean, inChord = false, drumMode = false,
  artNames: Map<number, string> = new Map(), lyric?: string,
): void {
  const x = xOfPpq(v, n.s);
  const y = yOfPitch(v, n.p);
  const w = Math.max(3, n.l * v.pxPerPpq - 1);
  const h = Math.max(2, v.rowHeight - 1);
  if (x + w < 0 || x > v.width || y + h < 0 || y > v.height) return;

  const alpha = 0.45 + 0.55 * n.v;
  ctx.globalAlpha = n.m ? 0.35 : alpha;
  ctx.fillStyle = selected ? c['note-selected'] : c['note-fill'];

  if (drumMode) {
    // Fixed-shape marker: a rounded square rotated 45°, anchored at the
    // note-on point. Size tracks row height only — never stretched by
    // horizontal zoom, so hits stay recognizable at any zoom level.
    const sel = selected;
    const size = Math.max(6, Math.min(v.rowHeight * 0.62, 22));
    const cxp = x + 0.5; // anchor exactly on the note-on (== gridline raster position)
    const cyp = y + h / 2;
    ctx.save();
    ctx.translate(cxp, cyp);
    ctx.rotate(Math.PI / 4);
    const half = size / 2;
    const rr = Math.min(3, half / 2);
    ctx.globalAlpha = n.m ? 0.35 : alpha;
    ctx.fillStyle = sel ? c['note-selected'] : c['note-fill'];
    roundedRect(ctx, -half, -half, size, size, rr);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = sel ? c['note-selected-border'] : c['note-border'];
    ctx.lineWidth = 1;
    roundedRect(ctx, -half + 0.5, -half + 0.5, size - 1, size - 1, rr);
    ctx.stroke();
    // inner dot for a subtle "hit" look
    if (!n.m) {
      ctx.fillStyle = c['note-text'];
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(1, size / 8), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    return;
  }

  const r = Math.min(3, h / 2, w / 2);
  roundedRect(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.strokeStyle = selected ? c['note-selected-border'] : inChord ? c['loop-band'] : c['note-border'];
  ctx.lineWidth = inChord && !selected ? 1.5 : 1;
  roundedRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r);
  ctx.stroke();
  ctx.lineWidth = 1;

  if (v.rowHeight >= 14 && w >= 26) {
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const art = n.a >= 0 ? artNames.get(n.a) : undefined;
    const pitch = pitchName(n.p);
    const pitchW = ctx.measureText(pitch).width;
    ctx.fillStyle = c['note-text'];
    if (art != null && w >= 26 + pitchW + ctx.measureText(art).width + 10) {
      ctx.fillText(pitch, x + 3, y + h / 2 + 0.5);
      ctx.globalAlpha = 0.75;
      ctx.fillText(art, x + 3 + pitchW + 6, y + h / 2 + 0.5);
      ctx.globalAlpha = 1;
    } else if (art != null && w >= ctx.measureText(art).width + 8) {
      ctx.fillText(art, x + 3, y + h / 2 + 0.5);
    } else {
      ctx.fillText(pitch, x + 3, y + h / 2 + 0.5);
    }
  }

  if (lyric != null && lyric !== '' && v.rowHeight >= 14) {
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = c['text-dim'];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(lyric, x + w / 2, y + h + 2);
  }
}

/** Overview strip: all notes + viewport indicator. */
export function drawMinimap(
  ctx: CanvasRenderingContext2D, c: ThemeColors,
  w: number, h: number,
  notes: Note[], contentEnd: number,
  viewStartPpq: number, viewEndPpq: number,
): void {
  ctx.fillStyle = c['roll-bg'];
  ctx.fillRect(0, 0, w, h);
  const span = Math.max(16, contentEnd);
  const k = w / span;
  ctx.globalAlpha = 0.7;
  for (const n of notes) {
    const x = n.s * k;
    const nw = Math.max(1.5, n.l * k);
    ctx.fillStyle = c['note-fill'];
    ctx.fillRect(x, ((127 - n.p) / 128) * (h - 4) + 2, nw, 2);
  }
  ctx.globalAlpha = 1;
  // viewport window
  const vx0 = viewStartPpq * k;
  const vx1 = Math.min(w, viewEndPpq * k);
  ctx.strokeStyle = c['accent'];
  ctx.globalAlpha = 0.9;
  ctx.strokeRect(vx0 + 0.5, 0.5, Math.max(6, vx1 - vx0) - 1, h - 1);
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = c['accent'];
  ctx.fillRect(vx0, 0, Math.max(6, vx1 - vx0), h);
  ctx.globalAlpha = 1;
}

function roundedRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  if (r <= 0) {
    ctx.rect(x, y, w, h);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export interface OverlayState {
  playheadPpq: number | null;
  editCursorPpq: number | null;
  marquee: { x0: number; y0: number; x1: number; y1: number } | null;
  stepCursorPpq: number | null;
  razorHoverPpq: number | null;
  createGhost?: { p: number; s: number; l: number } | null;
  drumMode?: boolean;
}

export function drawOverlay(
  ctx: CanvasRenderingContext2D, v: ViewState, c: ThemeColors,
  w: number, h: number, st: OverlayState,
): void {
  ctx.clearRect(0, 0, w, h);

  if (st.marquee) {
    const x = Math.min(st.marquee.x0, st.marquee.x1);
    const y = Math.min(st.marquee.y0, st.marquee.y1);
    const mw = Math.abs(st.marquee.x1 - st.marquee.x0);
    const mh = Math.abs(st.marquee.y1 - st.marquee.y0);
    ctx.fillStyle = c['accent'];
    ctx.globalAlpha = 0.12;
    ctx.fillRect(x, y, mw, mh);
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = c['accent'];
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, mw, mh);
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  if (st.editCursorPpq != null) {
    const x = Math.round(xOfPpq(v, st.editCursorPpq)) + 0.5;
    ctx.strokeStyle = c['edit-cursor'];
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  if (st.stepCursorPpq != null) {
    const x = Math.round(xOfPpq(v, st.stepCursorPpq)) + 0.5;
    ctx.strokeStyle = c['playhead'];
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }

  if (st.razorHoverPpq != null) {
    const x = Math.round(xOfPpq(v, st.razorHoverPpq)) + 0.5;
    ctx.strokeStyle = c['danger'];
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // pencil/spray creation ghost: the exact note (snap + chord assist applied)
  // the next click would create. Drum mode previews the same fixed marker
  // the real hit will use; other modes draw a translucent dashed note.
  if (st.createGhost && st.createGhost.l > 0) {
    const g = st.createGhost;
    const gx = xOfPpq(v, g.s);
    const gy = (127 - g.p) * v.rowHeight - v.scrollYPx;
    if (st.drumMode) {
      const size = Math.max(6, Math.min(v.rowHeight * 0.62, 22));
      const cxp = gx + 0.5;
      const cyp = gy + v.rowHeight / 2;
      ctx.save();
      ctx.translate(cxp, cyp);
      ctx.rotate(Math.PI / 4);
      const half = size / 2;
      const rr = Math.min(3, half / 2);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = c['note-fill'];
      roundedRect(ctx, -half, -half, size, size, rr);
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = c['note-fill'];
      ctx.setLineDash([4, 3]);
      roundedRect(ctx, -half + 0.5, -half + 0.5, size - 1, size - 1, rr);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.restore();
    } else {
      const gw = Math.max(4, g.l * v.pxPerPpq - 1);
      ctx.fillStyle = c['note-fill'];
      ctx.globalAlpha = 0.30;
      ctx.fillRect(gx, gy, gw, v.rowHeight - 1);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = c['note-fill'];
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(gx + 0.5, gy + 0.5, gw - 1, v.rowHeight - 2);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  if (st.playheadPpq != null) {
    const x = Math.round(xOfPpq(v, st.playheadPpq)) + 0.5;
    if (x >= -2 && x <= w + 2) {
      ctx.fillStyle = c['playhead'];
      ctx.fillRect(x, 0, 1, h);
      ctx.beginPath();
      ctx.moveTo(x - 5, 0);
      ctx.lineTo(x + 5, 0);
      ctx.lineTo(x, 7);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/** Chord track lane above the roll (Cubase-style chord strip). */
export function drawChordLane(
  ctx: CanvasRenderingContext2D, v: ViewState, c: ThemeColors,
  chords: ChordEvent[], selected: Set<number>,
  w: number, h: number,
  ghost: (Partial<ChordEvent> & { id: number }) | null,
): void {
  ctx.fillStyle = c['ruler-bg'];
  ctx.fillRect(0, 0, w, h);

  const drawChord = (ch: ChordEvent, isSel: boolean) => {
    const x = xOfPpq(v, ch.s);
    const cw = Math.max(4, ch.l * v.pxPerPpq - 1);
    const y = 3;
    const chH = h - 8;
    ctx.fillStyle = isSel ? c['note-selected'] : c['accent'];
    ctx.globalAlpha = isSel ? 0.95 : 0.7;
    roundedRect(ctx, x, y, cw, chH, 3);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = c['note-border'];
    roundedRect(ctx, x + 0.5, y + 0.5, cw - 1, chH - 1, 3);
    ctx.stroke();
    if (cw > 30) {
      ctx.fillStyle = c['note-text'];
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(chordName(ch), x + 5, y + chH / 2 + 0.5);
    }
  };

  for (const ch of chords) {
    const g = ghost?.id === ch.id ? { ...ch, ...ghost } : ch;
    drawChord(g as ChordEvent, selected.has(ch.id));
  }
  ctx.fillStyle = c['border'];
  ctx.fillRect(0, h - 1, w, 1);
}
