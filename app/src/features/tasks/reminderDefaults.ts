/**
 * 默认提醒创建桥。
 *
 * 设置页只保存偏好；真正“写入新任务”必须在所有创建入口（新建弹层、
 * 快速创建、日历/习惯转任务）共用的 `tasks.create` 上补齐。这里复用
 * settings/runtime 的当前设置，不新建第二套设置读取。
 *
 * 不覆盖已有提醒：只有调用方没有传 `reminder` 时才注入。修改默认值后
 * 已有任务不会被回填，下一次新建才生效。
 */

import { db, type DbClient } from '../../data/db/client';
import type { NewTask } from '../../data/db/types';
import { broadcastTasksChanged } from '../notifications/runtime';
import { getRuntimeSettings } from '../settings/runtime';
import { applyDefaultReminder } from './reminders';

const installedClients = new WeakSet<object>();

export function installTaskReminderDefaultsBridge(client: DbClient = db): void {
  if (installedClients.has(client)) {
    return;
  }
  installedClients.add(client);

  const createTask = client.tasks.create.bind(client.tasks);
  client.tasks.create = async (input: NewTask) => {
    const settings = getRuntimeSettings();
    const resolved = applyDefaultReminder(
      input,
      settings.task.defaultReminder,
    );
    const task = await createTask(resolved);
    if (resolved !== input) {
      // 快速创建不会经过 TaskStore.refresh；这里主动通知调度器重算，
      // 但只广播“本次确实补了提醒”的创建，避免无意义的重排。
      broadcastTasksChanged();
    }
    return task;
  };
}
