/**
 * 专注记录仓储封装。
 *
 * 产品约束（PRD §3.6.10 / 看板卡 P0-08）：
 * * 专注必须关联任务；没有任务时正式版拒绝写入，不再出现原型的“假成功”；
 * * 计时状态只存在内存，绝不写 localStorage；完成时才落一条 `focus_sessions`；
 * * 分钟数为正整数，单次上限 24 小时，避免误输入把统计撑爆；
 * * 页面只使用这里的高层方法，不拼 SQL、不直接接触 IPC 命令名。
 */

import type { DbClient } from '../db/client';
import type {
  FocusSession,
  FocusSessionQuery,
  FocusSessionUpdate,
} from '../db/types';

export type FocusMode = 'pomodoro' | 'countdown' | 'countup';
/** 手动补记不是计时模式，但同样写入 `mode` 供复盘区分。 */
export type FocusSessionMode = FocusMode | 'manual';

export const NO_TASK_MESSAGE = '先选择一个任务，本次专注不会记录';
export const EMPTY_DURATION_MESSAGE = '还没有开始计时';
export const INVALID_MINUTES_MESSAGE = '专注时长需为 1–1440 分钟';

export type RecordFocusInput = {
  taskId: string;
  minutes: number;
  startedAt: string;
  endedAt?: string | null;
  mode: FocusSessionMode;
  note?: string;
};

export function isValidFocusMinutes(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
}

/**
 * 写入前校验。返回错误文案，合法时返回 null。
 * 渲染层在发出 IPC 前先挡一次，桌面壳与测试都能得到一致的提示。
 */
export function validateFocusRecord(input: {
  taskId: string;
  minutes: number;
  startedAt: string;
}): string | null {
  if (!input.taskId.trim()) {
    return NO_TASK_MESSAGE;
  }
  if (!isValidFocusMinutes(input.minutes)) {
    return INVALID_MINUTES_MESSAGE;
  }
  if (!input.startedAt.trim()) {
    return '专注开始时间不能为空';
  }
  return null;
}

export function assertFocusRecord(input: {
  taskId: string;
  minutes: number;
  startedAt: string;
}): void {
  const message = validateFocusRecord(input);
  if (message) {
    throw new Error(message);
  }
}

export function createFocusRepository(client: DbClient) {
  const sessions = client.focusSessions;

  return {
    list: (query: FocusSessionQuery = {}): Promise<FocusSession[]> =>
      sessions.list(query),
    get: (id: string): Promise<FocusSession> => sessions.get(id),

    /**
     * 记录一段专注。单条写入而不是“先计数器 +1 再补明细”，
     * 今日/本周/复盘全部由这些事实行汇总。
     */
    async record(input: RecordFocusInput): Promise<FocusSession> {
      assertFocusRecord(input);
      return sessions.create({
        taskId: input.taskId,
        minutes: input.minutes,
        startedAt: input.startedAt,
        endedAt: input.endedAt ?? null,
        mode: input.mode,
        note: input.note ?? '',
      });
    },

    update: (
      id: string,
      input: FocusSessionUpdate,
    ): Promise<FocusSession> => sessions.update(id, input),
    remove: (id: string): Promise<void> => sessions.remove(id),
  };
}

export type FocusRepository = ReturnType<typeof createFocusRepository>;
