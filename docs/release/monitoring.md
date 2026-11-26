# 性能与错误监控（P2-04）

## 实现

`app/src/features/export/monitoring.ts`：

- 内存环形缓冲区，最多 80 条事件；不写数据库、不上传。
- 启动时（`main.tsx`）安装：
  - `window.error`；
  - `window.unhandledrejection`；
  - `document.visibilitychange`；
  - `PerformanceObserver` 的 `longtask`（环境支持时）。
- 备份流程记录：
  - `export.zip` / `export.json` / `export.markdown` / `export.csv` / `export.pdf`
    的耗时、字节数、提示数量；
  - `restore.parse` 的格式、条目数、字节数。
- 慢阈值：导出 ≥ 2000 ms、恢复 ≥ 3000 ms 标记 `slow`。
- 设置 → 数据与备份 → “下载诊断 JSON”导出快照。

## 脱敏

写入事件前统一经过 `redactSecrets`：

- Bearer 令牌、`token/password/secret/api_key/authorization` 赋值；
- 邮箱；
- 64 位长哈希。

诊断包只含时间、事件名、耗时、脱敏消息、平台/UA，不含笔记正文、
附件内容、文件路径或账号信息。

## 使用

```ts
import { installMonitoring, monitor } from './monitoring';

const cleanup = installMonitoring();
await monitor.measure('export.zip', async () => buildZip());
monitor.snapshot();
```

## 边界

- 不是第三方 APM；没有跨会话持久化、告警或服务端聚合。
- 监控在 `main.tsx` 安装一次；测试环境可显式 `monitor.reset()`。
- 真实 Tauri WebView 的长任务/内存指标仍需在桌面壳手工采样；**未执行**。
