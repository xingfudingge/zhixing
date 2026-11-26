# a11y · 可访问性基础件（P2-04）

- `FocusTrap.tsx`：`getFocusableElements`、Tab/Shift+Tab 循环、focusin 拉回、
  Esc 回调、关闭后焦点归还（可指定 `returnFocusRef`）。
- `Modal.tsx`：基于 FocusTrap 的对话框外壳；`role="dialog"`、
  `aria-modal`、`aria-labelledby/describedby`、`aria-busy`、背景滚动锁、
  统一关闭按钮。P2-04 新增对话框都使用它。
- `globalFocusTrap.ts`：`main.tsx` 安装的历史对话框兜底；只处理
  `role="dialog" aria-modal="true"`，跳过带 `data-a11y-managed="true"` 的
  Modal，避免双重陷阱。历史对话框的 Esc 仍由各自实现。
- `a11y.css`：模态、焦点环、视觉隐藏；只使用全局 token。

测试：`__tests__/FocusTrap.test.tsx`、`__tests__/globalFocusTrap.test.tsx`；
端到端覆盖见 `features/export/__tests__/DataBackupPanel.e2e.tsx`。
