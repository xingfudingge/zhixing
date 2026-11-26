/**
 * 清单树（侧栏唯一实例；清单页不再渲染第二份）。
 *
 * * 只渲染用户清单；内部 capture（is_inbox）不出现，也不作为入口。
 * * 用户清单可展开/折叠；拖拽只有同级排序、成为子清单、拖到树空白处三种落点。
 * * 拖拽走 PointerEvent（Tauri WKWebView 对 HTML5 DragEvent 不可靠），
 *   与 ZX-UX-01 的 6px 阈值模式一致。
 * * `onMove` 由上层写入 `lists_move`；失败时库层拒绝，树保持原样。
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link, useLocation } from 'react-router-dom';

import { ListsIcon } from '../../app/shell/icons';

import type { List } from '../../data/db/types';
import { ListIcon } from './ListIcon';
import {
  buildListTree,
  childLists,
  sortOrderForDrop,
  validateListMove,
  type ListNode,
} from './tree';

const DRAG_THRESHOLD = 6;
const CLICK_SUPPRESS_MS = 400;
const AUTO_EXPAND_MS = 600;

export type ListTreeAction = 'create-child' | 'edit' | 'delete' | 'move';

export type ListTreeProps = {
  lists: List[];
  counts: Map<string, number>;
  activeListId?: string | null;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onMove?: (
    id: string,
    parentId: string | null,
    sortOrder: number,
  ) => void | Promise<void>;
  onAction?: (action: ListTreeAction, list: List) => void;
  variant?: 'sidebar' | 'page';
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  unavailable?: boolean;
  onCreateRoot?: () => void;
};

type DropZone = 'before' | 'after' | 'child';

type DropState = {
  targetId: string;
  zone: DropZone;
  parentId: string | null;
  index: number;
  allowed: boolean;
  reason: string | null;
};

type GhostState = { title: string } | null;

type PointerSession = {
  id: string;
  title: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  cancel: () => void;
  cleanup: () => void;
};

function iconForDepth(depth: number) {
  return depth > 1 ? 'list-tree-row--nested' : '';
}

export function ListsTree({
  lists,
  counts,
  activeListId = null,
  collapsed,
  onToggle,
  onMove,
  onAction,
  variant = 'page',
  loading = false,
  error = null,
  onRetry,
  unavailable = false,
  onCreateRoot,
}: ListTreeProps) {
  const { pathname } = useLocation();
  const roots = buildListTree(lists);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const dropRef = useRef<DropState | null>(null);
  const [ghost, setGhost] = useState<GhostState>(null);
  const sessionRef = useRef<PointerSession | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const ghostPosition = useRef({ x: 0, y: 0 });
  const suppressClickUntil = useRef(0);
  const autoExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoExpandTarget = useRef<string | null>(null);

  const clearAutoExpand = () => {
    if (autoExpandTimer.current) {
      clearTimeout(autoExpandTimer.current);
      autoExpandTimer.current = null;
    }
    autoExpandTarget.current = null;
  };

  useEffect(() => clearAutoExpand, []);

  // 菜单点击外部 / Esc 关闭。
  useEffect(() => {
    if (!openMenuId) {
      return;
    }
    const close = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.list-tree-menu, .list-tree-more')) {
        return;
      }
      setOpenMenuId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenuId(null);
      }
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openMenuId]);

  useLayoutEffect(() => {
    if (!ghost || !ghostRef.current) {
      return;
    }
    const { x, y } = ghostPosition.current;
    ghostRef.current.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0)`;
  }, [ghost]);

  useEffect(() => {
    return () => {
      sessionRef.current?.cancel();
      clearAutoExpand();
    };
  }, []);

  const positionGhost = (x: number, y: number) => {
    ghostPosition.current = { x, y };
    if (ghostRef.current) {
      ghostRef.current.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0)`;
    }
  };

  const hasChildren = (list: List) => childLists(lists, list.id).length > 0;

  const readDrop = (event: PointerEvent | ReactPointerEvent): DropState | null => {
    const movingId = sessionRef.current?.id ?? null;
    if (!movingId) {
      return null;
    }
    if (typeof document.elementFromPoint !== 'function') {
      return null;
    }
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const row = element?.closest<HTMLElement>('[data-list-row]');
    if (!row) {
      if (!element?.closest('[data-list-tree]')) {
        return null;
      }
      const reason = validateListMove(lists, movingId, null);
      return {
        targetId: '__tree__',
        zone: 'after',
        parentId: null,
        index: childLists(lists, null).filter((list) => list.id !== movingId)
          .length,
        allowed: reason === null,
        reason,
      };
    }
    const targetId = row.getAttribute('data-list-id');
    if (!targetId || targetId === movingId) {
      return null;
    }
    const target = lists.find((list) => list.id === targetId);
    if (!target) {
      return null;
    }
    const rect = row.getBoundingClientRect();
    const ratio = rect.height === 0 ? 0.5 : (event.clientY - rect.top) / rect.height;
    const zone: DropZone =
      target.isInbox ? 'after' : ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'child';

    const parentId = zone === 'child' ? target.id : target.isInbox ? null : target.parentId;
    const reason = validateListMove(lists, movingId, parentId);
    const siblings = childLists(lists, parentId).filter(
      (list) => list.id !== movingId,
    );
    let index = siblings.length;
    if (zone === 'before' || zone === 'after') {
      const targetIndex = siblings.findIndex((list) => list.id === targetId);
      index =
        targetIndex < 0
          ? siblings.length
          : zone === 'before'
            ? targetIndex
            : targetIndex + 1;
    }
    return { targetId, zone, parentId, index, allowed: reason === null, reason };
  };

  const finishDrag = (upEvent: PointerEvent | null) => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    sessionRef.current = null;
    session.cleanup();
    clearAutoExpand();
    document.body.classList.remove('list-pointer-dragging');
    setDragId(null);
    setGhost(null);
    const finalDrop = dropRef.current;
    dropRef.current = null;
    setDrop(null);
    if (!session.active) {
      return;
    }
    suppressClickUntil.current = Date.now() + CLICK_SUPPRESS_MS;
    if (!upEvent || !finalDrop || !finalDrop.allowed) {
      return;
    }
    const sortOrder = sortOrderForDrop(
      lists,
      session.id,
      finalDrop.parentId,
      finalDrop.index,
    );
    void onMove?.(session.id, finalDrop.parentId, sortOrder);
  };

  const beginPointerDrag = (
    event: ReactPointerEvent<HTMLElement>,
    list: List,
  ) => {
    if (!onMove || list.isInbox || sessionRef.current) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    if (event.isPrimary === false) {
      return;
    }
    const origin = event.target as HTMLElement | null;
    if (origin?.closest('[data-no-drag]')) {
      return;
    }

    const session: PointerSession = {
      id: list.id,
      title: list.name,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      cancel: () => undefined,
      cleanup: () => undefined,
    };

    const onMoveEvent = (moveEvent: PointerEvent) => {
      if (
        sessionRef.current !== session ||
        moveEvent.pointerId !== session.pointerId
      ) {
        return;
      }
      if (!session.active) {
        const distance = Math.hypot(
          moveEvent.clientX - session.startX,
          moveEvent.clientY - session.startY,
        );
        if (distance < DRAG_THRESHOLD) {
          return;
        }
        session.active = true;
        setDragId(session.id);
        setGhost({ title: session.title });
        document.body.classList.add('list-pointer-dragging');
        window.getSelection()?.removeAllRanges();
      }
      if (moveEvent.cancelable) {
        moveEvent.preventDefault();
      }
      positionGhost(moveEvent.clientX, moveEvent.clientY);
      const next = readDrop(moveEvent);
      dropRef.current = next;
      setDrop(next);

      // 悬停 600ms 展开目标节点，方便把清单拖进折叠的父节点。
      if (next?.zone === 'child' && next.allowed) {
        if (autoExpandTarget.current !== next.targetId) {
          clearAutoExpand();
          autoExpandTarget.current = next.targetId;
          const target = lists.find((item) => item.id === next.targetId);
          if (target && hasChildren(target) && collapsed.has(target.id)) {
            autoExpandTimer.current = setTimeout(() => {
              onToggle(target.id);
              autoExpandTimer.current = null;
            }, AUTO_EXPAND_MS);
          }
        }
      } else {
        clearAutoExpand();
      }
    };

    const onUpEvent = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== session.pointerId) {
        return;
      }
      // 以抬起位置重新计算一次，避免最后一次 pointermove 被浏览器合并；
      // 未越过 6px 阈值的普通点击不做落点计算。
      if (session.active) {
        const next = readDrop(upEvent);
        if (next) {
          dropRef.current = next;
          setDrop(next);
        }
      }
      finishDrag(upEvent);
    };
    const onCancel = () => finishDrag(null);
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') {
        return;
      }
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      finishDrag(null);
    };
    const onBlur = () => finishDrag(null);

    const cleanup = () => {
      window.removeEventListener('pointermove', onMoveEvent);
      window.removeEventListener('pointerup', onUpEvent);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onBlur);
    };
    session.cancel = () => finishDrag(null);
    session.cleanup = cleanup;
    sessionRef.current = session;

    window.addEventListener('pointermove', onMoveEvent, { passive: false });
    window.addEventListener('pointerup', onUpEvent);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onBlur);
  };

  const guardClick = (event: React.MouseEvent) => {
    if (Date.now() < suppressClickUntil.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const dropClass = (id: string) => {
    if (!drop || drop.targetId !== id) {
      return '';
    }
    return drop.allowed ? `is-drop-${drop.zone}` : 'is-drop-invalid';
  };

  const renderRow = (node: ListNode) => {
    const { list, depth, children } = node;
    const isCollapsed = collapsed.has(list.id);
    const count = counts.get(list.id) ?? 0;
    const showCount = variant === 'page' || count > 0;
    const active = activeListId === list.id;
    return (
      <div className="list-tree-branch" key={list.id}>
        <div
          className={[
            'list-tree-row',
            iconForDepth(depth),
            active ? 'is-active' : '',
            dragId === list.id ? 'is-dragging' : '',
            dropClass(list.id),
          ]
            .filter(Boolean)
            .join(' ')}
          data-list-row
          data-list-id={list.id}
          style={{ '--tree-depth': depth } as CSSProperties}
          onPointerDown={(event) => beginPointerDrag(event, list)}
          onDoubleClick={(event) => {
            if (children.length === 0) {
              return;
            }
            event.preventDefault();
            onToggle(list.id);
          }}
        >
          {children.length > 0 ? (
            <button
              type="button"
              className="list-tree-toggle"
              data-no-drag
              aria-label={`${isCollapsed ? '展开' : '折叠'} ${list.name}`}
              aria-expanded={!isCollapsed}
              onClick={(event) => {
                event.stopPropagation();
                onToggle(list.id);
              }}
            >
              <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
            </button>
          ) : (
            <span className="list-tree-toggle-spacer" aria-hidden="true" />
          )}
          <Link
            className="list-tree-link"
            to={`/lists/${list.id}`}
            aria-current={active ? 'page' : undefined}
            title={children.length > 0 ? '含子清单' : list.name}
            onClick={guardClick}
          >
            <ListIcon list={list} />
            <span className="list-tree-name">{list.name}</span>
            {showCount ? (
              <span
                className="list-tree-count"
                aria-label={`${count} 个未完成任务`}
              >
                {count}
              </span>
            ) : null}
          </Link>
          {onAction ? (
            <button
              type="button"
              className="list-tree-more"
              data-no-drag
              aria-label={`清单操作：${list.name}`}
              aria-haspopup="menu"
              aria-expanded={openMenuId === list.id}
              onClick={(event) => {
                event.stopPropagation();
                setOpenMenuId((current) =>
                  current === list.id ? null : list.id,
                );
              }}
            >
              ···
            </button>
          ) : null}
          {openMenuId === list.id && onAction ? (
            <div
              className="list-tree-menu"
              role="menu"
              aria-label={`${list.name} 操作`}
              onClick={(event) => event.stopPropagation()}
            >
              {depth < 3 ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenuId(null);
                    onAction('create-child', list);
                  }}
                >
                  新建子清单
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpenMenuId(null);
                  onAction('edit', list);
                }}
              >
                编辑清单
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpenMenuId(null);
                  onAction('move', list);
                }}
              >
                移动到…
              </button>
              <button
                type="button"
                role="menuitem"
                className="is-danger"
                onClick={() => {
                  setOpenMenuId(null);
                  onAction('delete', list);
                }}
              >
                删除清单
              </button>
            </div>
          ) : null}
        </div>
        {children.length > 0 && !isCollapsed ? (
          <div className="list-tree-children">
            {children.map((child) => renderRow(child))}
          </div>
        ) : null}
      </div>
    );
  };

  if (loading) {
    return (
      <div
        className={`list-tree-panel list-tree-panel--${variant}`}
        aria-busy="true"
        aria-label="清单树加载中"
      >
        <div className="list-tree-panel-head">
          <span className="nav-section-label">清单</span>
        </div>
        <div className="list-tree-skeleton">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }

  return (
    <div className={`list-tree-panel list-tree-panel--${variant}`}>
      <div className="list-tree-panel-head">
        <span className="nav-section-label">清单</span>
        <div className="list-tree-panel-actions">
          {onCreateRoot ? (
            <button
              type="button"
              className="list-tree-head-button"
              aria-label="新建清单"
              title="新建根级清单"
              onClick={onCreateRoot}
            >
              ＋
            </button>
          ) : null}
          {variant === 'sidebar' ? (
            <Link
              to="/lists"
              className="list-tree-head-button list-tree-manage"
              aria-label="管理清单"
              title="管理清单"
              aria-current={pathname === '/lists' ? 'page' : undefined}
            >
              <ListsIcon className="nav-icon" />
              <span className="list-tree-head-label">管理</span>
            </Link>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="list-tree-state" role="alert">
          <p>清单加载失败</p>
          <p className="list-tree-state-reason">{error}</p>
          {onRetry ? (
            <button type="button" className="list-tree-retry" onClick={onRetry}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="list-tree" data-list-tree>
        {!unavailable ? roots.map((node) => renderRow(node)) : null}
        {!unavailable && roots.length === 0 ? (
          <p className="list-tree-empty">还没有清单</p>
        ) : null}
      </div>

      {unavailable ? (
        <p className="list-tree-unavailable">
          清单数据需在桌面壳内读取；清单入口仍可使用。
        </p>
      ) : null}

      {ghost ? (
        <div className="list-drag-ghost" ref={ghostRef} aria-hidden="true">
          {ghost.title}
        </div>
      ) : null}
    </div>
  );
}
