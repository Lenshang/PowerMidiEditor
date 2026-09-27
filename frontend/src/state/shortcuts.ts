// Configurable shortcut system: an action registry with default bindings,
// event -> binding matching, and display helpers. Bindings are persisted via
// the settings bridge (settings.shortcuts maps actionId -> binding).

export interface KeyBinding {
  type: 'key';
  code: string; // KeyboardEvent.code, e.g. "Digit1", "KeyQ", "Equal"
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface WheelBinding {
  type: 'wheel';
  dir: 'up' | 'down';
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

/** Explicitly unbound (used to override a default binding with "none"). */
export interface NoneBinding {
  type: 'none';
}

export type Binding = KeyBinding | WheelBinding | NoneBinding;

export interface ActionDef {
  id: string;
  label: string;
    group: string;
  def: Binding;
}

function key(code: string, mods: Partial<Pick<KeyBinding, 'ctrl' | 'alt' | 'shift' | 'meta'>> = {}): KeyBinding {
  return { type: 'key', code, ctrl: !!mods.ctrl, alt: !!mods.alt, shift: !!mods.shift, meta: !!mods.meta };
}
function wheel(dir: 'up' | 'down', mods: Partial<Pick<WheelBinding, 'ctrl' | 'alt' | 'shift'>> = {}): WheelBinding {
  return { type: 'wheel', dir, ctrl: !!mods.ctrl, alt: !!mods.alt, shift: !!mods.shift };
}

export const ACTIONS: ActionDef[] = [
  // 工具 (1..8)
  { id: 'tool.select', label: 'tool.select', group: 'set.group.tool', def: key('Digit1') },
  { id: 'tool.range', label: 'tool.range', group: 'set.group.tool', def: key('Digit2') },
  { id: 'tool.pencil', label: 'tool.pencil', group: 'set.group.tool', def: key('Digit3') },
  { id: 'tool.spray', label: 'tool.spray', group: 'set.group.tool', def: key('Digit4') },
  { id: 'tool.razor', label: 'tool.razor', group: 'set.group.tool', def: key('Digit5') },
  { id: 'tool.eraser', label: 'tool.eraser', group: 'set.group.tool', def: key('Digit6') },
  { id: 'tool.audition', label: 'tool.audition', group: 'set.group.tool', def: key('Digit7') },
  { id: 'tool.step', label: 'tool.step', group: 'set.group.tool', def: key('Digit8') },
  // 视图
  { id: 'view.zoomHIn', label: 'view.zoomHIn', group: 'set.group.view', def: key('Equal') },
  { id: 'view.zoomHOut', label: 'view.zoomHOut', group: 'set.group.view', def: key('Minus') },
  { id: 'view.zoomVIn', label: 'view.zoomVIn', group: 'set.group.view', def: key('Equal', { ctrl: true }) },
  { id: 'view.zoomVOut', label: 'view.zoomVOut', group: 'set.group.view', def: key('Minus', { ctrl: true }) },
  { id: 'view.zoomFit', label: 'view.zoomFit', group: 'set.group.view', def: key('KeyF') },
  { id: 'view.scrollUp', label: 'view.scrollUp', group: 'set.group.view', def: key('ArrowUp') },
  { id: 'view.scrollDown', label: 'view.scrollDown', group: 'set.group.view', def: key('ArrowDown') },
  { id: 'view.scrollLeft', label: 'view.scrollLeft', group: 'set.group.view', def: key('ArrowLeft') },
  { id: 'view.scrollRight', label: 'view.scrollRight', group: 'set.group.view', def: key('ArrowRight') },
  // 滚轮
  { id: 'wheel.scrollV', label: 'wheel.scrollV', group: 'set.group.view', def: wheel('down') },
  { id: 'wheel.scrollH', label: 'wheel.scrollH', group: 'set.group.view', def: wheel('down', { alt: true }) },
  { id: 'wheel.scrollHShift', label: 'wheel.scrollHShift', group: 'set.group.view', def: wheel('down', { shift: true }) },
  { id: 'wheel.zoomH', label: 'wheel.zoomH', group: 'set.group.view', def: wheel('down', { ctrl: true }) },
  { id: 'wheel.zoomV', label: 'wheel.zoomV', group: 'set.group.view', def: wheel('down', { ctrl: true, alt: true }) },
  // 编辑
  { id: 'edit.undo', label: 'edit.undo', group: 'set.group.edit', def: key('KeyZ', { ctrl: true }) },
  { id: 'edit.redo', label: 'edit.redo', group: 'set.group.edit', def: key('KeyY', { ctrl: true }) },
  { id: 'edit.selectAll', label: 'pr.selectAll', group: 'set.group.edit', def: key('KeyA', { ctrl: true }) },
  { id: 'edit.delete', label: 'pr.delete', group: 'set.group.edit', def: key('Delete') },
  { id: 'edit.deleteBksp', label: 'pr.delete', group: 'set.group.edit', def: key('Backspace') },
  { id: 'edit.copy', label: 'pr.copy', group: 'set.group.edit', def: key('KeyC', { ctrl: true }) },
  { id: 'edit.cut', label: 'disp.cut', group: 'set.group.edit', def: key('KeyX', { ctrl: true }) },
  { id: 'edit.paste', label: 'disp.paste', group: 'set.group.edit', def: key('KeyV', { ctrl: true }) },
  { id: 'edit.duplicate', label: 'pr.duplicate', group: 'set.group.edit', def: key('KeyD', { ctrl: true }) },
  { id: 'edit.legato', label: 'pr.legato', group: 'set.group.edit', def: key('KeyL') },
  { id: 'edit.humanize', label: 'disp.humanize', group: 'set.group.edit', def: key('KeyH') },
  { id: 'edit.toggleMute', label: 'pr.mute', group: 'set.group.edit', def: key('KeyM') },
  { id: 'edit.nudgeUp', label: 'disp.pitchUp', group: 'set.group.edit', def: key('ArrowUp', { alt: true }) },
  { id: 'edit.nudgeDown', label: 'disp.pitchDown', group: 'set.group.edit', def: key('ArrowDown', { alt: true }) },
  { id: 'edit.octaveUp', label: 'disp.octaveUp', group: 'set.group.edit', def: key('ArrowUp', { alt: true, shift: true }) },
  { id: 'edit.octaveDown', label: 'disp.octaveDown', group: 'set.group.edit', def: key('ArrowDown', { alt: true, shift: true }) },
  { id: 'edit.transposeUp', label: 'disp.pitchUp', group: 'set.group.edit', def: key('ArrowUp', { ctrl: true }) },
  { id: 'edit.transposeDown', label: 'disp.pitchDown', group: 'set.group.edit', def: key('ArrowDown', { ctrl: true }) },
  // 走带
  { id: 'transport.toggle', label: 'transport.toggle', group: 'set.group.transport', def: key('Space') },
  // 网格
  { id: 'grid.toggleSnap', label: 'grid.toggleSnap', group: 'set.group.grid', def: key('KeyJ') },
  { id: 'edit.quantize', label: 'disp.quantize', group: 'set.group.grid', def: key('KeyQ') },
  { id: 'edit.quantizeLength', label: 'disp.quantizeLength', group: 'set.group.grid', def: key('KeyQ', { shift: true }) },
];

const DEFAULTS: Record<string, Binding> = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a.def]),
);

export type ShortcutMap = Record<string, Binding>;

/** Merge user bindings over defaults; unknown/invalid entries ignored. */
export function resolveShortcuts(user: Record<string, unknown> | undefined): ShortcutMap {
  const out: ShortcutMap = { ...DEFAULTS };
  if (user) {
    for (const [id, b] of Object.entries(user)) {
      const t = (b as Binding | null)?.type;
      if (t === 'key' || t === 'wheel' || t === 'none') out[id] = b as Binding;
    }
  }
  return out;
}

export function bindingFromKeyboard(e: KeyboardEvent): KeyBinding {
  return {
    type: 'key', code: e.code,
    ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey,
  };
}

export function bindingFromWheel(e: WheelEvent): WheelBinding {
  return {
    type: 'wheel', dir: e.deltaY < 0 ? 'up' : 'down',
    ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
  };
}

export function bindingsEqual(a: Binding, b: Binding): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'wheel' && b.type === 'wheel')
    return a.dir === b.dir && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;
  if (a.type === 'key' && b.type === 'key')
    return a.code === b.code && a.ctrl === b.ctrl && a.alt === b.alt
      && a.shift === b.shift && a.meta === b.meta;
  return false;
}

const CODE_LABELS: Record<string, string> = {
  Equal: '=', Minus: '-', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Delete: 'Del', Backspace: 'Bksp', Escape: 'Esc', Enter: '⏎', Tab: 'Tab',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Space: 'Space', PageUp: 'PgUp', PageDown: 'PgDn', Home: 'Home', End: 'End',
  NumpadAdd: 'Num+', NumpadSubtract: 'Num−', NumpadMultiply: 'Num*', NumpadDivide: 'Num/',
  Insert: 'Ins', CapsLock: 'Caps',
};

export function bindingToText(b: Binding | undefined): string {
  if (!b || b.type === 'none') return '-';
  if (b.type === 'wheel') {
    const mods = [
      b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift',
    ].filter(Boolean).join('+');
    const dir = b.dir === 'up' ? 'Wheel up' : 'Wheel down';
    return mods ? `${mods}+${dir}` : dir;
  }
  const mods = [
    b.ctrl && 'Ctrl', b.alt && 'Alt', b.shift && 'Shift', b.meta && 'Win',
  ].filter(Boolean).join('+');
  const main = CODE_LABELS[b.code]
    ?? (b.code.startsWith('Key') ? b.code.slice(3)
      : b.code.startsWith('Digit') ? b.code.slice(5)
      : b.code.startsWith('Numpad') ? `Num${b.code.slice(6)}`
      : b.code);
  return mods ? `${mods}+${main}` : main;
}

/** Find the action id whose binding matches `b`. */
export function findAction(map: ShortcutMap, b: Binding): string | null {
  for (const [id, binding] of Object.entries(map)) {
    if (binding.type === 'none') continue;
    if (bindingsEqual(binding, b)) return id;
  }
  return null;
}

/** All action ids bound to the same binding (used for conflict handling). */
export function findConflicts(map: ShortcutMap, b: Binding, exceptId: string): string[] {
  if (b.type === 'none') return [];
  const ids: string[] = [];
  for (const [id, binding] of Object.entries(map)) {
    if (id !== exceptId && binding.type !== 'none' && bindingsEqual(binding, b)) ids.push(id);
  }
  return ids;
}
