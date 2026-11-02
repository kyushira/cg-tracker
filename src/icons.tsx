// Tiny inline SVG icons (no icon font, no network, works offline).
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export const IconClock = (p: P) => (
  <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const IconCheck = (p: P) => (
  <svg {...base} {...p}><path d="M4 12.5l5 5L20 6.5" /></svg>
);
export const IconSearch = (p: P) => (
  <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
);
export const IconScan = (p: P) => (
  <svg {...base} {...p}><path d="M4 7V5a1 1 0 011-1h2M17 4h2a1 1 0 011 1v2M20 17v2a1 1 0 01-1 1h-2M7 20H5a1 1 0 01-1-1v-2M8 8v8M11 8v8M14 8v8M17 8v8" /></svg>
);
export const IconGrid = (p: P) => (
  <svg {...base} {...p}><rect x="3" y="5" width="4" height="6" rx="1" /><rect x="10" y="5" width="4" height="6" rx="1" /><rect x="17" y="5" width="4" height="6" rx="1" /><rect x="3" y="14" width="4" height="6" rx="1" /><rect x="10" y="14" width="4" height="6" rx="1" /><rect x="17" y="14" width="4" height="6" rx="1" /></svg>
);
export const IconMore = (p: P) => (
  <svg {...base} {...p}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
);
export const IconUndo = (p: P) => (
  <svg {...base} {...p}><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 010 12h-3" /></svg>
);
export const IconX = (p: P) => (
  <svg {...base} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconDownload = (p: P) => (
  <svg {...base} {...p}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
);

/** App mark: two metrocarts married by a check. */
export const Logo = (p: P) => (
  <svg width="36" height="36" viewBox="0 0 64 64" aria-hidden {...p}>
    <rect width="64" height="64" rx="14" fill="#ffd60a" />
    <rect x="9" y="17" width="19" height="27" rx="3" fill="none" stroke="#0a0c10" strokeWidth="5" />
    <rect x="36" y="17" width="19" height="27" rx="3" fill="none" stroke="#0a0c10" strokeWidth="5" />
    <circle cx="14" cy="51" r="3" fill="#0a0c10" />
    <circle cx="23" cy="51" r="3" fill="#0a0c10" />
    <circle cx="41" cy="51" r="3" fill="#0a0c10" />
    <circle cx="50" cy="51" r="3" fill="#0a0c10" />
    <path d="M22 30h20" stroke="#0a0c10" strokeWidth="5" strokeLinecap="round" />
  </svg>
);
