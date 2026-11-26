/**
 * 清单树折叠状态：仅存本机 localStorage，不参与同步。
 * 跳转到某个清单时自动展开全部祖先；手动折叠后刷新仍保持。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { List } from '../../data/db/types';
import {
  ancestorIds,
  collapsedStorageValue,
  parseCollapsedStorage,
} from './tree';

export const LISTS_COLLAPSED_STORAGE_KEY = 'zx.lists.tree.collapsed.v1';

function readCollapsed(): Set<string> {
  if (typeof window === 'undefined') {
    return new Set();
  }
  try {
    return parseCollapsedStorage(
      window.localStorage.getItem(LISTS_COLLAPSED_STORAGE_KEY),
    );
  } catch {
    return new Set();
  }
}

function writeCollapsed(ids: Set<string>) {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(
      LISTS_COLLAPSED_STORAGE_KEY,
      collapsedStorageValue(ids),
    );
  } catch {
    // localStorage 不可用时折叠只在本次会话内生效。
  }
}

export function useCollapsedLists(
  lists: List[],
  activeListId?: string | null,
) {
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);

  const toggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      writeCollapsed(next);
      return next;
    });
  }, []);

  const expand = useCallback((id: string) => {
    setCollapsed((current) => {
      if (!current.has(id)) {
        return current;
      }
      const next = new Set(current);
      next.delete(id);
      writeCollapsed(next);
      return next;
    });
  }, []);

  // 当前路由指向子清单时展开祖先；不主动折叠其他分支。
  useEffect(() => {
    if (!activeListId) {
      return;
    }
    const ancestors = ancestorIds(lists, activeListId);
    if (ancestors.length === 0) {
      return;
    }
    setCollapsed((current) => {
      if (!ancestors.some((id) => current.has(id))) {
        return current;
      }
      const next = new Set(current);
      for (const id of ancestors) {
        next.delete(id);
      }
      writeCollapsed(next);
      return next;
    });
  }, [activeListId, lists]);

  return useMemo(
    () => ({ collapsed, toggle, expand }),
    [collapsed, toggle, expand],
  );
}
