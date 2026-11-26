/**
 * 倒数日分区：五类筛选 + 按剩余天数升序。
 * 倒数日只计数，不进入收件箱/今天，也没有完成按钮。
 */

import { useMemo, useState } from 'react';

import {
  COUNTDOWN_CATEGORIES,
  countdownDays,
  countdownMetaText,
  countdownTone,
  sortCountdowns,
} from '../../data/calendar/countdowns';
import type { Countdown } from '../../data/db/types';
import { ConfirmDialog } from '../tasks/Feedback';

export type CountdownsSectionProps = {
  today: string;
  countdowns: Countdown[];
  onNew: () => void;
  onEdit: (countdown: Countdown) => void;
  onDelete: (countdown: Countdown) => Promise<void>;
};

const ALL_CATEGORIES = ['全部', ...COUNTDOWN_CATEGORIES] as const;

export function CountdownsSection({
  today,
  countdowns,
  onNew,
  onEdit,
  onDelete,
}: CountdownsSectionProps) {
  const [category, setCategory] =
    useState<(typeof ALL_CATEGORIES)[number]>('全部');
  const [pendingDelete, setPendingDelete] = useState<Countdown | null>(null);

  const visible = useMemo(() => {
    const filtered =
      category === '全部'
        ? countdowns
        : countdowns.filter((countdown) => countdown.category === category);
    return sortCountdowns(filtered, today);
  }, [countdowns, category, today]);

  return (
    <div className="countdowns-section">
      <div className="calendar-info-banner">
        <span className="calendar-info-icon" aria-hidden="true">
          ◆
        </span>
        <div>
          <b>倒数日只负责“还有几天”</b>
          <p>
            生日、纪念日、节日、节气都可以放这里；它不占日历时间、不产生完成状态，
            也不会进入待办。需要执行的事情请建任务。
          </p>
        </div>
      </div>

      <div className="countdown-categories" role="group" aria-label="倒数日分类">
        {ALL_CATEGORIES.map((item) => (
          <button
            key={item}
            type="button"
            className={
              item === category
                ? 'countdown-category countdown-category--active'
                : 'countdown-category'
            }
            aria-pressed={item === category}
            onClick={() => setCategory(item)}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="countdown-head">
        <p>
          共 {visible.length} 个 · 按剩余天数升序
        </p>
        <button
          type="button"
          className="task-button task-button--primary"
          aria-label="倒数日分区新建倒数日"
          onClick={onNew}
        >
          ＋ 倒数日
        </button>
      </div>

      {visible.length > 0 ? (
        <div className="countdown-list">
          {visible.map((countdown) => {
            const days = countdownDays(countdown, today);
            const tone = countdownTone(countdown, today);
            const meta = countdownMetaText(countdown, today);
            return (
              <div
                className={`countdown-row countdown-row--${tone}`}
                key={countdown.id}
                data-countdown-id={countdown.id}
              >
                <span className="countdown-mark" aria-hidden="true" />
                <div className="countdown-main">
                  <b>{countdown.title}</b>
                  <small>{meta}</small>
                  {countdown.note ? (
                    <small className="countdown-note">{countdown.note}</small>
                  ) : null}
                </div>
                <div className={`countdown-days countdown-days--${tone}`}>
                  {days < 0 ? (
                    <b>已过去 {Math.abs(days)} 天</b>
                  ) : days === 0 ? (
                    <b>就是今天</b>
                  ) : (
                    <>
                      <b>{days}</b>
                      <small>天</small>
                    </>
                  )}
                </div>
                <div className="countdown-actions">
                  <button
                    type="button"
                    className="task-button task-button--small"
                    aria-label={`编辑倒数日「${countdown.title}」`}
                    onClick={() => onEdit(countdown)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="task-button task-button--small task-button--danger"
                    aria-label={`删除倒数日「${countdown.title}」`}
                    onClick={() => setPendingDelete(countdown)}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="countdown-empty">
          {category === '全部'
            ? '还没有倒数日，点右上角新建。'
            : '这个分类还没有倒数日，点右上角新建。'}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除这个倒数日？"
        description={
          pendingDelete
            ? `「${pendingDelete.title}」会从日历标记和倒数日列表移除。`
            : ''
        }
        confirmLabel="删除倒数日"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) {
            void onDelete(target);
          }
        }}
      />
    </div>
  );
}
