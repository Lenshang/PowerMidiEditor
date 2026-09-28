// Wire protocol shared with the C++ side (see docs/PROTOCOL.md).
// Field names are intentionally short for note data — they cross the bridge
// on every document update.

/** One MIDI note. Times are in quarter notes (1.0 = a quarter). */
export interface Note {
  id: number;
  /** pitch 0..127 */
  p: number;
  /** start, quarter notes */
  s: number;
  /** length, quarter notes */
  l: number;
  /** velocity 0..1 */
  v: number;
  /** muted */
  m: boolean;
  /** MIDI channel 1..16 */
  c: number;
  /** expression articulation id, -1 = none */
  a: number;
  /** sung syllable, exported as SMF FF05 lyric meta */
  ly?: string;
}

export interface NoteDraft {
  p: number;
  s: number;
  l: number;
  v: number;
  m: boolean;
  c: number;
  a: number;
}

/** One chord-track event. */
export interface ChordEvent {
  id: number;
  /** start, quarter notes */
  s: number;
  /** length, quarter notes */
  l: number;
  /** root pitch class 0..11 (0 = C) */
  r: number;
  /** quality index (see CHORD_QUALITIES in render.ts) */
  q: number;
}

/** Expression-map articulation. */
export interface Articulation {
  id: number;
  /** display name */
  n: string;
  /** keyswitch pitch 0..127, -1 = none */
  ks: number;
  /** cc number 0..127, -1 = none */
  cc: number;
  /** cc value 0..127 */
  v: number;
}

export interface DocumentState {
  revision: number;
  notes: Note[];
  /** CC controller events */
  ccs: ControllerEvent[];
  /** pitch bend events */
  pbs: PitchBendEvent[];
  /** chord track */
  chords: ChordEvent[];
  /** expression map articulations */
  articulations: Articulation[];
}

/** One CC controller event. */
export interface ControllerEvent {
  id: number;
  /** controller number 0..127 */
  cc: number;
  /** channel 1..16 */
  c: number;
  /** time, quarter notes */
  t: number;
  /** 0..127 */
  v: number;
}

/** One pitch bend event. v: 0..16383, 8192 = center. */
export interface PitchBendEvent {
  id: number;
  c: number;
  t: number;
  v: number;
}

export interface TransportState {
  playing: boolean;
  /** the plugin's own play button (independent of the host transport) */
  internalPlaying: boolean;
  /** internal transport cursor (valid while internalPlaying) */
  internalPpq: number;
  /** audition scrub state (valid while auditioning) */
  auditioning: boolean;
  auditionPpq: number;
  ppqValid: boolean;
  ppq: number;
  loopValid: boolean;
  loopStart: number;
  loopEnd: number;
  tempo: number;
  sampleRate: number;
  /** host time signature (fallback 4/4) */
  sigNum: number;
  sigDen: number;
  /** output monitor: last pitch-bend / CC values sent downstream (-1 = none yet) */
  lastPb: number;
  lastCcNumber: number;
  lastCcValue: number;
}

export interface SettingsState {
  theme: string;
  shortcuts: Record<string, unknown>;
  /** grid resolution in quarter notes (0.25 = 1/16) */
  gridPpq: number;
  snap: boolean;
  triplet: boolean;
  lengthQuantize: string;
  autoQuantizeInput: boolean;
  /** modifier held while dragging to bypass grid snap ('shift'|'alt'|'ctrl'|'none') */
  snapBypass: string;
  /** UI language ('en' | 'zhHans' | 'zhHant' | 'ja') */
  lang: string;
}

export interface DrumMapState {
  name: string;
  entries: Array<{ n: number; name: string }>;
}

export interface MidiInEvent {
  on: boolean;
  p: number;
  c: number;
  v: number;
}

export type UiEvent =
  | { kind: 'doc'; doc: DocumentState }
  | { kind: 'settings'; settings: SettingsState }
  | { kind: 'transport'; transport: TransportState }
  | { kind: 'midi'; midi: MidiInEvent[] }
  | { kind: 'drummap'; drummap: DrumMapState }
  | { kind: 'toast'; toast: string | { kind: 'toast'; key: string; params?: Array<{ k: string; v: string }> } };

export type EditOp =
  | { op: 'add'; note: NoteDraft }
  | { op: 'update'; note: Partial<Note> & { id: number } }
  | { op: 'remove'; id: number }
  | { op: 'updateMany'; notes: Array<Partial<Note> & { id: number }> }
  | { op: 'removeMany'; ids: number[] }
  | { op: 'addCC'; ev: Omit<ControllerEvent, 'id'> }
  | { op: 'updateManyCC'; evs: Array<Partial<ControllerEvent> & { id: number }> }
  | { op: 'removeManyCC'; ids: number[] }
  | { op: 'addPB'; ev: Omit<PitchBendEvent, 'id'> }
  | { op: 'updateManyPB'; evs: Array<Partial<PitchBendEvent> & { id: number }> }
  | { op: 'removeManyPB'; ids: number[] }
  | { op: 'addChord'; chord: Omit<ChordEvent, 'id'> }
  | { op: 'updateManyChords'; chords: Array<Partial<ChordEvent> & { id: number }> }
  | { op: 'removeManyChords'; ids: number[] };
