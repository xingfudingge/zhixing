/**
 * 旧 `/inbox` 兼容入口：只做一跳 `replace` 重定向到 `/tasks`。
 *
 * 不保留可渲染的旧收件箱页面，避免出现第二个任务入口；
 * 只透传白名单查询参数，`task` 原样保留，保证旧深链仍能打开详情。
 */

import { Navigate, useLocation } from 'react-router-dom';

const REDIRECT_PARAMS = ['task', 'filter', 'list', 'priority', 'date', 'q'];

export function InboxPage() {
  const location = useLocation();
  const source = new URLSearchParams(location.search);
  const next = new URLSearchParams();
  for (const key of REDIRECT_PARAMS) {
    const value = source.get(key);
    if (value !== null) {
      next.set(key, value);
    }
  }
  const search = next.toString();
  return (
    <Navigate
      to={{ pathname: '/tasks', search: search ? `?${search}` : '' }}
      replace
    />
  );
}
