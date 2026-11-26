# WebDAV 测试与验收

本目录只用于测试/验收，不进入服务端生产代码。

## 自动化测试

```sh
cd server
npx vitest run test/webdav
```

覆盖：

- `mock-webdav-server.ts`：默认**不返回 ETag**、不实现 LOCK/MOVE/COPY；
  - 支持 PROPFIND Depth 0/1、GET/HEAD/PUT/MKCOL/DELETE；
  - 可注入断网与“写入成功但返回 502”的响应丢失。
- `webdav-core.test.ts`：连接探测、目录清单推导、同 op 幂等、远端冲突不覆盖、
  断网/丢响应重试、分片上传/缺失/损坏、快照 sha256 回退、请求头断言。
- `webdav-engine.test.ts`：两设备增量同步、outbox 恢复、快照首同步、
  模式切换（Web 禁止 / 未上传需确认 / 切换失败保持原模式）。

## 真实 OpenList/Alist

准备一个可写的测试目录（不要指向真实数据）：

```sh
cd server
WEBDAV_URL=http://127.0.0.1:5244/dav \
WEBDAV_USERNAME=admin \
WEBDAV_PASSWORD='应用密码' \
WEBDAV_ROOT=/zhixing-verify \
WEBDAV_SPACE=verify \
npx tsx test/webdav/live-check.ts
```

脚本会实际执行 PROPFIND/MKCOL/PUT/GET/DELETE/分片探测，追加一个 op 并从目录
清单读回，写快照 + `.sha256` 校验，最后删除本次生成的文件。HTTP 仅允许
`127.0.0.1` / `localhost`；远端必须 HTTPS。

无外部服务时用内置 mock 走同一流程：

```sh
npx tsx test/webdav/live-check.ts --mock
```
