import type { SVGProps } from 'react';

import { ICONS, type IconName } from './icons';

export type IconProps = Omit<
  SVGProps<SVGSVGElement>,
  'name' | 'width' | 'height' | 'fill' | 'stroke'
> & {
  name: IconName;
  /** 视觉规范 §2.1：14 行内 / 16 按钮 / 18 工具轨 / 20 浮层 / 28 空态 */
  size?: number;
  /** 仅当图标本身承载信息时传入；可交互图标由按钮提供 aria-label。 */
  label?: string;
};

/**
 * 统一线性 SVG 图标。
 *
 * - `viewBox="0 0 24 24"`、`stroke-width=1.5`、圆角端点；
 * - 颜色一律 `currentColor`，由按钮的默认/悬停/选中/禁用态驱动；
 * - 默认 `aria-hidden`，避免和按钮文字重复朗读。
 */
export function Icon({
  name,
  size = 16,
  label,
  className,
  ...rest
}: IconProps) {
  return (
    <svg
      {...rest}
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      focusable="false"
      data-icon={name}
    >
      {label ? <title>{label}</title> : null}
      {ICONS[name]}
    </svg>
  );
}
