/**
 * ICS 只读订阅面板。
 *
 * 永远显示“只读”标签，只提供添加/同步/删除订阅，不提供把本地修改写回
 * ICS 的按钮。最后成功同步时间、最后尝试时间与错误都直接来自订阅记录。
 *
 * 传输差异（ZX12-AUDIT-01 R1/R2/R4）：
 * - 桌面壳走 Rust 受限 HTTP 代理，可安全使用 If-None-Match/304；
 * - 浏览器预览跨域时不发条件头，改用 200 + 原文对比；
 * - 错误文案由服务层给出，这里不做空 catch。
 */

import { useCallback, useEffect, useState } from 'react';

import type { IcsSyncResult, IcsSyncService } from './sync';
import { redactIcsUrl, type IcsSubscription } from './types';

export type IcsSubscriptionsPanelProps = {
  service: IcsSyncService;
  onNotice?: (message: string) => void;
};

function formatTime(iso: string | null): string {
  if (!iso) return '尚未同步';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function messageOf(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

function warningSuffix(result: IcsSyncResult): string {
  const warnings = result.warnings ?? [];
  if (warnings.length === 0) return '';
  const preview = warnings.slice(0, 3).join('；');
  const more = warnings.length > 3 ? `；等 ${warnings.length} 条` : '';
  return ` 解析警告：${preview}${more}`;
}

function resultNotice(result: IcsSyncResult): string {
  const warnings = warningSuffix(result);
  if (result.notModified) {
    const reason =
      result.notModifiedReason === 'http-304'
        ? '服务端 304'
        : '内容与上次一致';
    return `订阅未变化（${reason}），沿用最近一次缓存。${warnings}`;
  }
  return `同步完成：${result.eventCount} 个事件实例，只读导入。${warnings}`;
}

export function IcsSubscriptionsPanel({
  service,
  onNotice,
}: IcsSubscriptionsPanelProps) {
  const [subscriptions, setSubscriptions] = useState<IcsSubscription[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const tell = useCallback(
    (message: string) => {
      setNotice(message);
      onNotice?.(message);
    },
    [onNotice],
  );

  const refresh = useCallback(async () => {
    try {
      setSubscriptions(await service.listSubscriptions());
    } catch (reason) {
      setError(messageOf(reason, '读取 ICS 订阅失败（IndexedDB 不可用）'));
    }
  }, [service]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setBusy = (id: string, busy: boolean) => {
    setBusyIds((current) =>
      busy ? Array.from(new Set([...current, id])) : current.filter((x) => x !== id),
    );
  };

  const handleAdd = useCallback(async () => {
    setAdding(true);
    setError(null);
    setNotice(null);
    setPendingRemove(null);
    try {
      const subscription = await service.addSubscription({ name, url });
      setName('');
      setUrl('');
      await refresh();
      tell('订阅已添加，正在拉取 ICS…');
      setBusy(subscription.id, true);
      try {
        const result = await service.sync(subscription.id);
        tell(resultNotice(result));
      } catch (reason) {
        setNotice(null);
        setError(messageOf(reason, '首次同步失败'));
      } finally {
        setBusy(subscription.id, false);
      }
      await refresh();
    } catch (reason) {
      setError(messageOf(reason, '添加订阅失败'));
    } finally {
      setAdding(false);
    }
  }, [name, refresh, service, tell, url]);

  const handleSync = useCallback(
    async (subscription: IcsSubscription) => {
      setBusy(subscription.id, true);
      setError(null);
      setNotice(null);
      setPendingRemove(null);
      try {
        const result = await service.sync(subscription.id);
        tell(resultNotice(result));
      } catch (reason) {
        setNotice(null);
        setError(messageOf(reason, '同步失败'));
      } finally {
        await refresh();
        setBusy(subscription.id, false);
      }
    },
    [refresh, service, tell],
  );

  const handleSyncAll = useCallback(async () => {
    setSyncingAll(true);
    setError(null);
    setNotice(null);
    setPendingRemove(null);
    try {
      const report = await service.syncAll();
      await refresh();
      if (report.failures.length === 0) {
        tell(`全部同步完成：${report.results.length} 个订阅成功。`);
      } else {
        const detail = report.failures
          .map((failure) => `${failure.name}：${failure.message}`)
          .join('；');
        setError(
          `全部同步：${report.results.length} 个成功，${report.failures.length} 个失败。${detail}`,
        );
      }
    } catch (reason) {
      setError(messageOf(reason, '全部同步失败'));
    } finally {
      setSyncingAll(false);
    }
  }, [refresh, service, tell]);

  const handleRemove = useCallback(
    async (subscription: IcsSubscription) => {
      setBusy(subscription.id, true);
      setError(null);
      setNotice(null);
      try {
        await service.removeSubscription(subscription.id);
        setPendingRemove(null);
        tell('订阅已取消；只删除了订阅和缓存，已导入的本地事件与任务保留。');
        await refresh();
      } catch (reason) {
        setNotice(null);
        setError(messageOf(reason, '取消订阅失败'));
      } finally {
        setBusy(subscription.id, false);
      }
    },
    [refresh, service, tell],
  );

  return (
    <section className="zx-ics" aria-label="外部日历订阅">
      <header className="zx-ics-head">
        <div>
          <h2>外部日历 · ICS 订阅</h2>
          <p>
            只读拉取，不写回服务商；不会把外部事件自动变成任务。断网或同步失败时显示最近一次成功缓存。
          </p>
        </div>
        <div className="zx-ics-head-actions">
          {subscriptions.length > 0 ? (
            <button
              type="button"
              className="zx-ics-button"
              disabled={syncingAll || busyIds.length > 0}
              onClick={() => void handleSyncAll()}
            >
              {syncingAll ? '全部同步中…' : '全部同步'}
            </button>
          ) : null}
          <span className="zx-ics-badge">只读</span>
        </div>
      </header>

      {service.transportKind === 'browser' ? (
        <p className="zx-ics-hint" role="note">
          浏览器预览：同源 ICS 可用条件请求；跨域订阅受 CORS 限制，可能被拦或无法使用 304。
          正式同步请在桌面壳内进行（走内置网络代理，不受 CORS 限制）。
        </p>
      ) : null}

      <form
        className="zx-ics-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void handleAdd();
        }}
      >
        <label>
          <span>名称（可选）</span>
          <input
            type="text"
            value={name}
            placeholder="例如：团队日历"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="is-wide">
          <span>ICS URL</span>
          <input
            type="url"
            required
            value={url}
            placeholder="https://example.com/calendar.ics"
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="zx-ics-button is-primary"
          disabled={adding || !url.trim()}
        >
          {adding ? '添加中…' : '添加订阅'}
        </button>
      </form>

      {error ? (
        <p className="zx-ics-error" role="alert">
          {error}
        </p>
      ) : null}

      {notice ? (
        <p className="zx-ics-notice" role="status">
          {notice}
        </p>
      ) : null}

      {subscriptions.length === 0 ? (
        <p className="zx-ics-empty">
          还没有 ICS 订阅。添加后只读导入事件；不会出现“可写”状态。
        </p>
      ) : (
        <ul className="zx-ics-list">
          {subscriptions.map((subscription) => {
            const busy = busyIds.includes(subscription.id);
            return (
              <li key={subscription.id} data-subscription-id={subscription.id}>
                <div className="zx-ics-main">
                  <div className="zx-ics-title">
                    <b>{subscription.name}</b>
                    <span className="zx-ics-badge is-small">只读</span>
                  </div>
                  <small className="zx-ics-url">
                    {redactIcsUrl(subscription.url)}
                  </small>
                  <div className="zx-ics-stats">
                    <span>
                      最后同步：<b>{formatTime(subscription.lastSyncAt)}</b>
                    </span>
                    <span>
                      最后尝试：<b>{formatTime(subscription.lastAttemptAt)}</b>
                    </span>
                    <span>
                      事件实例：<b>{subscription.eventCount}</b>
                    </span>
                    {subscription.lastError && subscription.lastSyncAt ? (
                      <span className="zx-ics-cache-note">沿用最近一次成功缓存</span>
                    ) : null}
                  </div>
                  {subscription.lastError ? (
                    <p className="zx-ics-error" role="alert">
                      {subscription.lastError}
                    </p>
                  ) : null}
                  {subscription.lastWarning ? (
                    <p className="zx-ics-warning" role="status">
                      解析警告：{subscription.lastWarning}
                    </p>
                  ) : null}
                </div>
                <div className="zx-ics-actions">
                  {pendingRemove === subscription.id ? (
                    <>
                      <span className="zx-ics-confirm-text" role="note">
                        只删除订阅和缓存，已导入的事件与任务保留。
                      </span>
                      <button
                        type="button"
                        className="zx-ics-button is-danger"
                        aria-label={`确认删除订阅 ${subscription.name}`}
                        disabled={busy}
                        onClick={() => void handleRemove(subscription)}
                      >
                        确认删除
                      </button>
                      <button
                        type="button"
                        className="zx-ics-button"
                        aria-label={`取消删除订阅 ${subscription.name}`}
                        disabled={busy}
                        onClick={() => setPendingRemove(null)}
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="zx-ics-button"
                        aria-label={`立即同步订阅 ${subscription.name}`}
                        disabled={busy || syncingAll}
                        onClick={() => void handleSync(subscription)}
                      >
                        {busy ? '同步中…' : '立即同步'}
                      </button>
                      <button
                        type="button"
                        className="zx-ics-button is-danger"
                        aria-label={`删除订阅 ${subscription.name}`}
                        disabled={busy || syncingAll}
                        onClick={() => {
                          setPendingRemove(subscription.id);
                          setError(null);
                          setNotice(null);
                        }}
                      >
                        删除订阅
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="zx-ics-foot">
        ICS 不提供可靠的双向写能力，知行将订阅标记为只读。取消订阅不会删除知行任务或已导入的本地事件。
      </p>
    </section>
  );
}
