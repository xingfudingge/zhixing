# 提醒与通知（P2-03）

本机提醒计划器，支持应用内、浏览器与系统三个通道。系统通知不承诺必达：
UI 只显示“已发送（不保证送达）”/失败/抑制原因。

## 计划规则

- 任务必须有 `dueDate`（或 `dueAt`）与可解析的提醒值，如
  `提前 15 分钟`、`提前 1 小时`、`提前 2 天`、`准时`。
- 去重键：
  `${taskId}|${dueInstant}|${offset}|${channel}|${deviceId}`。
- 任务改期/完成/删除或关闭通道后，旧的 `scheduled` 计划会被标记
  `canceled`；改期后的新计划使用新去重键。
- 已发送/已抑制的计划不会因重新调和再次发送。
- 错过超过 5 分钟的提醒不补发，避免打开应用时集中弹旧提醒。
- 每日摘要可选，摘要遵守相同通道与免打扰规则。

## 通道

| 通道 | 行为 |
|---|---|
| 应用内 | `window.dispatchEvent(new CustomEvent('zhixing:notification', { detail: plan }))`；由宿主渲染。确定可用。 |
| 浏览器 | 只在用户点击“开启浏览器通知”时调用 `Notification.requestPermission()`；拒绝后不反复弹窗，保留应用内提醒。 |
| 系统 | 通过可注入 `SystemNotificationAdapter`；当前 Tauri 壳未接入原生插件时明确标记 `unsupported`。 |

- 权限状态以系统实时值为准，不落盘成“已授权”。
- 锁屏隐私开启时，浏览器通知只显示“知行 · 待办提醒”，不显示任务标题。
- 免打扰时段内不发送，创建一条 `|quiet` 延迟计划，在结束时间后发送。
- 通知记录保存在本机，最多 500 条；不保存任务正文。

## 接入

`Shell` 挂载 `NotificationRuntime`，使用应用级单例调度器：

```tsx
<NotificationRuntime />
```

运行时负责：

- 启动、每 30 秒、窗口回到前台、任务库刷新（`zhixing:tasks-changed`）
  与设置变化（`zhixing:notification-settings-changed`）时重新调和计划；
- 从真实 SQLite 任务库读取任务（浏览器预览不伪造任务）；
- 监听 `IN_APP_NOTIFICATION_EVENT` 渲染应用内提醒，并按去重键避免重复弹窗。

设置页 `NotifyGroup` 直接挂载 `NotificationCenter`，与运行时共享同一个
`getDefaultNotificationScheduler()`，所以修改开关/免打扰/摘要后立即生效。

手动测试通知：

```ts
const result = await scheduler.testNotification();
// result.ok 为 true 表示至少一个通道已触发；否则 result.outcomes 给出原因。
```

“发送测试通知”不写计划/发送记录，也不受免打扰限制；权限与系统能力仍按
真实状态返回。

## 测试

```sh
pnpm --filter app test -- src/features/notifications
pnpm --filter app test -- src/features/settings/__tests__/NotifyGroup.test.tsx
```
