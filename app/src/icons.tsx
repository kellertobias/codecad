// Line icons for toolbars, drawn on a 24 × 24 grid in the current text
// colour, so they follow the theme and the button's state.
import type { ReactNode } from "react";

const icons = {
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  redo: (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </>
  ),
  save: (
    <>
      <path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Z" />
      <path d="M8 3v5h7V3M8 21v-7h8v7" />
    </>
  ),
  saved: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  sketch: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16Z" />
      <path d="m13.5 6.5 4 4" />
    </>
  ),
  extrude: (
    <>
      <path d="M4 15 12 19l8-4-8-4Z" />
      <path d="M12 11V3m-3 3 3-3 3 3" />
    </>
  ),
  hole: (
    <>
      <ellipse cx="12" cy="7" rx="6" ry="2.5" />
      <path d="M6 7v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V7" />
      <path d="M12 9.5v8" strokeDasharray="2 2" />
    </>
  ),
  fillet: (
    <>
      <path d="M4 20V11a7 7 0 0 1 7-7h9" />
      <path d="M4 4h3M4 4v3" strokeDasharray="1.5 2" />
    </>
  ),
  chamfer: (
    <>
      <path d="M4 20V10l6-6h10" />
      <path d="M4 4h3M4 4v3" strokeDasharray="1.5 2" />
    </>
  ),
  shell: (
    <>
      <path d="M3 7h18v13H3Z" />
      <path d="M7 7v9h10V7" />
    </>
  ),
  pattern: (
    <>
      <rect x="3.5" y="3.5" width="6" height="6" rx="1" />
      <rect x="14.5" y="3.5" width="6" height="6" rx="1" />
      <rect x="3.5" y="14.5" width="6" height="6" rx="1" />
      <rect x="14.5" y="14.5" width="6" height="6" rx="1" />
    </>
  ),
  mirror: (
    <>
      <path d="M12 3v18" strokeDasharray="2 2" />
      <path d="M9 6 3 18h6ZM15 6l6 12h-6Z" />
    </>
  ),
  joint: (
    <>
      <path d="M3 5h8v5H8v4h3v5H3Z" />
      <path d="M21 5h-7v5h-3M14 19h7M21 5v14M11 14h3v5" />
    </>
  ),
  mate: (
    <>
      <path d="M4 16h16M4 20h16" />
      <path d="M8 4h8v6H8ZM12 10v3" />
    </>
  ),
  move: (
    <>
      <path d="M12 3v18M3 12h18" />
      <path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />
    </>
  ),
  measure: (
    <>
      <path d="m3 16 13-13 5 5-13 13Z" />
      <path d="m7 12 2 2M10 9l2 2M13 6l2 2" />
    </>
  ),
  select: <path d="M5 3l14 8-6 1.5L10 19Z" />,
  line: (
    <>
      <path d="M5 19 19 5" />
      <circle cx="5" cy="19" r="1.6" />
      <circle cx="19" cy="5" r="1.6" />
    </>
  ),
  rectangle: <rect x="3.5" y="6" width="17" height="12" rx="0.5" />,
  circle: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="0.8" />
    </>
  ),
  arc: (
    <>
      <path d="M4 18a10 10 0 0 1 16 0" />
      <circle cx="12" cy="18" r="0.8" />
    </>
  ),
  slot: <rect x="3" y="8" width="18" height="8" rx="4" />,
  trim: (
    <>
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="6" cy="17" r="2.5" />
      <path d="M8 8.5 20 17M8 15.5 20 7" />
    </>
  ),
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  front: (
    <>
      <path d="M5 8h11v11H5Z" />
      <path d="m5 8 3-3h11v11l-3 3M16 8l3-3" opacity="0.45" />
    </>
  ),
  top: (
    <>
      <path d="M5 8h11l3-3H8Z" />
      <path d="M5 8v11h11V8M16 19l3-3V5" opacity="0.45" />
    </>
  ),
  right: (
    <>
      <path d="M16 8l3-3v11l-3 3Z" />
      <path d="M16 8H5v11h11M5 8l3-3h11" opacity="0.45" />
    </>
  ),
  construction: <path d="M4 20 20 4" strokeDasharray="3 3" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </>
  ),
  model: (
    <>
      <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </>
  ),
  drawings: (
    <>
      <path d="M6 3h9l4 4v14H6Z" />
      <path d="M9 12h7M9 16h7M9 8h3" />
    </>
  ),
  layouts: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M3 12h10M13 4v16M13 9h8" />
    </>
  ),
  library: (
    <>
      <path d="M4 4h4v16H4ZM10 4h4v16h-4Z" />
      <path d="m16 5 3.5-1 3 15.5-3.5 1Z" />
    </>
  ),
  cutlist: (
    <>
      <path d="m4 6 1.5 1.5L8 5M4 12l1.5 1.5L8 11" />
      <path d="M11 6h9M11 12h9M11 18h9M5 18h.01" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11m-4-4 4 4 4-4" />
      <path d="M5 19h14" />
    </>
  ),
  isolate: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  offline: (
    <>
      <path d="M7 18h10a4 4 0 0 0 .8-7.9A6 6 0 0 0 6.3 8.6 4.8 4.8 0 0 0 7 18Z" />
      <path d="M3 3l18 18" />
    </>
  ),
  close_sketch: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16Z" />
      <path d="m15 17 2 2 4-4" />
    </>
  ),
  horizontal: (
    <>
      <path d="M4 12h16" />
      <circle cx="4" cy="12" r="1.5" />
      <circle cx="20" cy="12" r="1.5" />
    </>
  ),
  vertical: (
    <>
      <path d="M12 4v16" />
      <circle cx="12" cy="4" r="1.5" />
      <circle cx="12" cy="20" r="1.5" />
    </>
  ),
  parallel: <path d="M6 20 14 4M10 20l8-16" />,
  perpendicular: <path d="M4 20h16M10 20V6M10 15h5v5" />,
  equal: <path d="M5 9h14M5 15h14" />,
  tangent: (
    <>
      <circle cx="10" cy="13" r="6" />
      <path d="M3 7h18" />
    </>
  ),
  coincident: (
    <>
      <path d="M4 20 12 12l8 8M12 12V3" />
      <circle cx="12" cy="12" r="2" fill="currentColor" />
    </>
  ),
  on: (
    <>
      <path d="M3 17c5-8 13-8 18 0" />
      <circle cx="12" cy="11" r="2" fill="currentColor" />
    </>
  ),
  midpoint: (
    <>
      <path d="M3 12h18" />
      <path d="m12 8-3 4 3 4 3-4Z" fill="currentColor" />
    </>
  ),
  symmetric: (
    <>
      <path d="M12 3v18" strokeDasharray="2 2" />
      <circle cx="6" cy="12" r="1.8" />
      <circle cx="18" cy="12" r="1.8" />
    </>
  ),
  fix: (
    <>
      <rect x="6" y="11" width="12" height="9" rx="1.5" />
      <path d="M9 11V8a3 3 0 0 1 6 0v3" />
    </>
  ),
  dimension: (
    <>
      <path d="M4 6v12M20 6v12M4 12h16" />
      <path d="m7 9-3 3 3 3M17 9l3 3-3 3" />
    </>
  ),
  diameter: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M6 18 18 6" />
    </>
  ),
  radius: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 12l6-6" />
      <circle cx="12" cy="12" r="0.8" />
    </>
  ),
  dimension_h: (
    <>
      <path d="M4 5v6M20 5v6M4 8h16" />
      <path d="M4 16h16" opacity="0.4" />
    </>
  ),
  dimension_v: (
    <>
      <path d="M5 4h6M5 20h6M8 4v16" />
      <path d="M16 4v16" opacity="0.4" />
    </>
  ),
  offset: (
    <>
      <path d="M4 20V9a5 5 0 0 1 5-5h11" />
      <path d="M9 20v-9h11" strokeDasharray="2 2" />
    </>
  ),
  rotate_left: (
    <>
      <path d="M4 4v5h5" />
      <path d="M4.5 9A8 8 0 1 1 6 16.5" />
    </>
  ),
  rotate_right: (
    <>
      <path d="M20 4v5h-5" />
      <path d="M19.5 9A8 8 0 1 0 18 16.5" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <path d="M11 18.5h2" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof icons;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon-svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {icons[name]}
    </svg>
  );
}
