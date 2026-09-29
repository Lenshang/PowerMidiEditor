// Inline SVG icon set (16x16, stroke = currentColor) — no icon font/CDN so
// the plugin UI works fully offline.
interface IconProps {
  size?: number;
}

function svg(size: number | undefined, children: React.ReactNode) {
  return (
    <svg
      width={size ?? 15}
      height={size ?? 15}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const IconSelect = (p: IconProps) => svg(p.size, <>
  <path d="M4 2l8 7h-4l2.5 4.5-2 1L6 10l-2 2.5z" fill="currentColor" stroke="none" />
</>);

export const IconRange = (p: IconProps) => svg(p.size, <>
  <rect x="2.5" y="3.5" width="11" height="9" strokeDasharray="2.5 1.8" />
  <rect x="5" y="6" width="6" height="4" fill="currentColor" stroke="none" opacity="0.7" />
</>);

export const IconPencil = (p: IconProps) => svg(p.size, <>
  <path d="M3 13l1-3.2 7-7a1.4 1.4 0 012 0l.2.2a1.4 1.4 0 010 2l-7 7z" />
  <path d="M10 3.5l2.5 2.5" />
</>);

export const IconSpray = (p: IconProps) => svg(p.size, <>
  <rect x="5" y="8" width="2.6" height="2.6" fill="currentColor" stroke="none" />
  <rect x="9" y="8" width="2.6" height="2.6" fill="currentColor" stroke="none" />
  <rect x="7" y="11.4" width="2.6" height="2.6" fill="currentColor" stroke="none" />
  <path d="M10.5 5.5V3h2" />
  <circle cx="12.8" cy="2.4" r="0.8" fill="currentColor" stroke="none" />
  <circle cx="14.6" cy="4" r="0.7" fill="currentColor" stroke="none" />
</>);

export const IconRazor = (p: IconProps) => svg(p.size, <>
  <path d="M2.5 13.5L13 3" />
  <path d="M9.5 6.5l3 3" />
  <circle cx="3.5" cy="12.5" r="1.4" />
</>);

export const IconEraser = (p: IconProps) => svg(p.size, <>
  <path d="M6 12.5L2.8 9.3a1.5 1.5 0 010-2.1l4.4-4.4a1.5 1.5 0 012.1 0l3.9 3.9a1.5 1.5 0 010 2.1l-3.7 3.7z" />
  <path d="M5 6.5l4.5 4.5" />
  <path d="M7 13.5h6" />
</>);

export const IconAudition = (p: IconProps) => svg(p.size, <>
  <path d="M2.5 6.5v3h2.5L9 13V3L5 6.5z" fill="currentColor" stroke="none" />
  <path d="M11 5.5a3.5 3.5 0 010 5" />
  <path d="M12.8 3.8a6 6 0 010 8.4" />
</>);

export const IconStep = (p: IconProps) => svg(p.size, <>
  <rect x="2.5" y="9.5" width="4" height="4" fill="currentColor" stroke="none" />
  <rect x="9.5" y="9.5" width="4" height="4" strokeDasharray="2 1.4" />
  <path d="M10.5 2v4M8.5 4l2 2 2-2" />
</>);

export const IconMagnet = (p: IconProps) => svg(p.size, <>
  <path d="M3 3v5a5 5 0 0010 0V3h-3.4v5a1.6 1.6 0 01-3.2 0V3z" />
  <path d="M3 5.5h3.2M9.8 5.5H13" />
</>);

export const IconUndo = (p: IconProps) => svg(p.size, <>
  <path d="M3 6h7a3.5 3.5 0 013.5 3.5v0A3.5 3.5 0 0110 13H6" />
  <path d="M5.5 3.5L3 6l2.5 2.5" />
</>);

export const IconRedo = (p: IconProps) => svg(p.size, <>
  <path d="M13 6H6a3.5 3.5 0 00-3.5 3.5v0A3.5 3.5 0 006 13h4" />
  <path d="M10.5 3.5L13 6l-2.5 2.5" />
</>);

export const IconDragOut = (p: IconProps) => svg(p.size, <>
  <rect x="1.5" y="6" width="8" height="8" rx="1.5" />
  <path d="M8 8 L14 2 M9.5 2 H14 V6.5" />
</>);

export const IconDragOutSelected = (p: IconProps) => svg(p.size, <>
  <rect x="1.5" y="6" width="8" height="8" rx="1.5" strokeDasharray="2 2" />
  <path d="M8 8 L14 2 M9.5 2 H14 V6.5" />
  <circle cx="5.5" cy="10" r="1.4" fill="currentColor" stroke="none" />
</>);

export const IconGear = (p: IconProps) => svg(p.size, <>
  <circle cx="8" cy="8" r="2.2" />
  <path d="M8 1.8l.7 1.8 1.9-.5 1 1.7 1.8.7-1 1.7 1.3 1.4-1.3 1.4 1 1.7-1.8.7-1 1.7-1.9-.5L8 14.2l-.7-1.8-1.9.5-1-1.7-1.8-.7 1-1.7L2.3 8l1.3-1.4-1-1.7 1.8-.7 1-1.7 1.9.5z" opacity="0.9" />
</>);

export const IconLogo = (p: IconProps) => svg(p.size, <>
  <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
  <path d="M4.5 3v10M7.5 3v10M10.5 3v10" opacity="0.55" />
  <rect x="5" y="6.5" width="3.4" height="2" fill="currentColor" stroke="none" />
  <rect x="9" y="9" width="4" height="2" fill="currentColor" stroke="none" opacity="0.8" />
</>);
