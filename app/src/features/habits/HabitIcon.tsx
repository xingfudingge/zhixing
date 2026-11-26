/**
 * 习惯语义图标：统一 24×24 线性 SVG，描边使用 `currentColor`，
 * 由外层容器决定色调，因此明暗主题与选中/禁用态共用一套图形。
 */

import type { ReactNode } from 'react';

import {
  habitIconLabel,
  normalizeHabitIcon,
  type HabitIconKey,
} from './stats';

const SHAPES: Record<HabitIconKey, ReactNode> = {
  read: (
    <>
      <path d="M4 5.6c2.6-1.1 5.3-1.1 8 .4 2.7-1.5 5.4-1.5 8-.4v13c-2.6-1.1-5.3-1.1-8 .4-2.7-1.5-5.4-1.5-8-.4z" />
      <path d="M12 6v13" />
      <path d="M6.7 8.8c1.2-.3 2.3-.2 3.4.2M6.7 11.8c1.2-.3 2.3-.2 3.4.2" />
    </>
  ),
  exercise: (
    <>
      <path d="M7 7.5v9M17 7.5v9M4.4 10v4M19.6 10v4M7 12h10" />
    </>
  ),
  water: (
    <>
      <path d="M12 3.2c3.1 3.8 5.2 6.4 5.2 9.1a5.2 5.2 0 0 1-10.4 0c0-2.7 2.1-5.3 5.2-9.1z" />
      <path d="M8.9 13.1c.3 1.8 1.6 3 3.1 3.2" />
    </>
  ),
  sleep: (
    <>
      <path d="M19.8 14.9A8.1 8.1 0 0 1 9.1 4.2a8.1 8.1 0 1 0 10.7 10.7z" />
      <path d="M15.8 4.2h3.4l-3.4 3.4h3.4" />
    </>
  ),
  meditate: (
    <>
      <circle cx="12" cy="5" r="1.8" />
      <path d="M12 7.8v4.4" />
      <path d="M12 9.2c-2.1 0-3.4 1.2-3.4 2.8v1.8M12 9.2c2.1 0 3.4 1.2 3.4 2.8v1.8" />
      <path d="M5 17.5c1.6-2 4-3 7-3s5.4 1 7 3" />
      <path d="M8.6 13.8 6 17M15.4 13.8 18 17" />
    </>
  ),
  write: (
    <>
      <path d="M4.5 19.5l3.9-.9L19 8a2.12 2.12 0 0 0-3-3L5.4 15.6z" />
      <path d="M14.5 6.5l3 3M5.4 15.6l3 3" />
    </>
  ),
  study: (
    <>
      <path d="M3 9.2 12 5l9 4.2-9 4.2z" />
      <path d="M7 11.2v4.3c0 1.5 2.2 2.7 5 2.7s5-1.2 5-2.7v-4.3" />
      <path d="M21 9.4v5" />
    </>
  ),
  wake: (
    <>
      <circle cx="12" cy="9" r="3.2" />
      <path d="M12 2.8v1.8M5.8 9H4M20 9h-1.8M7.6 4.6 6.3 3.3M16.4 4.6l1.3-1.3" />
      <path d="M3 16.5h18M6 20h12" />
    </>
  ),
  diet: (
    <>
      <path d="M4 12.5h16a8 8 0 0 1-16 0z" />
      <path d="M8 20h8" />
      <path d="M9 9.5c0-1.1 1.2-1.3 1.2-2.5M13.8 9.5c0-1.1 1.2-1.3 1.2-2.5" />
    </>
  ),
  tidy: (
    <>
      <path d="M4 8h16v11H4z" />
      <path d="M3 4.5h18V8H3z" />
      <path d="M9.5 11.8h5" />
    </>
  ),
  music: (
    <>
      <path d="M9 17.5V5.8l10-2v11.7" />
      <circle cx="6.8" cy="17.8" r="2.1" />
      <circle cx="16.8" cy="15.8" r="2.1" />
    </>
  ),
  custom: (
    <>
      <path d="M12 3.5c.7 4.5 2.5 6.3 7 7-4.5.7-6.3 2.5-7 7-.7-4.5-2.5-6.3-7-7 4.5-.7 6.3-2.5 7-7z" />
      <path d="M18.5 16.5c.25 1.55.95 2.25 2.5 2.5-1.55.25-2.25.95-2.5 2.5-.25-1.55-.95-2.25-2.5-2.5 1.55-.25 2.25-.95 2.5-2.5z" />
    </>
  ),
};

export type HabitIconProps = {
  /** 稳定 key 或旧数据里的字符；统一走 normalize。 */
  icon: string | null | undefined;
  size?: number;
  className?: string;
  /** 纯装饰时由外层控件提供可访问名称。 */
  decorative?: boolean;
};

export function HabitIcon({
  icon,
  size = 20,
  className,
  decorative = false,
}: HabitIconProps) {
  const key = normalizeHabitIcon(icon);
  const label = `${habitIconLabel(key)}图标`;
  return (
    <svg
      className={['habit-glyph', className].filter(Boolean).join(' ')}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      data-habit-icon={key}
      focusable="false"
    >
      {SHAPES[key]}
    </svg>
  );
}
