// Theme definitions. Colors are CSS custom properties (see styles.css) read
// back once per theme change for canvas painting.
export interface ThemeDef {
  id: string;
  name: string;
}

export const THEMES: ThemeDef[] = [
  { id: 'dark', name: 'Dark' },
  { id: 'midnight', name: 'Midnight' },
  { id: 'ocean', name: 'Ocean' },
  { id: 'graphite', name: 'Graphite' },
  { id: 'light', name: 'Light' },
  { id: 'mint', name: 'Mint' },
  { id: 'paper', name: 'Paper' },
  { id: 'sky', name: 'Sky' },
  { id: 'blush', name: 'Blush' },
  { id: 'sage', name: 'Sage' },
  { id: 'lilac', name: 'Lilac' },
  { id: 'cubase', name: 'Cubase Blue' },
  { id: 'forest', name: 'Forest' },
  { id: 'coffee', name: 'Coffee' },
  { id: 'rose', name: 'Rose' },
  { id: 'lavender', name: 'Lavender' },
  { id: 'solar', name: 'Solar' },
];

export type ThemeColors = Record<string, string>;

let cache: { theme: string; colors: ThemeColors } | null = null;

export function themeColors(themeId: string): ThemeColors {
  if (cache && cache.theme === themeId) return cache.colors;
  const css = getComputedStyle(document.documentElement);
  const names = [
    'bg-app', 'bg-panel', 'bg-panel2', 'border', 'text', 'text-dim', 'text-faint',
    'accent', 'accent-soft', 'danger',
    'roll-bg', 'lane-white', 'lane-black', 'grid-sub', 'grid-beat', 'grid-bar',
    'key-white', 'key-black', 'key-label', 'key-border', 'key-pressed',
    'note-fill', 'note-border', 'note-selected', 'note-selected-border',
    'note-muted', 'note-text',
    'playhead', 'loop-band', 'edit-cursor',
    'ruler-bg', 'ruler-text', 'ruler-tick',
  ];
  const colors: ThemeColors = {};
  for (const n of names) colors[n] = css.getPropertyValue(`--${n}`).trim() || '#ff00ff';
  cache = { theme: themeId, colors };
  return colors;
}

export function invalidateThemeCache(): void {
  cache = null;
}
