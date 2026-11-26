/**
 * 块类型注册表：菜单分组、默认 payload、工厂。
 *
 * 新块类型只需在这里登记；未知类型不在此表中，渲染层会保留原 payload
 * 并显示“未知块”，避免旧客户端/未来插件的数据被删除。
 */

import type {
  BlockPayload,
  EditorBlock,
} from '../../../data/repositories/blocks';
import type { KnownBlockType } from '../types';

export type BlockMenuGroup = '基础' | '插入';

export type BlockDefinition = {
  type: KnownBlockType;
  label: string;
  icon: string;
  group: BlockMenuGroup;
  description?: string;
};

export const BLOCK_DEFINITIONS: ReadonlyArray<BlockDefinition> = [
  { type: 'paragraph', label: '文本', icon: 'T', group: '基础' },
  { type: 'heading1', label: '标题 1', icon: 'H1', group: '基础' },
  { type: 'heading2', label: '标题 2', icon: 'H2', group: '基础' },
  { type: 'heading3', label: '标题 3', icon: 'H3', group: '基础' },
  { type: 'heading4', label: '标题 4', icon: 'H4', group: '基础' },
  { type: 'heading5', label: '标题 5', icon: 'H5', group: '基础' },
  { type: 'todo', label: '待办事项', icon: '☑', group: '基础' },
  { type: 'bullet_list', label: '无序列表', icon: '•', group: '基础' },
  { type: 'ordered_list', label: '有序列表', icon: '1.', group: '基础' },
  { type: 'quote', label: '引用', icon: '❝', group: '基础' },
  { type: 'code', label: '代码块', icon: '</>', group: '基础' },
  { type: 'divider', label: '分割线', icon: '—', group: '基础' },
  {
    type: 'table',
    label: '表格',
    icon: '▦',
    group: '插入',
    description: '3×3 可编辑表格',
  },
  {
    type: 'file',
    label: '文件 / 图片',
    icon: '⌁',
    group: '插入',
    description: '只记录文件信息，不保存内容',
  },
  {
    type: 'board',
    label: '画板',
    icon: '▧',
    group: '插入',
    description: '保存画板引用，预览由画板模块提供',
  },
  {
    type: 'formula',
    label: '公式',
    icon: '∑',
    group: '插入',
    description: '保存 LaTeX 源，暂不渲染',
  },
  {
    type: 'link',
    label: '链接',
    icon: '↗',
    group: '插入',
    description: '仅允许 http / https / mailto',
  },
];

export const BLOCK_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  BLOCK_DEFINITIONS.map((definition) => [definition.type, definition.label]),
);

export function blockLabel(type: string): string {
  return BLOCK_LABELS[type] ?? `未知块（${type}）`;
}

export function defaultPayload(type: KnownBlockType): BlockPayload {
  switch (type) {
    case 'paragraph':
    case 'heading1':
    case 'heading2':
    case 'heading3':
    case 'heading4':
    case 'heading5':
    case 'bullet_list':
    case 'ordered_list':
    case 'quote':
      return { runs: [] };
    case 'todo':
      return { runs: [], checked: false };
    case 'code':
      return { code: '', language: '' };
    case 'divider':
      return {};
    case 'table':
      return {
        rows: [
          ['列 1', '列 2', '列 3'],
          ['', '', ''],
          ['', '', ''],
        ],
        header: true,
      };
    case 'file':
      return {
        attachmentId: null,
        fileName: '',
        byteSize: 0,
        mime: '',
        status: 'local',
      };
    case 'board':
      return { boardId: null, title: '未命名画板' };
    case 'formula':
      return { latex: '\\frac{a}{b}', renderer: 'none' };
    case 'link':
      return { url: '', title: '' };
    default:
      return {};
  }
}

export function newBlockId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `blk-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function createBlock(
  type: KnownBlockType,
  noteId = '',
  id: string = newBlockId(),
): EditorBlock {
  const now = new Date().toISOString();
  return {
    id,
    noteId,
    type,
    orderKey: 0,
    payload: defaultPayload(type),
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    version: 0,
  };
}

export function canContainText(type: string): boolean {
  return (
    type === 'paragraph' ||
    type === 'heading1' ||
    type === 'heading2' ||
    type === 'heading3' ||
    type === 'heading4' ||
    type === 'heading5' ||
    type === 'todo' ||
    type === 'bullet_list' ||
    type === 'ordered_list' ||
    type === 'quote'
  );
}

export function menuGroups(): Array<{
  group: BlockMenuGroup;
  items: BlockDefinition[];
}> {
  return (['基础', '插入'] as const).map((group) => ({
    group,
    items: BLOCK_DEFINITIONS.filter((definition) => definition.group === group),
  }));
}
