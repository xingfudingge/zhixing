import type { ReactNode } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';

/**
 * 画板模块既会在路由内使用，也会被笔记块测试在无 Router 的环境渲染。
 * 有 Router 时用 SPA 跳转，没有时退回普通链接。
 */
export function BoardLink({
  to,
  className,
  children,
  onNavigate,
}: {
  to: string;
  className?: string;
  children: ReactNode;
  onNavigate?: () => void;
}) {
  const inRouter = useInRouterContext();
  if (inRouter) {
    return (
      <Link to={to} className={className} onClick={onNavigate}>
        {children}
      </Link>
    );
  }
  return (
    <a href={to} className={className} onClick={onNavigate}>
      {children}
    </a>
  );
}
