/** 清单图标最小集：16×16 线性 SVG；空值/未知旧值回退为颜色圆点。 */

import type { CSSProperties, SVGProps } from 'react';

import type { List } from '../../data/db/types';
import { InboxIcon } from '../../app/shell/icons';

export const LIST_ICON_OPTIONS = [
  { value: '', label: '无（颜色点）' },
  { value: 'folder', label: '文件夹' },
  { value: 'briefcase', label: '公文包' },
  { value: 'home', label: '家' },
  { value: 'book', label: '书' },
  { value: 'star', label: '星标' },
  { value: 'bolt', label: '闪电' },
] as const;

export type ListIconValue = (typeof LIST_ICON_OPTIONS)[number]['value'];

const KNOWN = new Set<string>(
  LIST_ICON_OPTIONS.map((option) => option.value).filter(Boolean),
);

function IconSvg({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
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

function iconShape(icon: string) {
  switch (icon) {
    case 'folder':
      return (
        <>
          <path d="M1.9 4.1h4l1.2 1.5h7v6.6a1.4 1.4 0 0 1-1.4 1.4H3.3a1.4 1.4 0 0 1-1.4-1.4Z" />
          <path d="M1.9 5.6h12.2" />
        </>
      );
    case 'briefcase':
      return (
        <>
          <rect x="1.9" y="4.6" width="12.2" height="8.2" rx="1.4" />
          <path d="M6 4.6V3.5A1.1 1.1 0 0 1 7.1 2.4h1.8A1.1 1.1 0 0 1 10 3.5v1.1M1.9 8.3h12.2" />
        </>
      );
    case 'home':
      return (
        <>
          <path d="m2.2 7.1 5.8-4.6 5.8 4.6" />
          <path d="M3.7 6.4v6.2h8.6V6.4M6.6 12.6V9.2h2.8v3.4" />
        </>
      );
    case 'book':
      return (
        <>
          <path d="M8 3.6c-1.4-1-3.2-1.3-5.4-1v9.1c2.2-.3 4 0 5.4 1 1.4-1 3.2-1.3 5.4-1V2.6c-2.2-.3-4 0-5.4 1Z" />
          <path d="M8 3.6v9.1" />
        </>
      );
    case 'star':
      return (
        <>
          <path d="m8 1.9 1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.3l-3.6 1.9.7-4.1-3-2.9 4.1-.6Z" />
        </>
      );
    case 'bolt':
      return (
        <>
          <path d="M9.1 1.5 3.4 9h4l-.5 5.5L12.6 7h-4Z" />
        </>
      );
    default:
      return null;
  }
}

export type ListIconGlyphProps = {
  icon: string;
  color: string;
  inbox?: boolean;
  className?: string;
  size?: number;
};

/** 不依赖完整 List 行的图标渲染，供图标选择器与预览复用。 */
export function ListIconGlyph({
  icon,
  color,
  inbox = false,
  className,
  size = 16,
}: ListIconGlyphProps) {
  const style = {
    color: inbox ? 'var(--muted)' : color,
  } as CSSProperties;

  if (inbox) {
    return (
      <InboxIcon
        className={['list-icon', 'list-icon--inbox', className]
          .filter(Boolean)
          .join(' ')}
        width={size}
        height={size}
        style={style}
      />
    );
  }

  const shape = KNOWN.has(icon) ? iconShape(icon) : null;
  if (!shape) {
    return (
      <span
        className={['list-dot', className].filter(Boolean).join(' ')}
        style={{ '--list-color': color } as CSSProperties}
        aria-hidden="true"
      />
    );
  }

  return (
    <IconSvg
      className={['list-icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      style={style}
    >
      {shape}
    </IconSvg>
  );
}

export type ListIconProps = {
  list: List;
  className?: string;
  size?: number;
};

export function ListIcon({ list, className, size = 16 }: ListIconProps) {
  return (
    <ListIconGlyph
      icon={list.icon}
      color={list.color}
      inbox={list.isInbox}
      className={className}
      size={size}
    />
  );
}
