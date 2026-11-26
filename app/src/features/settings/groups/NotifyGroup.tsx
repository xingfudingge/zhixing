/**
 * 提醒与通知设置分组。
 *
 * 直接挂载 `features/notifications` 的通知中心：通道开关、免打扰、每日摘要、
 * 系统权限状态、测试通知与计划/发送记录都在这里，读写同一份设备偏好。
 * 权限状态永远来自系统实时值，不落盘、不显示“已授权”。
 */

import { useMemo } from 'react';

import { NotificationCenter } from '../../notifications/NotificationCenter';
import { getDefaultNotificationScheduler } from '../../notifications/runtime';
import type { NotificationScheduler } from '../../notifications/scheduler';
import '../../notifications/notifications.css';
import { SettingsCard } from './Controls';

export type NotifyGroupProps = {
  /** 测试注入；不传时使用应用级单例调度器（与 Shell 的通知运行时共享）。 */
  scheduler?: NotificationScheduler;
};

export function NotifyGroup({ scheduler }: NotifyGroupProps = {}) {
  const active = useMemo(
    () => scheduler ?? getDefaultNotificationScheduler(),
    [scheduler],
  );

  return (
    <SettingsCard
      title="提醒与通知"
      description="应用内提醒默认开启并由本机调度；浏览器/系统通知受权限与系统策略影响，不承诺必达。权限状态始终以系统实时值为准，只在点击开启时请求。"
    >
      <NotificationCenter scheduler={active} embedded showHeader={false} />
    </SettingsCard>
  );
}
