import type { EditorBlock } from '../../data/repositories/blocks';
import type { ActiveInlineMarks } from './FormatBar';
import { blockAlign, blockIndent, headingLevel, type InlineMarks, type KnownBlockType, type TextAlign } from './types';
import { BACKGROUND_COLORS, TEXT_COLORS } from './types';

type StylePanelProps = {
  block: EditorBlock | null;
  readOnly: boolean;
  active: ActiveInlineMarks;
  hasSelection: boolean;
  onClose: () => void;
  onConvert: (type: KnownBlockType) => void;
  onFormat: (patch: Partial<InlineMarks>) => void;
  onClear: () => void;
  onAlign: (align: TextAlign | undefined) => void;
  onIndent: (delta: number) => void;
  onInsert: (type: KnownBlockType) => void;
};

const HEADINGS: ReadonlyArray<{
  type: KnownBlockType;
  label: string;
}> = [
  { type: 'paragraph', label: '正文' },
  { type: 'heading1', label: 'H1' },
  { type: 'heading2', label: 'H2' },
  { type: 'heading3', label: 'H3' },
  { type: 'heading4', label: 'H4' },
  { type: 'heading5', label: 'H5' },
];

export function StylePanel({
  block,
  readOnly,
  active,
  hasSelection,
  onClose,
  onConvert,
  onFormat,
  onClear,
  onAlign,
  onIndent,
  onInsert,
}: StylePanelProps) {
  const disabled = readOnly || !block;
  const currentAlign = block ? blockAlign(block) ?? 'left' : 'left';
  const indent = block ? blockIndent(block) : 0;
  const blockType = block?.type;
  const currentHeading = blockType && headingLevel(blockType);

  return (
    <aside
      id="kn-style-panel"
      className="zxe-stylepanel"
      aria-label="样式面板"
      onMouseDown={(event) => event.preventDefault()}
    >
      <header className="zxe-panel-head">
        <div>
          <h2>样式</h2>
          <p>{hasSelection ? '作用于选中文字' : '作用于当前块'}</p>
        </div>
        <button
          type="button"
          className="zxe-panel-close"
          aria-label="关闭样式面板"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      {block ? (
        <p className="zxe-panel-current">
          当前块：{blockType === 'paragraph' ? '正文' : currentHeading ? `标题 ${currentHeading}` : blockType}
        </p>
      ) : (
        <p className="zxe-panel-current">选择正文中的块后可应用样式</p>
      )}

      <section className="zxe-panel-section" aria-label="块样式">
        <h3>块样式</h3>
        <div className="zxe-panel-grid">
          {HEADINGS.map((heading) => (
            <button
              type="button"
              key={heading.type}
              disabled={disabled}
              aria-pressed={blockType === heading.type}
              className={blockType === heading.type ? 'is-active' : undefined}
              onClick={() => onConvert(heading.type)}
            >
              {heading.label}
            </button>
          ))}
        </div>
      </section>

      <section className="zxe-panel-section" aria-label="行内格式">
        <h3>行内格式</h3>
        <div className="zxe-panel-grid zxe-panel-inline">
          <button
            type="button"
            aria-label="粗体"
            aria-pressed={active.bold}
            disabled={disabled}
            className={active.bold ? 'is-active' : undefined}
            onClick={() => onFormat({ bold: true })}
          >
            <b>B</b>
          </button>
          <button
            type="button"
            aria-label="斜体"
            aria-pressed={active.italic}
            disabled={disabled}
            className={active.italic ? 'is-active' : undefined}
            onClick={() => onFormat({ italic: true })}
          >
            <i>I</i>
          </button>
          <button
            type="button"
            aria-label="下划线"
            aria-pressed={active.underline}
            disabled={disabled}
            className={active.underline ? 'is-active' : undefined}
            onClick={() => onFormat({ underline: true })}
          >
            <u>U</u>
          </button>
          <button
            type="button"
            aria-label="删除线"
            aria-pressed={active.strike}
            disabled={disabled}
            className={active.strike ? 'is-active' : undefined}
            onClick={() => onFormat({ strike: true })}
          >
            <s>S</s>
          </button>
          <button
            type="button"
            aria-label="行内代码"
            aria-pressed={active.code}
            disabled={disabled}
            className={active.code ? 'is-active' : undefined}
            onClick={() => onFormat({ code: true })}
          >
            &lt;/&gt;
          </button>
        </div>
      </section>

      <section className="zxe-panel-section" aria-label="结构">
        <h3>结构</h3>
        <div className="zxe-panel-grid">
          <button
            type="button"
            disabled={disabled}
            aria-pressed={blockType === 'todo'}
            onClick={() => onConvert('todo')}
          >
            ☑ 待办
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={blockType === 'bullet_list'}
            onClick={() => onConvert('bullet_list')}
          >
            • 列表
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={blockType === 'ordered_list'}
            onClick={() => onConvert('ordered_list')}
          >
            1. 列表
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={blockType === 'quote'}
            onClick={() => onConvert('quote')}
          >
            ❝ 引用
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-pressed={blockType === 'code'}
            onClick={() => onConvert('code')}
          >
            代码
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onInsert('link')}
          >
            ↗ 链接
          </button>
        </div>
      </section>

      <section className="zxe-panel-section" aria-label="对齐与缩进">
        <h3>对齐与缩进</h3>
        <div className="zxe-panel-grid">
          {(
            [
              ['left', '左对齐'],
              ['center', '居中'],
              ['right', '右对齐'],
            ] as const
          ).map(([align, label]) => (
            <button
              type="button"
              key={align}
              disabled={disabled}
              aria-pressed={currentAlign === align}
              className={currentAlign === align ? 'is-active' : undefined}
              onClick={() => onAlign(align)}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            disabled={disabled || indent <= 0}
            onClick={() => onIndent(-1)}
          >
            减少缩进
          </button>
          <button
            type="button"
            disabled={disabled || indent >= 6}
            onClick={() => onIndent(1)}
          >
            增加缩进
          </button>
        </div>
      </section>

      <section className="zxe-panel-section" aria-label="文字颜色">
        <h3>文字颜色</h3>
        <div className="zxe-panel-colors">
          {TEXT_COLORS.map((color) => (
            <button
              type="button"
              key={color}
              className="zxe-swatch"
              aria-label={`文字颜色 ${color}`}
              title={color}
              disabled={disabled}
              onClick={() => onFormat({ color })}
            >
              <span style={{ background: color }} aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>

      <section className="zxe-panel-section" aria-label="背景颜色">
        <h3>背景颜色</h3>
        <div className="zxe-panel-colors">
          {BACKGROUND_COLORS.map((color) => (
            <button
              type="button"
              key={color}
              className="zxe-swatch"
              aria-label={`背景颜色 ${color}`}
              title={color}
              disabled={disabled}
              onClick={() => onFormat({ background: color })}
            >
              <span style={{ background: color }} aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>

      <button
        type="button"
        className="zxe-panel-clear"
        disabled={disabled}
        onClick={onClear}
      >
        清除全部格式
      </button>

      <section className="zxe-panel-section" aria-label="插入">
        <h3>插入</h3>
        <div className="zxe-panel-grid">
          <button type="button" disabled={disabled} onClick={() => onInsert('table')}>
            表格
          </button>
          <button type="button" disabled={disabled} onClick={() => onInsert('code')}>
            代码块
          </button>
          <button type="button" disabled={disabled} onClick={() => onInsert('formula')}>
            公式
          </button>
          <button type="button" disabled={disabled} onClick={() => onInsert('file')}>
            文件
          </button>
          <button type="button" disabled={disabled} onClick={() => onInsert('board')}>
            画板
          </button>
        </div>
      </section>
    </aside>
  );
}
