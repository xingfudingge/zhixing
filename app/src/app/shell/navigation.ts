import type { ComponentType, SVGProps } from 'react';

import {
  CalendarIcon,
  FocusIcon,
  HabitsIcon,
  InboxIcon,
  KnowledgeIcon,
  ReviewIcon,
  SettingsIcon,
  TodayIcon,
} from './icons';

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export type NavItem = {
  to: string;
  label: string;
  caption: string;
  icon: IconComponent;
  /**
   * 用于高亮的路径前缀。例如设置项链接到 /settings/appearance，
   * 但在任意 /settings/:group 下都应保持高亮。
   */
  activePrefix?: string;
};

export type NavSection = {
  id: string;
  label: string;
  items: NavItem[];
};

export const SETTINGS_NAV_ITEM: NavItem = {
  to: '/settings/appearance',
  label: '设置',
  caption: '偏好与同步',
  icon: SettingsIcon,
  activePrefix: '/settings',
};

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'workspace',
    label: '工作台',
    // 默认落点是今天；导航顺序固定为 今天 → 任务 → 日历。
    items: [
      { to: '/today', label: '今天', caption: '任务与视图', icon: TodayIcon },
      { to: '/tasks', label: '任务', caption: '全部任务', icon: InboxIcon },
      { to: '/calendar', label: '日历', caption: '事件与倒数日', icon: CalendarIcon },
    ],
  },
  {
    id: 'rhythm',
    label: '节奏',
    items: [
      { to: '/habits', label: '习惯', caption: '打卡与热力图', icon: HabitsIcon },
      { to: '/focus', label: '专注', caption: '计时与统计', icon: FocusIcon },
      { to: '/review', label: '复盘', caption: '回顾与总结', icon: ReviewIcon },
    ],
  },
  {
    id: 'knowledge',
    // 画板是笔记里的对象，不设平级入口；只保留知识。
    label: '知识',
    items: [
      { to: '/knowledge', label: '知识', caption: '目录 / 笔记', icon: KnowledgeIcon },
    ],
  },
];

export const SETTINGS_GROUPS = [
  { id: 'appearance', label: '外观与阅读', hint: '主题、强调色、密度与阅读偏好' },
  { id: 'task', label: '任务与记录', hint: '默认清单、提醒与完成后行为' },
  { id: 'calendar', label: '日历与工作日', hint: '时区、周起始与节假日' },
  { id: 'notify', label: '提醒与通知', hint: '摘要、免打扰与通知权限' },
  { id: 'ocr', label: '知识库与 OCR', hint: '识别范围、语言与引擎' },
  { id: 'privacy', label: '隐私与安全', hint: '失焦遮挡、剪贴板与加密笔记' },
  { id: 'sync', label: '同步与网络', hint: '本地 / WebDAV / 后台直连' },
  { id: 'data', label: '数据与备份', hint: '导出、导入与重置' },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]['id'];

export function isSettingsGroup(value: string | undefined): value is SettingsGroupId {
  return SETTINGS_GROUPS.some((group) => group.id === value);
}

export function settingsGroupOf(value: string | undefined) {
  return SETTINGS_GROUPS.find((group) => group.id === value);
}

export function isNavItemActive(pathname: string, item: NavItem): boolean {
  const base = item.activePrefix ?? item.to;
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function isImmersivePath(pathname: string): boolean {
  return (
    pathname === '/knowledge' ||
    pathname.startsWith('/knowledge/') ||
    pathname === '/board' ||
    pathname.startsWith('/board/')
  );
}
