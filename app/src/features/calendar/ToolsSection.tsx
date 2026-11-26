/**
 * 日历小工具：天数计算 / 农历转换 / 生肖查询 / 全屏时钟。
 * 全部离线可算；计算结果不创建任务，只有「加入倒数日」会写入倒数日表单。
 */

import { useState } from 'react';

import {
  addDaysISO,
  diffDays,
  formatLunarText,
  formatMonthDayWithYear,
  formatWeekday,
  isValidISODate,
  zodiacForYear,
} from '../../data/calendar';
import { DatePicker } from '../../ui/date';
import type { CountdownPrefill } from '../countdowns/CountdownDialog';
import { ClockOverlay } from './ClockOverlay';

type ToolMode = 'days' | 'lunar' | 'zodiac' | 'clock';

const TOOLS: ReadonlyArray<{ value: ToolMode; label: string }> = [
  { value: 'days', label: '天数计算' },
  { value: 'lunar', label: '农历转换' },
  { value: 'zodiac', label: '生肖查询' },
  { value: 'clock', label: '全屏时钟' },
];

export type ToolsSectionProps = {
  today: string;
  onAddCountdown: (prefill: CountdownPrefill) => void;
};

export function ToolsSection({ today, onAddCountdown }: ToolsSectionProps) {
  const [mode, setMode] = useState<ToolMode>('days');
  const [dateA, setDateA] = useState(today);
  const [dateB, setDateB] = useState(addDaysISO(today, 7));
  const [inclusive, setInclusive] = useState(false);
  const [lunarDate, setLunarDate] = useState(today);
  const [dateAValid, setDateAValid] = useState(true);
  const [dateBValid, setDateBValid] = useState(true);
  const [lunarValid, setLunarValid] = useState(true);
  const [zodiacYear, setZodiacYear] = useState(today.slice(0, 4));
  const [clockOpen, setClockOpen] = useState(false);

  const daysValue = useMemoDaysResult(dateA, dateB, inclusive);
  const daysResult =
    dateAValid && dateBValid ? daysValue : '请先修正日期';
  const lunarText =
    lunarValid && isValidISODate(lunarDate)
      ? formatLunarText(lunarDate, {
          includeYear: true,
          includeZodiac: true,
        })
      : '请先修正日期';
  const yearNumber = Number(zodiacYear);
  const safeYear = Number.isFinite(yearNumber) ? Math.trunc(yearNumber) : 2026;
  const animal = zodiacForYear(safeYear);
  const currentYear = Number(today.slice(0, 4));
  const birthYears = [safeYear, safeYear - 12, safeYear - 24, safeYear - 36];

  return (
    <div className="calendar-tools">
      <div className="calendar-tools-tabs" role="group" aria-label="日期工具">
        {TOOLS.map((tool) => (
          <button
            type="button"
            key={tool.value}
            className={
              mode === tool.value
                ? 'calendar-tool-tab calendar-tool-tab--active'
                : 'calendar-tool-tab'
            }
            aria-pressed={mode === tool.value}
            onClick={() => setMode(tool.value)}
          >
            {tool.label}
          </button>
        ))}
      </div>

      {mode === 'days' ? (
        <section className="calendar-tool-card" aria-label="天数计算">
          <h3>天数计算</h3>
          <p>
            算两个日期之间相隔多少天，或包含首尾两天的总天数。结果只用于查询，不会创建待办。
          </p>
          <div className="calendar-tool-grid">
            <label>
              时间 1
              <DatePicker
                value={dateA}
                required
                showHelper={false}
                onValidityChange={setDateAValid}
                onChange={(next) => setDateA(next ?? dateA)}
              />
            </label>
            <label>
              时间 2
              <DatePicker
                value={dateB}
                required
                showHelper={false}
                onValidityChange={setDateBValid}
                onChange={(next) => setDateB(next ?? dateB)}
              />
            </label>
          </div>
          <div className="calendar-tool-result">
            <div>
              <small>{inclusive ? '包含首尾' : '相隔'}</small>
              <strong data-testid="days-result">{daysResult}</strong>
            </div>
            <span>天</span>
            <button
              type="button"
              className="task-button task-button--small"
              aria-pressed={inclusive}
              onClick={() => setInclusive((current) => !current)}
            >
              切换：{inclusive ? '不包含首尾' : '包含首尾'}
            </button>
          </div>
          <div className="calendar-tool-chips">
            <button
              type="button"
              disabled={!dateAValid}
              onClick={() => setDateB(addDaysISO(dateA, 7))}
            >
              +7 天
            </button>
            <button
              type="button"
              disabled={!dateAValid}
              onClick={() => setDateB(addDaysISO(dateA, 30))}
            >
              +30 天
            </button>
            <button
              type="button"
              disabled={!dateAValid}
              onClick={() => setDateB(addDaysISO(dateA, 365))}
            >
              +1 年
            </button>
            <button
              type="button"
              onClick={() => {
                setDateA(today);
                setDateB(today);
              }}
            >
              重置为今天
            </button>
          </div>
        </section>
      ) : null}

      {mode === 'lunar' ? (
        <section className="calendar-tool-card" aria-label="农历转换">
          <h3>农历转换</h3>
          <p>
            公历与农历互查，使用系统内置的中国农历数据；离线可用。
          </p>
          <div className="calendar-tool-grid">
            <label>
              公历日期
              <DatePicker
                value={lunarDate}
                required
                showHelper={false}
                onValidityChange={setLunarValid}
                onChange={(next) => setLunarDate(next ?? lunarDate)}
              />
            </label>
          </div>
          <div className="calendar-tool-result calendar-tool-result--lunar">
            <div>
              <small>对应农历</small>
              <strong data-testid="lunar-result">{lunarText}</strong>
              <small>
                {lunarValid && isValidISODate(lunarDate)
                  ? `${formatMonthDayWithYear(lunarDate)} · ${formatWeekday(lunarDate)}`
                  : '请先修正日期'}
              </small>
            </div>
          </div>
          <div className="calendar-tool-chips">
            <button
              type="button"
              disabled={!lunarValid}
              onClick={() => {
                if (!lunarValid || !isValidISODate(lunarDate)) {
                  return;
                }
                onAddCountdown({
                  title: '农历纪念日',
                  category: '纪念日·生日',
                  calendarType: 'lunar',
                  targetDate: lunarDate,
                  repeatRule: '每年（农历）',
                  note: `由农历转换创建：${lunarText}`,
                });
              }}
            >
              加入倒数日
            </button>
          </div>
        </section>
      ) : null}

      {mode === 'zodiac' ? (
        <section className="calendar-tool-card" aria-label="生肖查询">
          <h3>生肖查询</h3>
          <p>按年份查生肖与出生年份；年龄按虚岁计算，仅作参考。</p>
          <div className="calendar-tool-grid">
            <label>
              查询年份
              <input
                type="number"
                min={1900}
                max={2100}
                value={zodiacYear}
                onChange={(event) => setZodiacYear(event.target.value)}
              />
            </label>
          </div>
          <div className="calendar-zodiac">
            <div className="calendar-zodiac-animal" aria-hidden="true">
              {animal}
            </div>
            <div>
              <strong>
                {safeYear} 年 · 属{animal}
              </strong>
              {birthYears.map((year) => (
                <small key={year}>
                  {year} 年出生 · 虚岁 {currentYear - year + 1}
                </small>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {mode === 'clock' ? (
        <section className="calendar-clock-card" aria-label="全屏时钟">
          <div className="calendar-clock-preview">
            {new Date().getHours().toString().padStart(2, '0')}:
            {new Date().getMinutes().toString().padStart(2, '0')}
          </div>
          <p>沉浸展示时间、日期与农历；不记录专注时长，也不写入任何数据。</p>
          <button
            type="button"
            className="task-button task-button--primary"
            onClick={() => setClockOpen(true)}
          >
            打开全屏时钟
          </button>
        </section>
      ) : null}

      <ClockOverlay open={clockOpen} onClose={() => setClockOpen(false)} />
    </div>
  );
}

function useMemoDaysResult(
  dateA: string,
  dateB: string,
  inclusive: boolean,
): string {
  if (!isValidISODate(dateA) || !isValidISODate(dateB)) {
    return '—';
  }
  const value = diffDays(dateA, dateB) + (inclusive ? 1 : 0);
  return String(value);
}
