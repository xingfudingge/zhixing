/**
 * 知识页的右键 / `···` 菜单，也是编辑器右键菜单的共用浮层。
 *
 * 菜单是应用内浮层：用 portal 挂到 body，避免被三栏工作区的
 * `overflow: hidden` 裁切；支持边界 clamp、Escape、点击外部、滚动/窗口
 * 尺寸变化时关闭，并可用方向键/Home/End 在菜单项间移动。
 *
 * ZX7-MENU-01 起统一支持：
 * - 分组标题 / 分隔线 / 图标槽 / 快捷键 / 危险项；
 * - 一层子菜单（hover 120ms、点击或 → 展开，← 收起）；
 * - radio / checkbox 语义（`aria-checked` + `role=menuitemradio/checkbox`）；
 * - `softDisabled`：保留可读的 `aria-disabled`、原因说明与跳过逻辑；
 * - 文案 key（`labelKey` / `hintKey`）由 `i18n/menu` 统一渲染。
 */

import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { t, type MenuKey } from '../../i18n/menu';

export type ContextMenuAction = {
  id: string;
  /** 旧调用方可继续传文案；编辑器菜单统一走 `labelKey`。 */
  label?: string;
  /** 菜单文案 key（ZX7-I18N-01）。与 `label` 二选一。 */
  labelKey?: MenuKey;
  icon?: string;
  /** 平台无关快捷键 token，如 `Mod+Shift+X`、`F2`、`Delete`。 */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** 不可用原因；渲染为 title，softDisabled 时同时作为 aria 说明。 */
  hint?: string;
  /** 不可用原因的 i18n key。与 `hint` 二选一。 */
  hintKey?: MenuKey;
  /** 兼容旧菜单：切换类动作（阅读/专注/面板）同步 aria-pressed。 */
  pressed?: boolean;
  /** radio / checkbox 的选中态。设置后渲染 `aria-checked`。 */
  checked?: boolean;
  /** 显式指定菜单项语义；默认 menuitem。 */
  role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
  /** 一层子菜单；父项不再需要 onSelect。 */
  submenu?: ContextMenuItem[];
  onSelect?: () => void;
};

export type ContextMenuDivider = {
  divider: true;
};

/** 菜单分组标题；用于表格属性、导出等需要命名的组。 */
export type ContextMenuHeading = {
  heading: string;
  /** 分组标题也支持 i18n key；编辑器菜单必须使用该字段。 */
  headingKey?: MenuKey;
};

export type ContextMenuItem =
  | ContextMenuAction
  | ContextMenuDivider
  | ContextMenuHeading;

export type ContextMenuCloseReason =
  | 'escape'
  | 'outside'
  | 'select'
  | 'tab'
  | 'reposition';

export type ContextMenuProps = {
  x: number;
  y: number;
  label?: string;
  items: ContextMenuItem[];
  /** 指针打开时传 false：焦点留在来源块/单元格，方向键再进入菜单。 */
  focusOnOpen?: boolean;
  /**
   * true 时不可用项不设原生 disabled，而用 aria-disabled + title，
   * 保留可聚焦与可读；键盘导航会跳过这些项。
   */
  softDisabled?: boolean;
  className?: string;
  onClose: (reason: ContextMenuCloseReason) => void;
};

const EDGE_GAP = 8;
const SUBMENU_GAP = 4;
const HOVER_DELAY = 120;

/**
 * 右栏浮窗当前是否可见。菜单优先做几何避让，而不是无条件关闭浮窗：
 * 触发点在浮窗之外时，菜单右缘不得越过浮窗左缘（ZX8-RAILPOP-01）。
 */
function visibleRailFlyout(): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null;
  }
  const element = document.querySelector<HTMLElement>(
    '[data-kn-rail-flyout]',
  );
  if (!element) {
    return null;
  }
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return null;
  }
  return element;
}

function isAction(item: ContextMenuItem): item is ContextMenuAction {
  return !('divider' in item) && !('heading' in item);
}

/** 将 `Mod+Shift+X` 之类的 token 渲染为当前平台的快捷键。 */
export function formatMenuShortcut(shortcut: string): string {
  const isApple =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
  if (!isApple && !/\bMod\b/.test(shortcut)) {
    return shortcut.replace(/\+/g, '+');
  }
  return shortcut
    .split('+')
    .map((token) => {
      if (token === 'Mod') return isApple ? '⌘' : 'Ctrl';
      if (token === 'Shift') return isApple ? '⇧' : 'Shift';
      if (token === 'Alt') return isApple ? '⌥' : 'Alt';
      return token;
    })
    .join(isApple ? '' : '+');
}

function resolvedLabel(item: ContextMenuAction): string {
  return item.labelKey ? t(item.labelKey) : (item.label ?? '');
}

function resolvedHint(item: ContextMenuAction): string | undefined {
  if (item.hintKey) return t(item.hintKey);
  return item.hint;
}

/** 只取当前列表的直接菜单项，避免把子菜单里的按钮算进方向键顺序。 */
function directButtons(
  list: HTMLElement | null | undefined,
): HTMLButtonElement[] {
  if (!list) return [];
  return Array.from(list.children).filter(
    (child): child is HTMLButtonElement =>
      child instanceof HTMLButtonElement &&
      child.classList.contains('kn-menu-item') &&
      !child.disabled &&
      child.getAttribute('aria-disabled') !== 'true',
  );
}

function isUnavailable(item: ContextMenuAction): boolean {
  return item.disabled === true;
}

type SubmenuPanelProps = {
  id: string;
  label: string;
  anchor: DOMRect;
  panelRef: (element: HTMLDivElement | null) => void;
  children: ReactNode;
};

/** 子菜单单独测量并翻转，不受主菜单 max-height / 滚动影响。 */
function SubmenuPanel({
  id,
  label,
  anchor,
  panelRef,
  children,
}: SubmenuPanelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({
    left: anchor.right + SUBMENU_GAP,
    top: anchor.top,
  });

  useLayoutEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    let left = anchor.right + SUBMENU_GAP;
    if (left + rect.width > window.innerWidth - EDGE_GAP) {
      left = anchor.left - rect.width - SUBMENU_GAP;
    }
    let top = anchor.top;
    if (top + rect.height > window.innerHeight - EDGE_GAP) {
      top = window.innerHeight - rect.height - EDGE_GAP;
    }
    setPosition({
      left: Math.max(EDGE_GAP, left),
      top: Math.max(EDGE_GAP, top),
    });
  }, [anchor]);

  return (
    <div
      ref={(element) => {
        ref.current = element;
        panelRef(element);
      }}
      className="kn-context-submenu"
      role="menu"
      aria-label={label}
      id={`${id}-submenu`}
      style={{ position: 'fixed', left: position.left, top: position.top }}
    >
      {children}
    </div>
  );
}

export function ContextMenu({
  x,
  y,
  label = '笔记操作',
  items,
  focusOnOpen = true,
  softDisabled = false,
  className,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const submenuRefs = useRef(new Map<string, HTMLDivElement>());
  const hoverTimerRef = useRef<number | null>(null);
  const pendingSubmenuFocusRef = useRef<string | null>(null);
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null);
  const menuId = useId();

  const clearHoverTimer = () => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  const openSubmenu = (id: string, focusFirst: boolean) => {
    clearHoverTimer();
    pendingSubmenuFocusRef.current = focusFirst ? id : null;
    setOpenSubmenuId(id);
  };

  const closeSubmenu = (restoreFocus: boolean) => {
    const current = openSubmenuId;
    clearHoverTimer();
    pendingSubmenuFocusRef.current = null;
    setOpenSubmenuId(null);
    if (restoreFocus && current) {
      window.setTimeout(() => itemRefs.current.get(current)?.focus(), 0);
    }
  };

  useEffect(() => () => clearHoverTimer(), []);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const rect = menu.getBoundingClientRect();
    let rightLimit = window.innerWidth - EDGE_GAP;

    const flyout = visibleRailFlyout();
    if (flyout) {
      const flyoutRect = flyout.getBoundingClientRect();
      // jsdom/隐藏布局没有真实尺寸：没有可避让的几何，交给视口 clamp。
      if (flyoutRect.width > 0 && flyoutRect.height > 0) {
        const triggerInFlyout =
          x >= flyoutRect.left &&
          x <= flyoutRect.right &&
          y >= flyoutRect.top &&
          y <= flyoutRect.bottom;
        if (!triggerInFlyout) {
          // 浮窗左侧放得下菜单才避让；放不下就关闭浮窗（只留菜单）。
          const maxLeftBesideFlyout =
            flyoutRect.left - EDGE_GAP - rect.width;
          if (maxLeftBesideFlyout < EDGE_GAP) {
            window.dispatchEvent(new CustomEvent('kn:close-rail-flyout'));
          } else {
            rightLimit = flyoutRect.left - EDGE_GAP;
          }
        }
      }
    }

    const maxLeft = Math.max(EDGE_GAP, rightLimit - rect.width);
    const maxTop = Math.max(EDGE_GAP, window.innerHeight - rect.height - EDGE_GAP);
    menu.style.left = `${Math.min(Math.max(EDGE_GAP, x), maxLeft)}px`;
    menu.style.top = `${Math.min(Math.max(EDGE_GAP, y), maxTop)}px`;
    if (focusOnOpen) {
      firstItemRef.current?.focus();
    }
  }, [focusOnOpen, x, y]);

  useEffect(() => {
    if (!openSubmenuId) return;
    if (pendingSubmenuFocusRef.current !== openSubmenuId) return;
    pendingSubmenuFocusRef.current = null;
    const panel = submenuRefs.current.get(openSubmenuId);
    directButtons(panel)[0]?.focus();
  }, [openSubmenuId]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) {
        return;
      }
      onClose('outside');
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const menu = menuRef.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        // 一次 Esc 只关闭菜单这一层，不再冒泡关闭右栏浮窗/展开内容区。
        event.stopPropagation();
        onClose('escape');
        return;
      }
      // 菜单内方向键/Tab 由容器 handler 接管，避免同一次按键关闭两次。
      if (menu && event.target instanceof Node && menu.contains(event.target)) {
        return;
      }
      if (event.key === 'Tab') {
        // Tab 关闭菜单，继续页面顺序；不把焦点困在菜单里。
        onClose('tab');
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
      const buttons = directButtons(menu);
      if (buttons.length === 0) {
        return;
      }
      event.preventDefault();
      const target =
        event.key === 'ArrowUp' || event.key === 'End'
          ? buttons[buttons.length - 1]
          : buttons[0];
      target?.focus();
    };
    const onReposition = (event: Event) => {
      // 菜单自身滚动（长菜单）不关闭；页面/窗口滚动才关闭。
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) {
        return;
      }
      onClose('reposition');
    };

    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown);
    }, 0);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [onClose]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      onClose('tab');
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (openSubmenuId) {
        closeSubmenu(true);
      } else {
        onClose('escape');
      }
      return;
    }

    const active = document.activeElement;
    const activeElement = active instanceof HTMLElement ? active : null;
    const list = activeElement?.closest<HTMLElement>(
      '.kn-context-submenu, .kn-context-menu',
    );
    const activeItem = activeElement?.closest<HTMLButtonElement>('.kn-menu-item');
    const inSubmenu = Boolean(activeElement?.closest('.kn-context-submenu'));

    // Enter / Space 执行当前项；preventDefault 防止原生 click 再触发一次。
    if (event.key === 'Enter' || event.key === ' ') {
      if (activeItem && !activeItem.disabled) {
        event.preventDefault();
        event.stopPropagation();
        activeItem.click();
      }
      return;
    }

    if (event.key === 'ArrowRight') {
      if (activeItem && openSubmenuId !== activeItem.dataset.submenuId) {
        const id = activeItem.dataset.submenuId;
        if (id) {
          event.preventDefault();
          event.stopPropagation();
          openSubmenu(id, true);
        }
      }
      return;
    }

    if (event.key === 'ArrowLeft') {
      if (inSubmenu && openSubmenuId) {
        event.preventDefault();
        event.stopPropagation();
        closeSubmenu(true);
      }
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
    event.stopPropagation();
    const buttons = directButtons(list ?? menuRef.current);
    if (buttons.length === 0) {
      return;
    }
    const currentIndex = buttons.indexOf(activeElement as HTMLButtonElement);
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : currentIndex === -1
            ? 0
            : (currentIndex +
                (event.key === 'ArrowDown' ? 1 : -1) +
                buttons.length) %
              buttons.length;
    buttons[nextIndex]?.focus();
  };

  const renderItems = (
    listItems: ContextMenuItem[],
    depth: 0 | 1,
  ): ReactNode =>
    listItems.map((item, index) => {
      if ('heading' in item) {
        const heading = item.headingKey ? t(item.headingKey) : item.heading;
        return (
          <div
            key={`heading-${depth}-${index}`}
            className="kn-menu-heading"
            aria-hidden="true"
          >
            {heading}
          </div>
        );
      }
      if (!isAction(item)) {
        return (
          <div
            key={`divider-${depth}-${index}`}
            className="kn-menu-divider"
            role="separator"
          />
        );
      }
      const unavailable = isUnavailable(item);
      const hasSubmenu = Boolean(item.submenu && item.submenu.length > 0);
      const isFirst =
        depth === 0 &&
        listItems
          .slice(0, index)
          .every((previous) => !isAction(previous) || previous.disabled);
      const hint = unavailable ? resolvedHint(item) : undefined;
      const hintId = `${menuId}-item-${depth}-${item.id}-hint`;
      const label = resolvedLabel(item);
      const role = item.role ?? (hasSubmenu ? 'menuitem' : 'menuitem');
      const checked =
        role === 'menuitemradio' || role === 'menuitemcheckbox'
          ? Boolean(item.checked)
          : undefined;
      const expanded = hasSubmenu ? openSubmenuId === item.id : undefined;
      return (
        <Fragment key={`${depth}-${item.id}`}>
          <button
            ref={(element) => {
              if (element) {
                itemRefs.current.set(item.id, element);
              } else {
                itemRefs.current.delete(item.id);
              }
              if (isFirst) {
                firstItemRef.current = element;
              }
            }}
            type="button"
            role={role}
            data-menu-item={item.id}
            data-submenu-id={hasSubmenu ? item.id : undefined}
            className={[
              'kn-menu-item',
              item.danger ? 'is-danger' : '',
              softDisabled && unavailable ? 'is-disabled' : '',
              hasSubmenu ? 'has-submenu' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            disabled={unavailable && !softDisabled}
            aria-disabled={softDisabled && unavailable ? 'true' : undefined}
            aria-pressed={
              role === 'menuitem' && item.pressed !== undefined
                ? item.pressed
                : undefined
            }
            aria-checked={checked}
            aria-haspopup={hasSubmenu ? 'menu' : undefined}
            aria-expanded={expanded}
            aria-controls={expanded ? `${menuId}-${item.id}-submenu` : undefined}
            aria-describedby={hint ? hintId : undefined}
            tabIndex={softDisabled && unavailable ? -1 : undefined}
            title={hint}
            onMouseEnter={(event) => {
              // 子菜单内部移动不能触发“换项收起已展开子菜单”的逻辑。
              if (event.currentTarget.closest('.kn-context-submenu')) {
                return;
              }
              if (hasSubmenu) {
                clearHoverTimer();
                hoverTimerRef.current = window.setTimeout(() => {
                  openSubmenu(item.id, false);
                }, HOVER_DELAY);
              } else if (openSubmenuId) {
                closeSubmenu(false);
              }
            }}
            onMouseLeave={() => {
              if (hasSubmenu) {
                clearHoverTimer();
              }
            }}
            onClick={() => {
              if (unavailable) {
                return;
              }
              if (hasSubmenu) {
                if (openSubmenuId === item.id) {
                  closeSubmenu(false);
                } else {
                  openSubmenu(item.id, true);
                }
                return;
              }
              onClose('select');
              item.onSelect?.();
            }}
            onFocus={(event) => {
              // 子菜单内的焦点不应反过来关闭自己；主菜单换项时收起已展开的子菜单。
              if (event.currentTarget.closest('.kn-context-submenu')) {
                return;
              }
              if (openSubmenuId && openSubmenuId !== item.id) {
                closeSubmenu(false);
              } else if (openSubmenuId && !hasSubmenu) {
                closeSubmenu(false);
              }
            }}
          >
            <span className="kn-menu-icon" aria-hidden="true">
              {item.icon ?? ''}
            </span>
            <span className="kn-menu-label">{label}</span>
            {hint ? (
              <span id={hintId} className="kn-menu-hint-text zx-visually-hidden">
                {hint}
              </span>
            ) : null}
            {item.shortcut ? (
              <span className="kn-menu-shortcut">
                {formatMenuShortcut(item.shortcut)}
              </span>
            ) : null}
            {checked ? (
              <span className="kn-menu-check" aria-hidden="true">
                ✓
              </span>
            ) : null}
            {hasSubmenu ? (
              <span className="kn-menu-arrow" aria-hidden="true">
                ▸
              </span>
            ) : null}
          </button>
          {hasSubmenu && openSubmenuId === item.id ? (
            <SubmenuPanel
              id={`${menuId}-${item.id}`}
              label={label}
              anchor={
                itemRefs.current.get(item.id)?.getBoundingClientRect() ??
                new DOMRect(x, y, 0, 0)
              }
              panelRef={(element) => {
                if (element) {
                  submenuRefs.current.set(item.id, element);
                } else {
                  submenuRefs.current.delete(item.id);
                }
              }}
            >
              {renderItems(item.submenu ?? [], 1)}
            </SubmenuPanel>
          ) : null}
        </Fragment>
      );
    });

  return createPortal(
    <div
      ref={menuRef}
      className={
        className ? `kn-context-menu ${className}` : 'kn-context-menu'
      }
      role="menu"
      aria-label={label}
      id={menuId}
      style={{ left: x, top: y }}
      onKeyDown={handleKeyDown}
    >
      {renderItems(items, 0)}
    </div>,
    document.body,
  );
}
