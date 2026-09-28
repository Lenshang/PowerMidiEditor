// Bottom lane editor: velocity bars, CC curves (multi-lane) and pitch bend.
// Supports point editing, straight-line fill and freehand drawing for CC/PB.
// Drags preview locally and commit once on release.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge } from '../bridge/bridge';
import type { EditOp } from '../bridge/protocol';
import { drawLaneBase, drawCurveLane, drawVelocityLane } from '../pianoroll/lanes';
import { ppqAtX, xOfPpq } from '../pianoroll/ViewMap';
import { snapPpq, transportClock, useStore, CC_CHOICES, gridStepPpq, type LaneMode } from '../state/store';
import { themeColors } from './themes';
import { t as ti } from '../i18n';

const LANE_H = 108;

interface DragState {
  laneIndex: number;
  kind: 'velocity' | 'curve';
  mode: 'move' | 'resize' | 'line' | 'free';
  ids: number[];
  startV: Map<number, number>;
  grabbedStartV: number;
  startY: number;
  overridesV: Map<number, number>;
  overridesT: Map<number, number>;
  grabStartT: number;
  moved: boolean;
  // freehand / line pending points (curve lanes only)
  pending: Array<{ t: number; v: number }>;
  anchor: { t: number; v: number } | null;
  // velocity freehand paint sweep
  painted: Set<number>;
  paintedVel: Map<number, number>;
  lastPaintX: number;
  // audible-edit throttle
  lastFiredVel: number;
}

export function LanePanel(): React.ReactElement {
  const laneMode = useStore((s) => s.laneMode);
  const ccNumber = useStore((s) => s.ccNumber);
  const view = useStore((s) => s.view);
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const laneSelection = useStore((s) => s.laneSelection);
  const theme = useStore((s) => s.settings.theme);

  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 800, h: LANE_H });
  const dragRef = useRef<DragState | null>(null);
  const [drawMode, setDrawMode] = useState<'point' | 'line' | 'free'>('point');
  const lyricBatchRef = useRef<HTMLInputElement>(null);
  const [lyricSplit, setLyricSplit] = useState<'space' | 'char'>('space');

  // Distribute space-separated syllables onto notes in time order: the
  // selection when there is one, otherwise the whole take.
  const applyLyricBatch = () => {
    const st = useStore.getState();
    const raw = lyricBatchRef.current ? lyricBatchRef.current.value : '';
    const syllables = lyricSplit === 'char'
      ? Array.from(raw.replace(/\s+/g, ''))
      : raw.trim().split(/\s+/).filter(Boolean);
    if (syllables.length === 0) { st.setHint(ti('lane.lyricEmpty')); return; }
    let targets = st.doc.notes;
    if (st.selection.length > 0)
      targets = targets.filter((n) => st.selection.includes(n.id));
    targets = [...targets].sort((a, b) => a.s - b.s);
    if (targets.length === 0) { st.setHint(ti('disp.noSelection')); return; }
    const ops: EditOp[] = targets.map((n, i) => ({
      op: 'update' as const,
      note: { id: n.id, ly: i < syllables.length ? syllables[i] : '' },
    }));
    commitOps(ops, ti('lane.lyricApply'));
    if (lyricBatchRef.current) lyricBatchRef.current.value = '';
    st.setHint(ti('lane.lyricApplied', { count: Math.min(targets.length, syllables.length) }));
  };
  const [addCcOpen, setAddCcOpen] = useState(false);
  const [newCc, setNewCc] = useState<number>(11);

  const lanes: Array<{ kind: 'velocity' } | { kind: 'cc'; cc: number } | { kind: 'pb' }> =
    laneMode === 'cc' ? [{ kind: 'cc' as const, cc: ccNumber }]
      : [{ kind: laneMode === 'pb' ? 'pb' : 'velocity' } as never];
  const laneH = LANE_H / lanes.length;
  const maxValue = laneMode === 'pb' ? 16383 : 127;

  const laneEvents = (laneIndex: number): Array<{ id: number; t: number; v: number }> => {
    const d = useStore.getState().doc;
    if (laneMode === 'velocity')
      return d.notes.map((n) => ({ id: n.id, t: n.s, v: n.v }));
    if (laneMode === 'cc')
      return d.ccs.filter((e) => e.cc === ccNumber).map((e) => ({ id: e.id, t: e.t, v: e.v }));
    return d.pbs.map((e) => ({ id: e.id, t: e.t, v: e.v }));
  };

  const vFromY = (y: number, h: number) => {
    const frac = Math.min(1, Math.max(0, 1 - y / (h - 6) - 3 / (h - 6)));
    return Math.round(frac * maxValue);
  };
  const yFromV = (val: number, h: number) => (1 - val / maxValue) * (h - 6) + 3;

  // --- drawing ---------------------------------------------------------------
  const draw = useCallback(() => {
    try {
      const st = useStore.getState();
      const v = st.view;
      const { w, h } = sizeRef.current;
      const colors = themeColors(st.settings.theme);
      const dpr = window.devicePixelRatio || 1;
      const canvas = baseRef.current;
      if (!canvas) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const gridStep = st.settings.triplet ? st.settings.gridPpq * (2 / 3) : st.settings.gridPpq;
      const drag = dragRef.current;
      const laneCount = Math.max(1, lanes.length);

      lanes.forEach((lane, li) => {
        const top = li * laneH;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, top, w, laneH);
        ctx.clip();
        ctx.translate(0, top);

        drawLaneBase(ctx, v, colors, w, laneH, gridStep);

        if (lane.kind === 'velocity') {
          const ov = drag?.kind === 'velocity' ? drag.overridesV : null;
          drawVelocityLane(ctx, v, colors, st.doc, new Set(st.selection), w, laneH, ov);
        } else {
          const cc = lane.kind === 'cc' ? lane.cc : -1;
          const raw = laneEvents(li);
          const previewPts = drag && drag.laneIndex === li ? drag.pending : [];
          const events = raw
            .map((e) => ({
              id: e.id,
              t: drag?.laneIndex === li ? (drag.overridesT.get(e.id) ?? e.t) : e.t,
              v: drag?.laneIndex === li ? (drag.overridesV.get(e.id) ?? e.v) : e.v,
            }))
            .concat(previewPts.map((p, i) => ({ id: -1000 - i, t: p.t, v: p.v })));
          drawCurveLane(ctx, v, colors, {
            events,
            maxValue: lane.kind === 'pb' ? 16383 : 127,
            selected: new Set(st.laneSelection),
            dragOverrides: null,
            dragPoints: null,
          }, w, laneH);

          // straight-line preview
          if (drawMode === 'line' && drag?.laneIndex === li && drag.anchor && drag.moved) {
            const y1 = yFromV(drag.anchor.v, laneH);
            const t1 = drag.overridesT.get(-1) ?? 0;
            ctx.strokeStyle = colors['accent'];
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(xOfPpq(v, drag.anchor.t), y1);
            ctx.lineTo(xOfPpq(v, t1), yFromV(vFromY(drag.startY, laneH), laneH));
            ctx.stroke();
            ctx.lineWidth = 1;
          }

          // lane badge
          if (laneCount > 1 || lane.kind === 'cc') {
            ctx.fillStyle = colors['ruler-text'];
            ctx.font = '9px system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(lane.kind === 'cc' ? `CC${cc}` : ti('lane.pb'), 4, 3);
          }
        }
        ctx.restore();
      });
    } catch (e) {
      // draw() runs from effects, ResizeObserver and pointer handlers — a bad
      // doc push must degrade to a hint, never kill the React tree
      console.error('lane draw failed', e);
      useStore.getState().setHint(ti('lane.drawError', { msg: e instanceof Error ? e.message : String(e) }));
    }
  }, [laneEvents, lanes, laneMode, drawMode]);

  useEffect(() => {
    try { draw(); } catch (e) {
      console.error('lane draw failed', e);
      useStore.getState().setHint(ti('lane.drawError', { msg: e instanceof Error ? e.message : String(e) }));
    }
  }, [draw, view, doc, selection, laneSelection, theme, laneMode, ccNumber]);

  // lane viewport size follows its container
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      sizeRef.current = { w: Math.floor(r.width), h: Math.floor(r.height) };
      draw();
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    apply();
    return () => ro.disconnect();
  }, [draw]);

  // playhead overlay (interpolated, same as the roll)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      try {
        const st = useStore.getState();
        const { w, h } = sizeRef.current;
        const canvas = overlayRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const t = st.transport;
        if (!t.ppqValid) return;
        const ppq = t.playing
          ? t.ppq + ((performance.now() - transportClock.lastEventAt) / 1000) * (t.tempo / 60)
          : t.ppq;
        const x = Math.round(xOfPpq(st.view, ppq)) + 0.5;
        if (x >= -2 && x <= w + 2) {
          ctx.fillStyle = themeColors(st.settings.theme)['playhead'];
          ctx.fillRect(x, 0, 1, h);
        }
      } catch (e) {
        console.error('lane overlay tick failed', e);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // --- interaction --------------------------------------------------------------
  const relative = (e: React.PointerEvent): { x: number; y: number; laneIndex: number; laneTop: number } => {
    const r = wrapRef.current!.getBoundingClientRect();
    const y = e.clientY - r.top;
    const idx = Math.min(lanes.length - 1, Math.max(0, Math.floor(y / laneH)));
    return { x: e.clientX - r.left, y: y - idx * laneH, laneIndex: idx, laneTop: idx * laneH };
  };

  const commitOps = (ops: EditOp[], name: string) => {
    useStore.getState().editDoc(ops, name);
  };

  // velocity freehand: paint the velocity of every note whose bar the stroke
  // segment [fromX..toX] sweeps over (interpolated so fast moves don't skip)
  const paintVelocity = (fromX: number, toX: number, y: number, drag: DragState, h: number) => {
    const st = useStore.getState();
    const v = st.view;
    const vel = Math.min(1, Math.max(0.02, 1 - y / (h - 4)));
    const lo = Math.min(fromX, toX);
    const hi = Math.max(fromX, toX);
    for (const n of st.doc.notes) {
      if (st.selection.length > 0 && !st.selection.includes(n.id)) continue;
      const barX = xOfPpq(v, n.s);
      const barW = Math.max(3, Math.min(n.l * v.pxPerPpq - 1, 16));
      const hitNow = toX >= barX - 3 && toX <= barX + barW + 3;
      const swept = barX <= hi && barX + barW >= lo;
      if (!hitNow && !swept) continue;
      const prevFired = drag.paintedVel.get(n.id) ?? -1;
      if (!drag.painted.has(n.id) || Math.abs(vel - prevFired) >= 0.05)
      {
        void getBridge().invoke('preview.note', { p: n.p, c: n.c, v: vel }).catch(() => {});
        drag.paintedVel.set(n.id, vel);
      }
      if (!drag.painted.has(n.id)) drag.startV.set(n.id, n.v);
      drag.painted.add(n.id);
      drag.overridesV.set(n.id, vel);
      drag.moved = true;
    }
    draw();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const st = useStore.getState();
    const pos = relative(e);
    const { x, y } = pos;
    const laneIndex = pos.laneIndex;
    const h = laneH;
    const v = st.view;

    const drag: DragState = {
      laneIndex, kind: laneMode === 'velocity' ? 'velocity' : 'curve',
      mode: 'move', ids: [], startV: new Map(), grabbedStartV: 0, startY: y,
      overridesV: new Map(), overridesT: new Map(), grabStartT: 0,
      moved: false, pending: [], anchor: null,
      painted: new Set(), paintedVel: new Map(), lastPaintX: x,
      lastFiredVel: -1,
    };

    if (laneMode === 'velocity' && drawMode === 'free') {
      // velocity freehand: sweep across bars to paint their velocities; with
      // an active selection only the selected notes are painted
      drag.mode = 'free';
      dragRef.current = drag;
      capturePointer(e.target as Element, e.pointerId);
      paintVelocity(x, x, y, drag, h);
      return;
    }

    if (laneMode === 'velocity') {
      // Overlapping bars: hit-test prefers SELECTED notes (they also draw on
      // top). With an active selection only selected notes are editable.
      const matches = st.doc.notes.filter((n) => {
        const barX = xOfPpq(v, n.s);
        const barW = Math.max(3, Math.min(n.l * v.pxPerPpq - 1, 16));
        return x >= barX - 3 && x <= barX + barW + 3;
      });
      if (matches.length === 0) return;

      if (st.selection.length > 0) {
        const selMatches = matches.filter((n) => st.selection.includes(n.id));
        if (selMatches.length === 0) return; // selection decides what is editable
        const hitSel = selMatches[selMatches.length - 1];
        drag.ids = [...st.selection];
        for (const id of drag.ids) {
          const n = st.doc.notes.find((nn) => nn.id === id);
          if (n) drag.startV.set(id, n.v);
        }
        drag.grabbedStartV = drag.startV.get(hitSel.id) ?? hitSel.v;
        drag.lastFiredVel = drag.grabbedStartV;
      } else {
        const hit = matches[matches.length - 1];
        st.setSelection([hit.id]); // clicking a bar selects its note first
        drag.ids = [hit.id];
        drag.startV.set(hit.id, hit.v);
        drag.grabbedStartV = hit.v;
        drag.lastFiredVel = hit.v;
      }
      drag.overridesV = new Map(drag.startV);
      drag.mode = 'move';
      dragRef.current = drag;
      capturePointer(e.target as Element, e.pointerId);
      return;
    }

    // --- cc / pb lanes ---
    const events = laneEvents(laneIndex);
    const selSet = new Set(st.laneSelection);
    let hit: { id: number; t: number; v: number } | null = null;
    let best = 81;
    for (const ev of events) {
      const px = xOfPpq(v, ev.t);
      const py = yFromV(ev.v, h);
      const d2 = (px - x) ** 2 + (py - y) ** 2;
      if (d2 < 81 && d2 < best) { best = d2; hit = ev; }
    }

    if (hit && e.altKey) {
      const op = laneMode === 'cc' ? 'removeManyCC' : 'removeManyPB';
      commitOps([{ op, ids: [hit.id] } as EditOp], laneMode === 'cc' ? ti('lane.deletedCcPoint') : ti('lane.deletedPbPoint'));
      st.setLaneSelection([]);
      return;
    }

    if (drawMode === 'free') {
      // freehand ignores the grid entirely: points land where the cursor is
      const t = Math.max(0, ppqAtX(v, x));
      drag.mode = 'free';
      drag.laneIndex = laneIndex;
      drag.pending = [{ t, v: vFromY(y, h) }];
      drag.grabStartT = t;
      dragRef.current = drag;
      capturePointer(e.target as Element, e.pointerId);
      draw();
      return;
    }

    if (drawMode === 'line') {
      const t = Math.max(0, snapPpq(ppqAtX(v, x), st.settings, 'floor'));
      drag.mode = 'line';
      drag.laneIndex = laneIndex;
      drag.anchor = { t, v: vFromY(y, h) };
      drag.overridesT.set(-1, t);
      dragRef.current = drag;
      capturePointer(e.target as Element, e.pointerId);
      return;
    }

    if (hit) {
      if (e.shiftKey) {
        st.setLaneSelection(selSet.has(hit.id)
          ? st.laneSelection.filter((i) => i !== hit!.id)
          : [...st.laneSelection, hit.id]);
      } else if (!selSet.has(hit.id)) {
        st.setLaneSelection([hit.id]);
      }
      drag.mode = 'move';
      drag.ids = [hit.id];
      drag.startV.set(hit.id, hit.v);
      drag.grabbedStartV = hit.v;
      drag.grabStartT = hit.t;
      drag.overridesV.set(hit.id, hit.v);
      drag.overridesT.set(hit.id, hit.t);
      dragRef.current = drag;
      capturePointer(e.target as Element, e.pointerId);
      return;
    }

    // point mode empty click: add a point
    const t = Math.max(0, snapPpq(ppqAtX(v, x), st.settings, 'floor'));
    const val = vFromY(y, h);
    if (laneMode === 'cc') {
      commitOps([{ op: 'addCC', ev: { cc: ccNumber, c: 1, t, v: val } }], ti('lane.addedCcPoint'));
    } else {
      commitOps([{ op: 'addPB', ev: { c: 1, t, v: val } }], ti('lane.addedPbPoint'));
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const pos = relative(e);
    const y = pos.y;
    const h = laneH;
    const st = useStore.getState();
    const v = st.view;

    if (drag.kind === 'velocity') {
      if (drag.mode === 'free') {
        const { x: px } = pos;
        paintVelocity(drag.lastPaintX, px, y, drag, h);
        drag.lastPaintX = px;
        return;
      }
      const newGrabbed = Math.min(1, Math.max(0.02, 1 - y / (h - 4)));
      const delta = newGrabbed - drag.grabbedStartV;
      drag.moved = true;
      for (const [id, startV] of drag.startV)
        drag.overridesV.set(id, Math.min(1, Math.max(0.02, startV + delta)));
      // audible feedback: re-trigger when the velocity moved by >= 0.04
      {
        const firstId = drag.ids[0] ?? drag.overridesV.keys().next().value;
        const curVel = firstId != null ? drag.overridesV.get(firstId) : undefined;
        if (curVel != null && Math.abs(curVel - drag.lastFiredVel) >= 0.04)
        {
          const note = st.doc.notes.find((nn) => nn.id === firstId);
          if (note)
          {
            void getBridge().invoke('preview.note', { p: note.p, c: note.c, v: curVel }).catch(() => {});
            drag.lastFiredVel = curVel;
          }
        }
      }
      draw();
      return;
    }

    const { x } = pos;
    const rawT = Math.max(0, ppqAtX(v, x));
    const val = vFromY(y, h);

    if (drag.mode === 'free') {
      // follow the cursor freely, with a density floor: points at least ~8px
      // AND 1/16 ppq apart, so a stroke can never stack hundreds of events
      const last = drag.pending[drag.pending.length - 1];
      const minSpacingPpq = Math.max(3 / v.pxPerPpq, 1 / 64);
      if (rawT - last.t >= minSpacingPpq) {
        drag.pending.push({ t: rawT, v: val });
        drag.moved = true;
        draw();
      }
      return;
    }

    if (drag.mode === 'line') {
      const t = Math.max(0, snapPpq(rawT, st.settings, 'round'));
      drag.overridesT.set(-1, t);
      drag.pending = [
        { t: drag.anchor!.t, v: drag.anchor!.v },
        { t, v: val },
      ];
      drag.moved = true;
      draw();
      return;
    }

    // move single point
    const id = drag.ids[0];
    const newT = Math.max(0, st.settings.snap ? snapPpq(rawT, st.settings, 'round') : rawT);
    drag.overridesT.set(id, newT);
    drag.overridesV.set(id, val);
    drag.moved = true;
    draw();
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const st = useStore.getState();

    if (drag.kind === 'velocity') {
      if (!drag.moved) return;
      const ops: EditOp[] = [{
        op: 'updateMany',
        notes: [...drag.overridesV].map(([id, vel]) => ({ id, v: +vel.toFixed(3) })),
      }];
      commitOps(ops, ti('lane.adjustVelocity'));
      return;
    }

    if (drag.mode === 'free' && drag.pending.length > 0) {
      // simplify before commit: drop interior points sitting on the straight
      // line between their neighbours (within tolerance) — same shape, fewer
      // events
      const pts = drag.pending;
      const tol = Math.max(1, maxValue / 96);
      const kept: Array<{ t: number; v: number }> = [pts[0]];
      for (let i = 1; i < pts.length - 1; i++) {
        const a = kept[kept.length - 1];
        const b = pts[i];
        const c = pts[i + 1];
        const f = c.t - a.t !== 0 ? (b.t - a.t) / (c.t - a.t) : 1;
        if (Math.abs(b.v - (a.v + (c.v - a.v) * f)) > tol) kept.push(b);
      }
      kept.push(pts[pts.length - 1]);
      const ops: EditOp[] = [];
      // paint-over: the stroke REPLACES existing points in its time range
      if (pts.length > 1) {
        const t0 = Math.min(pts[0].t, pts[pts.length - 1].t);
        const t1 = Math.max(pts[0].t, pts[pts.length - 1].t);
        const covered = laneMode === 'cc'
          ? doc.ccs.filter((e) => e.cc === ccNumber && e.t >= t0 && e.t <= t1)
          : doc.pbs.filter((e) => e.t >= t0 && e.t <= t1);
        if (covered.length > 0)
          ops.push(laneMode === 'cc'
            ? { op: 'removeManyCC' as const, ids: covered.map((e) => e.id) }
            : { op: 'removeManyPB' as const, ids: covered.map((e) => e.id) });
      }
      for (const p of kept)
        ops.push(laneMode === 'cc'
          ? { op: 'addCC' as const, ev: { cc: ccNumber, c: 1, t: p.t, v: p.v } }
          : { op: 'addPB' as const, ev: { c: 1, t: p.t, v: p.v } });
      commitOps(ops, ti('lane.free'));
      return;
    }

    if (drag.mode === 'line' && drag.moved && drag.pending.length === 2) {
      const [a, b] = drag.pending;
      const from = Math.min(a.t, b.t);
      const to = Math.max(a.t, b.t);
      const steps = Math.max(1, Math.round((to - from) / gridStepPpq(st.settings)));
      const ops: EditOp[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = from + ((to - from) * i) / steps;
        const f = to === from ? 0 : (t - a.t) / (b.t - a.t);
        const val = Math.round(a.v + (b.v - a.v) * f);
        ops.push(laneMode === 'cc'
          ? { op: 'addCC' as const, ev: { cc: ccNumber, c: 1, t, v: val } }
          : { op: 'addPB' as const, ev: { c: 1, t, v: val } });
      }
      commitOps(ops, ti('lane.lineFill'));
      return;
    }

    if (drag.mode === 'move' && drag.moved && drag.ids.length > 0) {
      const id = drag.ids[0];
      const t = drag.overridesT.get(id);
      const val = drag.overridesV.get(id);
      if (t == null || val == null) return;
      if (laneMode === 'cc') {
        commitOps([{ op: 'updateManyCC', evs: [{ id, t, v: val }] }], ti('lane.movedCcPoint'));
      } else {
        commitOps([{ op: 'updateManyPB', evs: [{ id, t, v: val }] }], ti('lane.movedPbPoint'));
      }
    }
  };

  const clearLane = (laneIndex: number) => {
    const st = useStore.getState();
    const ids = laneEvents(laneIndex).map((e) => e.id);
    if (ids.length === 0) return;
    if (laneMode === 'cc')
      commitOps([{ op: 'removeManyCC', ids }], ti('lane.clearedCcLane'));
    else if (laneMode === 'pb')
      commitOps([{ op: 'removeManyPB', ids }], ti('lane.clearedPbLane'));
    else st.setHint(ti('lane.velocityBelongsToNotes'));
  };

  const tabs: Array<{ id: LaneMode; label: string }> = [
    { id: 'velocity', label: 'lane.velocity' },
    { id: 'cc', label: 'CC' },
    { id: 'pb', label: 'lane.pb' },
    { id: 'lyric', label: 'lane.lyric' },
  ];

  return (
    <div className="lane-panel">
      <div className="lane-head">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`lane-tab ${laneMode === tab.id ? 'active' : ''}`}
            onClick={() => useStore.getState().setLaneMode(tab.id)}
          >
            {ti(tab.label)}
          </button>
        ))}
        {laneMode === 'cc' && (() => {
          const existingCcs = [...new Set(doc.ccs.map((e) => e.cc))].sort((a, b) => a - b);
          const ccName = (cc: number) => {
            const def = CC_CHOICES.find((c) => c.cc === cc);
            return def ? `${def.label} (CC${cc})` : `CC${cc}`;
          };
          return (
            <>
              <select
                className="tb-select lane-cc-select"
                title={ti('lane.switchCc')}
                value={String(ccNumber)}
                onChange={(e) => useStore.getState().setCcNumber(Number(e.target.value))}
              >
                {existingCcs.length === 0 && (
                  <option value={String(ccNumber)}>{ti('lane.noCcData')}</option>
                )}
                {existingCcs.map((cc) => (
                  <option key={cc} value={String(cc)}>{ccName(cc)}</option>
                ))}
                {/* a freshly created lane has no events yet — keep it visible
                    and selected until its first point lands */}
                {!existingCcs.includes(ccNumber) && existingCcs.length > 0 && (
                  <option value={String(ccNumber)}>{ccName(ccNumber)}</option>
                )}
              </select>
              <button className="mini-btn" title={ti('lane.addCc')}
                onClick={() => {
                  const unused = CC_CHOICES.find((c) => !existingCcs.includes(c.cc));
                  setNewCc(unused ? unused.cc : (existingCcs.length > 0 ? Math.max(...existingCcs) + 1 : 11));
                  setAddCcOpen(true);
                }}>+</button>
              <button
                className="mini-btn"
                title={ti('lane.removeCcTitle', { cc: ccNumber })}
                disabled={existingCcs.length === 0}
                onClick={() => {
                  const ids = doc.ccs.filter((e) => e.cc === ccNumber).map((e) => e.id);
                  if (ids.length > 0) {
                    commitOps([{ op: 'removeManyCC', ids }], ti('lane.clearedCcLane'));
                    useStore.getState().setHint(ti('lane.deletedCcLane', { cc: ccNumber }));
                  }
                }}
              >−</button>
            </>
          );
        })()}
        {laneMode === 'velocity' && (
          <select className="tb-select" title={ti('lane.drawMode')} value={drawMode === 'line' ? 'point' : drawMode}
            onChange={(e) => setDrawMode(e.target.value as typeof drawMode)}>
            <option value="point">{ti('lane.point')}</option>
            <option value="free">{ti('lane.free')}</option>
          </select>
        )}
        {laneMode === 'cc' && (
          <select className="tb-select" title={ti('lane.drawMode')} value={drawMode}
            onChange={(e) => setDrawMode(e.target.value as typeof drawMode)}>
            <option value="point">{ti('lane.point')}</option>
            <option value="line">{ti('lane.line')}</option>
            <option value="free">{ti('lane.free')}</option>
          </select>
        )}
        {laneMode === 'pb' && (
          <select className="tb-select" title={ti('lane.drawMode')} value={drawMode}
            onChange={(e) => setDrawMode(e.target.value as typeof drawMode)}>
            <option value="point">{ti('lane.point')}</option>
            <option value="line">{ti('lane.line')}</option>
            <option value="free">{ti('lane.free')}</option>
          </select>
        )}
        <span className="lane-hint">
          {laneMode === 'velocity'
            ? ti('lane.hintVelocity')
            : laneMode === 'cc'
              ? ti('lane.hintCc')
              : laneMode === 'lyric'
                ? ti('lane.hintLyric')
                : ti('lane.hintPb')}
        </span>
        <span className="lane-spring" />
        {laneMode === 'cc' ? (
          <button className="mini-btn" title={ti('lane.clearCcTitle', { cc: ccNumber })}
            onClick={() => {
              const ids = doc.ccs.filter((e) => e.cc === ccNumber).map((e) => e.id);
              if (ids.length > 0) commitOps([{ op: 'removeManyCC', ids }], ti('lane.clearedCcLane'));
            }}>{ti('lane.clear')}</button>
        ) : (
          <button className="mini-btn" onClick={() => clearLane(0)}>{ti('lane.clear')}</button>
        )}
      </div>
      {laneMode === 'lyric' && (() => {
        // Lyric strip aligned with the piano-roll timeline: one input per
        // note, positioned at its start; Enter commits and advances to the
        // next note to the right (fast syllable entry, SynthV-style).
        const px = view.pxPerPpq;
        const scrollX = view.scrollXPpq;
        const vis0 = scrollX - 0.5;
        const vis1 = scrollX + view.width / px;
        const ordered = [...doc.notes].sort((a, b) => a.s - b.s);
        const advance = (idx: number) => {
          const next = document.querySelector<HTMLInputElement>(
            `.lyric-strip input[data-i="${idx + 1}"]`);
          if (next) { next.focus(); next.select(); }
        };
        return (
          <div className="lyric-body" style={{ height: LANE_H }}>
            <div className="lyric-batch">
              <input className="lyric-batch-input" placeholder={ti('lane.lyricBatchHint')}
                ref={lyricBatchRef}
                onKeyDown={(e) => { if (e.key === 'Enter') applyLyricBatch(); }} />
              <div className="lyric-split">
                <button className={`mini-btn ${lyricSplit === 'space' ? 'active' : ''}`}
                  title={ti('lane.lyricSplitSpace')}
                  onClick={() => setLyricSplit('space')}>{ti('lane.lyricSplitSpace')}</button>
                <button className={`mini-btn ${lyricSplit === 'char' ? 'active' : ''}`}
                  title={ti('lane.lyricSplitChar')}
                  onClick={() => setLyricSplit('char')}>{ti('lane.lyricSplitChar')}</button>
              </div>
              <button className="mini-btn primary" onClick={applyLyricBatch}>{ti('lane.lyricApply')}</button>
              <span className="lyric-hint">{ti('lane.hintLyric')}</span>
            </div>
            <div className="lyric-strip">
              <div className="lyric-strip-inner" style={{ transform: `translateX(${-scrollX * px}px)` }}>
                {ordered.map((n, idx) => {
                  const x = n.s * px;
                  if (x < vis0 * px - 160 || x > vis1 * px + 160) return null;
                  const w = Math.max(14, Math.min(n.l * px - 4, 220));
                  return (
                    <div key={n.id} className={`lyric-cell ${selection.includes(n.id) ? 'sel' : ''}`}
                      style={{ left: x, width: w }} title={`p=${n.p}`}>
                      <input data-i={ordered.indexOf(n)} value={n.ly ?? ''}
                        onChange={(e) => {
                          useStore.getState().editDoc(
                            [{ op: 'update' as const, note: { id: n.id, ly: e.target.value } }],
                            ti('lane.lyricEdit'));
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            useStore.getState().editDoc(
                              [{ op: 'update' as const, note: { id: n.id, ly: (e.target as HTMLInputElement).value } }],
                              ti('lane.lyricEdit'));
                            advance(ordered.indexOf(n));
                          }
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}
      {laneMode !== 'lyric' && (
        <div
          ref={wrapRef}
          className="lane-body"
          style={{ height: LANE_H }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        >
          <canvas ref={baseRef} className="lane-canvas" />
          <canvas ref={overlayRef} className="lane-canvas" />
        </div>
      )}
      {addCcOpen && (
        <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) setAddCcOpen(false); }}>
          <div className="modal cc-add-modal">
            <div className="modal-head">
              <strong>{ti('lane.addCcTitle')}</strong>
              <button className="tb-btn" onClick={() => setAddCcOpen(false)} title={ti('lane.close')}>✕</button>
            </div>
            <div className="modal-body">
              <div className="cc-add-grid">
                {CC_CHOICES.map((c) => (
                  <button
                    key={c.cc}
                    className={`mini-btn ${newCc === c.cc ? 'primary' : ''}`}
                    disabled={doc.ccs.some((e) => e.cc === c.cc)}
                    title={doc.ccs.some((e) => e.cc === c.cc) ? ti('lane.ccInUse') : ''}
                    onClick={() => setNewCc(c.cc)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="settings-row">
                <span className="settings-label">{ti('lane.anyNumber')}</span>
                <input
                  className="lane-cc-input"
                  type="number" min={0} max={127}
                  value={newCc}
                  onChange={(e) => setNewCc(Math.min(127, Math.max(0, Number(e.target.value) || 0)))}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button className="mini-btn" onClick={() => setAddCcOpen(false)}>{ti('lane.cancel')}</button>
              <button
                className="mini-btn primary"
                onClick={() => {
                  useStore.getState().setCcNumber(newCc);
                  setAddCcOpen(false);
                }}
              >{ti('lane.create')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function capturePointer(target: Element, pointerId: number): void {
  try { target.setPointerCapture(pointerId); } catch { /* synthetic or already-released pointer */ }
}
