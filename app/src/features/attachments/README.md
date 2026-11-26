# 附件（P2-03）

内容寻址的附件队列：离线插入 → 本机可打开 → 用户显式上传 → 分片直传 →
服务端逐片校验 → 另一设备下载并校验整体 SHA-256。

## 数据边界

| 数据 | 位置 | 说明 |
|---|---|---|
| 附件元数据 | SQLite `attachments` | 权威记录，通过现有 `db.attachments.*` |
| 二进制 | IndexedDB `blobs` | 键 `attachments/{sha256}`，同内容去重 |
| 上传状态 | IndexedDB `attachment_state` | local/pending/uploading/available/remote/downloading/failed/missing |

浏览器/Tauri WebView 都使用 `IndexedDbBlobStore`；桌面正式版可替换为应用私有
目录实现同一接口。**不使用 localStorage 存二进制或冒充权威库。**

状态语义以 `outputs/附件状态语义-v4.md` 为准：`local` 是“本机已保存”，
`pending` 只表示“已进入上传队列”，只有 backend/WebDAV 模式且用户显式上传
才会出现；local 模式绝不显示“待上传/待同步”。

## 默认行为

- `AttachmentManager.ingest()` 只写本机并标为 `local`（本机已保存），没有
  任何网络调用；旧 `pending` 记录会按当前模式懒迁移。
- 图片上传需要 `uploader.upload(id, { allowRemote: true })`；UI 必须先勾选
  允许上传图片。普通文件也必须由用户点击“上传”；local 模式没有上传入口。
- 打开本机文件时默认重新校验 SHA-256；不一致会拒绝打开并标记失败。
- 删除附件只删除引用；同内容仍被其他笔记引用时保留 Blob。

## 分片协议

```
spaces/{space}/assets/.parts/{sha256}/{index}
spaces/{space}/assets/.parts/{sha256}/complete.json
```

1. `POST /api/v1/attachments/init`（现有 P2-01 路由）写元数据。
2. `POST /api/v1/attachments/:id/upload-session` 返回缺失分片的预签名 PUT。
3. 客户端 PUT 分片；重新申请会话时服务端 HEAD 已存在的分片，实现续传。
4. 客户端 PUT `complete.json`（含每片大小/哈希），再调
   `POST /api/v1/attachments/:id/upload-complete`。
5. 服务端逐片 HEAD + 回读 SHA-256、校验 complete.json，之后才 `available`，
   并把分片组装成整对象供旧 `/download` 使用。
6. 设备 B 调 `GET /api/v1/attachments/:id/download-manifest`，下载后合并并
   校验整体 SHA-256；不一致不会落盘。

## UI 接入（AUD-006）

- 笔记详情右栏「附件」挂载 `AttachmentSection`，`noteId` 为当前笔记；
  正文文件卡单独列在下方，只保存名称/大小，不复制二进制。
- 任务详情「附件」同样挂载 `AttachmentSection`，使用 `taskId`。
- `AttachmentSection` 在未注入 manager 时自动装配
  `createDesktopAttachmentRuntime()`；manager 不可用、或未配对后台导致
  uploader 为空时，会显示 `role="alert"` / `role="status"` 的可读原因，
  不渲染点了没反应的按钮。
- 上传阶段显示进度条；完成后显示「已同步」；失败显示「同步失败 · 本机保留」
  并可再次点击上传。local 模式显示「本机已保存」，不渲染上传按钮。图片可
  本机预览，任意本机附件可另存，删除会同时清理元数据、状态和无人引用的 Blob。

## 本机打开与另存（ZX-FILE-01）

所有“打开/下载/导出”都复用 `fileActions.ts`，不建第二套文件链路：

| 动作 | 桌面（Tauri） | 浏览器预览 |
|---|---|---|
| 打开图片 | 应用内预览 | 应用内预览 |
| 打开 PDF/Office/文本 | 写入应用缓存后交给系统默认应用（`open_attachment_file`） | PDF/文本在新标签预览；Office 等明确提示改用桌面版 |
| 另存附件 | 系统保存面板（`save_attachment_file`） | File System Access 保存面板 |
| 取消保存 | 返回 `canceled`，不写文件 | 返回 `canceled`，不写文件 |
| 重名 | 自动追加 `-1`/`-2`，不覆盖 | 由保存面板确认；写入前不预创建文件 |
| 无保存面板 | — | 抛出可读错误，**不回退到 Downloads 下载** |
| 知识 Markdown 导出 | 与附件另存同一命令 | 同一保存面板 |

`open_attachment_file` 的缓存路径与 `save_attachment_file` 的保存路径只用于
界面提示/日志，不写回 `attachments` 元数据；附件本体仍以 IndexedDB 的
内容寻址 Blob 为唯一来源。删除正文文件卡只移除块引用，不调用
`AttachmentManager.remove()`，因此不会误删仍被其他笔记引用的 Blob。
- 卡片展示完整 SHA-256，与上传时 `sha256Blob()` 计算值一致；列表在重新
  挂载/刷新后从 SQLite + IndexedDB 恢复。
- 本机图片卡挂载 `OcrImageAction`（AUD-007）：与设置页共用同一份 OCR 偏好，
  默认关闭时按钮禁用并给出设置路径；开启后只对真实本机原图识别，失败显示
  引擎原始错误，不补写示例文字。

### 任务附件归属

SQLite `attachments` 只有 `note_id`（外键指向 notes）和 `block_id`。任务
不是笔记，因此任务附件写 `block_id = "task:<taskId>"`，由
`AttachmentManager.listForTask()` 过滤；不会伪造 note_id，也不会写
localStorage。

## 编辑器接入

编辑器文件块只需保存 `attachmentId`；`attachmentFilePayload()` /
`attachmentImagePayload()` 给出 payload。`ImageBlock` 只读取本机 Blob，
不自动下载/上传。文件块本体不复制二进制。

## 服务端挂载

路由在 `server/src/attachments/`，需要一个挂载点：

```ts
await app.register(async (api) => registerAttachmentChunkRoutes(api), {
  prefix: '/api/v1',
});
```

`server/src/attachments/acceptance.ts` 已在真实 PostgreSQL + MinIO 上执行该
挂载并完成双设备哈希校验。

## 测试

```sh
pnpm --filter app test -- src/features/attachments
cd server && node --import tsx --test src/attachments/__tests__/chunked-upload.test.ts
```
