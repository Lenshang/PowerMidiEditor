// In-browser mock backend: mirrors the plugin's invoke/event contract so the
// whole UI runs in a plain browser during development and automated testing.
// Sounds for preview/audition are synthesised with WebAudio.
import type { Bridge } from './bridge';
import type {
  DocumentState,
  EditOp,
  Note,
  SettingsState,
  UiEvent,
} from './protocol';

const LS_DOC = 'pme.mock.doc';
const LS_SETTINGS = 'pme.mock.settings';

const DEFAULT_SETTINGS: SettingsState = {
  theme: 'dark',
  shortcuts: {},
  gridPpq: 0.25,
  snap: true,
  triplet: false,
  lengthQuantize: 'grid',
  autoQuantizeInput: false,
  snapBypass: 'shift',
  lang: 'en',
};

function demoDoc(): DocumentState {
  const demo: Array<[number, number, number]> = [
    [60, 0.0, 0.5], [64, 0.5, 0.5], [67, 1.0, 0.5], [72, 1.5, 0.5],
    [71, 2.0, 0.5], [67, 2.5, 0.5], [64, 3.0, 0.5], [60, 3.5, 0.5],
    [48, 0.0, 1.0], [55, 2.0, 1.0],
  ];
  let id = 1;
  const notes = demo.map(([p, s, l]) => ({
    id: id++, p, s, l, v: 0.85, m: false, c: 1, a: -1,
  }));
  const ccs = [[0.0, 70], [1.0, 100], [2.0, 110], [3.0, 85], [4.0, 70]].map(
    ([t, v]) => ({ id: id++, cc: 11, c: 1, t, v }),
  );
  const pbs = [[1.0, 8192], [1.5, 9500], [2.0, 8192]].map(
    ([t, v]) => ({ id: id++, c: 1, t, v }),
  );
  const chords = [
    { id: id++, s: 0.0, l: 4.0, r: 0, q: 0 }, // C maj
    { id: id++, s: 4.0, l: 4.0, r: 7, q: 0 }, // G maj
  ];
  return { revision: 1, notes, ccs, pbs, chords, articulations: [] };
}

// --- tiny WebAudio helper ---------------------------------------------------
let audioCtx: AudioContext | null = null;
function freqOf(pitch: number) {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}
function playTone(pitch: number, velocity: number, durationSec: number) {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freqOf(pitch);
    const peak = 0.05 + velocity * 0.15;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.08, durationSec));
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + Math.max(0.1, durationSec) + 0.05);
  } catch {
    // audio may be unavailable (automation) — silently ignore
  }
}

// -----------------------------------------------------------------------------
export function createMockBridge(): Bridge {
  let doc: DocumentState = loadDoc();
  let settings: SettingsState = loadSettings();
  let canUndo = false;
  let canRedo = false;
  const undoStack: Array<{ doc: DocumentState; canUndo: boolean; canRedo: boolean }> = [];
  const redoStack: Array<DocumentState> = [];

  const listeners = new Set<(e: UiEvent) => void>();
  let abSlot: 'A' | 'B' = 'A';

  // transport simulation
  let playing = false;
  let internalPlaying = false;
  let ppq = 0;
  let tempo = 120;
  const loop = { valid: true, start: 0, end: 16 };
  let lastTick = performance.now();

  function loadDoc(): DocumentState {
    try {
      const raw = localStorage.getItem(LS_DOC);
      if (raw) {
        const d = JSON.parse(raw) as DocumentState;
        // tolerate older mock saves
        d.ccs ??= [];
        d.pbs ??= [];
        d.chords ??= [];
        d.articulations ??= [];
        return d;
      }
    } catch { /* ignore */ }
    return demoDoc();
  }
  function loadSettings(): SettingsState {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as SettingsState) };
    } catch { /* ignore */ }
    return { ...DEFAULT_SETTINGS };
  }
  function saveDoc() {
    try { localStorage.setItem(LS_DOC, JSON.stringify(doc)); } catch { /* ignore */ }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); } catch { /* ignore */ }
  }

  function emit(e: UiEvent) {
    for (const l of listeners) l(e);
  }
  function pushDoc() {
    emit({ kind: 'doc', doc });
    saveDoc();
  }
  function pushSettings() {
    emit({ kind: 'settings', settings });
    saveSettings();
  }
  function snapshotUndo() {
    undoStack.push({ doc: structuredClone(doc), canUndo, canRedo });
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    canUndo = true;
    canRedo = false;
  }

  function applyOps(ops: EditOp[]) {
    let nextId = doc.notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
    nextId = Math.max(nextId, doc.ccs.reduce((m, e) => Math.max(m, e.id), 0) + 1);
    nextId = Math.max(nextId, doc.pbs.reduce((m, e) => Math.max(m, e.id), 0) + 1);
    nextId = Math.max(nextId, doc.chords.reduce((m, e) => Math.max(m, e.id), 0) + 1);
    for (const op of ops) {
      switch (op.op) {
        case 'add':
          doc.notes.push({
            id: nextId++,
            ...op.note,
          });
          break;
        case 'update': {
          const n = doc.notes.find((x) => x.id === op.note.id);
          if (n) Object.assign(n, op.note);
          break;
        }
        case 'remove':
          doc.notes = doc.notes.filter((x) => x.id !== op.id);
          break;
        case 'updateMany':
          for (const patch of op.notes) {
            const n = doc.notes.find((x) => x.id === patch.id);
            if (n) Object.assign(n, patch);
          }
          break;
        case 'removeMany': {
          const ids = new Set(op.ids);
          doc.notes = doc.notes.filter((x) => !ids.has(x.id));
          break;
        }
        case 'addCC':
          doc.ccs.push({ id: nextId++, ...op.ev });
          break;
        case 'updateManyCC':
          for (const patch of op.evs) {
            const e = doc.ccs.find((x) => x.id === patch.id);
            if (e) Object.assign(e, patch);
          }
          break;
        case 'removeManyCC': {
          const ids = new Set(op.ids);
          doc.ccs = doc.ccs.filter((x) => !ids.has(x.id));
          break;
        }
        case 'addPB':
          doc.pbs.push({ id: nextId++, ...op.ev });
          break;
        case 'updateManyPB':
          for (const patch of op.evs) {
            const e = doc.pbs.find((x) => x.id === patch.id);
            if (e) Object.assign(e, patch);
          }
          break;
        case 'removeManyPB': {
          const ids = new Set(op.ids);
          doc.pbs = doc.pbs.filter((x) => !ids.has(x.id));
          break;
        }
        case 'addChord':
          doc.chords.push({ id: nextId++, ...op.chord });
          break;
        case 'updateManyChords':
          for (const patch of op.chords) {
            const e = doc.chords.find((x) => x.id === patch.id);
            if (e) Object.assign(e, patch);
          }
          break;
        case 'removeManyChords': {
          const ids = new Set(op.ids);
          doc.chords = doc.chords.filter((x) => !ids.has(x.id));
          break;
        }
      }
    }
    doc.revision += 1;
  }

  // audition simulation
  let auditioning = false;
  let auditionCursor = 0;
  const playedIds = new Set<number>();

  setInterval(() => {
    const now = performance.now();
    const dt = Math.min(0.25, (now - lastTick) / 1000);
    lastTick = now;
    if (playing) {
      ppq += dt * (tempo / 60);
      if (loop.valid && ppq >= loop.end) ppq = loop.start + ((ppq - loop.start) % (loop.end - loop.start));
      emit({ kind: 'transport', transport: transportState() });
    }
    if (auditioning) {
      const from = auditionCursor;
      auditionCursor += dt * (tempo / 60);
      for (const n of doc.notes) {
        if (n.s >= from && n.s < auditionCursor) {
          playTone(n.p, n.v, Math.min(2, n.l * (60 / tempo)));
        }
      }
      if (from === auditionCursor) playedIds.clear();
      void playedIds;
    }
  }, 33);

  function transportState() {
    return {
      playing: playing || internalPlaying,
      internalPlaying,
      internalPpq: internalPlaying ? ppq : 0,
      auditioning,
      auditionPpq: auditionCursor,
      ppqValid: true,
      ppq,
      loopValid: loop.valid,
      loopStart: loop.start,
      loopEnd: loop.end,
      tempo,
      sampleRate: 48000,
      sigNum: 4,
      sigDen: 4,
      lastPb: -1,
      lastCcNumber: -1,
      lastCcValue: -1,
    };
  }

  const handlers: Record<string, (payload: unknown) => unknown> = {
    init: () => {
      emit({ kind: 'doc', doc });
      emit({ kind: 'settings', settings });
      emit({ kind: 'transport', transport: transportState() });
      return { doc, settings, version: '0.1.0-mock' };
    },
    'doc.edit': (payload) => {
      const { ops } = payload as { ops: EditOp[]; name?: string };
      snapshotUndo();
      applyOps(ops);
      pushDoc();
      return { revision: doc.revision };
    },
    'doc.undo': () => {
      const entry = undoStack.pop();
      if (!entry) return { revision: doc.revision, canUndo: false, canRedo: canRedo };
      redoStack.push(structuredClone(doc));
      doc = entry.doc;
      canUndo = entry.canUndo;
      canRedo = true;
      pushDoc();
      return { revision: doc.revision, canUndo, canRedo };
    },
    'doc.redo': () => {
      const next = redoStack.pop();
      if (!next) return { revision: doc.revision, canUndo, canRedo: false };
      undoStack.push({ doc: structuredClone(doc), canUndo, canRedo: true });
      doc = next;
      canUndo = true;
      pushDoc();
      return { revision: doc.revision, canUndo, canRedo };
    },
    'doc.clear': () => {
      snapshotUndo();
      applyOps([
        { op: 'removeMany', ids: doc.notes.map((n: Note) => n.id) },
        { op: 'removeManyCC', ids: doc.ccs.map((e) => e.id) },
        { op: 'removeManyPB', ids: doc.pbs.map((e) => e.id) },
        { op: 'removeManyChords', ids: doc.chords.map((e) => e.id) },
      ]);
      pushDoc();
      return { revision: doc.revision };
    },
    'map.set': (payload) => {
      const arr = (payload as { articulations: Array<{ id: number; n: string; ks: number; cc: number; v: number }> }).articulations ?? [];
      doc.articulations = arr;
      doc.revision += 1;
      pushDoc();
      return doc.articulations;
    },
    'record.set': () => true,
    'transport.play': (payload) => { const p = payload as { ppq?: number } | undefined; internalPlaying = true; ppq = (p && p.ppq) || 0; lastTick = performance.now(); emit({ kind: 'transport', transport: transportState() }); return true; },
    'transport.stop': () => { internalPlaying = false; emit({ kind: 'transport', transport: transportState() }); return true; },
    'ab.toggle': () => {
      abSlot = abSlot === 'A' ? 'B' : 'A';
      return { active: abSlot };
    },
    'file.dragMidiOut': () => true,
    'file.importMidiData': () => {
      // Browser mock: report success; the real bridge parses the SMF in C++.
      emit({ kind: 'toast', toast: { kind: 'toast', key: 'toast.imported', params: [] } });
      return true;
    },
    'file.saveProject': () => true,
    'file.openProject': () => true,
    'map.importCubase': () => true,
    'settings.update': (payload) => {
      settings = { ...settings, ...(payload as Partial<SettingsState>) };
      pushSettings();
      return { settings, revision: 0 };
    },
    'audition.start': (payload) => {
      auditioning = true;
      auditionCursor = (payload as { ppq: number }).ppq;
      return true;
    },
    'audition.stop': () => {
      auditioning = false;
      return true;
    },
    'preview.note': (payload) => {
      const { p, v } = payload as { p: number; v: number };
      playTone(p, v ?? 0.8, 0.3);
      return true;
    },
    panic: () => {
      auditioning = false;
      return true;
    },
  };

  const bridge: Bridge = {
    mode: 'mock',
    async invoke<T = unknown>(name: string, payload?: unknown) {
      const h = handlers[name];
      if (!h) throw new Error(`mock: unknown invoke '${name}'`);
      return h(payload) as T;
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  // DevHUD control surface
  (window as unknown as Record<string, unknown>).__PME_MOCK__ = {
    play: () => { playing = true; lastTick = performance.now(); emit({ kind: 'transport', transport: transportState() }); },
    stop: () => { playing = false; emit({ kind: 'transport', transport: transportState() }); },
    setTempo: (bpm: number) => { tempo = bpm; emit({ kind: 'transport', transport: transportState() }); },
    setLoop: (on: boolean) => { loop.valid = on; emit({ kind: 'transport', transport: transportState() }); },
    getTransport: () => transportState(),
    reset: () => { localStorage.removeItem(LS_DOC); localStorage.removeItem(LS_SETTINGS); location.reload(); },
  };

  return bridge;
}
