# 服务端附件分片（P2-03）

在 P2-01 的 `attachments` 元数据与 MinIO 预签名基础上，增加可续传分片、
complete.json 清单、逐片回读哈希校验、下载清单与整对象组装。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/attachments/:id/upload-session` | 返回缺失分片预签名 PUT、complete.json PUT、已存在分片 |
| POST | `/api/v1/attachments/:id/upload-complete` | 校验分片数量/大小/SHA-256 与 complete.json，置 available |
| GET | `/api/v1/attachments/:id/download-manifest?chunkSize=` | 返回分片预签名 GET；分片不完整时 409 |

先调用现有 `POST /api/v1/attachments/init` 创建元数据。

## 对象布局

```
spaces/{space}/assets/.parts/{sha256}/{index}
spaces/{space}/assets/.parts/{sha256}/complete.json
spaces/{space}/assets/{sha256}                  # complete 后组装
```

- 分片 PUT 与 complete.json PUT 都是客户端直传 MinIO，不经过 Node 内存。
- `complete` 逐片 HEAD 校验大小、回读流式计算 SHA-256；任一片失败都不更新
  `attachments.status`。
- 小于 `maxAssembleBytes`（默认 256MB）的文件在 complete 时组装成整对象，
  然后删除分片；这样旧 `/attachments/:id/download`、导出与备份仍可用。
- 大文件保留分片，由 `download-manifest` 读取。
- 兼容旧版整文件上传：没有分片但 `storage_key` 对象存在时，下载清单退回
  单对象。

## 挂载

```ts
await app.register(async (api) => registerAttachmentChunkRoutes(api), {
  prefix: '/api/v1',
});
```

插件只依赖 `app.zx.pool` / `app.zx.storage`。可选参数：

```ts
registerAttachmentChunkRoutes(api, {
  fetchImpl,          // 测试注入；默认全局 fetch
  assemble: false,    // 只验证，不组装整对象
  maxAssembleBytes,   // 组装阈值
});
```

## 测试与真实验收

```sh
pnpm typecheck
node --import tsx --test src/attachments/__tests__/chunked-upload.test.ts

DATABASE_URL='postgres://user@127.0.0.1:55432/postgres' \
ZX_S3_ENDPOINT='http://127.0.0.1:19000' \
ZX_S3_PUBLIC_ENDPOINT='http://127.0.0.1:19000' \
node --import tsx src/attachments/acceptance.ts
```

验收脚本会创建独立临时数据库，配对两台设备，验证断点续传、逐片校验、
整对象组装、设备 B 下载哈希与旧下载接口一致，最后清理数据库与对象。
