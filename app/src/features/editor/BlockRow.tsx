import { useState } from 'react';
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';

import type { JsonValue } from '../../data/db/types';
import type { EditorBlock } from '../../data/repositories/blocks';
import type { BoardImageFile } from '../board';
import { BoardBlock } from './blocks/BoardBlock';
import { CodeBlock } from './blocks/CodeBlock';
import {
  FileCardBlock,
  type FileCardLocalState,
} from './blocks/FileCardBlock';
import type { AttachmentDisplayState } from '../attachments/types';
import { FormulaBlock, type FormulaContextMenuState } from './blocks/FormulaBlock';
import { InlineEditable, type InlinePastePayload } from './blocks/InlineEditable';
import { LinkBlock } from './blocks/LinkBlock';
import { QuoteBlock } from './blocks/QuoteBlock';
import {
  TableBlock,
  type TableContextMenuState,
} from './blocks/TableBlock';
import { UnknownBlock } from './blocks/UnknownBlock';
import { canContainText } from './blocks/registry';
import { isBlockEmpty } from './model';
import type { LinkNoteOption } from './LinkDialog';
import {
  blockAlign,
  blockChecked,
  blockIndent,
  blockRuns,
  headingLevel,
  isHeadingBlockType,
  isTextualBlockType,
  type InlineMarks,
  type InlineRun,
} from './types';
import type { InlineSelection, SelectionRect } from './inline';

export type BlockRowProps = {
  block: EditorBlock;
  index: number;
  count: number;
  readOnly: boolean;
  active: boolean;
  dragging: boolean;
  /** 文档级块选择态（ZX-NOTE-03）；不改 payload。 */
  selected: boolean;
  /** 已有块选择时，Shift+点击正文任意位置也扩展范围。 */
  selecting: boolean;
  /**
   * 文档级全选（⌘/Ctrl+A）态：沿用 ZX-NOTE-07 的约定，不在每行挂
   * 复选框，避免整篇选中时所有行同时出现勾选框；普通写作态与高级
   * 块选择态都显示行前选择入口（ZX10-BLOCKSEL-01）。
   */
  documentSelecting: boolean;
  /** 搜索结果定位后的短暂高亮（N-18）；只影响视觉，不改内容。 */
  highlighted: boolean;
  onSelectBlock: (
    id: string,
    modifiers: {
      shiftKey: boolean;
      additive: boolean;
      /** false：取消选择后不把光标送回块内（行前控件点击）。 */
      restoreFocus?: boolean;
      /** true：键盘触发时保留控件焦点，避免选中后焦点被正文抢走。 */
      preserveFocus?: boolean;
    },
  ) => void;
  onFocusBlock: (id: string) => void;
  onBlurBlock: (id: string) => void;
  /** 打开站内笔记内链；由知识页判断目标是否存在。 */
  onOpenNote?: (noteId: string) => void;
  /** 画板块导出 PNG 后插入当前笔记（文件卡）。 */
  onBoardInsertImage?: (file: BoardImageFile) => Promise<void>;
  /** 引用出处弹层可选的未删除笔记（ZX-NOTE-04）。 */
  noteOptions?: readonly LinkNoteOption[];
  /** 打开引用出处弹层；由编辑器统一渲染，避免每个块各自持有弹层。 */
  onEditQuote?: (id: string) => void;
  onMenu: (id: string, rect: SelectionRect) => void;
  onInputRuns: (id: string, runs: InlineRun[]) => void;
  onInlineFormat: (patch: Partial<InlineMarks>) => void;
  onSelectionChange: (
    id: string,
    selection: (InlineSelection & { rect: SelectionRect }) | null,
  ) => void;
  onEnter: (id: string, before: InlineRun[], after: InlineRun[]) => void;
  onBackspaceAtStart: (id: string) => void;
  onSlash: (id: string, rect: SelectionRect) => void;
  onPaste: (id: string, payload: InlinePastePayload) => void;
  onToggleTodo: (id: string) => void;
  /** 编辑器右键菜单：表格/公式以块 id 回调，菜单由编辑器统一渲染。 */
  contextMenuBlockId?: string | null;
  onTableContextMenu?: (id: string, state: TableContextMenuState) => void;
  onFormulaContextMenu?: (id: string, state: FormulaContextMenuState) => void;
  /**
   * 非文本块的 payload 变更。`mergeKey` 用于把同一表格单元格/同一字段的
   * 连续输入合并成一步撤销历史；结构性操作不传。
   */
  onPayload: (id: string, patch: Record<string, JsonValue>, mergeKey?: string) => void;
  onDragStart: (id: string) => void;
  onDragOver: (id: string, event: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: (id: string) => void;
  /** 文件卡：按附件管理器查到的本机状态渲染打开/下载/删除。 */
  fileLocalStates?: Record<string, FileCardLocalState>;
  /** 按同步模式派生的展示状态；用于文件行文案，不参与打开判定。 */
  fileSyncStates?: Record<string, AttachmentDisplayState>;
  fileLocalErrors?: Record<string, string | null>;
  onFileOpen?: (id: string) => void | Promise<void>;
  onFileDownload?: (id: string) => void | Promise<void>;
  onFileRemoteDownload?: (id: string) => void | Promise<void>;
  onFileRemove?: (id: string) => void;
  onFileReselect?: (id: string) => void;
  onFileRename?: (id: string, name: string) => void;
};

function placeholderFor(block: EditorBlock): string {
  if (block.type === 'paragraph') {
    return '开始写…';
  }
  if (isHeadingBlockType(block.type)) {
    return '标题';
  }
  if (block.type === 'todo') {
    return '待办事项';
  }
  if (block.type === 'bullet_list' || block.type === 'ordered_list') {
    return '列表项';
  }
  if (block.type === 'quote') {
    return '引用';
  }
  return '开始写…';
}

export function BlockRow({
  block,
  index,
  count,
  readOnly,
  active,
  dragging,
  selected,
  selecting,
  documentSelecting,
  highlighted,
  onSelectBlock,
  onFocusBlock,
  onBlurBlock,
  onOpenNote,
  onBoardInsertImage,
  noteOptions,
  onEditQuote,
  onMenu,
  onInputRuns,
  onInlineFormat,
  onSelectionChange,
  onEnter,
  onBackspaceAtStart,
  onSlash,
  onPaste,
  onToggleTodo,
  contextMenuBlockId,
  onTableContextMenu,
  onFormulaContextMenu,
  onPayload,
  onDragStart,
  onDragOver,
  onDrop,
  fileLocalStates,
  fileSyncStates,
  fileLocalErrors,
  onFileOpen,
  onFileDownload,
  onFileRemoteDownload,
  onFileRemove,
  onFileReselect,
  onFileRename,
}: BlockRowProps) {
  const empty = isBlockEmpty(block);
  /**
   * 块序号不是常驻属性（ZX6-PROPS-02）：只在显式块选择态或指针悬停
   * 当前行时渲染。普通输入/阅读态（含焦点）不显示，避免每块右上角
   * 都挂着一个数字。用状态而非纯 :hover，保证隐藏时 DOM 里也不残留。
   */
  const [hovered, setHovered] = useState(false);
  const align = blockAlign(block);
  const indent = blockIndent(block);
  const rowStyle = {
    textAlign: align,
    '--zxe-indent': indent,
  } as CSSProperties;

  const inlineProps = {
    blockId: block.id,
    runs: blockRuns(block),
    readOnly,
    onInput: onInputRuns,
    onInlineFormat,
    onSelectionChange,
    onEnter,
    onBackspaceAtStart,
    onSlash,
    onPaste,
    onFocusBlock,
    onBlurBlock,
    onOpenNote,
  };

  let content: ReactNode;

  if (block.type === 'paragraph') {
    content = (
      <InlineEditable
        {...inlineProps}
        as="div"
        className="zxe-paragraph"
        ariaLabel="正文"
        placeholder={placeholderFor(block)}
      />
    );
  } else if (headingLevel(block.type)) {
    const level = headingLevel(block.type) ?? 2;
    const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5';
    content = (
      <InlineEditable
        {...inlineProps}
        as={Tag}
        className={`zxe-heading zxe-heading-${level}`}
        ariaLabel={`标题 ${level}`}
        placeholder={placeholderFor(block)}
      />
    );
  } else if (block.type === 'todo') {
    const checked = blockChecked(block);
    content = (
      <div className={checked ? 'zxe-todo is-done' : 'zxe-todo'}>
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={checked ? '标记未完成' : '标记完成'}
          className="zxe-todo-check"
          disabled={readOnly}
          onClick={() => onToggleTodo(block.id)}
        >
          {checked ? '✓' : ''}
        </button>
        <InlineEditable
          {...inlineProps}
          as="div"
          className="zxe-todo-text"
          ariaLabel="待办内容"
          placeholder={placeholderFor(block)}
        />
      </div>
    );
  } else if (block.type === 'bullet_list' || block.type === 'ordered_list') {
    const ordered = block.type === 'ordered_list';
    content = (
      <div className={ordered ? 'zxe-list zxe-list-ordered' : 'zxe-list'}>
        <span className="zxe-list-marker" aria-hidden="true">
          {ordered ? '1.' : '•'}
        </span>
        <InlineEditable
          {...inlineProps}
          as="div"
          className="zxe-list-text"
          ariaLabel={ordered ? '有序列表项' : '无序列表项'}
          placeholder={placeholderFor(block)}
        />
      </div>
    );
  } else if (block.type === 'quote') {
    content = (
      <QuoteBlock
        block={block}
        readOnly={readOnly}
        noteOptions={noteOptions}
        onOpenNote={onOpenNote}
        onEditSource={
          readOnly ? undefined : () => onEditQuote?.(block.id)
        }
        inlineProps={inlineProps}
      />
    );
  } else if (block.type === 'code') {
    content = (
      <CodeBlock
        block={block}
        readOnly={readOnly}
        onChange={(code) => onPayload(block.id, { code })}
        onChangeLanguage={(language) => onPayload(block.id, { language })}
        onChangeOptions={(patch) => onPayload(block.id, patch)}
      />
    );
  } else if (block.type === 'divider') {
    content = <hr className="zxe-divider" aria-label="分割线" />;
  } else if (block.type === 'table') {
    content = (
      <TableBlock
        block={block}
        readOnly={readOnly}
        contextMenuOpen={contextMenuBlockId === block.id}
        onContextMenu={
          onTableContextMenu
            ? (state) => onTableContextMenu(block.id, state)
            : undefined
        }
        onChange={(rows, cell) =>
          onPayload(
            block.id,
            { rows },
            cell
              ? `table:${block.id}:${cell.row}:${cell.column}`
              : undefined,
          )
        }
      />
    );
  } else if (block.type === 'file') {
    content = (
      <FileCardBlock
        block={block}
        readOnly={readOnly}
        onChangeName={(fileName) => onPayload(block.id, { fileName })}
        onCommitName={
          onFileRename
            ? (fileName) => onFileRename(block.id, fileName)
            : undefined
        }
        localState={fileLocalStates?.[block.id]}
        syncState={fileSyncStates?.[block.id]}
        localError={fileLocalErrors?.[block.id]}
        onOpen={onFileOpen ? () => onFileOpen(block.id) : undefined}
        onDownload={
          onFileDownload ? () => onFileDownload(block.id) : undefined
        }
        onRemoteDownload={
          onFileRemoteDownload
            ? () => onFileRemoteDownload(block.id)
            : undefined
        }
        onRemove={onFileRemove ? () => onFileRemove(block.id) : undefined}
        onReselect={
          onFileReselect ? () => onFileReselect(block.id) : undefined
        }
      />
    );
  } else if (block.type === 'board') {
    content = (
      <BoardBlock
        block={block}
        readOnly={readOnly}
        onChangeTitle={(title) => onPayload(block.id, { title })}
        onChangeBoard={(patch) =>
          onPayload(block.id, {
            boardId: patch.boardId,
            title: patch.title,
          })
        }
        onInsertExportedImage={onBoardInsertImage}
      />
    );
  } else if (block.type === 'formula') {
    content = (
      <FormulaBlock
        block={block}
        readOnly={readOnly}
        onContextMenu={
          onFormulaContextMenu
            ? (state) => onFormulaContextMenu(block.id, state)
            : undefined
        }
        onChangeLatex={(latex) =>
          onPayload(block.id, { latex, renderer: 'katex' })
        }
        onChangeDisplay={(display) =>
          onPayload(block.id, { display, renderer: 'katex' })
        }
      />
    );
  } else if (block.type === 'link') {
    content = (
      <LinkBlock
        block={block}
        readOnly={readOnly}
        noteOptions={noteOptions}
        onOpenNote={onOpenNote}
        onChange={(patch) => onPayload(block.id, patch)}
      />
    );
  } else {
    content = <UnknownBlock block={block} />;
  }

  const isTextual = isTextualBlockType(block.type) || block.type === 'code';

  return (
    <div
      className={[
        'zxe-row',
        active ? 'is-active' : '',
        selected ? 'is-block-selected' : '',
        dragging ? 'is-dragging' : '',
        highlighted ? 'is-search-hit' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-block-id={block.id}
      data-block-type={block.type}
      data-empty={empty ? 'true' : 'false'}
      data-selected={selected ? 'true' : 'false'}
      // 原子块（表格/公式/文件/画板/代码等）与可合并文本块区分开，
      // 供键盘逻辑、样式和验收脚本判断“前块能否合并”。
      data-block-atomic={canContainText(block.type) ? 'false' : 'true'}
      // 原子块没有 contenteditable；整行可编程聚焦，删除相邻块后
      // 仍能把键盘焦点留在位，而不是掉回 body。
      tabIndex={-1}
      style={rowStyle}
      onKeyDownCapture={(event) => {
        const native = event.nativeEvent;
        // 中文输入法组合态：Backspace/Enter 属于输入法候选操作，
        // 不能冒泡到 InlineEditable 触发块合并或拆块。
        if (native.isComposing || native.keyCode === 229) {
          event.stopPropagation();
        }
      }}
      onFocusCapture={() => onFocusBlock(block.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClickCapture={(event: ReactMouseEvent<HTMLDivElement>) => {
        // 默认不进入块选择：Shift+点击正文只做浏览器原生文字选择。
        // 只有已经通过「选择块」按钮或 ⌘/Ctrl+Shift+A 进入高级块选择后，
        // 才把整块当成范围单位，避免两套选择模型叠加。
        if (readOnly || !event.shiftKey || !selecting) {
          return;
        }
        const target = event.target as Element | null;
        if (target?.closest?.('.zxe-block-select, .zxe-block-control')) {
          return;
        }
        // 没有块选择时，Shift+点击正文仍交给浏览器扩展文字选区；进入块
        // 选择后才把整块作为范围单位，避免两套选择叠加。
        const interactive = target?.closest?.(
          'input, textarea, select, a, button, [data-inline-editor="true"]',
        );
        if (interactive && !selecting) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onSelectBlock(block.id, { shiftKey: true, additive: false });
      }}
      onDragOver={(event) => onDragOver(block.id, event)}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(block.id);
      }}
    >
      {readOnly ? null : (
        <div className="zxe-block-gutter">
          {/*
           * 行前低频块选择入口（ZX10-BLOCKSEL-01）：普通写作态常驻 DOM，
           * 随 gutter 在 hover / focus-within / 已选中时浮出。单击选中整行，
           * 再点取消，Shift+点击扩展范围，⌘/Ctrl+点击追加/切换；不打开
           * 块菜单、不触发拖拽。文档级全选（⌘/Ctrl+A）仍不挂每行复选框。
           */}
          {documentSelecting ? null : (
            <button
              type="button"
              className={
                selected
                  ? 'zxe-block-select is-selected'
                  : 'zxe-block-select'
              }
              aria-label={
                selected
                  ? `取消选择第 ${index + 1} 块`
                  : `选择第 ${index + 1} 块`
              }
              aria-pressed={selected}
              title={
                selected
                  ? `取消选择第 ${index + 1} 块 · Shift+点击扩展范围 · ⌘/Ctrl+点击追加`
                  : `选择第 ${index + 1} 块 · Shift+点击扩展范围 · ⌘/Ctrl+点击追加`
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const additive = event.metaKey || event.ctrlKey;
                // 无修饰键再次点击已选中行 = 取消该行；多选时只移除这一行。
                const toggleOff = selected && !event.shiftKey && !additive;
                onSelectBlock(block.id, {
                  shiftKey: event.shiftKey,
                  additive: additive || toggleOff,
                  restoreFocus: false,
                  // Enter/Space 触发的 click detail 为 0，保留按钮焦点以便
                  // 再次按 Enter 取消选择；鼠标点击仍沿用正文焦点。
                  preserveFocus: event.detail === 0,
                });
              }}
            >
              <span aria-hidden="true">{selected ? '✓' : ''}</span>
            </button>
          )}
          <button
            type="button"
            className={
              empty ? 'zxe-block-control is-empty' : 'zxe-block-control'
            }
            aria-label={empty ? '插入内容' : '块操作'}
            title={
              empty
                ? `在第 ${index + 1} 块插入内容`
                : `第 ${index + 1} 块操作 / 拖拽排序`
            }
            draggable
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              onMenu(block.id, {
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
              });
            }}
            onDragStart={(event) => {
              event.dataTransfer?.setData('text/plain', block.id);
              if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move';
              }
              onDragStart(block.id);
            }}
          >
            {empty ? '＋' : '⠿'}
          </button>
        </div>
      )}
      <div
        className={
          isTextual ? 'zxe-row-content is-textual' : 'zxe-row-content'
        }
      >
        {content}
      </div>
      {count > 1 && !readOnly && (selected || hovered) ? (
        <span className="zxe-row-index" aria-hidden="true">
          {index + 1}
        </span>
      ) : null}
    </div>
  );
}
