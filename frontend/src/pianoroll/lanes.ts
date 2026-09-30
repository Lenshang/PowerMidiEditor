// Painting for the bottom lane editor (velocity bars, CC curves, pitch bend).
import type { ControllerEvent, DocumentState, PitchBendEvent } from '../bridge/protocol';
import type { ViewState } from '../state/store';
import type { ThemeColors } from '../ui/themes';
import { drawGridLines } from './render';
import { xOfPpq } from './ViewMap';

export type LanePoint = { id: number; t: number; v: number }; // v in lane units

/** Velocity bar width in px — fixed so zoom never changes it (hit-tests share this). */
export const VELOCITY_BAR_W = 8;

export function drawLaneBase(
  ctx: CanvasRenderingContext2D, v: ViewState, c: ThemeColors,
  w: number, h: number, gridStep: number,
): void {
  ctx.fillStyle = c['roll-bg'];
  ctx.fillRect(0, 0, w, h);
  drawGridLines(ctx, v, c, gridStep, h);
  // top edge
  ctx.fillStyle = c['border'];
  ctx.globalAlpha = 0.6;
  ctx.fillRect(0, 0, w, 1);
  ctx.globalAlpha = 1;
}

/** Velocity lane: one bar per note, bottom-aligned. Selected bars draw on top. */
export function drawVelocityLane(
  ctx: CanvasRenderingContext2D, v: ViewState, c: ThemeColors,
  doc: DocumentState, selection: Set<number>,
  w: number, h: number, dragOverrides: Map<number, number> | null,
): void {
  const [startPpq, endPpq] = [v.scrollXPpq, v.scrollXPpq + w / v.pxPerPpq];
  const drawPass = (wantSelected: boolean) => {
    for (const n of doc.notes) {
      if (n.s + n.l < startPpq || n.s > endPpq) continue;
      if (selection.has(n.id) !== wantSelected) continue;
      const vel = dragOverrides?.get(n.id) ?? n.v;
      const x = xOfPpq(v, n.s);
      const barW = VELOCITY_BAR_W;
      const barH = Math.max(2, vel * (h - 4));
      ctx.fillStyle = wantSelected ? c['note-selected'] : c['note-fill'];
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x, h - barH, barW, barH);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = c['note-border'];
      ctx.strokeRect(x + 0.5, h - barH + 0.5, barW - 1, barH - 1);
    }
  };
  drawPass(false);
  drawPass(true);
  // center hint line
  ctx.strokeStyle = c['grid-sub'];
  ctx.globalAlpha = 0.35;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, h - (h - 4) - 0.5);
  ctx.lineTo(w, h - (h - 4) - 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

interface CurveLane {
  events: Array<{ id: number; t: number; v: number }>;
  maxValue: number;   // 127 for CC, 16383 for pitch bend
  selected: Set<number>;
  dragOverrides: Map<number, number> | null; // id -> v
  dragPoints: Map<number, number> | null;    // id -> t (preview positions)
}

/** CC / pitch-bend lanes: polyline + editable points. */
export function drawCurveLane(
  ctx: CanvasRenderingContext2D, v: ViewState, c: ThemeColors,
  lane: CurveLane, w: number, h: number,
): void {
  const max = lane.maxValue;
  const neutralY = lane.maxValue === 16383
    ? (1 - 8192 / max) * (h - 6) + 3 // pitch bend rests at center
    : (1 - 0 / max) * (h - 6) + 3;   // CC rests at 0
  const pts = lane.events
    .map((e) => ({
      id: e.id,
      x: xOfPpq(v, lane.dragPoints?.get(e.id) ?? e.t),
      y: (1 - (lane.dragOverrides?.get(e.id) ?? e.v) / max) * (h - 6) + 3,
    }))
    .sort((a, b) => a.x - b.x);

  // Playback semantics, drawn as-is: the value rests at neutral before the
  // first point and holds the last point's value after it.
  const first = pts[0];
  const last = pts[pts.length - 1];

  // translucent fill under the curve
  ctx.fillStyle = c['accent'];
  ctx.globalAlpha = 0.10;
  ctx.beginPath();
  if (pts.length === 0) {
    ctx.rect(-4, neutralY, w + 8, h - neutralY + 4);
  } else {
    ctx.moveTo(-4, h);
    // flat at neutral before the first point, vertical jump at the point
    ctx.lineTo(-4, neutralY);
    ctx.lineTo(first.x, neutralY);
    ctx.lineTo(first.x, first.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineTo(w + 4, last.y);
    ctx.lineTo(w + 4, h);
    ctx.closePath();
  }
  ctx.fill();
  ctx.globalAlpha = 1;

  // the curve
  ctx.strokeStyle = c['accent'];
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (pts.length === 0) {
    ctx.moveTo(-4, neutralY);
    ctx.lineTo(w + 4, neutralY);
  } else {
    ctx.moveTo(-4, neutralY);
    ctx.lineTo(first.x, neutralY);
    ctx.lineTo(first.x, first.y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineTo(w + 4, last.y);
  }
  ctx.stroke();
  ctx.lineWidth = 1;

  // pitch bend center line
  if (lane.maxValue === 16383) {
    const cy = Math.round((1 - 8192 / max) * (h - 6) + 3) + 0.5;
    ctx.strokeStyle = c['grid-beat'];
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // handle squares
  for (const p of pts) {
    const sel = lane.selected.has(p.id);
    ctx.fillStyle = sel ? c['note-selected'] : c['note-fill'];
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
    ctx.strokeStyle = c['note-border'];
    ctx.strokeRect(p.x - 3, p.y - 3, 6, 6);
  }
}

export function velocityLaneEvents(doc: DocumentState): LanePoint[] {
  return doc.notes.map((n) => ({ id: n.id, t: n.s, v: n.v }));
}

export function ccLaneEvents(doc: DocumentState, cc: number): LanePoint[] {
  return doc.ccs.filter((e: ControllerEvent) => e.cc === cc)
    .map((e) => ({ id: e.id, t: e.t, v: e.v }));
}

export function pbLaneEvents(doc: DocumentState): PitchBendEvent[] {
  return doc.pbs;
}
