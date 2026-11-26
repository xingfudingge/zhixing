# WebDAV（OpenList / Alist）模式

本目录是 `P2-02` 的客户端实现，核心协议在 `packages/sync-webdav/`。

## 设计要点

- 只用 `PROPFIND / GET / PUT / MKCOL / DELETE`；**不发送** `If-Match`、`If-None-Match`、`LOCK/UNLOCK`、`MOVE`，也不读取/比较 ETag。
- 远端布局：

```text
{root}/spaces/{spaceId}/ops/{deviceId}/{seq}-{opId}.ndjson
{root}/spaces/{spaceId}/snapshots/{coveredSeq}-{deviceId}-{uuid}.json.gz
{root}/spaces/{spaceId}/snapshots/{...}.json.gz.sha256
{root}/spaces/{spaceId}/assets/{sha256}
{root}/spaces/{spaceId}/assets/.parts/{sha256}/{n}
{root}/spaces/{spaceId}/assets/.parts/{sha256}/complete.json
```

- 没有可变 manifest、没有全局游标、没有锁。设备游标 = 该设备目录里已应用的最大 `seq`。
- 文件名不可变；`PUT` 前若目标已存在，比对内容：相同则跳过，不同则报 `REMOTE_CONFLICT`，**绝不覆盖远端未知文件**。
- 大文件按 `chunkSize`（默认 4 MiB）写分片，最后写 `complete.json`；读取时全部分片存在且整体 SHA-256 匹配才可用。
- 网络/超时/429/5xx 指数退避重试；`PUT` 的幂等性来自不可变文件名，断网恢复不会重复写 op。
- 仅 HTTPS；`http://127.0.0.1` / `localhost` 允许用于本地 OpenList/Alist 验收。
- Web 平台不提供入口：`WebDavSettingsPanel` 只显示说明，`WebDavClient` / `WebDavSyncEngine` 也会拒绝 `platform: 'web'`。

## 接入设置页

`SyncGroup` 所在文件不在本卡文件域内，因此本卡只提供可挂载组件与控制器，不修改
`app/src/features/settings/`。宿主接入方式：

```tsx
import {
  WebDavSettingsPanel,
  WebDavModeController,
  createWebDavSyncEngine,
  detectPlatform,
} from '../../sync/webdav';

const platform = detectPlatform();
const engine = createWebDavSyncEngine({
  baseUrl,
  username,
  password,
  root: '/zhixing',
  spaceId: 'personal',
  deviceId,
  deviceName: '本机',
  platform,
});
const controller = new WebDavModeController({ engine, platform });

<WebDavSettingsPanel
  platform={platform}
  currentMode={currentMode}
  pendingUploads={pendingUploads}
  onModeChange={(target, decision) =>
    controller.switchMode(target, { confirmed: decision.allowed })
  }
/>
```

密码只保存在组件内存；当前版本不落盘（接入 OS 安全存储前不保存），`LocalStorageWebDavConfigStore` 只写入地址/用户名/目录/设备 ID。

## 自测

```sh
# 核心 + 引擎 + mock WebDAV（Node）
cd server && npx vitest run test/webdav

# UI / 平台保护 / 模式切换（jsdom）
cd app && npx vitest run src/sync/webdav

# 真实本地 OpenList/Alist
cd server && WEBDAV_URL=http://127.0.0.1:5244/dav \
  WEBDAV_USERNAME=admin WEBDAV_PASSWORD=... \
  npx tsx test/webdav/live-check.ts
```
