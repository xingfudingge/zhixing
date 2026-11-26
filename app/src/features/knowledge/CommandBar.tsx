/**
 * 知识页文档命令栏（ZX-DESIGN-08 / ZX-TOOLBAR-02 / ZX-DESIGN-15）。
 *
 * 顶层只有 5 个文档级命令：样式、插入、链接、导出、更多。
 * 命令栏不是格式栏：B/I/U/S、颜色等选区格式仍只在划词格式条和
 * 样式 popover 中出现。≤900 额外出现「工具」入口，打开 9 项工具抽屉，
 * 不在正文里补常驻按钮。
 */

import { useEffect, useRef, useState } from 'react';

import { Icon } from '../../ui/icons/Icon';
import { BLOCK_DEFINITIONS } from '../editor/blocks/registry';
import type { KnownBlockType } from '../editor/types';
import { t } from '../../i18n/menu';
import {
  ContextMenu,
  type ContextMenuItem,
  type ContextMenuCloseReason,
} from './contextMenu';

export type CommandExportFormat = 'docx' | 'pdf' | 'md' | 'zxnote';

type CommandMenuId = 'insert' | 'export' | 'more';

type MenuState = {
  id: CommandMenuId;
  x: number;
  y: number;
} | null;

export type CommandBarProps = {
  /** 当前块类型对应的中文标签，例如「正文」「标题 2」。 */
  styleLabel: string;
  readOnly: boolean;
  trashed: boolean;
  readingMode: boolean;
  focusMode: boolean;
  immersive: boolean;
  /** 内容区已展开（左树/列表收起）；命令栏保留唯一的「还原」入口。 */
  expanded?: boolean;
  styleOpen: boolean;
  narrow: boolean;
  /** ≤900 的工具抽屉是否打开；驱动「工具」按钮的 aria-expanded。 */
  toolsOpen: boolean;
  pinned: boolean;
  favorite: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onStyle: () => void;
  onInsert: (type: KnownBlockType) => void;
  onLink: () => void;
  onExport: (format?: CommandExportFormat) => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleReading: () => void;
  onToggleFocus: () => void;
  onToggleImmersive: () => void;
  onToggleExpanded?: () => void;
  onTogglePinned: () => void;
  onToggleFavorite: () => void;
  onCopyLink: () => void;
  onCopyBody: () => void;
  onMove: () => void;
  onRename: () => void;
  onShowInfo: () => void;
  onHelp: () => void;
  onRestore: () => void;
  onOpenTools: () => void;
};

const TEXT_TYPES: ReadonlyArray<KnownBlockType> = [
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5',
  'todo',
  'bullet_list',
  'ordered_list',
  'quote',
  'divider',
];

const INSERT_TYPES: ReadonlyArray<KnownBlockType> = [
  'table',
  'code',
  'formula',
  'file',
  'board',
  'link',
];

const INSERT_LABELS: Partial<Record<KnownBlockType, string>> = {
  paragraph: '正文',
  todo: '待办事项',
};

function definitionOf(type: KnownBlockType) {
  return BLOCK_DEFINITIONS.find((definition) => definition.type === type);
}

function insertItem(type: KnownBlockType, onInsert: (type: KnownBlockType) => void) {
  const definition = definitionOf(type);
  return {
    id: `insert-${type}`,
    label: INSERT_LABELS[type] ?? definition?.label ?? type,
    icon: definition?.icon,
    onSelect: () => onInsert(type),
  };
}


export function CommandBar({
  styleLabel,
  readOnly,
  trashed,
  readingMode,
  focusMode,
  immersive,
  expanded = false,
  styleOpen,
  narrow,
  toolsOpen,
  pinned,
  favorite,
  canUndo,
  canRedo,
  onStyle,
  onInsert,
  onLink,
  onExport,
  onUndo,
  onRedo,
  onToggleReading,
  onToggleFocus,
  onToggleImmersive,
  onToggleExpanded,
  onTogglePinned,
  onToggleFavorite,
  onCopyLink,
  onCopyBody,
  onMove,
  onRename,
  onShowInfo,
  onHelp,
  onRestore,
  onOpenTools,
}: CommandBarProps) {
  const [menu, setMenu] = useState<MenuState>(null);
  const styleRef = useRef<HTMLButtonElement>(null);
  const insertRef = useRef<HTMLButtonElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const toolsRef = useRef<HTMLButtonElement>(null);
  const previousToolsOpen = useRef(toolsOpen);

  const editable = !readOnly && !trashed;

  const triggerOf = (id: CommandMenuId) => {
    switch (id) {
      case 'insert':
        return insertRef.current;
      case 'export':
        return exportRef.current;
      case 'more':
        return moreRef.current;
    }
  };

  const openMenu = (id: CommandMenuId) => {
    const trigger = triggerOf(id);
    if (!trigger) {
      return;
    }
    if (menu?.id === id) {
      setMenu(null);
      return;
    }
    const rect = trigger.getBoundingClientRect();
    setMenu({ id, x: rect.left, y: rect.bottom + 4 });
  };

  const closeMenu = (reason: ContextMenuCloseReason) => {
    const active = menu;
    setMenu(null);
    if (reason === 'escape' || reason === 'select') {
      if (active) {
        triggerOf(active.id)?.focus();
      }
    }
  };

  // 抽屉关闭后把焦点还给「工具」触发按钮（ZX-DESIGN-15 §3.4）。
  useEffect(() => {
    if (previousToolsOpen.current && !toolsOpen) {
      toolsRef.current?.focus();
    }
    previousToolsOpen.current = toolsOpen;
  }, [toolsOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === 'F10') {
        event.preventDefault();
        styleRef.current?.focus();
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || !event.shiftKey || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'i') {
        event.preventDefault();
        if (editable) {
          openMenu('insert');
        }
        return;
      }
      if (key === 'k') {
        event.preventDefault();
        if (editable) {
          onLink();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editable, menu, onLink]);

  const styleDisabled = !editable;

  let menuItems: ContextMenuItem[] = [];
  let menuLabel = '';
  if (menu?.id === 'insert') {
    menuLabel = '插入块';
    menuItems = [
      { heading: '文本块' },
      ...TEXT_TYPES.map((type) => insertItem(type, onInsert)),
      { heading: '插入' },
      ...INSERT_TYPES.map((type) => insertItem(type, onInsert)),
    ];
  } else if (menu?.id === 'export') {
    menuLabel = '导出';
    menuItems = [
      { id: 'export-docx', label: 'Word 文档（.docx）', icon: '⇩', onSelect: () => onExport('docx') },
      { id: 'export-pdf', label: 'PDF（.pdf）', icon: '⇩', onSelect: () => onExport('pdf') },
      { id: 'export-md', label: 'Markdown（.md）', icon: '⇩', onSelect: () => onExport('md') },
      { id: 'export-zxnote', label: '知行笔记包（.zxnote）', icon: '⇩', onSelect: () => onExport('zxnote') },
      { divider: true },
      { id: 'export-options', label: '导出选项…', icon: '⇩', onSelect: () => onExport() },
      { heading: '说明' },
      { id: 'export-note-docx', label: 'Word 可编辑；v1 仅导出，不支持回导', icon: '·', disabled: true, onSelect: () => undefined },
      { id: 'export-note-pdf', label: 'PDF 为图像型，文字不可选中', icon: '·', disabled: true, onSelect: () => undefined },
      { id: 'export-note-md', label: 'Markdown 会丢失颜色与列宽', icon: '·', disabled: true, onSelect: () => undefined },
      { id: 'export-note-zxnote', label: '笔记包完整保留块/画板/附件；仅知行可导入', icon: '·', disabled: true, onSelect: () => undefined },
    ];
  } else if (menu?.id === 'more') {
    menuLabel = t('menu.common.more');
    menuItems = trashed
      ? [
          { id: 'restore', labelKey: 'menu.note.restore', icon: '↩', onSelect: onRestore },
          { id: 'copy-link', labelKey: 'menu.note.copyLink', icon: '⌁', onSelect: onCopyLink },
          { divider: true },
          { id: 'export', labelKey: 'menu.note.exportSnapshot', icon: '⇩', onSelect: () => onExport() },
        ]
      : [
          { heading: '编辑' },
          { id: 'undo', label: '撤销', icon: '↶', shortcut: 'Mod+Z', disabled: !canUndo || readOnly, onSelect: onUndo },
          { id: 'redo', label: '重做', icon: '↷', shortcut: 'Mod+Shift+Z', disabled: !canRedo || readOnly, onSelect: onRedo },
          ...(narrow
            ? [
                {
                  id: 'insert-link',
                  label: '插入链接',
                  icon: '⌁',
                  shortcut: 'Mod+Shift+K',
                  disabled: !editable,
                  onSelect: onLink,
                },
              ]
            : []),
          { heading: '视图' },
          {
            id: 'reading',
            label: readingMode ? '退出阅读' : '阅读模式',
            icon: readingMode ? '✎' : '◐',
            shortcut: 'Mod+Shift+R',
            pressed: readingMode,
            onSelect: onToggleReading,
          },
          {
            id: 'focus',
            label: focusMode ? '退出专注' : '专注模式',
            icon: '◉',
            shortcut: 'Mod+Shift+F',
            pressed: focusMode,
            onSelect: onToggleFocus,
          },
          {
            id: 'immersive',
            label: immersive ? '退出全屏' : '全屏阅读',
            icon: '⛶',
            shortcut: 'F11',
            pressed: immersive,
            onSelect: onToggleImmersive,
          },
          { heading: '笔记' },
          {
            id: 'pin',
            labelKey: pinned ? 'menu.note.unpin' : 'menu.note.pin',
            icon: '⌖',
            onSelect: onTogglePinned,
          },
          {
            id: 'favorite',
            labelKey: favorite ? 'menu.note.unfavorite' : 'menu.note.favorite',
            icon: favorite ? '★' : '☆',
            onSelect: onToggleFavorite,
          },
          {
            id: 'copy-link',
            labelKey: 'menu.note.copyLink',
            icon: '⌁',
            shortcut: 'Mod+Shift+L',
            onSelect: onCopyLink,
          },
          { id: 'copy-body', labelKey: 'menu.note.copyBody', icon: '▤', onSelect: onCopyBody },
          { divider: true },
          { id: 'move', labelKey: 'menu.note.move', icon: '⇄', onSelect: onMove },
          { id: 'rename', labelKey: 'menu.note.rename', icon: 'Aa', shortcut: 'F2', onSelect: onRename },
          { id: 'info', label: '笔记信息', icon: 'ⓘ', onSelect: onShowInfo },
          { heading: '帮助' },
          { id: 'help', label: '快捷键与说明…', icon: '?', onSelect: onHelp },
        ];
  }

  return (
    <div className="kn-commandbar" role="toolbar" aria-label="文档命令">
      <div className="kn-commandbar-main">
        <button
          ref={styleRef}
          type="button"
          className={styleOpen ? 'kn-cmd-button is-active' : 'kn-cmd-button'}
          aria-label={`样式菜单：${styleLabel}`}
          aria-haspopup="dialog"
          aria-expanded={styleOpen}
          aria-controls="kn-style-panel"
          title="样式与段落（Alt+F10）"
          disabled={styleDisabled}
          onClick={() => {
            setMenu(null);
            onStyle();
          }}
        >
          <span className="kn-cmd-icon" aria-hidden="true">
            Aa
          </span>
          <span className="kn-cmd-text">{styleLabel}</span>
          <span className="kn-cmd-caret" aria-hidden="true">
            ▾
          </span>
        </button>

        <button
          ref={insertRef}
          type="button"
          className="kn-cmd-button"
          aria-label="插入菜单"
          aria-haspopup="menu"
          aria-expanded={menu?.id === 'insert'}
          title="插入内容（⌘⇧I）"
          disabled={!editable}
          onClick={() => openMenu('insert')}
        >
          <span className="kn-cmd-icon" aria-hidden="true">
            ＋
          </span>
          <span className="kn-cmd-text">插入</span>
          <span className="kn-cmd-caret" aria-hidden="true">
            ▾
          </span>
        </button>

        {narrow ? null : (
          <button
            type="button"
            className="kn-cmd-button"
            aria-label="插入链接"
            title="链接（⌘⇧K）"
            disabled={!editable}
            onClick={onLink}
          >
            <Icon name="note-link" size={15} />
            <span className="kn-cmd-text">链接</span>
          </button>
        )}

        <button
          ref={exportRef}
          type="button"
          className="kn-cmd-button"
          aria-label="导出笔记"
          aria-haspopup="menu"
          aria-expanded={menu?.id === 'export'}
          title="导出（⇧⌘E）"
          onClick={() => openMenu('export')}
        >
          <span className="kn-cmd-icon" aria-hidden="true">
            ⇩
          </span>
          <span className="kn-cmd-text">导出</span>
          <span className="kn-cmd-caret" aria-hidden="true">
            ▾
          </span>
        </button>

        <button
          ref={moreRef}
          type="button"
          className="kn-cmd-button"
          aria-label="更多文档操作"
          aria-haspopup="menu"
          aria-expanded={menu?.id === 'more'}
          title="更多"
          onClick={() => openMenu('more')}
        >
          <span className="kn-cmd-icon" aria-hidden="true">
            ⋯
          </span>
          <span className="kn-cmd-text">更多</span>
          <span className="kn-cmd-caret" aria-hidden="true">
            ▾
          </span>
        </button>
      </div>

      <div className="kn-commandbar-end">
        {expanded && onToggleExpanded ? (
          <button
            type="button"
            className="kn-cmd-button kn-cmd-expanded"
            aria-label="还原目录与列表"
            title="还原目录与列表（Esc）"
            onClick={onToggleExpanded}
          >
            <span className="kn-cmd-icon" aria-hidden="true">
              ⇤
            </span>
            <span className="kn-cmd-text">还原</span>
          </button>
        ) : null}
        {readingMode ? (
          <button
            type="button"
            className="kn-cmd-primary"
            aria-label={trashed ? '回收站笔记不可编辑' : '进入编辑模式'}
            disabled={trashed}
            onClick={onToggleReading}
          >
            ✎ 编辑
          </button>
        ) : null}
        {narrow ? (
          <button
            ref={toolsRef}
            type="button"
            className="kn-cmd-button kn-cmd-tools"
            aria-label="工具"
            aria-haspopup="dialog"
            aria-expanded={toolsOpen}
            title="笔记工具：阅读/样式/链接/大纲/信息/附件/专注/画板/全屏"
            onClick={onOpenTools}
          >
            <span className="kn-cmd-icon" aria-hidden="true">
              ▤
            </span>
            <span className="kn-cmd-text">工具</span>
          </button>
        ) : null}
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={menuLabel}
          items={menuItems}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  );
}
