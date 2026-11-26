import { describe, expect, it } from 'vitest';

import { createDbClient, type DbInvoker } from '../db/client';
import type { FocusSession } from '../db/types';
import {
  EMPTY_DURATION_MESSAGE,
  INVALID_MINUTES_MESSAGE,
  NO_TASK_MESSAGE,
  createFocusRepository,
  isValidFocusMinutes,
  validateFocusRecord,
} from './focus';

type Call = { command: string; args?: Record<string, unknown> };

const session: FocusSession = {
  id: 'focus-1',
  spaceId: 'personal',
  taskId: 'task-review',
  minutes: 25,
  startedAt: '2026-10-26T09:00:00+08:00',
  endedAt: '2026-10-26T09:25:00+08:00',
  mode: 'pomodoro',
  note: '',
  createdAt: '2026-10-26T01:25:00.000Z',
  updatedAt: '2026-10-26T01:25:00.000Z',
  deletedAt: null,
  version: 1,
};

function makeClient(
  respond: (command: string, args?: Record<string, unknown>) => unknown,
) {
  const calls: Call[] = [];
  const invoker: DbInvoker = (command, args) => {
    calls.push({ command, args });
    return Promise.resolve(respond(command, args) as never);
  };
  return { client: createDbClient(invoker), calls };
}

describe('专注记录校验', () => {
  it('任务必填、分钟为 1–1440 的整数', () => {
    expect(
      validateFocusRecord({
        taskId: '',
        minutes: 25,
        startedAt: '2026-10-26T09:00:00+08:00',
      }),
    ).toBe(NO_TASK_MESSAGE);
    expect(
      validateFocusRecord({
        taskId: 'task-review',
        minutes: 0,
        startedAt: '2026-10-26T09:00:00+08:00',
      }),
    ).toBe(INVALID_MINUTES_MESSAGE);
    expect(
      validateFocusRecord({
        taskId: 'task-review',
        minutes: 25,
        startedAt: '',
      }),
    ).toBe('专注开始时间不能为空');
    expect(
      validateFocusRecord({
        taskId: 'task-review',
        minutes: 25,
        startedAt: '2026-10-26T09:00:00+08:00',
      }),
    ).toBeNull();

    expect(isValidFocusMinutes(1)).toBe(true);
    expect(isValidFocusMinutes(1440)).toBe(true);
    expect(isValidFocusMinutes(1441)).toBe(false);
    expect(isValidFocusMinutes(2.5)).toBe(false);
  });

  it('无任务时直接拒绝，不发出 IPC，避免原型式假成功', async () => {
    const { client, calls } = makeClient(() => session);
    const repository = createFocusRepository(client);

    await expect(
      repository.record({
        taskId: '',
        minutes: 25,
        startedAt: '2026-10-26T09:00:00+08:00',
        endedAt: '2026-10-26T09:25:00+08:00',
        mode: 'pomodoro',
      }),
    ).rejects.toThrow(NO_TASK_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it('非法分钟拒绝；0 分钟不会写成一条记录', async () => {
    const { client, calls } = makeClient(() => session);
    const repository = createFocusRepository(client);

    await expect(
      repository.record({
        taskId: 'task-review',
        minutes: 0,
        startedAt: '2026-10-26T09:00:00+08:00',
        mode: 'manual',
      }),
    ).rejects.toThrow(INVALID_MINUTES_MESSAGE);
    expect(calls).toHaveLength(0);
    expect(EMPTY_DURATION_MESSAGE).toBe('还没有开始计时');
  });
});

describe('createFocusRepository', () => {
  it('合法记录补全默认 note/endedAt 后调用 focus_sessions_create', async () => {
    const { client, calls } = makeClient(() => session);
    const repository = createFocusRepository(client);

    const created = await repository.record({
      taskId: 'task-review',
      minutes: 25,
      startedAt: '2026-10-26T09:00:00+08:00',
      endedAt: '2026-10-26T09:25:00+08:00',
      mode: 'pomodoro',
    });

    expect(created).toEqual(session);
    expect(calls).toEqual([
      {
        command: 'focus_sessions_create',
        args: {
          input: {
            taskId: 'task-review',
            minutes: 25,
            startedAt: '2026-10-26T09:00:00+08:00',
            endedAt: '2026-10-26T09:25:00+08:00',
            mode: 'pomodoro',
            note: '',
          },
        },
      },
    ]);
  });

  it('查询与删除直接委托，命令名固定', async () => {
    const { client, calls } = makeClient((command) => {
      if (command === 'focus_sessions_list') {
        return [session];
      }
      return undefined;
    });
    const repository = createFocusRepository(client);

    await expect(
      repository.list({ from: '2026-10-20', to: '2026-10-26' }),
    ).resolves.toEqual([session]);
    await repository.remove('focus-1');

    expect(calls.map((call) => call.command)).toEqual([
      'focus_sessions_list',
      'focus_sessions_delete',
    ]);
  });
});
