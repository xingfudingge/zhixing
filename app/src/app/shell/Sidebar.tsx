import { Fragment, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { db } from '../../data/db/client';
import { LISTS_CHANGED_EVENT } from '../../data/repositories/lists';
import { ListsTree, type ListTreeAction } from '../../pages/Lists/ListsTree';
import { useCollapsedLists } from '../../pages/Lists/useCollapsedLists';
import { DatabaseCard } from './DatabaseCard';
import {
  NAV_SECTIONS,
  SETTINGS_NAV_ITEM,
  isNavItemActive,
  type NavItem,
} from './navigation';
import { useListsSummary, type ListsSummary } from './useListsSummary';

function formatBadge(value: number): string {
  return value > 999 ? '999+' : String(value);
}

function SidebarNavLink({
  item,
  badge = null,
}: {
  item: NavItem;
  badge?: number | null;
}) {
  const { pathname } = useLocation();
  const active = isNavItemActive(pathname, item);
  const Icon = item.icon;
  const showBadge = typeof badge === 'number' && badge > 0;
  const title = showBadge
    ? `${item.label} · ${item.caption} · ${badge} 条未完成`
    : `${item.label} · ${item.caption}`;

  return (
    <Link
      to={item.to}
      className={active ? 'nav-link is-active' : 'nav-link'}
      aria-current={active ? 'page' : undefined}
      title={title}
    >
      <Icon className="nav-icon" />
      <span className="nav-label">{item.label}</span>
      {showBadge ? (
        <span
          className="nav-badge"
          aria-label={`${badge} 条未完成任务`}
          title={title}
        >
          {formatBadge(badge)}
        </span>
      ) : null}
      <span className="nav-caption" aria-hidden="true">
        {item.caption}
      </span>
    </Link>
  );
}

function formatMoveError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message || '移动失败，已还原';
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '移动失败，已还原';
}

/** 侧栏清单树：只渲染用户清单，计数来自轻量摘要查询。 */
function SidebarLists({ summary }: { summary: ListsSummary }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const activeListId = pathname.startsWith('/lists/')
    ? decodeURIComponent(pathname.slice('/lists/'.length).split('/')[0])
    : null;
  const { collapsed, toggle } = useCollapsedLists(
    summary.lists,
    activeListId,
  );
  const [moveError, setMoveError] = useState<string | null>(null);

  const handleAction = (action: ListTreeAction, list: { id: string }) => {
    // 侧栏不在 TaskStore/ToastProvider 内：节点操作跳到该清单详情，
    // 由查询参数打开弹层。不能落回 /lists 概览，否则会丢失当前清单上下文。
    const param =
      action === 'create-child'
        ? 'newChild'
        : action === 'edit'
          ? 'edit'
          : action === 'delete'
            ? 'delete'
            : 'move';
    navigate(
      `/lists/${encodeURIComponent(list.id)}?${param}=${encodeURIComponent(list.id)}`,
    );
  };

  const move = async (
    id: string,
    parentId: string | null,
    sortOrder: number,
  ) => {
    setMoveError(null);
    try {
      await db.lists.move(id, { parentId, sortOrder });
      summary.refresh();
      window.dispatchEvent(new Event(LISTS_CHANGED_EVENT));
    } catch (reason) {
      // 不做乐观变更：失败时树仍在原位，只提示原因。
      setMoveError(`移动失败，已还原：${formatMoveError(reason)}`);
    }
  };

  return (
    <div className="nav-group nav-group--lists">
      <ListsTree
        variant="sidebar"
        lists={summary.lists}
        counts={summary.counts.byId}
        activeListId={activeListId}
        collapsed={collapsed}
        onToggle={toggle}
        onMove={move}
        onAction={handleAction}
        loading={summary.status === 'loading'}
        error={summary.status === 'error' ? summary.error : null}
        unavailable={summary.status === 'unavailable'}
        onRetry={summary.refresh}
        onCreateRoot={() => navigate('/lists?new=root')}
      />
      {moveError ? (
        <p className="list-tree-action-error" role="status">
          {moveError}
        </p>
      ) : null}
    </div>
  );
}

export function Sidebar({ immersive }: { immersive: boolean }) {
  const summary = useListsSummary();
  const taskBadge =
    summary.status === 'ready' ? summary.counts.openTotal : null;

  return (
    <aside className="sidebar" aria-label="全局导航">
      {immersive ? (
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            知
          </span>
          <span className="brand-name">知行</span>
        </div>
      ) : null}

      <nav className="sidebar-nav" aria-label="主导航">
        <div className="nav-groups">
          {NAV_SECTIONS.map((section) => (
            <Fragment key={section.id}>
              <div className="nav-group">
                <p className="nav-section-label">{section.label}</p>
                <div className="nav-list">
                  {section.items.map((item) => (
                    <SidebarNavLink
                      item={item}
                      key={item.to}
                      badge={item.to === '/tasks' ? taskBadge : null}
                    />
                  ))}
                </div>
              </div>
              {/* 清单树独立成组：任务分组之后、节奏之前。 */}
              {section.id === 'workspace' ? (
                <SidebarLists summary={summary} />
              ) : null}
            </Fragment>
          ))}
        </div>

        <div className="nav-group nav-group--settings">
          <SidebarNavLink item={SETTINGS_NAV_ITEM} />
        </div>
      </nav>

      <DatabaseCard />
    </aside>
  );
}
