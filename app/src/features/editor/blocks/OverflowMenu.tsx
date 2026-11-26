/**
 * 块级工具条的 `⋯` 菜单（ZX-DESIGN-08）。
 *
 * 代码 / 公式 / 文件卡只保留主动作与识别信息，低频设置收进这里；
 * 菜单支持方向键、Home/End、Enter、Esc 关闭并归还焦点。
 *
 * ZX-DESIGN-15 §4.2：表格「更多」菜单需要在条目间分段，并给禁用项说明原因，
 * 因此新增可选的 `separator` / `hint`（两者都是增量字段，既有调用方不受影响）。
 * §4.3：禁用项不再用原生 disabled（那样无法聚焦），改为 `aria-disabled` 并拦截执行。
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

type OverflowMenuAction = {
  id: string;
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  /** 禁用原因或补充说明，显示为 title。 */
  hint?: string;
  separator?: false;
  onSelect: () => void;
};

type OverflowMenuSeparator = {
  id: string;
  separator: true;
};

export type OverflowMenuItem = OverflowMenuAction | OverflowMenuSeparator;

type OverflowMenuProps = {
  /** 触发按钮和菜单的可访问名称，例如「更多代码块选项」。 */
  label: string;
  items: OverflowMenuItem[];
  triggerTitle?: string;
  triggerContent?: ReactNode;
  triggerClassName?: string;
  className?: string;
  /**
   * 菜单打开后焦点去哪：
   * - `always`（默认，既有行为）：第一项；
   * - `keyboard`：只有键盘打开才进第一项，指针打开留在来源编辑器；
   * - `never`：不移动焦点。
   */
  focusOnOpen?: 'always' | 'keyboard' | 'never';
  /** 关闭/取消后焦点返回的元素；省略时回到触发按钮（既有行为）。 */
  returnFocusRef?: RefObject<HTMLElement | null>;
  /**
   * 指针按下触发按钮/菜单项时阻止默认聚焦。
   * 用于让 portal 菜单不把焦点从来源编辑器（例如公式 textarea）带走。
   */
  preservePointerFocus?: boolean;
  /** 菜单开关通知；来源据此记录选区快照与失焦保护。 */
  onOpenChange?: (open: boolean) => void;
};

type Position = {
  x: number;
  y: number;
};

const EDGE_GAP = 8;

export function OverflowMenu({
  label,
  items,
  triggerTitle,
  triggerContent = '⋯',
  triggerClassName,
  className,
  focusOnOpen = 'always',
  returnFocusRef,
  preservePointerFocus = false,
  onOpenChange,
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 本次打开是否由指针触发；键盘触发仍需把焦点送进第一项。 */
  const openedByPointerRef = useRef(false);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const menuId = useId();

  const notifyOpenChange = (next: boolean) => {
    onOpenChangeRef.current?.(next);
  };

  const focusReturnTarget = () => {
    const target = returnFocusRef?.current;
    if (target) {
      target.focus({ preventScroll: true });
      return;
    }
    triggerRef.current?.focus();
  };

  const close = (focusTrigger: boolean) => {
    setOpen(false);
    notifyOpenChange(false);
    if (focusTrigger) {
      focusReturnTarget();
    }
  };

  const openMenu = () => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    setPosition({ x: rect.left, y: rect.bottom + 4 });
    notifyOpenChange(true);
    setOpen(true);
  };

  const handleTriggerPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    openedByPointerRef.current = true;
    if (preservePointerFocus && event.button === 0) {
      // 阻止 pointerdown 的默认聚焦，焦点留在来源编辑器（公式 textarea）。
      event.preventDefault();
    }
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      openedByPointerRef.current = false;
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    const menu = menuRef.current;
    if (menu) {
      const rect = menu.getBoundingClientRect();
      const maxLeft = Math.max(
        EDGE_GAP,
        window.innerWidth - rect.width - EDGE_GAP,
      );
      const maxTop = Math.max(
        EDGE_GAP,
        window.innerHeight - rect.height - EDGE_GAP,
      );
      menu.style.left = `${Math.min(Math.max(EDGE_GAP, position.x), maxLeft)}px`;
      menu.style.top = `${Math.min(Math.max(EDGE_GAP, position.y), maxTop)}px`;
      const shouldFocusFirst =
        focusOnOpen === 'always' ||
        (focusOnOpen === 'keyboard' && !openedByPointerRef.current);
      if (shouldFocusFirst) {
        menu.querySelector<HTMLButtonElement>('button[role="menuitem"]')?.focus();
      }
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        (menuRef.current?.contains(target) ||
          triggerRef.current?.contains(target))
      ) {
        return;
      }
      // 指定了归还目标（例如公式输入框）时，点外部关闭菜单后把焦点还回去；
      // 若点击的是别的可聚焦元素，浏览器会在本次 pointerdown 默认动作里接管焦点。
      close(Boolean(returnFocusRef));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, position.x, position.y, focusOnOpen, returnFocusRef]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      close(true);
      return;
    }
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    event.preventDefault();
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]',
      ) ?? [],
    );
    if (buttons.length === 0) {
      return;
    }
    const current = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : current === -1
            ? 0
            : (current +
                (event.key === 'ArrowDown' ? 1 : -1) +
                buttons.length) %
              buttons.length;
    buttons[next]?.focus();
  };

  return (
    <span className={className ? `zxe-overflow ${className}` : 'zxe-overflow'}>
      <button
        ref={triggerRef}
        type="button"
        className={
          triggerClassName
            ? `zxe-overflow-trigger ${triggerClassName}`
            : 'zxe-overflow-trigger'
        }
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={triggerTitle ?? label}
        onPointerDown={handleTriggerPointerDown}
        onKeyDown={handleTriggerKeyDown}
        onClick={() => {
          if (open) {
            // 有归还目标时，关闭菜单而不是把焦点留在触发按钮上。
            close(Boolean(returnFocusRef));
          } else {
            openMenu();
          }
        }}
      >
        {triggerContent}
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="zxe-overflow-menu"
              role="menu"
              aria-label={label}
              style={{ left: position.x, top: position.y }}
              onKeyDown={handleMenuKeyDown}
              onPointerDown={(event) => {
                if (preservePointerFocus) {
                  // 指针选择菜单项不把焦点从来源编辑器抢到按钮上。
                  event.preventDefault();
                }
              }}
            >
              {items.map((item) =>
                item.separator ? (
                  <div
                    key={item.id}
                    role="separator"
                    className="zxe-overflow-separator"
                  />
                ) : (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    className="zxe-overflow-item"
                    aria-pressed={item.pressed}
                    aria-disabled={item.disabled || undefined}
                    title={item.hint}
                    onClick={() => {
                      if (item.disabled) {
                        return;
                      }
                      close(true);
                      item.onSelect();
                    }}
                  >
                    <span>{item.label}</span>
                    {item.pressed === true ? (
                      <span className="zxe-overflow-check" aria-hidden="true">
                        ✓
                      </span>
                    ) : null}
                  </button>
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
