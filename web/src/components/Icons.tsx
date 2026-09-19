import type { SVGProps } from 'react';

const base = (p: SVGProps<SVGSVGElement>) => ({
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  ...p,
});

export const IconDay = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="4" y="5" width="16" height="15" rx="3" />
    <path d="M4 10h16M8 3v4M16 3v4" />
    <path d="M8 14h5" />
  </svg>
);
export const IconWeek = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="15" rx="3" />
    <path d="M3 10h18M9 10v10M15 10v10" />
  </svg>
);
export const IconMonth = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="3" y="5" width="18" height="15" rx="3" />
    <path d="M3 10h18" />
    <circle cx="8" cy="14.5" r="0.9" fill="currentColor" />
    <circle cx="12" cy="14.5" r="0.9" fill="currentColor" />
    <circle cx="16" cy="14.5" r="0.9" fill="currentColor" />
  </svg>
);
export const IconList = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <circle cx="4.5" cy="6" r="1" fill="currentColor" />
    <circle cx="4.5" cy="12" r="1" fill="currentColor" />
    <circle cx="4.5" cy="18" r="1" fill="currentColor" />
  </svg>
);
export const IconStats = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" />
  </svg>
);
export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 2, ...p })}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconSettings = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);
export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base({ strokeWidth: 2.2, ...p })}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
export const IconPlay = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M8 6v12l10-6z" fill="currentColor" stroke="none" />
  </svg>
);
export const IconX = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconChevronLeft = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);
export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);
export const IconToday = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
  </svg>
);
export const IconRepeat = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M17 2l4 4-4 4" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <path d="M7 22l-4-4 4-4" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
  </svg>
);
export const IconBell = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
);
export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
  </svg>
);
export const IconMic = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
  </svg>
);
export const IconStop = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
  </svg>
);
export const IconPause = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="7" y="6" width="3.5" height="12" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.5" y="6" width="3.5" height="12" rx="1" fill="currentColor" stroke="none" />
  </svg>
);
export const IconDownload = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
  </svg>
);
export const IconSend = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M21 3L10 14M21 3l-7 18-4-7-7-4z" />
  </svg>
);
export const IconChat = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 5h16v11H9l-5 4z" />
  </svg>
);
export const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M12 3l10 18H2z" />
    <path d="M12 10v5M12 18v.5" />
  </svg>
);
