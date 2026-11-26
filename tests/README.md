# 知行 · ZX-090 独立验收套件

本目录只用于验收，不属于产品运行代码。测试渲染真实 `App` / 路由 / 页面 / store，
只把 Tauri IPC 替换为 `harness/fakeTauri.ts` 的内存命令路由；Rust/SQLite 侧由
`pnpm --filter app test:db`、`cargo test` 与真实桌面进程日志另行验证。

```sh
# 全量独立验收（需先在 app/ 安装依赖）
tests/run-acceptance.sh

# 只跑某个文件 / 用例
tests/run-acceptance.sh core-paths
tests/run-acceptance.sh -t '知识核心路径'
```

覆盖：
- 任务：新建、完成/撤销、快速双点、删除不存在项、删除撤销、四象限/看板拖拽、刷新重挂载；
- 收件箱/清单：分诊、删除清单迁移任务到收件箱；
- 任务详情：子任务、创建时间、执行笔记与回链；
- 日历：月/周/日、拖拽改期、事件/倒数日、天数/生肖、沉浸时钟；
- 习惯/专注/复盘：打卡撤销/未来拒绝/安排行动、无任务拒绝/手动补记、保存复盘与幂等；
- 知识：打开/改标题正文/新建/删除/恢复、HTML 编辑器与块编辑器的接线缺口；
- 画板：加载节点/连线、阅读模式、改标题/插入对象/保存；
- 设置：主题/字号/宽度持久化、偏好重置、偏好备份导入/非法文件、农历联动；
- 空库全模块空态与控制台零报错。

已知缺口（详见 `outputs/验收报告-知行-v1.md`）：
- 知识页未接入 `features/editor` 块编辑器、`features/editor/todos` 笔记待办、右栏 12 工具；
- `features/attachments`、`features/ocr`、`features/notifications`、`features/calendar/ics`、`features/sync/webdav` 未接入任何页面入口；
- 设置「重置全部数据」仍标注未实现；
- `pnpm --filter app tauri dev` 与 `tauri build` 因 Cargo 多 bin 无 `default-run` 失败。

## AUD-017 断点验收（F-035）

```sh
pnpm build
node tests/e2e/aud017-browser.mjs
```

真实 Chromium（CDP 视口覆盖 + 真实鼠标）跑 1024/900/768/390 × 知识/画板/设置/表格
共 16 个组合，逐组合输出截图、`scrollWidth vs clientWidth`、越界元素与控制台状态；
另含空数据、刷新持久化、快速连点、不存在项与表格删减边界。结果见
`tests/evidence/aud017/`，报告见 `outputs/验收报告-AUD-017.md`。
