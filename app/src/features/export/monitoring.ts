/**
 * 本机性能/错误监控（P2-04）。
 *
 * 单用户产品不接第三方 APM：错误与耗时只保存在内存环形缓冲区，用户可
 * 主动下载诊断 JSON。写入前统一脱敏（令牌、密码、邮箱、长哈希），诊断
 * 包不包含笔记正文、附件内容或任何账号信息。
 */

import { redactSecrets } from './sanitize';

export const MONITORING_EVENT = 'zhixing:monitoring';
const MAX_EVENTS = 80;
const SLOW_EXPORT_MS = 2000;
const SLOW_RESTORE_MS = 3000;

export type MonitorEventKind = 'error' | 'timing' | 'longtask' | 'info';

export type MonitorEvent = {
  id: number;
  at: string;
  kind: MonitorEventKind;
  name: string;
  durationMs?: number;
  message?: string;
  context?: Record<string, string | number | boolean | null>;
  slow?: boolean;
};

type Listener = (event: MonitorEvent) => void;

class Monitor {
  private events: MonitorEvent[] = [];
  private sequence = 0;
  private listeners = new Set<Listener>();
  private cleanup: (() => void) | null = null;
  /** 默认关闭：必须在设置中显式开启后才记录任何事件。 */
  private enabled = false;

  setEnabled(next: boolean): void {
    this.enabled = next;
    if (!next) {
      this.reset();
    }
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(
          new CustomEvent('zhixing:monitoring-enabled', { detail: next }),
        );
      } catch {
        // ignore
      }
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  record(
    kind: MonitorEventKind,
    name: string,
    details: {
      durationMs?: number;
      message?: string;
      context?: MonitorEvent['context'];
      slow?: boolean;
    } = {},
  ): MonitorEvent {
    if (!this.enabled) {
      // 关闭时不保存、不广播；仍返回一个只读事件对象，调用方无需改控制流。
      return {
        id: 0,
        at: new Date().toISOString(),
        kind,
        name: 'diagnostics-disabled',
      };
    }
    this.sequence += 1;
    const event: MonitorEvent = {
      id: this.sequence,
      at: new Date().toISOString(),
      kind,
      name: redactSecrets(name).slice(0, 160),
      durationMs: details.durationMs,
      message: details.message
        ? redactSecrets(details.message).slice(0, 800)
        : undefined,
      context: details.context,
      slow: details.slow,
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 监听器异常不得影响主流程。
      }
    }
    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(
          new CustomEvent(MONITORING_EVENT, { detail: event }),
        );
      } catch {
        // ignore
      }
    }
    return event;
  }

  error(name: string, error: unknown, context?: MonitorEvent['context']): MonitorEvent {
    const message =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : typeof error === 'string'
          ? error
          : '未知错误';
    return this.record('error', name, { message, context });
  }

  timing(
    name: string,
    durationMs: number,
    context?: MonitorEvent['context'],
  ): MonitorEvent {
    const slow = durationMs >= (name.includes('restore') ? SLOW_RESTORE_MS : SLOW_EXPORT_MS);
    return this.record('timing', name, {
      durationMs: Math.round(durationMs * 100) / 100,
      context,
      slow,
    });
  }

  async measure<T>(
    name: string,
    task: () => Promise<T>,
    context?: MonitorEvent['context'],
  ): Promise<T> {
    const started = nowMs();
    try {
      const result = await task();
      this.timing(name, nowMs() - started, { ...context, ok: true });
      return result;
    } catch (error) {
      const duration = nowMs() - started;
      this.error(name, error, { ...context, durationMs: Math.round(duration) });
      throw error;
    }
  }

  /**
   * 匿名本机摘要：只含 OS 族、事件名称/类型/耗时与脱敏后的错误摘要；
   * 不含用户代理全文、文件路径、笔记/任务正文或任何账号信息，也不上传。
   */
  snapshot(): {
    schemaVersion: number;
    enabled: boolean;
    generatedAt: string;
    platform: string;
    eventCount: number;
    slowCount: number;
    errorCount: number;
    slowestMs: number;
    events: MonitorEvent[];
    slowEvents: MonitorEvent[];
    errors: MonitorEvent[];
  } {
    const events = this.events.map((event) => ({
      ...event,
      name: anonymizeDiagnosticText(event.name),
      message: event.message
        ? anonymizeDiagnosticText(event.message)
        : undefined,
      context: event.context
        ? Object.fromEntries(
            Object.entries(event.context).map(([key, value]) => [
              key,
              typeof value === 'string'
                ? anonymizeDiagnosticText(value)
                : value,
            ]),
          )
        : undefined,
    }));
    const durations = events
      .map((event) => event.durationMs ?? 0)
      .filter((value) => Number.isFinite(value));
    return {
      schemaVersion: 1,
      enabled: this.enabled,
      generatedAt: new Date().toISOString(),
      platform: detectPlatformFamily(),
      eventCount: events.length,
      slowCount: events.filter((event) => event.slow).length,
      errorCount: events.filter((event) => event.kind === 'error').length,
      slowestMs: durations.length > 0 ? Math.max(...durations) : 0,
      events,
      slowEvents: events.filter((event) => event.slow),
      errors: events.filter((event) => event.kind === 'error'),
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  install(): () => void {
    if (this.cleanup) return this.cleanup;
    if (typeof window === 'undefined') {
      this.cleanup = () => {};
      return this.cleanup;
    }

    const onError = (event: ErrorEvent) => {
      this.error('window.error', event.error ?? event.message, {
        source: redactSecrets(`${event.filename}:${event.lineno}`),
      });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      this.error('window.unhandledrejection', event.reason);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        this.record('info', 'document.hidden');
      }
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    document.addEventListener('visibilitychange', onVisibility);

    let observer: PerformanceObserver | null = null;
    const PerformanceObserverCtor =
      typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : null;
    if (PerformanceObserverCtor) {
      try {
        observer = new PerformanceObserverCtor((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration >= 50) {
              this.record('longtask', 'longtask', {
                durationMs: Math.round(entry.duration),
                slow: true,
              });
            }
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch {
        observer = null;
      }
    }

    this.cleanup = () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      document.removeEventListener('visibilitychange', onVisibility);
      observer?.disconnect();
      observer = null;
      this.cleanup = null;
    };
    return this.cleanup;
  }

  reset(): void {
    this.events = [];
    this.sequence = 0;
  }
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export const monitor = new Monitor();

export function installMonitoring(): () => void {
  return monitor.install();
}

function detectPlatformFamily(): string {
  if (typeof navigator === 'undefined') {
    return 'unknown';
  }
  const source = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase();
  if (source.includes('mac')) return 'macos';
  if (source.includes('win')) return 'windows';
  if (source.includes('linux')) return 'linux';
  if (source.includes('android')) return 'android';
  if (source.includes('iphone') || source.includes('ipad') || source.includes('ios')) {
    return 'ios';
  }
  return 'web';
}

/** 去掉常见绝对路径与 URL 中的用户目录，避免诊断包泄露本机目录结构。 */
export function anonymizeDiagnosticText(value: string): string {
  return redactSecrets(value)
    .replace(/\/(?:Users|home)\/[^\s"'<>]+/g, '[本机路径已隐藏]')
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, '[本机路径已隐藏]')
    .replace(/file:\/\/[^\s"'<>]+/g, '[本机文件 URL 已隐藏]')
    .slice(0, 800);
}

export function runDiagnosticsDownload(): string {
  return JSON.stringify(monitor.snapshot(), null, 2);
}
