/**
 * 引用块（ZX-NOTE-04）。
 *
 * 引用是块类型 `quote`，不是段落样式：正文沿用 runs，下面一行展示出处、
 * 关联笔记与来源链接。三个来源字段互相独立，可以任意组合或全空。
 *
 * 内链契约与链接块/关系图一致：只认 `zhixing://note/<合法 id>`。目标笔记
 * 已删除时不画可点击 chip，而是明确显示「关联笔记已删除」；历史脏 URL
 * 不渲染成可点击链接，交给出处弹层修正。
 */

import type { EditorBlock } from '../../../data/repositories/blocks';
import type { LinkNoteOption } from '../LinkDialog';
import { internalNoteIdFromUrl, sanitizeLinkUrl } from '../security';
import { blockQuote } from '../types';
import {
  InlineEditable,
  type InlineEditableProps,
} from './InlineEditable';

/** 除呈现细节外，正文编辑能力全部由 BlockRow 透传。 */
export type QuoteInlineProps = Omit<
  InlineEditableProps,
  'as' | 'className' | 'ariaLabel' | 'placeholder'
>;

type QuoteBlockProps = {
  block: EditorBlock;
  readOnly: boolean;
  /** 未删除的笔记；缺省时无法判断目标是否存在。 */
  noteOptions?: readonly LinkNoteOption[];
  onOpenNote?: (noteId: string) => void;
  /** 打开出处弹层；阅读态不传。 */
  onEditSource?: () => void;
  inlineProps: QuoteInlineProps;
};

export function QuoteBlock({
  block,
  readOnly,
  noteOptions,
  onOpenNote,
  onEditSource,
  inlineProps,
}: QuoteBlockProps) {
  const quote = blockQuote(block);
  const noteId = quote.noteId;
  const hasMeta = Boolean(
    quote.source || noteId || quote.sourceUrl,
  );

  const note = noteId
    ? noteOptions?.find((option) => option.id === noteId)
    : undefined;
  const noteMissing =
    Boolean(noteId) &&
    noteOptions !== undefined &&
    !note;

  const internalSourceId = internalNoteIdFromUrl(quote.sourceUrl);
  const externalSourceUrl = internalSourceId
    ? null
    : sanitizeLinkUrl(quote.sourceUrl);
  const sourceUrlInvalid =
    Boolean(quote.sourceUrl) &&
    !internalSourceId &&
    !externalSourceUrl;
  // noteId 优先级更高：同一篇笔记不重复显示两个内链 chip。
  const showSourceUrl =
    Boolean(quote.sourceUrl) &&
    internalSourceId !== noteId;

  const sourceNote = internalSourceId
    ? noteOptions?.find((option) => option.id === internalSourceId)
    : undefined;
  const internalSourceMissing =
    Boolean(internalSourceId) &&
    noteOptions !== undefined &&
    !sourceNote;

  const openNote = (noteId: string) => {
    if (onOpenNote) {
      onOpenNote(noteId);
    }
  };

  const sourceLine = quote.source ? `— ${quote.source}` : null;

  return (
    <blockquote
      className="zxe-quote"
      data-has-meta={hasMeta ? 'true' : 'false'}
      data-empty-meta={hasMeta ? 'false' : 'true'}
    >
      <InlineEditable
        {...inlineProps}
        as="div"
        className="zxe-quote-text"
        ariaLabel="引用内容"
        placeholder="引用"
      />

      {readOnly && !hasMeta ? null : (
        <div
          className="zxe-quote-meta"
          role="group"
          aria-label="引用出处"
        >
          {sourceLine ? (
            readOnly ? (
              <span className="zxe-quote-source" title={quote.source}>
                {sourceLine}
              </span>
            ) : (
              <button
                type="button"
                className="zxe-quote-source"
                title="编辑引用出处"
                onClick={onEditSource}
              >
                {sourceLine}
              </button>
            )
          ) : !readOnly ? (
            <button
              type="button"
              className="zxe-quote-add-source"
              onClick={onEditSource}
            >
              ＋ 添加出处
            </button>
          ) : null}

          {noteId ? (
            note ? (
              onOpenNote ? (
                <button
                  type="button"
                  className="zxe-quote-note"
                  title={`关联笔记：${note.title}`}
                  aria-label={`打开关联笔记：${note.title}`}
                  onClick={() => openNote(noteId)}
                >
                  ⌁ {note.title}
                </button>
              ) : (
                <span
                  className="zxe-quote-note"
                  title={`关联笔记：${note.title}`}
                >
                  ⌁ {note.title}
                </span>
              )
            ) : noteOptions === undefined && !noteMissing ? (
              onOpenNote ? (
                <button
                  type="button"
                  className="zxe-quote-note"
                  title={`关联笔记：${noteId}`}
                  aria-label="打开关联笔记"
                  onClick={() => openNote(noteId)}
                >
                  ⌁ 关联笔记
                </button>
              ) : (
                <span className="zxe-quote-note" title={noteId}>
                  ⌁ 关联笔记
                </span>
              )
            ) : (
              <span
                className="zxe-quote-note is-missing"
                aria-disabled="true"
                title="关联笔记已删除"
              >
                关联笔记已删除
              </span>
            )
          ) : null}

          {showSourceUrl ? (
            internalSourceId ? (
              internalSourceMissing ? (
                <span
                  className="zxe-quote-url is-missing"
                  aria-disabled="true"
                  title="站内来源已失效"
                >
                  站内来源已失效
                </span>
              ) : onOpenNote ? (
                <button
                  type="button"
                  className="zxe-quote-url"
                  title={
                    sourceNote
                      ? `站内来源：${sourceNote.title}`
                      : '打开站内来源'
                  }
                  aria-label={
                    sourceNote
                      ? `打开站内来源：${sourceNote.title}`
                      : '打开站内来源'
                  }
                  onClick={() => openNote(internalSourceId)}
                >
                  ⌁ 站内来源
                </button>
              ) : (
                <span className="zxe-quote-url" title="站内来源">
                  ⌁ 站内来源
                </span>
              )
            ) : externalSourceUrl ? (
              <a
                className="zxe-quote-url"
                href={externalSourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                title="打开来源"
                aria-label="打开来源链接"
              >
                ↗ 来源链接
              </a>
            ) : sourceUrlInvalid ? (
              <span
                className="zxe-quote-url is-invalid"
                role="alert"
                title="来源链接无效，请在出处弹层修正"
              >
                来源链接无效
              </span>
            ) : null
          ) : null}

          {!readOnly && (sourceLine || noteId || quote.sourceUrl) ? (
            <button
              type="button"
              className="zxe-quote-edit"
              aria-label="编辑引用出处"
              title="编辑引用出处"
              onClick={onEditSource}
            >
              <span aria-hidden="true">✎</span>
            </button>
          ) : null}
        </div>
      )}
    </blockquote>
  );
}
