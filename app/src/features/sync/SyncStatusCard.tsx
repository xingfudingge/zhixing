/**
 * 同步队列与错误面板。
 *
 * 数字和错误全部来自 SyncStore / 游标存储；local 模式只展示本机队列，
 * 不触发网络。按钮在 local 下仍可点击，但 runtime 会立即短路并说明原因。
 */

import { useId } from 'react';

import type { SyncMode, SyncStatus } from './types.ts';

export type SyncStatusMessage = {
  kind: 'success' | 'error' | 'info';
  text: string;
};

export type SyncStatusCardProps = {
  mode: SyncMode;
  status: SyncStatus | null;
  loading: boolean;
  syncing: boolean;
  message: SyncStatusMessage | null;
  onSyncNow: () => void;
  onRefresh: () => void;
};

const MODE_LABEL: Record<SyncMode, string> = {
  local: '仅本机',
  webdav: 'WebDAV',
  backend: '后台直连',
};

function formatTime(value: string | null): string {
  if (!value) return '尚未同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function retryLabel(at: number | null): string {
  if (at === null) return '可立即重试';
  const remaining = at - Date.now();
  if (remaining <= 0) return '可立即重试';
  if (remaining < 60_000) return `${Math.ceil(remaining / 1000)} 秒后重试`;
  return `${Math.ceil(remaining / 60_000)} 分钟后重试`;
}

export function SyncStatusCard({
  mode,
  status,
  loading,
  syncing,
  message,
  onSyncNow,
  onRefresh,
}: SyncStatusCardProps) {
  const titleId = useId();
  const pending = status?.pendingUploads ?? 0;
  const conflicts = status?.pendingConflicts ?? 0;
  const issues = status?.issues ?? [];

  return (
    <section className="sync-status" aria-labelledby={titleId}>
      <header className="sync-status-head">
        <div>
          <h3 id={titleId}>同步队列</h3>
          <p>待上传、冲突与错误均来自本机同步存储，不读取远端账号信息。</p>
        </div>
        <span className="sync-status-mode">{MODE_LABEL[mode]}</span>
      </header>

      <dl className="sync-status-grid">
        <div>
          <dt>待上传</dt>
          <dd>{loading ? '…' : `${pending} 条`}</dd>
        </div>
        <div>
          <dt>待处理冲突</dt>
          <dd>{loading ? '…' : `${conflicts} 条`}</dd>
        </div>
        <div>
          <dt>上次同步</dt>
          <dd>{loading ? '…' : formatTime(status?.lastSyncAt ?? null)}</dd>
        </div>
      </dl>

      {mode === 'local' ? (
        <p className="settings-hint" role="note">
          仅本机模式不会发起任何同步网络请求；点击“立即同步”也只会提示本机状态。
        </p>
      ) : null}

      {mode === 'webdav' && status && !status.webdavConfigured ? (
        <p className="settings-hint" role="note">
          WebDAV 尚未保存连接信息，立即同步会提示先配置地址。
        </p>
      ) : null}

      {mode === 'backend' && status && !status.backendProfile ? (
        <p className="settings-hint" role="note">
          后台尚未配对，立即同步不会发出请求。
        </p>
      ) : null}

      {status?.lastError ? (
        <div className="settings-error" role="alert">
          <b>上次同步错误</b>
          <span>{status.lastError}</span>
        </div>
      ) : null}

      {issues.length > 0 ? (
        <ul className="sync-issue-list" aria-label="同步错误列表">
          {issues.map((issue) => (
            <li key={issue.id}>
              <div>
                <b>{issue.entityType ?? '同步操作'}</b>
                <span>{issue.message}</span>
              </div>
              <small>
                第 {issue.attempts} 次 · {retryLabel(issue.nextAttemptAt)}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sync-issue-empty" role="status">
          {loading ? '正在读取同步状态…' : '没有待处理的同步错误。'}
        </p>
      )}

      <div className="settings-sync-actions">
        <button
          type="button"
          className="settings-sync-button is-primary"
          onClick={onSyncNow}
          disabled={syncing}
        >
          {syncing ? '同步中…' : '立即同步'}
        </button>
        <button
          type="button"
          className="settings-sync-button"
          onClick={onRefresh}
          disabled={loading || syncing}
        >
          刷新状态
        </button>
      </div>

      {message ? (
        <div
          className={
            message.kind === 'error'
              ? 'settings-error'
              : 'settings-banner'
          }
          role={message.kind === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </div>
      ) : null}
    </section>
  );
}
