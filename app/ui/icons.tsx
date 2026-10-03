import type { SVGProps } from "react";

// One stroke weight, one grid. Drawn for 16 px.
const base = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

type P = SVGProps<SVGSVGElement>;

export const Icon = {
  plugin: (p: P) => (
    <svg {...base} {...p}><path d="M3 4.5h2.25a1.5 1.5 0 1 1 3 0H10.5v2.25a1.5 1.5 0 1 1 0 3V12.5H8.25a1.5 1.5 0 1 0-3 0H3V9.75a1.5 1.5 0 1 0 0-3z" /></svg>
  ),
  plug: (p: P) => (
    <svg {...base} {...p}><path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3" /></svg>
  ),
  instructions: (p: P) => (
    <svg {...base} {...p}><path d="M4 2.5h5.5L12 5v8.5H4z" /><path d="M9.5 2.5V5H12M6 8h4M6 10.5h4" /></svg>
  ),
  memory: (p: P) => (
    <svg {...base} {...p}><path d="M8 2.5a4 4 0 0 0-4 4c0 1.4.6 2.3 1.4 3 .5.5.6 1 .6 1.5v1h4v-1c0-.5.1-1 .6-1.5.8-.7 1.4-1.6 1.4-3a4 4 0 0 0-4-4z" /><path d="M6.5 14h3" /></svg>
  ),
  agents: (p: P) => (
    <svg {...base} {...p}><circle cx="8" cy="5.5" r="2.5" /><path d="M3.5 13.5c.6-2.4 2.3-3.5 4.5-3.5s3.9 1.1 4.5 3.5" /></svg>
  ),
  styles: (p: P) => (
    <svg {...base} {...p}><path d="M3 13l1-3.5 6.5-6.5a1.8 1.8 0 0 1 2.5 2.5L6.5 12z" /><path d="M9.5 4l2.5 2.5" /></svg>
  ),
  skills: (p: P) => (
    <svg {...base} {...p}><path d="M9 2L4 9h4l-1 5 5-7H8z" /></svg>
  ),
  settings: (p: P) => (
    <svg {...base} {...p}><path d="M3 4.5h6M12 4.5h1M3 8h1M7 8h6M3 11.5h7M13 11.5h0" /><circle cx="10.5" cy="4.5" r="1.5" /><circle cx="5.5" cy="8" r="1.5" /><circle cx="11.5" cy="11.5" r="1.5" /></svg>
  ),
  spark: (p: P) => (
    <svg {...base} {...p}><path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4zM13 11.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5z" /></svg>
  ),
  chart: (p: P) => (
    <svg {...base} {...p}><path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" /></svg>
  ),
  hook: (p: P) => (
    <svg {...base} {...p}><path d="M6 2.5v6.5a3 3 0 0 0 6 0V7.5M10.5 9l1.5-1.5L13.5 9" /></svg>
  ),
  bulb: (p: P) => (
    <svg {...base} {...p}><path d="M6 12.5h4M6.5 14.5h3M8 1.5a4.5 4.5 0 0 0-2.6 8.2c.4.3.6.8.6 1.3v.5h4V11c0-.5.2-1 .6-1.3A4.5 4.5 0 0 0 8 1.5z" /></svg>
  ),
  history: (p: P) => (
    <svg {...base} {...p}><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" /><path d="M2.5 2.5v2.5H5M8 5v3l2 1.5" /></svg>
  ),
  prefs: (p: P) => (
    <svg {...base} {...p}><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></svg>
  ),
  library: (p: P) => (
    <svg {...base} {...p}><path d="M3 2.5v11M6 2.5v11M9 3l3.5 10" /></svg>
  ),
  search: (p: P) => (
    <svg {...base} {...p}><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5l3 3" /></svg>
  ),
  shield: (p: P) => (
    <svg {...base} {...p}><path d="M8 1.75l5 2v4c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5v-4z" /><path d="M5.75 8l1.5 1.5 3-3" /></svg>
  ),
  more: (p: P) => (
    <svg {...base} {...p}><circle cx="3.75" cy="8" r=".6" fill="currentColor" /><circle cx="8" cy="8" r=".6" fill="currentColor" /><circle cx="12.25" cy="8" r=".6" fill="currentColor" /></svg>
  ),
  chevron: (p: P) => (
    <svg {...base} {...p}><path d="M5 6.5l3 3 3-3" /></svg>
  ),
  updown: (p: P) => (
    <svg {...base} {...p}><path d="M5 6l3-3 3 3M5 10l3 3 3-3" /></svg>
  ),
  book: (p: P) => (
    <svg {...base} {...p}><path d="M2.5 3.5c2-.8 3.8-.6 5.5.8 1.7-1.4 3.5-1.6 5.5-.8v9c-2-.8-3.8-.6-5.5.8-1.7-1.4-3.5-1.6-5.5-.8z" /><path d="M8 4.3v9" /></svg>
  ),
  external: (p: P) => (
    <svg {...base} {...p}><path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5" /></svg>
  ),
  plus: (p: P) => (
    <svg {...base} {...p}><path d="M8 3v10M3 8h10" /></svg>
  ),
  check: (p: P) => (
    <svg {...base} {...p}><path d="M3 8.5l3 3 7-7" /></svg>
  ),
  lock: (p: P) => (
    <svg {...base} {...p}><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
  ),
  refresh: (p: P) => (
    <svg {...base} {...p}><path d="M13 3v3h-3M3 13v-3h3" /><path d="M12.6 6A5 5 0 0 0 3.8 4.8M3.4 10a5 5 0 0 0 8.8 1.2" /></svg>
  ),
  trash: (p: P) => (
    <svg {...base} {...p}><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9" /></svg>
  ),
  close: (p: P) => (
    <svg {...base} {...p}><path d="M4 4l8 8M12 4l-8 8" /></svg>
  ),
  sessions: (p: P) => (
    <svg {...base} {...p}><path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5A1.5 1.5 0 0 1 2.5 9z" /><path d="M5.5 5.5h5M5.5 7.5h3" /></svg>
  ),
  folder: (p: P) => (
    <svg {...base} {...p}><path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2.5l1.5 1.5h4A1.5 1.5 0 0 1 13.5 6v5.5A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z" /></svg>
  ),
  read: (p: P) => (
    <svg {...base} {...p}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>
  ),
  edit: (p: P) => (
    <svg {...base} {...p}><path d="M3 13l.8-3 7-7a1.4 1.4 0 0 1 2.2 2.2l-7 7z" /><path d="M9.5 4.5l2 2" /></svg>
  ),
  run: (p: P) => (
    <svg {...base} {...p}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M5 6.5l2 1.5-2 1.5M8.5 10H11" /></svg>
  ),
  web: (p: P) => (
    <svg {...base} {...p}><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5" /></svg>
  ),
  agent: (p: P) => (
    <svg {...base} {...p}><circle cx="4.5" cy="4" r="1.5" /><circle cx="4.5" cy="12" r="1.5" /><circle cx="11.5" cy="8" r="1.5" /><path d="M4.5 5.5v5M6 4h1.5a2.5 2.5 0 0 1 2.5 2.5V8" /></svg>
  ),
  plan: (p: P) => (
    <svg {...base} {...p}><path d="M6.5 4.5h7M6.5 8h7M6.5 11.5h7" /><path d="M2.5 4.5l.8.8 1.5-1.6M2.5 8l.8.8 1.5-1.6" /><circle cx="3.5" cy="11.5" r=".6" /></svg>
  ),
  tool: (p: P) => (
    <svg {...base} {...p}><circle cx="8" cy="8" r="1.8" /><circle cx="8" cy="8" r="5.5" strokeDasharray="2 2.2" /></svg>
  ),
  copy: (p: P) => (
    <svg {...base} {...p}><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" /></svg>
  ),
  clock: (p: P) => (
    <svg {...base} {...p}><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.2" /></svg>
  ),
  branch: (p: P) => (
    <svg {...base} {...p}><circle cx="5" cy="3.8" r="1.3" /><circle cx="5" cy="12.2" r="1.3" /><circle cx="11" cy="5.5" r="1.3" /><path d="M5 5.1v5.8M11 6.8c0 2.4-2 3.2-6 4" /></svg>
  ),
  chip: (p: P) => (
    <svg {...base} {...p}><rect x="4" y="4" width="8" height="8" rx="1.5" /><path d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2" /></svg>
  ),
  arrow: (p: P) => (
    <svg {...base} {...p}><path d="M3 8h10M9 4l4 4-4 4" /></svg>
  ),
  back: (p: P) => (
    <svg {...base} {...p}><path d="M13 8H3M7 4L3 8l4 4" /></svg>
  ),
  layers: (p: P) => (
    <svg {...base} {...p}><path d="M8 2.5l5.5 3L8 8.5l-5.5-3z" /><path d="M2.5 8.5L8 11.5l5.5-3M2.5 11L8 14l5.5-3" /></svg>
  ),
  import: (p: P) => (
    <svg {...base} {...p}><path d="M8 2.5v7M5 6.5l3 3 3-3M3 11v1.5A1 1 0 0 0 4 13.5h8a1 1 0 0 0 1-1V11" /></svg>
  ),
};

/** The app's mark: three sheets, each a folder's instructions, laid over the one above it. */
export function Mark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect x="10" y="8" width="36" height="28" rx="6" fill="var(--paper-2)" stroke="var(--rule)" strokeWidth="1.5" />
      <rect x="15" y="18" width="36" height="28" rx="6" fill="var(--raised)" stroke="var(--rule)" strokeWidth="1.5" />
      <rect x="20" y="28" width="36" height="28" rx="6" fill="var(--raised)" stroke="var(--graphite)" strokeWidth="1.5" />
      <path d="M27 37h16M27 42.5h22M27 48h11" stroke="var(--graphite)" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="49" cy="37" r="3" fill="var(--pencil)" />
    </svg>
  );
}
