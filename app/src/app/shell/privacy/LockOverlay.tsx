import { useLayoutEffect, useRef } from 'react';

import './privacy.css';

/**
 * 失焦遮挡层。
 *
 * 只渲染“已隐藏”状态，不读取、不复制任何笔记/任务内容；覆盖层使用
 * `--surface` 不透明背景，而不是滤镜或半透明遮罩。截图保护不在承诺范围内。
 */
export function LockOverlay({
  covered,
  onReveal,
}: {
  covered: boolean;
  onReveal: () => void;
}) {
  const revealRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!covered) {
      return;
    }
    // 焦点移到恢复按钮：键盘用户按 Enter 即可揭开，但仍然是一次显式操作。
    revealRef.current?.focus();
  }, [covered]);

  if (!covered) {
    return null;
  }

  return (
    <div
      className="privacy-lock"
      role="dialog"
      aria-modal="true"
      aria-label="内容已隐藏"
      data-testid="privacy-lock-overlay"
    >
      <div className="privacy-lock-card">
        <span className="privacy-lock-eyebrow">知行 · 隐私保护</span>
        <h2 className="privacy-lock-title">内容已隐藏</h2>
        <p className="privacy-lock-body">
          应用失去焦点时已遮挡笔记正文与任务标题。恢复后不会自动显示，
          请确认周围环境安全后再继续。
        </p>
        <button
          ref={revealRef}
          type="button"
          className="privacy-lock-reveal"
          onClick={onReveal}
        >
          显示内容
        </button>
        <p className="privacy-lock-hint">
          该遮挡只覆盖应用窗口内容，不承诺防截屏或防录屏；不会修改任何数据。
        </p>
      </div>
    </div>
  );
}
