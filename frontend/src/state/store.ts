import { create } from 'zustand';
import { getBridge } from '../bridge/bridge';
import { t } from '../i18n';
import type {
  ControllerEvent,
  DocumentState,
  DrumMapState,
  EditOp,
  Note,
  PitchBendEvent,
  SettingsState,
  TransportState,
  UiEvent,
} from '../bridge/protocol';

export type ToolId =
  | 'select' | 'range' | 'pencil' | 'spray'
  | 'razor' | 'eraser' | 'audition' | 'step';

/** Which lane the bottom editor panel shows. */
export type LaneMode = 'velocity' | 'cc' | 'pb' | 'lyric';

/** Frequent CC numbers for the lane selector. */
export const CC_CHOICES: Array<{ label: string; cc: number }> = [
  { label: 'CC11', cc: 11 },
  { label: 'CC1', cc: 1 },
  { label: 'CC7', cc: 7 },
  { label: 'CC10', cc: 10 },
  { label: 'CC64', cc: 64 },
];

export interface ViewState {
  /** horizontal zoom: pixels per quarter note */
  pxPerPpq: number;
  /** vertical zoom: pixel height of one semitone row */
  rowHeight: number;
  /** content ppq at the left edge of the roll */
  scrollXPpq: number;
  /** content pixels scrolled down from the top (pitch 127) */
  scrollYPx: number;
  /** roll viewport size in CSS pixels (set by PianoRoll) */
  width: number;
  height: number;
}

export const VIEW_LIMITS = {
  pxPerPpqMin: 0.02,
  pxPerPpqMax: 800,
  rowHeightMin: 4,
  rowHeightMax: 64,
};

/** Set whenever a transport event arrives; used to interpolate the playhead. */
export const transportClock = { lastEventAt: 0 };

/** Midi-in events fan out here (PianoRoll subscribes for key highlights). */
export const midiBus = {
  subs: new Set<(events: import('../bridge/protocol').MidiInEvent[]) => void>(),
};

interface StoreState {
  mode: 'juce' | 'mock';
  ready: boolean;
  initError: string | null;
  version: string;
  doc: DocumentState;
  settings: SettingsState;
  /** true while a bare Ctrl/Cmd keydown is held (focus probe indicator) */
  ctrlPressed: boolean;
  setCtrlPressed(v: boolean): void;
  drumMap: DrumMapState;
  transport: TransportState;
  view: ViewState;
  selection: number[];
  laneSelection: number[];
  laneMode: LaneMode;
  /** articulation display strip visibility (user-toggleable) */
  showArtStrip: boolean;
  setShowArtStrip(v: boolean): void;
  /** bottom panel heights (px): velocity/CC lane area and the art strip */
  laneHeight: number;
  setLaneHeight(h: number): void;
  /** null = auto-fit to the packed rows */
  artStripHeight: number | null;
  setArtStripHeight(h: number): void;
  /** set before editDoc(addChord): the doc handler auto-selects the new chord */
  pendingChordSelect: boolean;
  setPendingChordSelect(v: boolean): void;
  ccNumber: number;
  chordSelection: number[];
  activeArticulation: number | null;
  expressionOpen: boolean;
  recordArmed: boolean;
  drumMode: boolean;
  chordAssist: boolean;
  editCursorPpq: number;
  activeTool: ToolId;
  canUndo: boolean;
  canRedo: boolean;
  followPlayhead: boolean;
  settingsOpen: boolean;
  settingsCapture: string | null;
  statusHint: string;

  init(): Promise<void>;
  applyEvent(e: UiEvent): void;
  setViewport(w: number, h: number): void;
  setView(patch: Partial<Omit<ViewState, 'width' | 'height'>>): void;
  setTool(t: ToolId): void;
  setSelection(ids: number[]): void;
  setLaneMode(m: LaneMode): void;
  setCcNumber(cc: number): void;
  setLaneSelection(ids: number[]): void;
  setChordSelection(ids: number[]): void;
  setActiveArticulation(id: number | null): void;
  setExpressionOpen(open: boolean): void;
  setRecordArmed(v: boolean): void;
  toggleDrumMode(): void;
  toggleChordAssist(): void;
  setEditCursor(ppq: number): void;
  updateSettings(patch: Partial<SettingsState>): void;
  editDoc(ops: EditOp[], name: string): void;
  undo(): void;
  redo(): void;
  clearDoc(): void;
  setSettingsOpen(open: boolean): void;
  setCaptureAction(id: string | null): void;
  setHint(text: string): void;
  setFollow(on: boolean): void;
}

const emptyTransport: TransportState = {
  playing: false, internalPlaying: false, internalPpq: 0, auditioning: false, auditionPpq: 0, ppqValid: false, ppq: 0,
  loopValid: false, loopStart: 0, loopEnd: 0,
  tempo: 120, sampleRate: 48000,
  sigNum: 4, sigDen: 4,
  lastPb: -1, lastCcNumber: -1, lastCcValue: -1,
};

/** Format an unknown bridge failure for display. */
export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Guarantee all event collections exist — older/foreign pushes must never
 *  leave undefined arrays behind (they crash lane editors on first touch). */
export function normalizeDoc(d: DocumentState): DocumentState {
  return {
    ...d,
    notes: d.notes ?? [],
    ccs: d.ccs ?? [],
    pbs: d.pbs ?? [],
    chords: d.chords ?? [],
    articulations: d.articulations ?? [],
  };
}

function clampView(v: ViewState): ViewState {
  const pxPerPpq = Math.min(VIEW_LIMITS.pxPerPpqMax,
    Math.max(VIEW_LIMITS.pxPerPpqMin, v.pxPerPpq));
  const rowHeight = Math.min(VIEW_LIMITS.rowHeightMax,
    Math.max(VIEW_LIMITS.rowHeightMin, v.rowHeight));
  const maxScrollY = Math.max(0, 128 * rowHeight - v.height);
  return {
    ...v,
    pxPerPpq,
    rowHeight,
    scrollXPpq: Math.max(-0.5, v.scrollXPpq),
    scrollYPx: Math.min(maxScrollY, Math.max(0, v.scrollYPx)),
  };
}

export const useStore = create<StoreState>((set, get) => ({
  mode: 'mock',
  ready: false,
  initError: null,
  version: '',
  doc: { revision: 0, notes: [], ccs: [], pbs: [], chords: [], articulations: [] },
  settings: {
    theme: 'dark', shortcuts: {}, gridPpq: 0.25, snap: true,
    triplet: false, lengthQuantize: 'grid', autoQuantizeInput: false, browserAutoChords: true,
    snapBypass: 'shift',
    lang: 'en',
  },
  ctrlPressed: false,
  drumMap: { name: '', entries: [] } as import('../bridge/protocol').DrumMapState,
  transport: emptyTransport,
  view: {
    pxPerPpq: 2, rowHeight: 16, scrollXPpq: 0, scrollYPx: (127 - 76) * 16,
    width: 800, height: 400,
  },
  selection: [],
  laneSelection: [],
  laneMode: 'velocity',
  showArtStrip: true,
  laneHeight: 108,
  artStripHeight: null,
  pendingChordSelect: false,
  ccNumber: 11,
  chordSelection: [],
  activeArticulation: null,
  expressionOpen: false,
  recordArmed: false,
  drumMode: false,
  chordAssist: false,
  editCursorPpq: 0,
  activeTool: 'select',
  canUndo: false,
  canRedo: false,
  followPlayhead: true,
  settingsOpen: false,
  settingsCapture: null,
  statusHint: '',

  async init() {
    const bridge = getBridge();
    try {
      const data = await bridge.invoke<{ doc: DocumentState; settings: SettingsState; version: string }>('init');
      set({
        mode: bridge.mode,
        ready: true,
        initError: null,
        version: data.version,
        doc: normalizeDoc(data.doc),
        settings: { ...data.settings, shortcuts: data.settings.shortcuts ?? {} },
      });
      bridge.onEvent((e) => get().applyEvent(e));
    } catch (e) {
      set({ initError: describeError(e) });
    }
  },

  applyEvent(e: UiEvent) {
    switch (e.kind) {
      case 'doc': {
        const d = normalizeDoc(e.doc);
        let chordSelection = get().chordSelection;
        if (get().pendingChordSelect && d.chords.length > 0) {
          // auto-select the freshly added chord (highest id) so the toolbar
          // root/quality controls show up right away
          let newest = d.chords[0];
          for (const c of d.chords) if (c.id > newest.id) newest = c;
          chordSelection = [newest.id];
        }
        // CC lanes follow reality: the switcher lists numbers that actually
        // have data; the active number falls back to the first existing lane.
        const existing = [...new Set(d.ccs.map((c) => c.cc))].sort((a, b) => a - b);
        const ccNumber = existing.includes(get().ccNumber) ? get().ccNumber : (existing[0] ?? get().ccNumber);
        // auto-selecting the new chord drops any note selection (exclusivity)
        const selection = get().pendingChordSelect && d.chords.length > 0 ? [] : get().selection;
        set({ doc: d, ccNumber, selection, chordSelection, pendingChordSelect: false });
        break;
      }
      case 'drummap':
        set({ drumMap: e.drummap ?? { name: '', entries: [] } });
        break;
      case 'settings':
        set({ settings: e.settings });
        break;
      case 'transport':
        transportClock.lastEventAt = performance.now();
        set({ transport: e.transport });
        break;
      case 'midi':
        for (const sub of midiBus.subs) sub(e.midi);
        break;
      case 'toast': {
        // Either a plain string (legacy) or { key, params[] } that the UI
        // translates in the selected language.
        const tv = e.toast as unknown;
        if (tv && typeof tv === 'object') {
          const o = tv as { key?: string; params?: Array<{ k: string; v: string }> };
          if (o.key) {
            const params: Record<string, string> = {};
            for (const p of o.params ?? []) params[p.k] = p.v;
            set({ statusHint: t(o.key, params) });
            break;
          }
        }
        set({ statusHint: String(e.toast) });
        break;
      }
    }
  },

  setViewport(w, h) {
    const { view } = get();
    if (view.width === w && view.height === h) return;
    set({ view: clampView({ ...view, width: w, height: h }) });
  },

  setView(patch) {
    set({ view: clampView({ ...get().view, ...patch }) });
  },

  setTool(t) {
    set({ activeTool: t });
  },

  setSelection(ids) {
    // Note and chord selections are mutually exclusive: picking notes drops
    // any chord selection, so an edit op always has exactly one target kind.
    set(ids.length > 0 ? { selection: ids, chordSelection: [] } : { selection: ids });
  },

  setLaneMode(m) {
    set({ laneMode: m, laneSelection: [] });
  },

  setShowArtStrip(v) {
    set({ showArtStrip: v });
  },

  setLaneHeight(h) {
    set({ laneHeight: Math.max(40, Math.min(400, Math.round(h))) });
  },

  setArtStripHeight(h) {
    set({ artStripHeight: Math.max(18, Math.min(250, Math.round(h))) });
  },

  setPendingChordSelect(v) {
    set({ pendingChordSelect: v });
  },

  setCcNumber(cc) {
    set({ ccNumber: cc, laneSelection: [] });
  },

  setLaneSelection(ids) {
    set({ laneSelection: ids });
  },

  setChordSelection(ids) {
    // picking chords drops any note selection (see setSelection)
    set(ids.length > 0 ? { chordSelection: ids, selection: [] } : { chordSelection: ids });
  },

  setActiveArticulation(id) {
    set({ activeArticulation: id });
  },

  setExpressionOpen(open) {
    set({ expressionOpen: open });
  },

  setRecordArmed(v) {
    set({ recordArmed: v });
    void getBridge().invoke('record.set', { armed: v }).catch(() => {});
  },

  toggleDrumMode() {
    set({ drumMode: !get().drumMode });
  },

  toggleChordAssist() {
    set({ chordAssist: !get().chordAssist });
  },

  setCtrlPressed(v) {
    set({ ctrlPressed: v });
  },

  setEditCursor(ppq) {
    set({ editCursorPpq: Math.max(0, ppq) });
  },

  updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    void getBridge().invoke('settings.update', settings).catch(() => {});
  },

  editDoc(ops, name) {
    getBridge()
      .invoke<{ revision: number; canUndo?: boolean; canRedo?: boolean }>('doc.edit', { ops, name })
      .then((r) => {
        if (r?.canUndo !== undefined) set({ canUndo: r.canUndo, canRedo: r.canRedo ?? false });
        else set({ canUndo: true });
      })
      .catch((err) => set({ statusHint: t('app.uiError', { msg: String(err) }) }));
  },

  undo() {
    getBridge()
      .invoke<{ revision: number; canUndo: boolean; canRedo: boolean }>('doc.undo')
      .then((r) => set({ canUndo: r.canUndo, canRedo: r.canRedo }))
      .catch(() => {});
  },

  redo() {
    getBridge()
      .invoke<{ revision: number; canUndo: boolean; canRedo: boolean }>('doc.redo')
      .then((r) => set({ canUndo: r.canUndo, canRedo: r.canRedo }))
      .catch(() => {});
  },

  clearDoc() {
    const { selection } = get();
    if (selection.length > 0) {
      get().editDoc([{ op: 'removeMany', ids: selection }], t('pr.delete'));
    } else {
      getBridge().invoke('doc.clear').catch(() => {});
    }
  },

  setSettingsOpen(open) {
    set({ settingsOpen: open, settingsCapture: null });
  },

  setCaptureAction(id) {
    set({ settingsCapture: id });
  },

  setHint(text) {
    set({ statusHint: text });
  },

  setFollow(on) {
    set({ followPlayhead: on });
  },
}));

// --- selectors / helpers -----------------------------------------------------

/** Effective grid step in quarter notes (triplets shrink the step). */
export function gridStepPpq(s: SettingsState): number {
  return s.triplet ? s.gridPpq * (2 / 3) : s.gridPpq;
}

/**
 * Snap tuned for drum hits: the drawn marker is a point anchored AT its
 * start, so round to the NEAREST grid point — a cursor anywhere within the
 * second half of a cell captures the point to its right. Drum mode only.
 */
export function snapPpqDrum(t: number, s: SettingsState): number {
  if (!s.snap) return t;
  const step = gridStepPpq(s);
  return Math.round(t / step) * step;
}

export function snapPpq(t: number, s: SettingsState, mode: 'floor' | 'round' = 'floor'): number {
  if (!s.snap) return t;
  const step = gridStepPpq(s);
  return mode === 'floor' ? Math.floor(t / step + 1e-9) * step : Math.round(t / step) * step;
}

/** All notes (for rendering); revision changes force fresh reads. */
export function noteById(doc: DocumentState, id: number): Note | undefined {
  return doc.notes.find((n) => n.id === id);
}
