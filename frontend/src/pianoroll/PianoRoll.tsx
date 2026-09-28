import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge } from '../bridge/bridge';
import type { MidiInEvent, Note } from '../bridge/protocol';
import { gridStepPpq, midiBus, snapPpq, snapPpqDrum, transportClock, useStore } from '../state/store';
import { runAction } from '../state/dispatch';
import type { EditOp } from '../bridge/protocol';
import { t } from '../i18n';
import { bindingFromWheel, resolveShortcuts } from '../state/shortcuts';
import { themeColors } from '../ui/themes';
import {
  chordPcsAt, drawChordLane, drawGridLines, drawKeys, drawMinimap, drawNotes, drawOverlay,
  drawRollBackground, drawRuler,
  setCustomDrumNames,
} from './render';
import {
  KEYS_WIDTH, ppqAtX, RULER_HEIGHT, barPpqOf, xOfPpq, pitchAtY, floatPitchAtY,
} from './ViewMap';

export const CHORD_LANE_HEIGHT = 34;
export const MINIMAP_H = 24;

interface Marquee {
  x0: number; y0: number; x1: number; y1: number;
  additive: boolean;
  startIds: number[];
}

interface DragState {
  mode: 'move' | 'resize' | 'marquee' | 'range' | 'draw' | 'spray' | 'erase';
  duplicate: boolean;
  startX: number; startY: number;
  ids: number[];
  originals: Map<number, { s: number; p: number; l: number }>;
  ghosts: Map<number, { s: number; p: number; l: number }>;
  newNotes: Array<{ p: number; s: number; l: number; v: number; m: boolean; c: number; a: number }>;
  eraseIds: Set<number>;
  additive: boolean;
  startIds: number[];
  lastSprayCell: number | null;
  moved: boolean;
  lastPreviewPitch: number;
}

const lastDrawLen = { value: 0.5 }; // pencil remembers the last drawn length
function setupCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function PianoRoll(): React.ReactElement {
  const view = useStore((s) => s.view);
  const doc = useStore((s) => s.doc);
  const settings = useStore((s) => s.settings);
  const selection = useStore((s) => s.selection);
  const theme = useStore((s) => s.settings.theme);
  const activeTool = useStore((s) => s.activeTool);
  const chordSelection = useStore((s) => s.chordSelection);
  const drumMode = useStore((s) => s.drumMode);

  const rootRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const chordWrapRef = useRef<HTMLDivElement>(null);
  const chordRef = useRef<HTMLCanvasElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  const notesRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const marqueeRef = useRef<Marquee | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const chordDragRef = useRef<{ mode: 'move' | 'resize'; id: number; startX: number; startS: number; startL: number; ghost: { id: number; s: number; l: number } | null; moved: boolean } | null>(null);
  const razorHoverRef = useRef<number | null>(null);
  // pencil/spray creation ghost: the exact spot (after snap + chord assist)
  // where the next click would create a note
  const ghostRef = useRef<{ p: number; s: number; l: number } | null>(null);
  const pressedRef = useRef<Map<number, number>>(new Map());
  const dragAuditionRef = useRef(false);
  const dragCursorRef = useRef(false);
  const panRef = useRef<{ x: number; y: number; scrollXPpq: number; scrollYPx: number } | null>(null);
  const lastEmptyClick = useRef({ t: -1e9, x: 0, y: 0 });
  const miniDragRef = useRef(false);
  const miniRef = useRef<HTMLCanvasElement>(null);
  const contentEndRef = useRef(32);
  const drumMap = useStore((st) => st.drumMap);
  useEffect(() => {
    const names: Record<number, string> = {};
    for (const e of drumMap.entries) names[e.i] = e.name;
    setCustomDrumNames(drumMap.entries.length > 0 ? names : null);
    draw();
  }, [drumMap]);

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; ppq: number; noteId: number | null } | null>(null);
  const [lyricFromModal, setLyricFromModal] = useState<number | null>(null);
  const [lyricFromText, setLyricFromText] = useState('');
  const [lyricFromSplit, setLyricFromSplit] = useState<'space' | 'char'>('char');

  const commitLyricFrom = () => {
    if (lyricFromModal == null) return;
    const st = useStore.getState();
    const ordered = [...st.doc.notes].sort((x, y) => x.s - y.s);
    const startIdx = ordered.findIndex((x) => x.id === lyricFromModal);
    const targets = startIdx >= 0 ? ordered.slice(startIdx) : [];
    const syllables = lyricFromSplit === 'char'
      ? Array.from(lyricFromText.replace(/\s+/g, ''))
      : lyricFromText.trim().split(/\s+/).filter(Boolean);
    const ops: EditOp[] = [];
    for (let i = 0; i < targets.length && i < syllables.length; i++)
      ops.push({ op: 'update' as const, note: { id: targets[i].id, ly: syllables[i] } });
    if (ops.length > 0) {
      st.editDoc(ops, t('lane.lyricApply'));
      st.setHint(t('lane.lyricApplied', { count: ops.length }));
    }
    setLyricFromModal(null);
  };

  // --- viewport size --------------------------------------------------------
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const apply = () => {
      const r = el.getBoundingClientRect();
      useStore.getState().setViewport(Math.floor(r.width), Math.floor(r.height));
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    apply();
    return () => ro.disconnect();
  }, []);

  // --- static layers (grid / keys / ruler / chords / notes) ------------------
  const draw = useCallback(() => {
    try {
      const st = useStore.getState();
      const v = st.view;
      const colors = themeColors(theme);
      const bar = barPpqOf(st.transport.sigNum, st.transport.sigDen);

    const grid = gridRef.current && setupCanvas(gridRef.current, v.width, v.height);
    if (grid) {
      drawRollBackground(grid, v, colors);
      drawGridLines(grid, v, colors, gridStepPpq(st.settings), v.height, bar);
    }
    const keys = keysRef.current && setupCanvas(keysRef.current, KEYS_WIDTH, v.height);
    if (keys) drawKeys(keys, v, colors, KEYS_WIDTH, v.height, new Set(pressedRef.current.keys()), st.drumMode);

    const ruler = rulerRef.current && setupCanvas(rulerRef.current, v.width, RULER_HEIGHT);
    if (ruler) {
      const t = st.transport;
      drawRuler(ruler, v, colors, v.width, RULER_HEIGHT, {
        valid: t.loopValid, start: t.loopStart, end: t.loopEnd,
      }, bar, st.editCursorPpq);
    }

    // chord lane
    const chordLane = chordRef.current && setupCanvas(chordRef.current, v.width, CHORD_LANE_HEIGHT);
    if (chordLane) {
      drawChordLane(chordLane, v, colors, st.doc.chords, new Set(st.chordSelection),
        v.width, CHORD_LANE_HEIGHT, chordDragRef.current?.ghost ?? null);
    }

    // notes (with drag previews)
    const drag = dragRef.current;
    const overrides = drag && (drag.mode === 'move' || drag.mode === 'resize')
      ? new Map(drag.ghosts) : null;
    const erased = drag && drag.mode === 'erase' ? drag.eraseIds : null;
    const ghosts: Note[] = drag && (drag.mode === 'draw' || drag.mode === 'spray')
      ? drag.newNotes.map((n, i) => ({
          id: -1 - i, p: n.p, s: n.s, l: n.l, v: n.v, m: false, c: n.c, a: n.a,
        }))
      : [];
    const effectiveNotes = st.doc.notes
      .filter((n) => erased == null || !erased.has(n.id))
      .map((n) => {
        const g = overrides?.get(n.id);
        return g ? { ...n, s: g.s, p: g.p, l: g.l } : n;
      });
    const notes = notesRef.current && setupCanvas(notesRef.current, v.width, v.height);
    if (notes) {
      const artNames = new Map<number, string>();
      for (const a of st.doc.articulations) artNames.set(a.id, a.n);
      drawNotes(notes, v, colors, { ...st.doc, notes: effectiveNotes },
        new Set(st.selection), ghosts, st.drumMode, artNames);
    }

    // minimap overview
    const mini = miniRef.current && setupCanvas(miniRef.current, v.width, MINIMAP_H);
    if (mini) {
      contentEndRef.current = Math.max(contentEndRef.current,
        st.doc.notes.reduce((m, n) => Math.max(m, n.s + n.l), 0) + 4);
      drawMinimap(mini, colors, v.width, MINIMAP_H, st.doc.notes, contentEndRef.current,
        v.scrollXPpq, v.scrollXPpq + v.width / v.pxPerPpq);
    }
    } catch (e) {
      // draw() runs from effects and ResizeObserver — degrade to a hint
      console.error('roll draw failed', e);
      useStore.getState().setHint(t('pr.drawError', { msg: e instanceof Error ? e.message : String(e) }));
    }
  }, [theme]);

  useEffect(() => {
    try { draw(); } catch (e) {
      // a bad doc push must never kill the React tree (boundaries don't
      // catch effect errors) — degrade to a status hint
      console.error('roll draw failed', e);
      useStore.getState().setHint(t('pr.drawError', { msg: e instanceof Error ? e.message : String(e) }));
    }
  }, [draw, view, doc, settings, selection, chordSelection, drumMode]);

  // --- overlay animation loop (playhead, marquee, follow, razor hint) --------
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      try {
        const st = useStore.getState();
        const v = st.view;
        const overlay = overlayRef.current && setupCanvas(overlayRef.current, v.width, v.height);
        if (!overlay) return;
        const colors = themeColors(st.settings.theme);

        const t = st.transport;
        let playheadPpq: number | null = null;
        if (t.internalPlaying) {
          // the plugin's own play button: follow the internal transport cursor
          playheadPpq = t.internalPpq;
        } else if (t.auditioning) {
          // audition scrub: the cursor walks from the held position
          playheadPpq = t.auditionPpq;
        } else if (t.ppqValid) {
          playheadPpq = t.playing
            ? t.ppq + ((performance.now() - transportClock.lastEventAt) / 1000) * (t.tempo / 60)
            : t.ppq;
        }

        if ((t.internalPlaying || t.auditioning || t.playing) && st.followPlayhead && playheadPpq != null) {
          const x = xOfPpq(v, playheadPpq);
          if (x > v.width * 0.92 || x < -4) {
            st.setView({ scrollXPpq: Math.max(-0.5, playheadPpq - (v.width * 0.1) / v.pxPerPpq) });
          }
        }

        if (pressedRef.current.size > 0) {
          const now = performance.now();
          let changed = false;
          for (const [p, until] of pressedRef.current) {
            if (until < now) { pressedRef.current.delete(p); changed = true; }
          }
          if (changed) {
            const keys = keysRef.current && setupCanvas(keysRef.current, KEYS_WIDTH, v.height);
            if (keys) drawKeys(keys, v, colors, KEYS_WIDTH, v.height, new Set(pressedRef.current.keys()), st.drumMode);
          }
        }

        drawOverlay(overlay, v, colors, v.width, v.height, {
          playheadPpq,
          editCursorPpq: st.editCursorPpq,
          marquee: marqueeRef.current,
          stepCursorPpq: st.activeTool === 'step' ? st.editCursorPpq : null,
          razorHoverPpq: st.activeTool === 'razor' ? razorHoverRef.current : null,
          createGhost: (st.activeTool === 'pencil' || st.activeTool === 'spray') && !dragRef.current ? ghostRef.current : null,
          drumMode: st.drumMode,
        });
        if (st.activeTool !== 'pencil' && st.activeTool !== 'spray') ghostRef.current = null;
      } catch (e) {
        console.error('overlay tick failed', e);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // --- midi input: pressed-key highlight + step input -------------------------
  useEffect(() => {
    const sub = (events: MidiInEvent[]) => {
      const st = useStore.getState();
      const now = performance.now();
      for (const e of events) {
        if (e.on) pressedRef.current.set(e.p, now + 400);
        else pressedRef.current.set(e.p, now);
        if (st.activeTool === 'step' && e.on) {
          const len = gridStepPpq(st.settings);
          st.editDoc([{
            op: 'add',
            note: { p: e.p, s: st.editCursorPpq, l: len, v: Math.max(0.1, e.v), m: false, c: 1, a: st.activeArticulation ?? -1 },
          }], t('tb.tool.step'));
          st.setEditCursor(st.editCursorPpq + len);
        }      }
    };
    midiBus.subs.add(sub);
    return () => { midiBus.subs.delete(sub); };
  }, []);

  // --- wheel: bindings -> scroll / zoom ---------------------------------------
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const st = useStore.getState();
      const map = resolveShortcuts(st.settings.shortcuts);
      const wb = bindingFromWheel(e);
      const has = (id: string) => {
        const b = map[id];
        return b?.type === 'wheel'
          && b.ctrl === wb.ctrl && b.alt === wb.alt && b.shift === wb.shift;
      };
      const v = st.view;
      const factor = Math.exp(-e.deltaY * 0.0016);
      const rect = viewRef.current!.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (has('wheel.zoomH')) {
        const anchorPpq = ppqAtX(v, mx);
        const px = v.pxPerPpq * factor;
        st.setView({ pxPerPpq: px, scrollXPpq: anchorPpq - mx / px });
        return;
      }
      if (has('wheel.zoomV')) {
        const fp = floatPitchAtY(v, my);
        const rh = v.rowHeight * factor;
        st.setView({ rowHeight: rh, scrollYPx: v.scrollYPx + (127 - fp) * (rh - v.rowHeight) });
        return;
      }
      if (has('wheel.scrollH') || has('wheel.scrollHShift')) {
        st.setView({ scrollXPpq: v.scrollXPpq + (e.deltaY + e.deltaX) / v.pxPerPpq });
        return;
      }
      if (has('wheel.scrollV')) {
        st.setView({ scrollYPx: v.scrollYPx + e.deltaY });
        return;
      }
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        st.setView({ scrollXPpq: v.scrollXPpq + e.deltaX / v.pxPerPpq });
      } else {
        st.setView({ scrollYPx: v.scrollYPx + e.deltaY });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    // middle click must not start the browser's autoscroll — it pans the roll
    const onMidDown = (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); };
    const onAux = (e: Event) => e.preventDefault();
    el.addEventListener('mousedown', onMidDown);
    el.addEventListener('auxclick', onAux);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onMidDown);
      el.removeEventListener('auxclick', onAux);
    };
  }, []);

  // --- shared helpers -----------------------------------------------------------
  const rollRelative = (e: React.PointerEvent | React.MouseEvent): { x: number; y: number } => {
    const r = viewRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const hitNote = (x: number, y: number) => {
    const st = useStore.getState();
    const pitch = pitchAtY(st.view, y);
    const ppq = ppqAtX(st.view, x);
    const notes = st.doc.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.p !== pitch) continue;
      if (ppq >= n.s && ppq <= n.s + n.l) return n;
    }
    return null;
  };

  const makeDrag = (mode: DragState['mode'], startX: number, startY: number): DragState => ({
    mode, duplicate: false, startX, startY,
    ids: [], originals: new Map(), ghosts: new Map(), newNotes: [],
    eraseIds: new Set(), additive: false, startIds: [],
    lastSprayCell: null, moved: false, lastPreviewPitch: -1,
  });

  /** True while the configured snap-bypass modifier is held (live per event). */
  const snapBypassed = (e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean }): boolean => {
    const mod = useStore.getState().settings.snapBypass ?? 'shift';
    if (mod === 'none') return false;
    if (mod === 'shift') return e.shiftKey;
    if (mod === 'alt') return e.altKey;
    return e.ctrlKey;
  };

  /** Start moving/resizing an existing note (shared by arrow + pencil tools). */
  const beginNoteDrag = (hit: Note, e: React.PointerEvent, x: number, y: number) => {
    const st = useStore.getState();
    const v = st.view;
    const drag = makeDrag(x >= xOfPpq(v, hit.s + hit.l) - 6 ? 'resize' : 'move', x, y);
    drag.duplicate = e.altKey;
    if (st.selection.includes(hit.id)) {
      drag.ids = [...st.selection];
    } else {
      drag.ids = [hit.id];
      if (!e.shiftKey) st.setSelection([hit.id]);
      else { st.setSelection([...st.selection, hit.id]); drag.ids = [...st.selection, hit.id]; }
    }
    for (const id of drag.ids) {
      const n = st.doc.notes.find((nn) => nn.id === id);
      if (n) {
        drag.originals.set(id, { s: n.s, p: n.p, l: n.l });
        drag.ghosts.set(id, { s: n.s, p: n.p, l: n.l });
      }
    }
    if (e.altKey && !st.selection.includes(hit.id)) drag.ids = [hit.id];
    dragRef.current = drag;
    capturePointer(e.target as Element, e.pointerId);
  };

  /** Chord assist: snap the pitch to the nearest chord tone at time t. */
  const assistPitch = (pitch: number, t: number): number => {
    const st = useStore.getState();
    if (!st.chordAssist) return pitch;
    const pcs = chordPcsAt(st.doc.chords, t);
    if (!pcs || pcs.has(((pitch % 12) + 12) % 12)) return pitch;
    let best = pitch;
    let bestD = 13;
    for (let d = 0; d <= 6; d++) {
      for (const dir of [1, -1]) {
        const cand = pitch + d * dir;
        if (cand < 0 || cand > 127) continue;
        if (pcs.has(((cand % 12) + 12) % 12) && d < bestD) { best = cand; bestD = d; }
      }
    }
    return best;
  };

  // --- roll pointer handling (select / range / pencil / spray / razor / eraser / audition)
  const onRollPointerDown = (e: React.PointerEvent) => {
    // middle button: free pan (vertical + horizontal), DAW-style
    if (e.button === 1) {
      e.preventDefault();
      const st = useStore.getState();
      panRef.current = {
        x: e.clientX, y: e.clientY,
        scrollXPpq: st.view.scrollXPpq, scrollYPx: st.view.scrollYPx,
      };
      const el = viewRef.current;
      if (el) el.dataset.hcursor = 'pan';
      capturePointer(e.target as Element, e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const st = useStore.getState();
    const { x, y } = rollRelative(e);
    const tool = st.activeTool;
    const v = st.view;
    const ppq = ppqAtX(v, x);
    const pitch = pitchAtY(v, y);

    switch (tool) {
      case 'select': {
        const hit = hitNote(x, y);
        if (hit) {
          beginNoteDrag(hit, e, x, y);
          return;
        }
        // double-click on empty space creates a note at the grid position
        // (pointerdown has no click count, so detect it by timing)
        const now = performance.now();
        const isDbl = now - lastEmptyClick.current.t < 350
          && Math.abs(x - lastEmptyClick.current.x) < 5
          && Math.abs(y - lastEmptyClick.current.y) < 5;
        lastEmptyClick.current = { t: now, x, y };
        if (isDbl) {
          const drawS = st.drumMode
            ? snapPpqDrum(ppq, st.settings)
            : snapPpq(ppq, st.settings, 'floor');
          const dblP = assistPitch(pitch, drawS);
          st.editDoc([{
            op: 'add',
            note: { p: dblP, s: drawS, l: lastDrawLen.value, v: 0.8, m: false, c: 1, a: st.activeArticulation ?? -1 },
          }], t('pr.dblClickCreate'));
          void getBridge().invoke('preview.note', { p: dblP, c: 1, v: 0.8 }).catch(() => {});
          draw();
          return;
        }
        marqueeRef.current = {
          x0: x, y0: y, x1: x, y1: y,
          additive: e.shiftKey,
          startIds: e.shiftKey ? [...st.selection] : [],
        };
        if (!e.shiftKey) st.setSelection([]);
        capturePointer(e.target as Element, e.pointerId);
        return;
      }

      case 'range': {
        marqueeRef.current = {
          x0: x, y0: 0, x1: x, y1: v.height,
          additive: e.shiftKey,
          startIds: e.shiftKey ? [...st.selection] : [],
        };
        if (!e.shiftKey) st.setSelection([]);
        capturePointer(e.target as Element, e.pointerId);
        return;
      }

      case 'pencil': {
        // clicking an existing note drags it instead of drawing over it
        const hit = hitNote(x, y);
        if (hit) {
          beginNoteDrag(hit, e, x, y);
          draw();
          return;
        }
        const step = gridStepPpq(st.settings);
        const bypass = snapBypassed(e);
        const drag = makeDrag('draw', x, y);
        const drawS = st.drumMode && !bypass
          ? snapPpqDrum(ppq, st.settings)
          : bypass ? ppq : snapPpq(ppq, st.settings, 'floor');
        drag.newNotes = [{
          p: assistPitch(pitch, drawS), s: drawS,
          l: lastDrawLen.value, v: 0.8, m: false, c: 1, a: st.activeArticulation ?? -1,
        }];
        drag.moved = false;
        dragRef.current = drag;
        capturePointer(e.target as Element, e.pointerId);
        void step;
        // audible feedback: the created pitch sounds briefly downstream
        void getBridge().invoke('preview.note', { p: drag.newNotes[0].p, c: 1, v: 0.8 }).catch(() => {});
        draw();
        return;
      }

      case 'spray': {
        const step = gridStepPpq(st.settings);
        const drag = makeDrag('spray', x, y);
        const cell = st.drumMode && !snapBypassed(e) ? snapPpqDrum(ppq, st.settings) : snapPpq(ppq, st.settings, 'floor');
        const sprayP = assistPitch(pitch, cell);
        drag.newNotes = [{ p: sprayP, s: cell, l: step, v: 0.8, m: false, c: 1, a: st.activeArticulation ?? -1 }];
        void getBridge().invoke('preview.note', { p: sprayP, c: 1, v: 0.8 }).catch(() => {});
        drag.lastSprayCell = cell;
        dragRef.current = drag;
        capturePointer(e.target as Element, e.pointerId);
        draw();
        return;
      }

      case 'razor': {
        const hit = hitNote(x, y);
        if (!hit) return;
        const split = snapBypassed(e) ? ppq : snapPpq(ppq, st.settings, 'round');
        if (split > hit.s + 1e-6 && split < hit.s + hit.l - 1e-6) {
          st.editDoc([
            { op: 'update', note: { id: hit.id, l: split - hit.s } },
            {
              op: 'add',
              note: { p: hit.p, s: split, l: hit.s + hit.l - split, v: hit.v, m: hit.m, c: hit.c, a: hit.a },
            },
          ], t('pr.splitNote'));
        }
        return;
      }

      case 'eraser': {
        const drag = makeDrag('erase', x, y);
        dragRef.current = drag;
        capturePointer(e.target as Element, e.pointerId);
        eraseAt(x, y);
        return;
      }

      case 'audition': {
        dragAuditionRef.current = true;
        capturePointer(e.target as Element, e.pointerId);
        void getBridge().invoke('audition.start', { ppq: ppq }).catch(() => {});
        return;
      }
    }
  };

  const eraseAt = (x: number, y: number) => {
    const hit = hitNote(x, y);
    if (hit && dragRef.current) {
      dragRef.current.eraseIds.add(hit.id);
      dragRef.current.moved = true;
      draw();
    }
  };

  const onRollPointerMove = (e: React.PointerEvent) => {
    const st = useStore.getState();
    const { x, y } = rollRelative(e);
    const v = st.view;
    const drag = dragRef.current;

    // middle-button pan
    const pan = panRef.current;
    if (pan) {
      st.setView({
        scrollXPpq: pan.scrollXPpq - (e.clientX - pan.x) / v.pxPerPpq,
        scrollYPx: pan.scrollYPx - (e.clientY - pan.y),
      });
      return;
    }

    // creation ghost for pencil / spray: preview the exact note the next
    // click would draw (snap + chord assist applied), live under the cursor
    if (!drag && !marqueeRef.current && (st.activeTool === 'pencil' || st.activeTool === 'spray')) {
      const drumSnap = st.drumMode;
      const gs = !st.settings.snap || snapBypassed(e)
        ? ppqAtX(v, x)
        : drumSnap ? snapPpqDrum(ppqAtX(v, x), st.settings) : snapPpq(ppqAtX(v, x), st.settings, 'floor');
      const gl = st.activeTool === 'spray' ? gridStepPpq(st.settings) : lastDrawLen.value;
      ghostRef.current = { p: assistPitch(pitchAtY(v, y), gs), s: gs, l: gl };
    }

    // hover feedback: resize edge / movable note under the cursor
    if (!drag && !marqueeRef.current && (st.activeTool === 'select' || st.activeTool === 'pencil')) {
      const hit = hitNote(x, y);
      const el = viewRef.current;
      if (el) {
        if (hit) el.dataset.hcursor = x >= xOfPpq(v, hit.s + hit.l) - 6 ? 'resize' : 'move';
        else delete el.dataset.hcursor;
      }
    }

    if (dragAuditionRef.current && st.activeTool === 'audition') {
      void getBridge().invoke('audition.start', { ppq: ppqAtX(v, x) }).catch(() => {});
      return;
    }

    if (st.activeTool === 'razor' && !drag) {
      razorHoverRef.current = snapPpq(ppqAtX(v, x), st.settings, 'round');
      return;
    }

    // marquee growth (select / range tools)
    const m = marqueeRef.current;
    if (m) {
      marqueeRef.current = {
        ...m,
        x1: x,
        y1: st.activeTool === 'range' ? m.y1 : y,
      };
      return;
    }

    if (!drag) return;

    const bypass = snapBypassed(e);
    const dPpq = (x - drag.startX) / v.pxPerPpq;
    const dPitch = Math.round(-(y - drag.startY) / v.rowHeight);

    switch (drag.mode) {
      case 'move':
      case 'resize':
      {
        for (const [id, orig] of drag.originals)
        {
          if (drag.mode === 'move') {
            const ns = st.settings.snap && !bypass ? snapPpq(orig.s + dPpq, st.settings, 'round') : orig.s + dPpq;
            const rawPitch = Math.min(127, Math.max(0, orig.p + dPitch));
            // chord assist applies while dragging too — snap the moved pitch
            // into the chord under the note's new start time
            const np = bypass ? rawPitch : assistPitch(rawPitch, Math.max(0, ns));
            const g = drag.ghosts.get(id)!;
            drag.ghosts.set(id, { s: Math.max(0, ns), p: np, l: g.l });
          } else {
            const end = bypass ? orig.s + orig.l + dPpq : snapPpq(orig.s + orig.l + dPpq, st.settings, 'round');
            const g = drag.ghosts.get(id)!;
            drag.ghosts.set(id, { s: g.s, p: g.p, l: Math.max(gridStepPpq(st.settings), end - g.s) });
          }
        }
        // audible drag: sound the (first) dragged note whenever its pitch changes
        for (const [id, g] of drag.ghosts)
        {
          if (g.p !== drag.lastPreviewPitch)
          {
            const note = st.doc.notes.find((nn) => nn.id === id);
            if (note)
            {
              void getBridge().invoke('preview.note', { p: g.p, c: note.c, v: note.v }).catch(() => {});
              drag.lastPreviewPitch = g.p;
            }
          }
          break; // preview only the first (grabbed) note
        }
        drag.moved = true;
        draw();
        break;
      }
      case 'draw': {
        const n0 = drag.newNotes[0];
        const rawEnd = ppqAtX(v, x);
        const end = bypass ? rawEnd : snapPpq(rawEnd, st.settings, 'round');
        const step = gridStepPpq(st.settings);
        const l = Math.max(step, end - n0.s);
        if (l !== n0.l) {
          n0.l = l;
          drag.moved = true;
          draw();
        }
        break;
      }
      case 'spray': {
        const step = gridStepPpq(st.settings);
        const rawPitch = pitchAtY(v, y);
        const pitch = assistPitch(rawPitch, snapPpq(ppqAtX(v, x), st.settings, 'floor'));
        const cell = st.drumMode && !bypass ? snapPpqDrum(ppqAtX(v, x), st.settings) : snapPpq(ppqAtX(v, x), st.settings, 'floor');
        const from = Math.round((drag.lastSprayCell ?? cell) / step);
        const to = Math.round(cell / step);
        const dir = Math.sign(to - from);
        let sprayed = false;
        for (let idx = from + dir; dir !== 0 ? (dir > 0 ? idx <= to : idx >= to) : false; idx += dir) {
          const s = idx * step;
          if (!drag.newNotes.some((n) => Math.abs(n.s - s) < 1e-9 && n.p === pitch)) {
            drag.newNotes.push({ p: pitch, s, l: step, v: 0.8, m: false, c: 1, a: st.activeArticulation ?? -1 });
            sprayed = true;
          }
        }
        if (sprayed)
          void getBridge().invoke('preview.note', { p: pitch, c: 1, v: 0.8 }).catch(() => {});
        if (to !== from) drag.lastSprayCell = cell;
        drag.moved = true;
        draw();
        break;
      }
      case 'erase':
        eraseAt(x, y);
        break;
    }
  };

  const onRollPointerUp = () => {
    const st = useStore.getState();
    if (panRef.current) {
      panRef.current = null;
      const el = viewRef.current;
      if (el) delete el.dataset.hcursor;
      return;
    }
    if (dragAuditionRef.current) {
      dragAuditionRef.current = false;
      void getBridge().invoke('audition.stop').catch(() => {});
    }
    const drag = dragRef.current;
    dragRef.current = null;

    const m = marqueeRef.current;
    if (m) {
      marqueeRef.current = null;
      const v = st.view;
      const ppq0 = Math.min(ppqAtX(v, m.x0), ppqAtX(v, m.x1));
      const ppq1 = Math.max(ppqAtX(v, m.x0), ppqAtX(v, m.x1));
      const isRange = st.activeTool === 'range';
      const p0 = isRange ? 0 : pitchAtY(v, Math.max(m.y0, m.y1));
      const p1 = isRange ? 127 : pitchAtY(v, Math.min(m.y0, m.y1));
      const inside = st.doc.notes
        .filter((n) => n.s + n.l >= ppq0 && n.s <= ppq1 && n.p >= p0 && n.p <= p1)
        .map((n) => n.id);
      st.setSelection(m.additive ? [...new Set([...m.startIds, ...inside])] : inside);
      return;
    }

    if (!drag) return;

    switch (drag.mode) {
      case 'move':
      {
        if (!drag.moved) break;
        if (drag.duplicate) {
          const ops = drag.ids.map((id) => {
            const o = drag.originals.get(id)!;
            const g = drag.ghosts.get(id)!;
            const src = st.doc.notes.find((n) => n.id === id)!;
            return { op: 'add' as const, note: { p: g.p, s: g.s, l: o.l, v: src.v, m: src.m, c: src.c, a: src.a } };
          });
          st.editDoc(ops, t('pr.copyDrag'));
        } else {
          const ops = drag.ids.map((id) => {
            const g = drag.ghosts.get(id)!;
            return { op: 'update' as const, note: { id, s: g.s, p: g.p } };
          });
          st.editDoc(ops, t('pr.moveNote'));
        }
        break;
      }
      case 'resize':
      {
        if (!drag.moved) break;
        const ops = drag.ids.map((id) => {
          const g = drag.ghosts.get(id)!;
          return { op: 'update' as const, note: { id, l: g.l } };
        });
        st.editDoc(ops, t('pr.resizeNote'));
        break;
      }
      case 'draw':
      {
        const n0 = drag.newNotes[0];
        lastDrawLen.value = n0.l;
        st.editDoc([{ op: 'add', note: { ...n0 } }], t('pr.drawNote'));
        break;
      }
      case 'spray':
      {
        if (drag.newNotes.length === 0) break;
        const ops = drag.newNotes.map((n) => ({ op: 'add' as const, note: { ...n } }));
        st.editDoc(ops, t('pr.sprayNote'));
        break;
      }
      case 'erase':
      {
        if (drag.eraseIds.size > 0)
          st.editDoc([{ op: 'removeMany', ids: [...drag.eraseIds] }], t('pr.erase'));
        break;
      }
    }
  };

  const onKeysPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const st = useStore.getState();
    const r = keysRef.current!.getBoundingClientRect();
    const pitch = pitchAtY(st.view, e.clientY - r.top);
    if (pitch >= 0 && pitch <= 127) {
      pressedRef.current.set(pitch, performance.now() + 350);
      void getBridge().invoke('preview.note', { p: pitch, c: 1, v: 0.8 }).catch(() => {});
    }
  };

  const onRulerPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const st = useStore.getState();
    const r = rulerRef.current!.getBoundingClientRect();
    const ppq = Math.max(0, ppqAtX(st.view, e.clientX - r.left));
    st.setEditCursor(snapPpq(ppq, st.settings, 'floor'));
    dragCursorRef.current = true;
    capturePointer(e.target as Element, e.pointerId);
  };

  const onRulerPointerMove = (e: React.PointerEvent) => {
    if (!dragCursorRef.current) return;
    const st = useStore.getState();
    const r = rulerRef.current!.getBoundingClientRect();
    const ppq = Math.max(0, ppqAtX(st.view, e.clientX - r.left));
    st.setEditCursor(snapPpq(ppq, st.settings, 'floor'));
    draw();
  };

  const onRulerPointerUp = () => { dragCursorRef.current = false; };

  // --- minimap navigation -------------------------------------------------------
  const miniSeek = (clientX: number) => {
    const st = useStore.getState();
    const r = miniRef.current!.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const center = frac * contentEndRef.current;
    st.setView({ scrollXPpq: Math.max(-0.5, center - st.view.width / 2 / st.view.pxPerPpq) });
  };
  const onMiniPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    miniDragRef.current = true;
    capturePointer(e.target as Element, e.pointerId);
    miniSeek(e.clientX);
  };
  const onMiniPointerMove = (e: React.PointerEvent) => {
    if (miniDragRef.current) miniSeek(e.clientX);
  };
  const onMiniPointerUp = () => { miniDragRef.current = false; };

  // --- context menu ----------------------------------------------------------------
  const onRollContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const { x, y } = rollRelative(e);
    const hit = hitNote(x, y);
    setCtxMenu({ x, y, ppq: ppqAtX(useStore.getState().view, x), noteId: hit?.id ?? null });
  };

  // position the context menu so it stays inside the roll view: flip up and
  // clamp horizontally based on the measured size once rendered
  const ctxMenuStyle = (x: number, y: number): React.CSSProperties => {
    const vw = view.width ?? 800;
    const vh = view.height ?? 400;
    const estW = 190;
    const estH = ctxMenu?.noteId != null ? 7 * 30 + 10 : 2 * 30 + 10;
    const left = Math.max(4, Math.min(x, vw - estW - 4));
    const top = y + estH > vh - 4 ? Math.max(4, y - estH) : y;
    return { left, top };
  };

  const ctxItems = (): Array<{ label: string; run: () => void }> => {
    const st = useStore.getState();
    if (ctxMenu?.noteId != null) {
      const id = ctxMenu.noteId;
      if (!st.selection.includes(id)) st.setSelection([id]);
      const note = st.doc.notes.find((n) => n.id === id);
      return [
        { label: t('pr.delete'), run: () => runAction('edit.delete') },
        { label: t('pr.copy'), run: () => runAction('edit.copy') },
        { label: note?.m ? t('pr.unmute') : t('pr.mute'), run: () => runAction('edit.toggleMute') },
        { label: t('pr.humanizeVel'), run: () => runAction('edit.humanize') },
        { label: t('pr.legato'), run: () => runAction('edit.legato') },
        { label: t('pr.clearArticulationTag'), run: () => st.editDoc([{ op: 'update', note: { id, a: -1 } }], t('pr.clearArticulation')) },
        { label: t('pr.lyricBatchFrom'), run: () => { setLyricFromText(''); setLyricFromModal(id); } },
      ];
    }
    return [
      { label: t('pr.pasteHere'), run: () => { st.setEditCursor(ctxMenu?.ppq ?? 0); runAction('edit.paste'); } },
      { label: t('pr.selectAll'), run: () => runAction('edit.selectAll') },
    ];
  };

  // --- chord lane interactions ---------------------------------------------------
  const chordRelative = (e: React.PointerEvent) => {
    const r = chordWrapRef.current!.getBoundingClientRect();
    return e.clientX - r.left;
  };

  const hitChord = (x: number) => {
    const st = useStore.getState();
    const ppq = ppqAtX(st.view, x);
    return st.doc.chords.find((c) => ppq >= c.s && ppq <= c.s + c.l) ?? null;
  };

  const onChordPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const st = useStore.getState();
    const x = chordRelative(e);
    const v = st.view;
    const hit = hitChord(x);
    if (hit) {
      st.setChordSelection(e.shiftKey
        ? (st.chordSelection.includes(hit.id)
            ? st.chordSelection.filter((i) => i !== hit.id)
            : [...st.chordSelection, hit.id])
        : [hit.id]);
      const mode = x >= xOfPpq(v, hit.s + hit.l) - 7 ? 'resize' : 'move';
      chordDragRef.current = {
        mode, id: hit.id, startX: x, startS: hit.s, startL: hit.l,
        ghost: { id: hit.id, s: hit.s, l: hit.l }, moved: false,
      };
      capturePointer(e.target as Element, e.pointerId);
    } else {
      const s = Math.max(0, snapPpq(ppqAtX(v, x), st.settings, 'floor'));
      // auto-select after the doc push lands: the toolbar root/quality
      // dropdowns only render for a selected chord
      st.setPendingChordSelect(true);
      st.editDoc([{ op: 'addChord', chord: { s, l: 4.0, r: 0, q: 0 } }], t('pr.addChord'));
    }
  };

  const onChordPointerMove = (e: React.PointerEvent) => {
    const d = chordDragRef.current;
    if (!d) {
      // hover feedback: resize edge at the right of a chord block
      const st = useStore.getState();
      const x = chordRelative(e);
      const hit = hitChord(x);
      const el = chordWrapRef.current;
      if (el) {
        if (hit) el.dataset.hcursor = x >= xOfPpq(st.view, hit.s + hit.l) - 7 ? 'resize' : 'move';
        else delete el.dataset.hcursor;
      }
      return;
    }
    const st = useStore.getState();
    const x = chordRelative(e);
    const dPpq = (x - d.startX) / st.view.pxPerPpq;
    if (d.mode === 'move') {
      const ns = Math.max(0, st.settings.snap ? snapPpq(d.startS + dPpq, st.settings, 'round') : d.startS + dPpq);
      d.ghost = { id: d.id, s: ns, l: d.startL };
    } else {
      const end = snapPpq(d.startS + d.startL + dPpq, st.settings, 'round');
      d.ghost = { id: d.id, s: d.startS, l: Math.max(gridStepPpq(st.settings), end - d.startS) };
    }
    d.moved = true;
    draw();
  };

  const onChordPointerUp = () => {
    const d = chordDragRef.current;
    chordDragRef.current = null;
    if (!d || !d.moved) return;
    useStore.getState().editDoc(
      [{ op: 'updateManyChords', chords: [{ id: d.id, s: d.ghost!.s, l: d.ghost!.l }] }],
      d.mode === 'move' ? t('pr.moveChord') : t('pr.resizeChord'));
  };

  const [dropActive, setDropActive] = useState(false);
  const dropDepthRef = useRef(0);

  const dragHasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const onRootDragEnter = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dropDepthRef.current += 1;
    setDropActive(true);
  };
  const onRootDragOver = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onRootDragLeave = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    dropDepthRef.current = Math.max(0, dropDepthRef.current - 1);
    if (dropDepthRef.current === 0) setDropActive(false);
  };
  const onRootDrop = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dropDepthRef.current = 0;
    setDropActive(false);
    const file = Array.from(e.dataTransfer.files).find((f) => /\.midi?$/i.test(f.name));
    if (!file) return;
    void file.arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf);
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk)
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
      void getBridge().invoke('file.importMidiData', { data: btoa(bin) }).catch(() => {});
    });
  };

  return (
    <div ref={rootRef} className="roll-root" data-tool={activeTool}
      onDragEnter={onRootDragEnter} onDragOver={onRootDragOver}
      onDragLeave={onRootDragLeave} onDrop={onRootDrop}>
      {dropActive && (
        <div className="drop-hint">
          <span>{t('pr.dropToImport')}</span>
        </div>
      )}
      <div className="roll-corner" />
      <canvas ref={rulerRef} className="roll-ruler" height={RULER_HEIGHT}
        onPointerDown={onRulerPointerDown} onPointerMove={onRulerPointerMove} onPointerUp={onRulerPointerUp} />
      <div ref={chordWrapRef} className="roll-chords" style={{ height: CHORD_LANE_HEIGHT }}
        onPointerDown={onChordPointerDown} onPointerMove={onChordPointerMove} onPointerUp={onChordPointerUp}>
        <canvas ref={chordRef} className="roll-layer" />
      </div>
      <canvas ref={keysRef} className="roll-keys" width={KEYS_WIDTH} onPointerDown={onKeysPointerDown} />
      <div
        ref={viewRef}
        className="roll-view"
        onPointerDown={onRollPointerDown}
        onPointerMove={onRollPointerMove}
        onPointerUp={onRollPointerUp}
        onPointerLeave={() => { const el = viewRef.current; if (el) delete el.dataset.hcursor; }}
        onContextMenu={onRollContextMenu}
      >
        <canvas ref={gridRef} className="roll-layer" />
        <canvas ref={notesRef} className="roll-layer" />
        <canvas ref={overlayRef} className="roll-layer" />
        {ctxMenu && (
          <div className="ctx-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) setCtxMenu(null); }}
            onContextMenu={(e) => e.preventDefault()}>
            <div className="ctx-menu" style={ctxMenuStyle(ctxMenu.x, ctxMenu.y)}
              onPointerDown={(e) => e.stopPropagation()}>
              {ctxItems().map((item) => (
                <button key={item.label} className="ctx-item"
                  onClick={() => { item.run(); setCtxMenu(null); }}>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <canvas ref={miniRef} className="roll-minimap" height={MINIMAP_H}
        onPointerDown={onMiniPointerDown} onPointerMove={onMiniPointerMove} onPointerUp={onMiniPointerUp} />
      {lyricFromModal != null && (
        <div className="modal-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) setLyricFromModal(null); }}>
          <div className="modal lyric-from-modal">
            <div className="modal-head">
              <strong>{t('pr.lyricBatchFrom')}</strong>
              <button className="tb-btn" onClick={() => setLyricFromModal(null)} title={t('lane.close')}>✕</button>
            </div>
            <div className="modal-body">
              <textarea
                className="lyric-batch-input lyric-from-textarea"
                autoFocus
                placeholder={t('lane.lyricBatchHint')}
                value={lyricFromText}
                onChange={(e) => setLyricFromText(e.target.value)}
              />
              <div className="lyric-split" style={{ marginTop: 8 }}>
                <button className={`mini-btn ${lyricFromSplit === 'space' ? 'active' : ''}`}
                  onClick={() => setLyricFromSplit('space')}>{t('lane.lyricSplitSpace')}</button>
                <button className={`mini-btn ${lyricFromSplit === 'char' ? 'active' : ''}`}
                  onClick={() => setLyricFromSplit('char')}>{t('lane.lyricSplitChar')}</button>
                <span className="lyric-hint">{t('pr.lyricBatchNote')}</span>
              </div>
            </div>
            <div className="modal-foot">
              <button className="mini-btn" onClick={() => setLyricFromModal(null)}>{t('lane.cancel')}</button>
              <button className="mini-btn primary" onClick={commitLyricFrom}>{t('lane.create')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function themeColorsSafe(theme: string) {
  return themeColors(theme);
}
void themeColorsSafe;

function capturePointer(target: Element, pointerId: number): void {
  try { target.setPointerCapture(pointerId); } catch { /* synthetic or already-released pointer */ }
}
