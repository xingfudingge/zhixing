/**
 * 提醒与通知设置/状态面板。
 *
 * 权限说明、免打扰、通道开关、计划与发送记录都在这里可见。UI 不展示
 * “已送达”这类无法保证的承诺，只展示“已发送到浏览器/应用内”或失败原因。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { formatPlanTime } from './planner';
import type { NotificationScheduler } from './scheduler';
import {
  channelLabel,
  explainPermission,
  planStatusLabel,
  type DeliveryRecord,
  type NotificationPermissionState,
  type NotificationSettings,
  type NotificationTask,
  type ReminderPlan,
} from './types';

export type NotificationCenterProps = {
  scheduler: NotificationScheduler;
  tasks?: ReadonlyArray<NotificationTask>;
  now?: () => Date;
  onNotice?: (message: string) => void;
  /** 嵌入设置卡片时不重复标题与外层卡片样式。 */
  embedded?: boolean;
  /** 默认 true；嵌入时由设置卡片提供标题。 */
  showHeader?: boolean;
};

function tone(status: string): string {
  if (status === 'sent') return 'ok';
  if (status === 'failed' || status === 'blocked') return 'danger';
  if (status === 'suppressed' || status === 'unsupported') return 'warn';
  if (status === 'canceled') return 'neutral';
  return 'active';
}

export function NotificationCenter({
  scheduler,
  tasks,
  now = () => new Date(),
  onNotice,
  embedded = false,
  showHeader = true,
}: NotificationCenterProps) {
  const [settings, setSettings] = useState<NotificationSettings>(() =>
    scheduler.settings(),
  );
  const [permission, setPermission] = useState<NotificationPermissionState>(
    () => scheduler.browserPermission(),
  );
  const [systemAvailable, setSystemAvailable] = useState(false);
  const [plans, setPlans] = useState<ReminderPlan[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRecord[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const taskSignature = tasks
    ? tasks
        .map(
          (task) =>
            `${task.id}:${task.status}:${task.dueAt ?? ''}:${task.dueDate ?? ''}:${task.dueTime ?? ''}:${task.reminder}:${task.deletedAt ?? ''}`,
        )
        .join('|')
    : '';

  const notify = useCallback(
    (message: string) => {
      setNotice(message);
      onNotice?.(message);
    },
    [onNotice],
  );

  const refresh = useCallback(async () => {
    setPlans(await scheduler.getPlans());
    setDeliveries(await scheduler.getDeliveries());
  }, [scheduler]);

  const reconcile = useCallback(async () => {
    const currentTasks = tasksRef.current;
    if (!currentTasks) {
      await refresh();
      return;
    }
    try {
      await scheduler.reconcile(currentTasks);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '刷新提醒计划失败');
    }
  }, [refresh, scheduler]);

  useEffect(() => {
    setSystemAvailable(false);
    void scheduler.systemAvailable().then(setSystemAvailable);
    void reconcile();
  }, [reconcile, scheduler, taskSignature]);

  // 权限永远以系统实时值为准：切回窗口时重新读取，不把旧状态写死。
  useEffect(() => {
    const refreshPermission = () => setPermission(scheduler.browserPermission());
    window.addEventListener('focus', refreshPermission);
    document.addEventListener('visibilitychange', refreshPermission);
    return () => {
      window.removeEventListener('focus', refreshPermission);
      document.removeEventListener('visibilitychange', refreshPermission);
    };
  }, [scheduler]);

  const update = useCallback(
    async (patch: Partial<NotificationSettings>) => {
      const next = scheduler.updateSettings(patch);
      setSettings(next);
      await reconcile();
    },
    [reconcile, scheduler],
  );

  const enableBrowser = useCallback(
    async (enabled: boolean) => {
      setError(null);
      if (!enabled) {
        await update({ browser: false });
        return;
      }
      const next = await scheduler.requestBrowserPermission();
      setPermission(next);
      if (next === 'granted') {
        await update({ browser: true });
        notify('浏览器通知已开启；系统仍可能延迟或丢弃，不承诺必达。');
      } else {
        await update({ browser: false });
        notify(explainPermission(next).detail);
      }
    },
    [notify, update],
  );

  const checkNow = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      await scheduler.checkNow(now());
      await refresh();
      notify('已检查到点提醒；结果与原因见下方记录。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '检查提醒失败');
    } finally {
      setChecking(false);
    }
  }, [notify, now, refresh, scheduler]);

  const sendTest = useCallback(async () => {
    setTesting(true);
    setError(null);
    try {
      const result = await scheduler.testNotification();
      setPermission(scheduler.browserPermission());
      const summary = result.outcomes
        .map(
          (outcome) =>
            `${channelLabel(outcome.channel)}：${planStatusLabel(
              outcome.status,
            )}（${outcome.explanation}）`,
        )
        .join('；');
      if (result.ok) {
        notify(`测试通知已触发。${summary}`);
      } else {
        setError(`测试通知未触发。${summary}`);
      }
    } catch (reason) {
      setError(
        `测试通知发送失败：${
          reason instanceof Error ? reason.message : '未知错误'
        }`,
      );
    } finally {
      setTesting(false);
    }
  }, [notify, scheduler]);

  const permissionInfo = explainPermission(permission, {
    isTauri:
      typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
  });
  const scheduled = plans.filter((plan) => plan.status === 'scheduled');
  const history = plans.filter((plan) => plan.status !== 'scheduled');
  const quiet = settings.quietHours;

  const actions = (
    <div className="zx-notify-actions">
      <button
        type="button"
        className="zx-notify-button"
        onClick={() => void sendTest()}
        disabled={testing}
      >
        {testing ? '发送中…' : '发送测试通知'}
      </button>
      <button
        type="button"
        className="zx-notify-button is-primary"
        onClick={() => void checkNow()}
        disabled={checking}
      >
        {checking ? '检查中…' : '立即检查到点提醒'}
      </button>
    </div>
  );

  return (
    <section
      className={
        embedded ? 'zx-notify zx-notify--embedded' : 'zx-notify'
      }
      aria-label="提醒与通知"
    >
      {showHeader ? (
        <header className="zx-notify-head">
          <div>
            <h2>提醒与通知</h2>
            <p>
              应用内提醒由本机调度；浏览器/系统通知受权限与系统策略影响，
              不承诺必达。所有计划都有去重键，改期会撤销旧提醒。
            </p>
          </div>
          {actions}
        </header>
      ) : (
        actions
      )}

      <div className="zx-notify-permission" role="status">
        <div>
          <b>浏览器权限：{permissionInfo.label}</b>
          <p>{permissionInfo.detail}</p>
        </div>
        {permission === 'default' ? (
          <button
            type="button"
            className="zx-notify-button"
            onClick={() => void enableBrowser(true)}
          >
            开启浏览器通知
          </button>
        ) : (
          <button
            type="button"
            className="zx-notify-button"
            onClick={() => setPermission(scheduler.browserPermission())}
          >
            刷新权限状态
          </button>
        )}
      </div>

      <div className="zx-notify-channels">
        <label className="zx-notify-toggle">
          <input
            type="checkbox"
            checked={settings.inApp}
            onChange={(event) => void update({ inApp: event.target.checked })}
          />
          <span>
            <b>应用内提醒</b>
            <small>本机弹窗/事件；不需要系统权限</small>
          </span>
        </label>
        <label className="zx-notify-toggle">
          <input
            type="checkbox"
            checked={settings.browser}
            onChange={(event) => void enableBrowser(event.target.checked)}
          />
          <span>
            <b>浏览器通知</b>
            <small>
              当前权限：{permissionInfo.label}；只在点击开启时请求
            </small>
          </span>
        </label>
        <label className="zx-notify-toggle">
          <input
            type="checkbox"
            checked={settings.system}
            disabled={!systemAvailable}
            onChange={(event) =>
              void update({ system: event.target.checked })
            }
          />
          <span>
            <b>系统通知</b>
            <small>
              {systemAvailable
                ? '已接入系统适配器；仍不承诺必达'
                : '当前壳层未接入原生通知插件，系统通道不可用；应用内提醒仍会工作'}
            </small>
          </span>
        </label>
      </div>

      <div className="zx-notify-options">
        <label className="zx-notify-toggle is-small">
          <input
            type="checkbox"
            checked={settings.sound}
            onChange={(event) => void update({ sound: event.target.checked })}
          />
          <span>
            <b>通知声音</b>
            <small>仅浏览器/系统适配器支持时生效</small>
          </span>
        </label>
        <label className="zx-notify-toggle is-small">
          <input
            type="checkbox"
            checked={settings.lockScreenPrivacy}
            onChange={(event) =>
              void update({ lockScreenPrivacy: event.target.checked })
            }
          />
          <span>
            <b>锁屏隐私</b>
            <small>系统通知只显示“待办提醒”，不显示标题</small>
          </span>
        </label>
      </div>

      <fieldset className="zx-notify-fieldset">
        <legend>免打扰时段</legend>
        <label className="zx-notify-toggle is-small">
          <input
            type="checkbox"
            checked={quiet.enabled}
            onChange={(event) =>
              void update({
                quietHours: { ...quiet, enabled: event.target.checked },
              })
            }
          />
          <span>
            <b>启用免打扰</b>
            <small>时段内不发送，改为结束后延迟提醒；跨午夜同样生效</small>
          </span>
        </label>
        <div className="zx-notify-times">
          <label>
            开始
            <input
              type="time"
              value={quiet.start}
              disabled={!quiet.enabled}
              onChange={(event) =>
                void update({
                  quietHours: { ...quiet, start: event.target.value },
                })
              }
            />
          </label>
          <label>
            结束
            <input
              type="time"
              value={quiet.end}
              disabled={!quiet.enabled}
              onChange={(event) =>
                void update({
                  quietHours: { ...quiet, end: event.target.value },
                })
              }
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="zx-notify-fieldset">
        <legend>每日摘要</legend>
        <label className="zx-notify-toggle is-small">
          <input
            type="checkbox"
            checked={settings.dailyDigest.enabled}
            onChange={(event) =>
              void update({
                dailyDigest: {
                  ...settings.dailyDigest,
                  enabled: event.target.checked,
                },
              })
            }
          />
          <span>
            <b>每天汇总今天与逾期任务</b>
            <small>摘要同样遵守免打扰与通道开关</small>
          </span>
        </label>
        <label className="zx-notify-time">
          时间
          <input
            type="time"
            value={settings.dailyDigest.time}
            disabled={!settings.dailyDigest.enabled}
            onChange={(event) =>
              void update({
                dailyDigest: {
                  ...settings.dailyDigest,
                  time: event.target.value,
                },
              })
            }
          />
        </label>
      </fieldset>

      {notice ? (
        <p className="zx-notify-notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="zx-notify-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="zx-notify-plans">
        <header>
          <b>待触发提醒</b>
          <span>{scheduled.length} 条</span>
        </header>
        {scheduled.length === 0 ? (
          <p className="zx-notify-empty">
            暂无待触发提醒。任务需要设置日期与提醒值，且提醒通道开启。
          </p>
        ) : (
          <ul>
            {scheduled.map((plan) => (
              <li key={plan.dedupeKey} data-status={plan.status}>
                <div>
                  <b>{plan.title}</b>
                  <small>
                    {channelLabel(plan.channel)} · {formatPlanTime(plan.triggerAt)} ·{' '}
                    {plan.timezone}
                  </small>
                  <span>{plan.body}</span>
                </div>
                <em className={`is-${tone(plan.status)}`}>
                  {planStatusLabel(plan.status)}
                </em>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="zx-notify-history">
        <header>
          <b>发送与抑制记录</b>
          <span>{deliveries.length} 条</span>
        </header>
        {deliveries.length === 0 && history.length === 0 ? (
          <p className="zx-notify-empty">还没有发送或抑制记录。</p>
        ) : (
          <ul>
            {deliveries
              .slice()
              .reverse()
              .map((record) => (
                <li key={record.id} data-status={record.status}>
                  <div>
                    <b>{record.title}</b>
                    <small>
                      {channelLabel(record.channel)} · {formatPlanTime(record.at)} ·{' '}
                      {planStatusLabel(record.status)}
                    </small>
                    {record.explanation ? <span>{record.explanation}</span> : null}
                  </div>
                  <em className={`is-${tone(record.status)}`}>
                    {planStatusLabel(record.status)}
                  </em>
                </li>
              ))}
            {history
              .filter((plan) => plan.status === 'canceled')
              .map((plan) => (
                <li key={`history_${plan.dedupeKey}`} data-status="canceled">
                  <div>
                    <b>{plan.title}</b>
                    <small>
                      {channelLabel(plan.channel)} · 原定{' '}
                      {formatPlanTime(plan.triggerAt)}
                    </small>
                    <span>{plan.explanation ?? '计划已撤销'}</span>
                  </div>
                  <em className="is-neutral">已撤销</em>
                </li>
              ))}
          </ul>
        )}
      </div>
    </section>
  );
}
