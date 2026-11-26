# 可访问性说明（P2-04）

## 已实现

### 新增 Modal（`app/src/app/a11y/Modal.tsx`）

- `role="dialog"`、`aria-modal="true"`、`aria-labelledby`、`aria-describedby`。
- 打开后焦点进入对话框；Tab / Shift+Tab 在对话框内循环。
- Esc 关闭（写入中禁用）；关闭按钮有 `aria-label`；`aria-busy` 反映写入状态。
- 关闭后焦点回到打开它的元素；背景滚动锁定。
- 所有按钮使用原生 `<button type="button">`；单选/复选使用原生 input。

### 全局历史对话框兜底（`app/src/app/a11y/globalFocusTrap.ts`）

`main.tsx` 启动时安装：

- 对现有 `role="dialog" aria-modal="true"` 对话框补上 Tab 循环、焦点外逃
  拉回、关闭后焦点归还；
- P2-04 自带 `FocusTrap` 的 Modal 通过 `data-a11y-managed="true"` 跳过，
  避免双重陷阱；
- 历史对话框的 Esc 仍由各自实现处理。

### 恢复预览

- 冲突区使用 `fieldset` + `legend`，单选项有可读文本；
- 阻止项、校验提示、恢复进度分别使用列表、`role="alert"`、
  `role="status" aria-live="polite"`；
- 页面设置 `aria-busy`，写入中禁用 Esc/关闭/确认。

## 自动化验证

```sh
pnpm --filter app test -- src/app/a11y
pnpm --filter app test:e2e
```

覆盖：

- Tab 从最后一个控件回到第一个；Shift+Tab 反向循环；
- Esc 关闭并把焦点还给触发按钮；
- 禁用、隐藏、`tabindex="-1"` 元素不进入焦点序列；
- 全局兜底与自带 FocusTrap 不重复接管。

## 已知缺口（未完成，不得宣称已达标）

- **未执行**真实屏幕阅读器（VoiceOver/NVDA）人工走查。
- **未执行**全站颜色对比度自动化审计；现有色板沿用 tokens.css。
- 历史对话框只补了焦点循环/归还，没有统一重写其标题/描述关联与
  `aria-live`；需要逐个组件迁移时再验收。
- 画布/Canvas 画板的键盘操作不在本卡范围。
