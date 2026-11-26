import type { SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function TodayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="3.4" />
      <path d="M10 2.2v2M10 15.8v2M2.2 10h2M15.8 10h2M4.5 4.5l1.4 1.4M14.1 14.1l1.4 1.4M15.5 4.5l-1.4 1.4M5.9 14.1l-1.4 1.4" />
    </Svg>
  );
}

export function InboxIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 11.5 5 4.8A1.6 1.6 0 0 1 6.5 3.7h7A1.6 1.6 0 0 1 15 4.8l2 6.7" />
      <path d="M3 11.5h3.4l1 2h5.2l1-2H17v3.2a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 14.7Z" />
    </Svg>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4.5" width="14" height="12.5" rx="2" />
      <path d="M3 8.3h14M6.5 2.8v3.2M13.5 2.8v3.2" />
      <path d="M6.5 11.4h2M11.5 11.4h2M6.5 14.2h2" />
    </Svg>
  );
}

export function HabitsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 2.8c.7 2.8 1.8 4 3.6 4.7-1.8.8-3.1 2-3.6 5.2-.6-3.2-1.9-4.4-3.7-5.2 1.8-.7 3-1.9 3.7-4.7Z" />
      <path d="M15.8 11.8c.35 1.5.95 2.15 1.9 2.5-1 .4-1.6 1.1-1.9 2.8-.4-1.7-1-2.4-1.9-2.8.9-.35 1.5-1 1.9-2.5Z" />
    </Svg>
  );
}

export function FocusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="6.4" />
      <circle cx="10" cy="10" r="3" />
      <path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4" />
    </Svg>
  );
}

export function ReviewIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.2 16.8h13.6" />
      <rect x="4.5" y="9.5" width="2.6" height="5" rx=".8" />
      <rect x="8.7" y="5.6" width="2.6" height="8.9" rx=".8" />
      <rect x="12.9" y="7.7" width="2.6" height="6.8" rx=".8" />
    </Svg>
  );
}

export function ListsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7.2 5.5h9.2M7.2 10h9.2M7.2 14.5h9.2" />
      <circle cx="4" cy="5.5" r=".9" fill="currentColor" stroke="none" />
      <circle cx="4" cy="10" r=".9" fill="currentColor" stroke="none" />
      <circle cx="4" cy="14.5" r=".9" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function KnowledgeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.2 3.7h8.1A2.2 2.2 0 0 1 14.5 6v10.3H6.4a2.2 2.2 0 0 1-2.2-2.2Z" />
      <path d="M4.2 14.1a2.2 2.2 0 0 1 2.2-2.2h8.1M7.2 6.5h4.8M7.2 9.2h3.4" />
    </Svg>
  );
}

export function BoardIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.8" y="3.2" width="5.4" height="4.2" rx="1.1" />
      <rect x="11.8" y="12.6" width="5.4" height="4.2" rx="1.1" />
      <rect x="3.2" y="13.2" width="4.6" height="3.6" rx="1.1" />
      <path d="M8.2 5.3h2.4a2 2 0 0 1 2 2v5.3M6 7.4v5.8" />
    </Svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.6 11 4a6.3 6.3 0 0 1 1.7.7l1.6-.4 1.3 2.2-1 1.3c.1.5.2 1 .2 1.6s-.1 1.1-.2 1.6l1 1.3-1.3 2.2-1.6-.4a6.3 6.3 0 0 1-1.7.7l-1 1.4-2 0-1-1.4a6.3 6.3 0 0 1-1.7-.7l-1.6.4-1.3-2.2 1-1.3A6.4 6.4 0 0 1 3.7 10c0-.6.1-1.1.2-1.6l-1-1.3 1.3-2.2 1.6.4A6.3 6.3 0 0 1 7.5 4l1-1.4Z" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8.8" cy="8.8" r="5.2" />
      <path d="m12.7 12.7 4 4" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 4.2v11.6M4.2 10h11.6" />
    </Svg>
  );
}

export function HelpIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M8.1 7.7a2 2 0 1 1 3.2 1.7c-.8.5-1.3 1-1.3 2" />
      <path d="M10 14.2h.01" />
    </Svg>
  );
}

export function PaletteIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 3.2a6.8 6.8 0 1 0 0 13.6c1.4 0 2.1-.8 2.1-1.7 0-.8-.5-1.3-.5-2 0-.9.7-1.5 1.7-1.5h1.2c1.2 0 2.1-.9 2.1-2.2A6.7 6.7 0 0 0 10 3.2Z" />
      <circle cx="6.7" cy="8.1" r=".9" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="5.9" r=".9" fill="currentColor" stroke="none" />
      <circle cx="12.8" cy="7.1" r=".9" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function SyncIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M16.2 8.2A6.5 6.5 0 0 0 4.6 6.1L3 8" />
      <path d="M3 4.1V8h3.9M3.8 11.8a6.5 6.5 0 0 0 11.6 2.1L17 12" />
      <path d="M17 15.9V12h-3.9" />
    </Svg>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10 2.8c.8 3.4 1.9 4.6 4.4 5.5-2.5.9-3.7 2.2-4.4 5.8-.8-3.6-2-4.9-4.5-5.8C8 7.4 9.2 6.2 10 2.8Z" />
    </Svg>
  );
}

export function WorkspaceIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.8" y="3.2" width="14.4" height="13.6" rx="2" />
      <path d="M7 3.4v13.2M2.9 7.3h14.2" />
    </Svg>
  );
}
