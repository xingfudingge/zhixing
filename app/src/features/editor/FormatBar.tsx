import {
  useRef,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { SelectionRect } from './inline';
import type { InlineMarks } from './types';

export type ActiveInlineMarks = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
};

type FormatBarProps = {
  rect: SelectionRect;
  active: ActiveInlineMarks;
  onFormat: (patch: Partial<InlineMarks>) => void;
  onClear: () => void;
  onLink: () => void;
};

const TEXT_SWATCHES = [
  { color: '#c0392b', label: '红色' },
  { color: '#2f7e63', label: '绿色' },
  { color: '#5579d5', label: '蓝色' },
];

const BACKGROUND_SWATCH = '#fff1a8';

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  onAction: () => void;
};

/**
 * 在 mousedown 阶段执行格式命令，避免浏览器在 click 前折叠选区、
 * 导致浮条被卸载。键盘 Enter/Space 走 click 分支。
 */
function ActionButton({
  onAction,
  onPointerDown,
  onClick,
  onMouseDown,
  ...rest
}: ActionButtonProps) {
  const handled = useRef(false);
  return (
    <button
      type="button"
      {...rest}
      onPointerDown={(event: ReactPointerEvent<HTMLButtonElement>) => {
        // pointerdown 早于焦点迁移/选区折叠，先执行格式命令。
        event.preventDefault();
        handled.current = true;
        onAction();
        onPointerDown?.(event);
      }}
      onMouseDown={(event) => {
        // 阻止浏览器默认的焦点迁移；旧测试环境可能不派发 pointerdown。
        event.preventDefault();
        if (!handled.current) {
          handled.current = true;
          onAction();
        }
        onMouseDown?.(event);
      }}
      onClick={(event) => {
        if (handled.current) {
          handled.current = false;
          return;
        }
        onAction();
        onClick?.(event);
      }}
    />
  );
}

/**
 * 划词格式条：只有存在非折叠选区时出现，不是正文顶部的固定工具栏。
 */
export function FormatBar({
  rect,
  active,
  onFormat,
  onClear,
  onLink,
}: FormatBarProps) {
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const left = Math.max(
    10,
    Math.min(viewportWidth - 340, rect.left + rect.width / 2 - 170),
  );
  const top = Math.max(10, rect.top - 46);

  return (
    <div
      className="zxe-formatbar"
      role="toolbar"
      aria-label="文字格式"
      style={{ left, top }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <ActionButton
        aria-label="粗体"
        title="粗体"
        aria-pressed={active.bold}
        className={active.bold ? 'is-active' : undefined}
        onAction={() => onFormat({ bold: true })}
      >
        <b>B</b>
      </ActionButton>
      <ActionButton
        aria-label="斜体"
        title="斜体"
        aria-pressed={active.italic}
        className={active.italic ? 'is-active' : undefined}
        onAction={() => onFormat({ italic: true })}
      >
        <i>I</i>
      </ActionButton>
      <ActionButton
        aria-label="下划线"
        title="下划线"
        aria-pressed={active.underline}
        className={active.underline ? 'is-active' : undefined}
        onAction={() => onFormat({ underline: true })}
      >
        <u>U</u>
      </ActionButton>
      <ActionButton
        aria-label="删除线"
        title="删除线"
        aria-pressed={active.strike}
        className={active.strike ? 'is-active' : undefined}
        onAction={() => onFormat({ strike: true })}
      >
        <s>S</s>
      </ActionButton>
      <span className="zxe-formatbar-sep" aria-hidden="true" />
      <ActionButton
        aria-label="行内代码"
        title="行内代码"
        aria-pressed={active.code}
        className={active.code ? 'is-active' : undefined}
        onAction={() => onFormat({ code: true })}
      >
        &lt;/&gt;
      </ActionButton>
      <ActionButton aria-label="链接" title="链接" onAction={onLink}>
        ↗
      </ActionButton>
      <span className="zxe-formatbar-sep" aria-hidden="true" />
      {TEXT_SWATCHES.map((swatch) => (
        <ActionButton
          className="zxe-swatch"
          key={swatch.color}
          aria-label={`文字颜色 ${swatch.color}`}
          title={`${swatch.label}文字`}
          onAction={() => onFormat({ color: swatch.color })}
        >
          <span style={{ background: swatch.color }} aria-hidden="true" />
        </ActionButton>
      ))}
      <ActionButton
        className="zxe-swatch"
        aria-label={`背景颜色 ${BACKGROUND_SWATCH}`}
        title="黄色底色"
        onAction={() => onFormat({ background: BACKGROUND_SWATCH })}
      >
        <span style={{ background: BACKGROUND_SWATCH }} aria-hidden="true" />
      </ActionButton>
      <span className="zxe-formatbar-sep" aria-hidden="true" />
      <ActionButton
        className="zxe-formatbar-clear"
        aria-label="清除格式"
        title="清除格式"
        onAction={onClear}
      >
        ⌫
      </ActionButton>
    </div>
  );
}
