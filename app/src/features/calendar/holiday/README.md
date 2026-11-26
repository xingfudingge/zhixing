# 节假日同步源与个人日期例外

## 上游数据源

| 项 | 值 |
|---|---|
| 仓库 | [`NateScarlet/holiday-cn`](https://github.com/NateScarlet/holiday-cn) |
| 许可 | MIT（仓库 `LICENSE`） |
| 审计日 commit | `2fa4d1e5fb471bc89bdabeb630c141fee6201575`（2026-10-30） |
| 数据文件 | `2026.json`（39 天）、`2027.json`（审计日 `days: []`） |
| Schema | `schema.json` |
| 同步地址 | `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json`、`https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json` |
| 引入方式 | 数据源，不引入代码；不包含 GPL/AGPL 依赖 |

数据格式（上游 README/schema）：

```ts
type Holidays = {
  year: number;
  papers: string[];
  days: { name: string; date: string; isOffDay: boolean }[];
};
```

## 行为

- **内置回退**：`data/calendar/holidays.ts` 保留国务院办公厅 2026 年安排（39 天）作为离线包。
- **远端缓存**：IndexedDB `zhixing-holiday`；`packages` 按年份存解析后的数据包，`meta` 存
  `lastSyncAt` / `lastAttemptAt` / `lastError` / `version` / `notPublishedYears`。
- **按年覆盖**：成功同步某年后，该年以内远端包为准；没有远端包的年份继续使用内置 2026。
- **空包**：`days: []`（如 2027）返回 `HolidayNotPublishedError`，不会覆盖缓存，也不会当成成功数据。
- **失败**：HTTP 错误、超时、非 JSON、坏日期/坏 `isOffDay` 都会记录 `lastError` 并保留上次成功缓存；
  错误信息只包含脱敏 URL，不包含响应正文。
- **自动同步**：默认关闭；打开后最多每 24 小时检查一次；内置源不联网。
- **个人例外**：`settings` 表键 `calendar.dateExceptions`，同日保存为更新；优先级
  `个人例外 > 法定节假日/调休 > 周规则`。
- **备份**：`calendar.holidaySource` 与 `calendar.dateExceptions` 进入偏好备份 v3；v1/v2 备份可导入，
  缺失字段补默认。节假日数据包本身是公共数据，不进入业务备份。

## 测试

- `src/features/calendar/holiday/__tests__/parse.test.ts`：上游格式、空包、坏 JSON/坏字段、URL 校验。
- `src/features/calendar/holiday/__tests__/sync.test.ts`：成功、HTTP 失败、超时、格式错误、离线、304、
  跨年空包、清除源、自定义 URL、自动同步节流。
- `src/features/calendar/__tests__/workweek.test.ts`：个人例外优先级、跨年、远程包按年覆盖。
- `src/features/settings/__tests__/CalendarGroupHoliday.test.tsx`：设置页同步与例外增删改。
