/** 习惯列表行：图标/颜色、周视图圆点、连续/最佳与行动入口。 */

import type { Habit, HabitLog } from '../../data/db/types';
import { HabitIcon } from './HabitIcon';
import {
  activeLogDates,
  habitStreak,
  habitToneOf,
  isFutureDate,
  WEEKDAY_LABELS,
  weekDates,
} from './stats';

export type HabitRowProps = {
  habit: Habit;
  logs: HabitLog[] | undefined;
  today: string;
  onToggle: (date: string) => void;
  onArrange: () => void;
  onEdit: () => void;
  busy?: boolean;
};

export function HabitRow({
  habit,
  logs,
  today,
  onToggle,
  onArrange,
  onEdit,
  busy = false,
}: HabitRowProps) {
  const dates = activeLogDates(logs);
  const week = weekDates(today);
  const streak = habitStreak(logs, today);

  return (
    <article className="habit-row" data-habit-id={habit.id}>
      <div className={`habit-icon habit-icon--${habitToneOf(habit.color)}`}>
        <HabitIcon icon={habit.icon} size={20} />
      </div>

      <div className="habit-main">
        <div className="habit-title-line">
          <b>{habit.title}</b>
          <small>{habit.schedule || '每天'}</small>
        </div>
        <div
          className="habit-week"
          role="group"
          aria-label={`${habit.title} 本周打卡，周一到周日`}
        >
          {week.map((date, index) => {
            const checked = dates.has(date);
            const future = isFutureDate(date, today);
            return (
              <button
                type="button"
                key={date}
                className={[
                  'habit-day',
                  checked ? 'is-on' : '',
                  date === today ? 'is-today' : '',
                  future ? 'is-future' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                data-date={date}
                data-checked={checked ? 'true' : 'false'}
                aria-label={`${habit.title} ${date} ${
                  checked ? '已打卡' : '未打卡'
                }${future ? '（未来日期，不可打卡）' : ''}`}
                aria-disabled={future || busy ? 'true' : undefined}
                title={date}
                onClick={() => onToggle(date)}
              >
                {checked ? '✓' : WEEKDAY_LABELS[index]}
              </button>
            );
          })}
        </div>
      </div>

      <div
        className="habit-streak"
        aria-label={`当前连续 ${streak.current} 天，最佳 ${streak.best} 天`}
      >
        <span aria-hidden="true">🔥</span> <b>{streak.current}</b> 天
        <small>最佳 {streak.best}</small>
      </div>

      <div className="habit-row-actions">
        <button
          type="button"
          className="habit-button habit-button--small"
          aria-label={`安排行动：${habit.title}`}
          onClick={onArrange}
          disabled={busy}
        >
          安排行动
        </button>
        <button
          type="button"
          className="habit-button habit-button--small habit-button--ghost"
          aria-label={`编辑习惯：${habit.title}`}
          onClick={onEdit}
          disabled={busy}
        >
          编辑
        </button>
      </div>
    </article>
  );
}
