/** 月热力图：每个习惯一行、当月每天一格；历史格可补卡，未来格拒绝。 */

import type { CSSProperties } from 'react';

import type { Habit } from '../../data/db/types';
import { HabitIcon } from './HabitIcon';
import {
  activeLogDates,
  habitToneOf,
  isFutureDate,
  monthDates,
  monthLabel,
  shiftMonth,
  type HabitLogMap,
} from './stats';

export type HabitHeatmapProps = {
  habits: Habit[];
  logsByHabit: HabitLogMap;
  today: string;
  month: string;
  onMonthChange: (month: string) => void;
  onToggle: (habit: Habit, date: string) => void;
  busy?: boolean;
};

export function HabitHeatmap({
  habits,
  logsByHabit,
  today,
  month,
  onMonthChange,
  onToggle,
  busy = false,
}: HabitHeatmapProps) {
  const dates = monthDates(month);
  const gridStyle = {
    gridTemplateColumns: `112px repeat(${dates.length}, minmax(17px, 1fr))`,
  } satisfies CSSProperties;

  return (
    <section className="habit-card habit-heatmap-card" aria-label="习惯月热力图">
      <div className="habit-heatmap-head">
        <button
          type="button"
          className="habit-month-nav"
          aria-label="上个月"
          onClick={() => onMonthChange(shiftMonth(month, -1))}
        >
          ‹
        </button>
        <h2>{monthLabel(month)}热力图</h2>
        <button
          type="button"
          className="habit-month-nav"
          aria-label="下个月"
          onClick={() => onMonthChange(shiftMonth(month, 1))}
        >
          ›
        </button>
        <span className="habit-hint">点击任意历史日期补卡 / 撤销；未来日期不可点击</span>
      </div>

      <div className="habit-heatmap-scroll">
        <div className="habit-heatmap" style={gridStyle}>
          <div className="habit-heatmap-corner" aria-hidden="true" />
          {dates.map((date) => (
            <div
              key={`day-${date}`}
              className={
                date === today ? 'habit-heatmap-daynum is-today' : 'habit-heatmap-daynum'
              }
              aria-hidden="true"
            >
              {Number(date.slice(-2))}
            </div>
          ))}

          {habits.map((habit) => {
            const checkedDates = activeLogDates(logsByHabit[habit.id]);
            return (
              <HabitHeatmapRow
                key={habit.id}
                habit={habit}
                dates={dates}
                checkedDates={checkedDates}
                today={today}
                busy={busy}
                onToggle={onToggle}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

function HabitHeatmapRow({
  habit,
  dates,
  checkedDates,
  today,
  busy,
  onToggle,
}: {
  habit: Habit;
  dates: string[];
  checkedDates: ReadonlySet<string>;
  today: string;
  busy: boolean;
  onToggle: (habit: Habit, date: string) => void;
}) {
  return (
    <>
      <div className="habit-heatmap-label" title={habit.title}>
        <span
          className={`habit-heatmap-icon habit-heatmap-icon--${habitToneOf(
            habit.color,
          )}`}
        >
          <HabitIcon icon={habit.icon} size={14} />
        </span>
        <span>{habit.title}</span>
      </div>
      {dates.map((date) => {
        const checked = checkedDates.has(date);
        const future = isFutureDate(date, today);
        return (
          <button
            type="button"
            key={`${habit.id}-${date}`}
            className={[
              'habit-cell',
              checked ? 'is-on' : '',
              date === today ? 'is-today' : '',
              future ? 'is-future' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            data-date={date}
            data-habit-id={habit.id}
            data-checked={checked ? 'true' : 'false'}
            aria-label={`${habit.title} ${date} ${
              checked ? '已打卡' : '未打卡'
            }${future ? '（未来日期，不可打卡）' : ''}`}
            aria-disabled={future || busy ? 'true' : undefined}
            title={`${date} ${checked ? '已打卡' : '未打卡'}`}
            onClick={() => onToggle(habit, date)}
          >
            <span className="habit-cell-dot" aria-hidden="true" />
          </button>
        );
      })}
    </>
  );
}
