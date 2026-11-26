import { invoke } from '@tauri-apps/api/core';
import { info as logInfo } from '@tauri-apps/plugin-log';
import { useEffect, useState } from 'react';

type DbStatus = {
  path: string;
  ready: boolean;
  schemaVersion: number;
  journalMode: string;
  foreignKeys: boolean;
  applied: string[];
  error: string | null;
};

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * P0-01 桌面壳的本地库探针。P0-03 接入正式仓储后，这里只保留轻量状态展示。
 */
export function DatabaseCard() {
  const runtime = isTauriRuntime();
  const [status, setStatus] = useState<DbStatus | null>(null);
  const [loading, setLoading] = useState(runtime);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runtime) {
      return;
    }

    let cancelled = false;

    invoke<DbStatus>('db_status')
      .then((nextStatus) => {
        if (cancelled) {
          return;
        }
        setStatus(nextStatus);
        if (nextStatus.error) {
          setError(nextStatus.error);
        }
        void logInfo(
          `[zhixing] desktop shell ready: schemaVersion=${nextStatus.schemaVersion} journalMode=${nextStatus.journalMode}`,
        ).catch(() => {});
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [runtime]);

  if (!runtime) {
    return (
      <section className="db-card" aria-label="本地库状态">
        <div className="db-heading">
          <span className="status-dot is-idle" aria-hidden="true" />
          <span>浏览器预览</span>
        </div>
        <p className="db-detail">SQLite 只在 Tauri 桌面壳内初始化。</p>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="db-card" aria-label="本地库状态" aria-live="polite">
        <div className="db-heading">
          <span className="status-dot is-loading" aria-hidden="true" />
          <span>正在检查本地库</span>
        </div>
      </section>
    );
  }

  if (error || status?.error) {
    return (
      <section className="db-card is-error" aria-label="本地库状态">
        <div className="db-heading">
          <span className="status-dot is-error" aria-hidden="true" />
          <span>本地库未就绪</span>
        </div>
        <p className="db-detail">{error ?? status?.error}</p>
      </section>
    );
  }

  if (!status) {
    return (
      <section className="db-card" aria-label="本地库状态">
        <div className="db-heading">
          <span className="status-dot is-idle" aria-hidden="true" />
          <span>本地库状态未知</span>
        </div>
      </section>
    );
  }

  return (
    <section className="db-card" aria-label="本地库状态">
      <div className="db-heading">
        <span className="status-dot is-ready" aria-hidden="true" />
        <span>本地库已就绪</span>
      </div>
      <p className="db-detail">
        v{status.schemaVersion} · {status.journalMode.toUpperCase()} ·{' '}
        {status.foreignKeys ? 'FK ON' : 'FK OFF'} · {status.applied.length} 个迁移
      </p>
      <p className="db-path" title={status.path}>
        {status.path}
      </p>
    </section>
  );
}
