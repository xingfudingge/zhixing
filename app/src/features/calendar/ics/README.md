# ICS 只读订阅（P2-03 / AUD-009）

`IcsSubscription.readOnly` 在类型层面固定为 `true`；本模块没有写回 ICS、
删除远端事件或双向同步 API。订阅面板永远显示“只读”。

## 入口

设置 → 日历与工作日 → **外部日历 · ICS 订阅**：填写 ICS URL 后“添加订阅”
会立即拉取并导入；每个订阅可“立即同步”或“删除订阅”。最后成功同步时间、
最后尝试时间、事件实例数与错误都在设置页展示。

导入的事件写入现有 SQLite `events` 表（`source = ics:<订阅id>`），日历页按
既有查询显示。日历中的外部事件带“只读”标记，事件列表隐藏编辑/删除入口；
点击只会提示只读，不会打开编辑框，仍可手动“建任务”（纯本地派生）。

## 解析范围

- 折行（CRLF + 空格/Tab）与文本转义；
- VEVENT：UID、SUMMARY、DESCRIPTION、LOCATION、DTSTART/DTEND
  （DATE、DATE-TIME、TZID、Z）、DURATION；
- RRULE：DAILY/WEEKLY/MONTHLY/YEARLY、INTERVAL、COUNT、UNTIL、BYDAY；
- EXDATE、RECURRENCE-ID 覆盖；
- VALARM 忽略；缺少 UID/DTSTART 的事件跳过并记录警告。

不支持的 RRULE 会退化为单次事件（`parseRecurrence` 返回 null），不会编造
重复实例。

## 同步

传输层（ZX12-AUDIT-01 R1/R2/R4）：

- **桌面壳**：调用 Rust 命令 `http_fetch_text`（`app/src-tauri/src/http.rs`），
  不受 WebView CSP `connect-src` 与 CORS 限制，保留
  `If-None-Match` / `If-Modified-Since`，跨域 304 也可用；
- **浏览器预览**：同源地址沿用条件请求；跨域地址不发送条件头（避免预检被拒），
  改为比较 200 响应原文，内容相同同样标记“未变化”；
- 代理只允许 http/https，只转发 accept / if-none-match / if-modified-since，
  固定 GET、整体超时、最多 5 次重定向、响应体上限 16 MiB。

同步规则：

1. 请求带 `If-None-Match` / `If-Modified-Since`（条件满足时）；
2. 304 → 只更新 `lastSyncAt/lastAttemptAt`，不重复物化；没有缓存却收到 304
   会明确失败，不伪造同步成功；
3. 200 → 解析、展开（默认过去 90 天到未来 365 天）、映射成本地事件；
   原文与上次缓存一致时跳过重复物化；
4. 只管理 `source = ics:<subscriptionId>` 的事件，按
   `externalUid = uid#实例开始时间` 幂等更新；同一 UID/实例重复出现时保留
   `SEQUENCE` 更高的修订；远端删除的实例从本地镜像移除；
5. 失败保留最近成功缓存，写 `lastAttemptAt/lastError`；请求与响应体读取都有
   超时上限（默认 20 秒），超时明确报错，不把 `lastSyncAt` 写成当前时间；
6. 解析警告（缺 UID/DTSTART/坏日期）不阻断其余事件，写入 `lastWarning` 并在
   设置页展示；
7. 全部同步逐个执行，单个失败不阻断其他订阅，失败清单由 `syncAll()` 返回；
8. 取消订阅只删除订阅与缓存，不删除已导入的本地事件（也不删除知行任务）；
   UI 二次确认并写明保留范围。

## 状态展示

- 只读标签；
- 最后成功同步时间、最后尝试时间、事件实例数、错误与解析警告；
- 失败时若已有成功同步，显示“沿用最近一次成功缓存”；
- URL 展示时去掉 query/凭据（`redactIcsUrl`）；
- 断网/重启后仍从 IndexedDB 读取订阅与最近一次缓存；事件实例已物化在
  SQLite `events` 表，重启不丢。

## 测试

```sh
# 单元/组件 + IndexedDB 重启
pnpm --filter app exec vitest run src/features/calendar/ics

# 真实上游（可选；默认跳过）
ICS_REAL_HTTP=1 pnpm --filter app exec vitest run \
  src/features/calendar/ics/__tests__/real-http.test.ts

# 真实本地 HTTP 服务：200 → 304 → 500 → 删除保留事件
./tests/run-acceptance.sh p2-ics

# Rust 受限代理（超时/304/500/请求头白名单）
/Users/example/.cargo/bin/cargo test --manifest-path app/src-tauri/Cargo.toml --lib http::
```
