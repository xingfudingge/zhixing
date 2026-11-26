# 知行后台同步服务（P2-01）

Fastify 5 + PostgreSQL 16 + MinIO。**单用户、无账号、无成员、无席位**：服务端只认“设备”，
`space_id` 只是同步分区，不是权限边界。数据库里没有 `users / accounts / memberships / seats` 表。

## 能力

| 能力 | 实现 |
|---|---|
| API 前缀 | `/api/v1`，JSON |
| 设备接入 | 管理员生成一次性配对码（10 分钟）→ 设备令牌（24h）+ 刷新令牌（30 天） |
| 同步 | `POST /sync/push`（≤200 op，`op_id` 幂等）、`GET /sync/pull?cursor&limit`、`GET /sync/status` |
| 合并 | HLC + Version Vector + 字段级 LWW；正文/画板并发生成独立冲突副本 |
| 游标 | `sync_ops.seq` 单调递增；`device_sync_state.last_pull_cursor` 按设备保存 |
| 附件 | PostgreSQL 元数据 + MinIO/S3 预签名上传；完成时读回并校验 SHA-256 |
| 鉴权 | 管理口令（scrypt）→ 管理员会话；设备令牌只存 SHA-256 哈希；配对码只存哈希 |
| 防护 | 登录失败锁定、接口限流、HLC 设备绑定、payload 原型污染校验、CORS 白名单 |

未实现且不属于本卡：WebDAV、实时 WS 推送、服务端全文搜索、客户端许可/离线权益签名、多人协作。

## Docker Compose 启动

需要 Docker Compose 2.17+（使用 `additional_contexts` 把 `packages/shared` 注入构建）。

```sh
# 仓库根目录
docker compose up -d --build
curl localhost:8787/api/v1/health
```

Compose 会启动 `postgres:16-alpine`、`minio`（9000/9001）和本服务（8787）。
服务启动时自动迁移、自动创建 bucket。默认初始化 token 为 `dev-setup-token`，
仅用于本机验收；公网部署必须替换并设置 `ZX_SETUP_ALLOW_REMOTE=false`。

首次初始化：

```sh
curl -sS -X POST localhost:8787/api/v1/setup \
  -H 'content-type: application/json' \
  -d '{"setupToken":"dev-setup-token","passphrase":"change-me-please"}'
```

返回 `adminToken`（同时设置 HttpOnly Cookie）。之后：

```sh
# 生成配对码
curl -sS -X POST localhost:8787/api/v1/devices/pair-code \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"label":"MacBook"}'

# 客户端配对（桌面/移动 App 调用，不需要管理员令牌）
curl -sS -X POST localhost:8787/api/v1/devices/pair \
  -H 'content-type: application/json' \
  -d '{"code":"ZX-XXXX-XXXX","name":"MacBook","platform":"macos"}'
```

## 本地开发（不使用 Docker）

```sh
cd server
npm ci
DATABASE_URL=postgres://user@127.0.0.1:5432/zhixing npm run migrate
DATABASE_URL=... ZX_SETUP_TOKEN=dev-setup-token npm start
```

服务启动时会再次执行 migration（幂等），并打印健康检查地址。若未设置
`ZX_SETUP_TOKEN`，会生成一次性 token 输出到控制台。

### 环境变量

见 [`.env.example`](./.env.example)。关键项：

- `DATABASE_URL`：PostgreSQL 连接串。
- `ZX_SETUP_TOKEN` / `ZX_SETUP_ALLOW_REMOTE`：首次初始化校验；默认只允许本机。
- `ZX_S3_ENDPOINT`：服务端访问 MinIO 的地址（Docker 内是 `http://minio:9000`）。
- `ZX_S3_PUBLIC_ENDPOINT`：客户端可访问的地址（Docker 宿主机是 `http://localhost:9000`）。
- `ZX_S3_BUCKET` / `ZX_S3_ACCESS_KEY` / `ZX_S3_SECRET_KEY`。
- `ZX_ACCESS_TTL` / `ZX_REFRESH_TTL` / `ZX_PAIRING_TTL` / `ZX_ADMIN_SESSION_TTL`。
- `ZX_MAX_DEVICES`：单部署设备上限（安全阀，不是席位/计费概念）。
- `ZX_TRUST_PROXY`：放在 nginx 后设为 `true`。

## API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v1/health` | 公开 | DB/存储/初始化状态 |
| GET | `/.well-known/zhixing` | 公开 | 发现、版本协商；`webdav=false` |
| POST | `/api/v1/setup` | setup token | 一次性初始化管理口令 |
| POST | `/api/v1/auth/login` | 公开 | 口令登录，限流 + 失败锁定 |
| POST | `/api/v1/auth/logout` | 会话 | 注销 |
| GET | `/api/v1/auth/status` | 管理员 | 会话状态 |
| POST | `/api/v1/devices/pair-code` | 管理员 | 生成一次性配对码 |
| POST | `/api/v1/devices/pair` | 配对码 | 换设备令牌 + 刷新令牌 |
| POST | `/api/v1/devices/refresh` | 刷新令牌 | 轮换设备令牌 |
| GET | `/api/v1/devices` | 管理员 | 设备列表 |
| DELETE | `/api/v1/devices/:id` | 管理员 | 撤销设备（立即失效） |
| POST | `/api/v1/sync/push` | 设备 | 批量上传 op（≤200） |
| GET | `/api/v1/sync/pull?cursor=&limit=` | 设备 | 增量拉取 op + 冲突 |
| GET | `/api/v1/sync/status` | 设备 | 游标、最近冲突、实体计数、存储状态 |
| GET | `/api/v1/sync/entity/:type/:id` | 设备 | 查看合并投影（调试/验收） |
| GET | `/api/v1/sync/conflicts` | 设备 | 最近冲突审计 |
| POST | `/api/v1/attachments/init` | 设备 | 写元数据 + 返回预签名 PUT |
| POST | `/api/v1/attachments/:id/complete` | 设备 | 校验大小/SHA-256 后置为 available |
| GET | `/api/v1/attachments/:id/download` | 设备 | 预签名下载 URL |
| GET | `/api/v1/attachments?noteId=` | 设备 | 附件元数据列表 |
| DELETE | `/api/v1/attachments/:id` | 设备 | 软删除元数据 |

设备鉴权头：

```
Authorization: Bearer <deviceToken>
X-ZX-Device: <deviceId>
```

### Op 信封

```json
{
  "op_id": "019...uuidv7",
  "space_id": "personal",
  "device_id": "dev_...",
  "entity_type": "task",
  "entity_id": "task-1",
  "op_type": "upsert|patch|delete|yupdate",
  "hlc": { "ms": 1761400000000, "c": 3, "d": "dev_..." },
  "base_vv": { "dev_other": 12 },
  "payload": { "title": "写周报" },
  "created_at": "2026-10-26T09:00:00Z"
}
```

服务端强制 `hlc.d === 设备 ID`，拒绝伪造；`op_id` 唯一，重复上传返回
`duplicates`，不二次写实体、不二次生成冲突副本。

### 合并规则

- **标量字段**：字段级 LWW（HLC 大者胜，同 HLC 比 device_id）。并发标量冲突写
  `conflicts(kind=field_lww)` 审计。
- **正文/画板快照**：`body / snapshot / snapshot_json / snapshotJson` 并发修改时，
  绝不静默覆盖。LWW 赢家留在主实体，落败内容写成独立的 `note`/`board` 冲突副本，
  `title` 带“（冲突副本）”、`conflict_of` 指向原实体，并把副本作为 server op
  写入 `sync_ops`，客户端 pull 后即可显示。
- **冲突副本 ID**：用冲突双方 HLC 规范排序生成，服务端和客户端离线合并会得到同一 ID，
  不会出现两份重复副本。
- **删除**：墓碑优先；旧设备 replay 不会复活实体。
- **版本向量**：只做因果判断；`base_vv` 不覆盖未知设备计数。

## 附件

1. `POST /attachments/init`：客户端提交 `sha256 / byteSize / mime / fileName`，
   服务端写 `attachments(status=pending)`，返回 MinIO 预签名 PUT URL。
2. 客户端直接 PUT 到 MinIO（二进制不进 PostgreSQL）。
3. `POST /attachments/:id/complete`：服务端 HEAD 校验大小，再读回流式计算 SHA-256；
   通过后置 `available`，不一致会删除对象并返回 `ATTACHMENT_HASH_MISMATCH`。
4. `GET /attachments/:id/download` 返回预签名 GET URL。

## 客户端同步引擎

`app/src/sync/` 与 `packages/shared/` 提供可复用实现：

- `SyncEngine`：配对、outbox、增量拉取、指数退避、401 自动刷新、离线恢复。
- `MemorySyncStore` / `LocalStorageSyncStore`：当前渲染层持久化；桌面正式版实现
  `SyncStore` 接口接 SQLite 的 `op_outbox / sync_cursor / conflicts` 即可，业务逻辑不变。
- `SyncHttpClient`：`fetch` 可注入，测试不依赖真实网络。

## 测试与验收

```sh
cd server
npm run typecheck
npm test        # 共享合并逻辑 + 服务端单元测试；集成测试需 TEST_DATABASE_URL

# 真实 PostgreSQL 集成测试
ZX_TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/zx_test npm run test:integration

# 真实端到端（服务已启动、MinIO 可用）
DATABASE_URL=postgres://... ZX_SETUP_TOKEN=... npm run acceptance
```

`acceptance` 覆盖：健康检查、两设备配对、不同字段合并、正文冲突副本、重复
`operation_id`、断网恢复、数据库无 users/accounts/memberships/seats、附件上传
哈希校验与下载。成功输出 `ACCEPTANCE OK`。

## 已知边界

- 限流是进程内实现；多实例部署需换成 Redis/网关限流。
- 管理会话 Cookie 写请求要求 `X-ZX-CSRF: 1`；API 客户端用 Bearer，不受影响。
- 首次初始化在 Docker 桥接网络下不是“宿主回环地址”，Compose 为方便本机验收
  默认 `ZX_SETUP_ALLOW_REMOTE=true`。公网部署请关闭，并在服务器本机初始化。
- 冲突审计当前没有“已解决”状态；副本本身可编辑/删除，后续卡片再做解决动作。
