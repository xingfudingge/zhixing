import type { ReactNode } from 'react';

/**
 * 知行统一图标表（视觉规范 2026-10-28 §2）。
 *
 * 约定：
 * - 24×24 画布，内容落在 3–21 安全区；
 * - 仅用描边，不写死颜色（颜色由 `currentColor` 继承）；
 * - 线宽/端点/转角由 `<Icon>` 统一设置，图标本身只描述几何。
 *
 * 命名：`icon-<域>-<动作>` 去掉 `icon-` 前缀，域取
 * `board / note / common`。同一语义只保留一个图标。
 */
export const ICONS = {
  /* ---------- 画板：选择与结构 ---------- */
  'board-select': (
    <path d="M6 3.5 18.5 11l-5.6 1.3-2.4 5.7Z" />
  ),
  'board-hand': (
    <>
      <path d="M8.5 12.5V7.8a1.4 1.4 0 0 1 2.8 0v3.9" />
      <path d="M11.3 11.7V6.4a1.4 1.4 0 0 1 2.8 0v4.9" />
      <path d="M14.1 11.3V7.6a1.4 1.4 0 0 1 2.8 0v6.2" />
      <path d="M16.9 10.6v-1a1.4 1.4 0 0 1 2.8 0v5.3c0 3.4-2.4 5.8-5.8 5.8h-1.6c-1.9 0-3.3-.8-4.4-2.3l-3-3.9a1.55 1.55 0 0 1 2.4-1.95l2.2 2.2" />
    </>
  ),
  'board-connector': (
    <>
      <circle cx="5.5" cy="6" r="2" />
      <circle cx="18.5" cy="18" r="2" />
      <path d="M7.5 7.5 16.2 15.4" />
      <path d="m13.6 15.6 2.6.3-.3-2.6" />
    </>
  ),
  'board-template': (
    <>
      <rect x="3.5" y="3.5" width="7" height="5.5" rx="1" />
      <rect x="13.5" y="15" width="7" height="5.5" rx="1" />
      <path d="M10.5 6.2h3a2 2 0 0 1 2 2v6.8" />
      <path d="m13.6 12.4 1.9 2.3 1.9-2.3" />
    </>
  ),

  /* ---------- 画板：形状 ---------- */
  'board-rect': <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />,
  'board-round-rect': (
    <rect x="3.5" y="5.5" width="17" height="13" rx="4.5" />
  ),
  'board-ellipse': <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />,
  'board-diamond': <path d="M12 3.5 20.5 12 12 20.5 3.5 12Z" />,
  'board-text': (
    <>
      <path d="M5 6.5h14" />
      <path d="M12 6.5V18" />
      <path d="M8.5 18h7" />
    </>
  ),
  'board-sticky': (
    <>
      <path d="M4 4.5h10.5L20 10v9.5H4Z" />
      <path d="M14.5 4.5V10H20" />
    </>
  ),
  'board-frame': (
    <>
      <path d="M8 3.5v17" />
      <path d="M16 3.5v17" />
      <path d="M3.5 8h17" />
      <path d="M3.5 16h17" />
    </>
  ),
  'board-shapes': (
    <>
      <path d="M8 3.5 12 10H4Z" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <circle cx="16.5" cy="17" r="3.5" />
    </>
  ),

  /* ---------- 画板：连线线型 ---------- */
  'board-line-straight': (
    <>
      <circle cx="4.5" cy="19.5" r="1.2" />
      <circle cx="19.5" cy="4.5" r="1.2" />
      <path d="M5.5 18.5 18.5 5.5" />
    </>
  ),
  'board-line-elbow': (
    <>
      <circle cx="4.5" cy="19.5" r="1.2" />
      <circle cx="19.5" cy="10" r="1.2" />
      <path d="M4.5 18.3V12a2 2 0 0 1 2-2h13" />
    </>
  ),
  'board-line-curve': (
    <>
      <circle cx="4.5" cy="19.5" r="1.2" />
      <circle cx="19.5" cy="4.5" r="1.2" />
      <path d="M5.5 18.5C6 11.5 11.5 5.5 18.5 5.5" />
    </>
  ),

  /* ---------- 画板：历史与编辑 ---------- */
  'board-undo': (
    <>
      <path d="M4.5 9h8.7a5 5 0 0 1 0 10H8.5" />
      <path d="m8.5 5-4 4 4 4" />
    </>
  ),
  'board-redo': (
    <>
      <path d="M19.5 9h-8.7a5 5 0 0 0 0 10h4.7" />
      <path d="m15.5 5 4 4-4 4" />
    </>
  ),

  /* ---------- 画板：对齐 ---------- */
  'board-align-left': (
    <>
      <path d="M4 4v16" />
      <rect x="7" y="6.5" width="10" height="4" rx="1" />
      <rect x="7" y="13.5" width="6" height="4" rx="1" />
    </>
  ),
  'board-align-center': (
    <>
      <path d="M12 3v18" />
      <rect x="4" y="6.5" width="16" height="4" rx="1" />
      <rect x="7" y="13.5" width="10" height="4" rx="1" />
    </>
  ),
  'board-align-right': (
    <>
      <path d="M20 4v16" />
      <rect x="7" y="6.5" width="10" height="4" rx="1" />
      <rect x="11" y="13.5" width="6" height="4" rx="1" />
    </>
  ),
  'board-align-top': (
    <>
      <path d="M4 4h16" />
      <rect x="6.5" y="7" width="4" height="10" rx="1" />
      <rect x="13.5" y="7" width="4" height="6" rx="1" />
    </>
  ),
  'board-align-middle': (
    <>
      <path d="M3 12h18" />
      <rect x="6.5" y="4" width="4" height="16" rx="1" />
      <rect x="13.5" y="7" width="4" height="10" rx="1" />
    </>
  ),
  'board-align-bottom': (
    <>
      <path d="M4 20h16" />
      <rect x="6.5" y="7" width="4" height="10" rx="1" />
      <rect x="13.5" y="11" width="4" height="6" rx="1" />
    </>
  ),

  /* ---------- 笔记工具轨 ---------- */
  'note-read': (
    <>
      <path d="M3 12S6.6 5.5 12 5.5 21 12 21 12 17.4 18.5 12 18.5 3 12 3 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'note-edit': (
    <>
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17Z" />
      <path d="m13.5 6.5 3 3" />
    </>
  ),
  'note-style': (
    <>
      <path d="M5 18 10 5l5 13" />
      <path d="M7 13.5h6" />
      <path d="M4 20.5h16" />
    </>
  ),
  'note-link': (
    <>
      <path d="M10.5 13.5a3.5 3.5 0 0 0 4.9 0l2.3-2.3a3.5 3.5 0 0 0-4.9-4.9l-1.2 1.2" />
      <path d="M13.5 10.5a3.5 3.5 0 0 0-4.9 0l-2.3 2.3a3.5 3.5 0 0 0 4.9 4.9l1.2-1.2" />
    </>
  ),
  'note-outline': (
    <>
      <path d="M4 5.5h16" />
      <path d="M7 9.5h13" />
      <path d="M7 13.5h13" />
      <path d="M7 17.5h9" />
      <circle cx="4.5" cy="9.5" r="1" />
      <circle cx="4.5" cy="13.5" r="1" />
      <circle cx="4.5" cy="17.5" r="1" />
    </>
  ),
  'note-info': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11.2v5" />
      <path d="M12 7.8h.01" />
    </>
  ),
  'note-attachment': (
    <path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
  ),
  'note-focus': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1.2" />
    </>
  ),
  'note-typewriter': (
    <>
      <path d="M4 6.5h16" />
      <path d="M4 10.5h16" />
      <path d="M4 14.5h9" />
      <path d="M17.5 12.5v7" />
      <path d="M15 19.5h5" />
    </>
  ),
  'note-board': (
    <>
      <rect x="3.5" y="4" width="17" height="14" rx="2" />
      <path d="M8 18v2.5" />
      <path d="M16 18v2.5" />
      <path d="M7.5 8.5h9" />
      <path d="M7.5 12.5h5.5" />
    </>
  ),
  'note-fullscreen': (
    <>
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </>
  ),

  /* ---------- 通用 ---------- */
  'common-trash': (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V4.5h6V7" />
      <path d="m6.5 7 1 13h9l1-13" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </>
  ),
  'common-chevron-left': <path d="m14.5 5-7 7 7 7" />,
  'common-chevron-right': <path d="m9.5 5 7 7-7 7" />,
} as const satisfies Record<string, ReactNode>;

export type IconName = keyof typeof ICONS;
