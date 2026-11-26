/**
 * 复盘仓储封装（P0-09）。
 *
 * 复盘是只读聚合：`load` 只读取任务、专注、习惯与打卡事实行；
 * `save` 调用 Rust 单事务命令，创建「复盘笔记 + review_snapshots」。
 *
 * 产品约束：
 * * 不改任务 / 专注 / 习惯；
 * * 任务完成日只看 `completed_at`，绝不回退到到期日；
 * * 同范围重复保存由后端唯一索引兜底，不会重复创建快照；
 * * 浏览器预览没有 IPC 时页面明确提示，不伪造统计。
 */

import type { DbClient } from '../db/client';
import { db } from '../db/client';
import type {
  HabitLog,
  ReviewSnapshot,
  SavedReview,
} from '../db/types';
import {
  buildReviewAggregate,
  currentReviewToday,
  REVIEW_DAYS,
  reviewRange,
  type ReviewAggregate,
} from '../../features/review/model';

export type ReviewLoadOptions = {
  /** 固定“今天”，测试可注入稳定日期。 */
  today?: string;
  /** 默认最近 7 天。 */
  days?: number;
};

export type ReviewRepository = {
  load: (options?: ReviewLoadOptions) => Promise<ReviewAggregate>;
  save: (aggregate: ReviewAggregate) => Promise<SavedReview>;
  snapshot: (from: string, to: string) => Promise<ReviewSnapshot | null>;
};

export function createReviewRepository(client: DbClient = db): ReviewRepository {
  return {
    async load(options: ReviewLoadOptions = {}): Promise<ReviewAggregate> {
      const today = options.today ?? currentReviewToday();
      const days = options.days ?? REVIEW_DAYS;
      const range = reviewRange(today, days);

      const [tasks, sessions, habits, lists] = await Promise.all([
        client.tasks.list(),
        client.focusSessions.list({ from: range.from, to: range.to }),
        client.habits.list({ includeArchived: true }),
        client.lists.list(),
      ]);

      const logsByHabit: Record<string, HabitLog[]> = {};
      await Promise.all(
        habits.map(async (habit) => {
          logsByHabit[habit.id] = await client.habits.logs.list(habit.id, {
            from: range.from,
            to: range.to,
          });
        }),
      );

      return buildReviewAggregate({
        today,
        days,
        tasks,
        sessions,
        habits,
        logsByHabit,
        lists,
      });
    },

    save(aggregate: ReviewAggregate): Promise<SavedReview> {
      return client.reviewSnapshots.save({
        rangeStart: aggregate.range.from,
        rangeEnd: aggregate.range.to,
        taskIds: aggregate.sourceIds.taskIds,
        focusIds: aggregate.sourceIds.focusIds,
        habitIds: aggregate.sourceIds.habitIds,
        note: {
          title: aggregate.note.title,
          folderId: null,
          tags: aggregate.note.tags,
          body: aggregate.note.body,
          bodyFormat: 'html',
          status: 'active',
          favorite: false,
          pinned: false,
        },
      });
    },

    snapshot(from: string, to: string): Promise<ReviewSnapshot | null> {
      return client.reviewSnapshots.getByRange(from, to);
    },
  };
}
