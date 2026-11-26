# import · 备份校验与恢复（P2-04）

| 文件 | 职责 |
|---|---|
| `parseBackup.ts` | ZIP/JSON 解析、manifest/哈希/计数/关系/白名单校验；只解析不写库 |
| `planRestore.ts` | 冲突分类、默认跳过、覆盖/保留两者、ID 重映射、依赖阻止、操作排序、逐项应用 |
| `restoreTarget.ts` | 生产写入目标：只调用既有 Tauri IPC 命令 + IndexedDB 附件状态 |
| `RestorePreviewDialog.tsx` | 恢复预览：摘要、冲突对比、覆盖确认、阻止/提示、进度与结果 |

恢复语义：

- 冲突默认 `skip`，不会静默覆盖；
- `overwrite` 只对支持的集合开放；任务/笔记会先尝试 restore；
- `keep-both` 生成新 ID；笔记的块/待办、任务的子任务、画板的节点/连线会随父对象复制；
- 父对象被跳过/阻止时，新增子对象一并阻止；
- 回收站对象先建后软删除，关系字段不改写为 `null`；
- 写入按父→子顺序，删除最后执行；中途失败停止并报告已应用数量。

测试：`planRestore.test.ts`、`parseBackup.test.ts`、`memoryTarget.ts` 与
`DataBackupPanel.e2e.tsx`（`pnpm --filter app test:e2e`）。
