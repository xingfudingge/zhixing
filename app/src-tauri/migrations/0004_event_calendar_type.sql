-- 0004_event_calendar_type
-- AUD-024 / DEF-AUD014-02：事件缺少「历法：公历/农历」字段。
-- 约束：
--   * 与 countdowns.calendar_type 保持一致：只允许 solar / lunar，默认 solar。
--   * 仅作标记，不把农历事件换算成下一次公历实例（PRD §3.6.6 边界）。
--   * 旧数据由 ADD COLUMN 的 NOT NULL DEFAULT 回填为 solar，不丢失任何事件。

ALTER TABLE events
  ADD COLUMN calendar_type TEXT NOT NULL DEFAULT 'solar'
  CHECK (calendar_type IN ('solar', 'lunar'));
