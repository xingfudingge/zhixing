/**
 * 专注域运行时：把计时引擎、任务关联、SQLite 写入、统计与白噪音串起来。
 *
 * 运行时是外部 store（`useSyncExternalStore`），不是 React 组件状态：
 * 切到其他页面时组件卸载，计时与自动记录仍继续；只有关闭应用才会丢失
 * 当前这段内存计时。计时状态绝不写 localStorage。
 */

import { db, isTauriRuntime, type DbClient } from '../../data/db/client';
import type { FocusSession, Task } from '../../data/db/types';
import {
  createFocusRepository,
  EMPTY_DURATION_MESSAGE,
  INVALID_MINUTES_MESSAGE,
  isValidFocusMinutes,
  NO_TASK_MESSAGE,
  type FocusMode,
  type FocusRepository,
  type FocusSessionMode,
  type RecordFocusInput,
} from '../../data/repositories/focus';
import {
  createTaskRepository,
  type TaskRepository,
} from '../../data/repositories/tasks';
import {
  noiseController,
  type NoiseController,
  type NoiseSnapshot,
  type NoiseType,
} from '../../audio/noise';
import {
  DEFAULT_FOCUS_CONFIG,
  FocusTimer,
  type FocusTimerConfig,
  type FocusTimerDue,
  type FocusTimerSnapshot,
} from './focusTimer';
import { localDateFromMs, localIsoFromMs } from './stats';

export type FocusSource = {
  tasks: Pick<TaskRepository, 'list'>;
  sessions: Pick<FocusRepository, 'list' | 'record'>;
};

export function createFocusSource(client: DbClient = db): FocusSource {
  return {
    tasks: createTaskRepository(client),
    sessions: createFocusRepository(client),
  };
}

export type FocusStoreStatus = 'loading' | 'ready' | 'unavailable' | 'error';

export type FocusNoticeTone = 'info' | 'success' | 'danger';

export type FocusNotice = {
  id: number;
  message: string;
  tone: FocusNoticeTone;
};

export type FocusActionResult = {
  ok: boolean;
  message?: string;
  minutes?: number;
};

export type FocusRuntimeSnapshot = {
  status: FocusStoreStatus;
  error: string | null;
  tasks: Task[];
  taskId: string | null;
  sessions: FocusSession[];
  today: string;
  timer: FocusTimerSnapshot;
  noise: NoiseSnapshot;
  notice: FocusNotice | null;
  recording: boolean;
};

export type FocusRuntimeOptions = {
  source?: FocusSource;
  available?: boolean;
  /** 固定“今天”，测试可注入稳定日期。 */
  today?: string;
  now?: () => number;
  /** 计时刷新间隔；测试可设大值，靠 `sync()` 精确推进。 */
  tickMs?: number;
  initialConfig?: Partial<FocusTimerConfig>;
  timer?: FocusTimer;
  noise?: NoiseController;
};

type RecordResult =
  | { ok: true; session: FocusSession }
  | { ok: false; message: string };

export function formatError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '操作失败，请重试';
}

function isOpenTask(task: Task | undefined): task is Task {
  return (
    task !== undefined &&
    task.deletedAt === null &&
    task.status !== 'done'
  );
}

export class FocusRuntime {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => FocusRuntimeSnapshot;

  private source: FocusSource;
  private available: boolean;
  private now: () => number;
  private todayOverride: string | null;
  private today: string;
  private timer: FocusTimer;
  private noise: NoiseController;
  private listeners = new Set<() => void>();
  private unsubscribeTimer: () => void;
  private unsubscribeNoise: () => void;
  private snapshot: FocusRuntimeSnapshot;
  private tasks: Task[] = [];
  private sessions: FocusSession[] = [];
  private taskId: string | null = null;
  private status: FocusStoreStatus;
  private error: string | null = null;
  private notice: FocusNotice | null = null;
  private noticeSeed = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private recording = false;
  private dueBusy = false;
  private loadPromise: Promise<void> | null = null;
  private disposed = false;
  private resumeHandler: (() => void) | null = null;

  constructor(options: FocusRuntimeOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.source = options.source ?? createFocusSource();
    this.available =
      options.available ?? (options.source !== undefined ? true : isTauriRuntime());
    this.todayOverride = options.today ?? null;
    this.today = options.today ?? localDateFromMs(this.now());
    this.timer =
      options.timer ??
      new FocusTimer({
        now: this.now,
        tickMs: options.tickMs,
        initialConfig: options.initialConfig ?? DEFAULT_FOCUS_CONFIG,
      });
    this.noise = options.noise ?? noiseController;
    this.status = this.available ? 'loading' : 'unavailable';
    this.snapshot = this.buildSnapshot();

    this.subscribe = (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    };
    this.getSnapshot = () => this.snapshot;

    this.unsubscribeTimer = this.timer.subscribe(() => {
      this.emit();
      this.maybeHandleDue();
    });
    this.unsubscribeNoise = this.noise.subscribe(() => this.emit());

    /*
     * 桌面窗口切到后台时 WebView 可能暂停定时器；恢复可见/聚焦时按真实
     * 时间追平并补记。监听挂在运行时而不是页面，切到其他路由也有效。
     */
    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
      this.resumeHandler = () => {
        if (document.visibilityState !== 'hidden') {
          this.sync();
        }
      };
      document.addEventListener('visibilitychange', this.resumeHandler);
      window.addEventListener('focus', this.resumeHandler);
    }
  }

  private buildSnapshot(): FocusRuntimeSnapshot {
    return {
      status: this.status,
      error: this.error,
      tasks: this.tasks,
      taskId: this.taskId,
      sessions: this.sessions,
      today: this.today,
      timer: this.timer.getSnapshot(),
      noise: this.noise.getSnapshot(),
      notice: this.notice,
      recording: this.recording,
    };
  }

  private emit(): void {
    if (this.disposed) {
      return;
    }
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private notify(message: string, tone: FocusNoticeTone = 'info'): void {
    this.noticeSeed += 1;
    const id = this.noticeSeed;
    this.notice = { id, message, tone };
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
    }
    this.noticeTimer = setTimeout(() => {
      if (this.notice?.id === id) {
        this.notice = null;
        this.emit();
      }
    }, 5000);
    this.emit();
  }

  async init(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.available) {
      this.status = 'unavailable';
      this.emit();
      return;
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }
    this.loadPromise = this.refresh()
      .catch(() => undefined)
      .finally(() => {
        this.loadPromise = null;
      });
    return this.loadPromise;
  }

  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (!this.available) {
      this.status = 'unavailable';
      this.emit();
      return;
    }
    if (this.status !== 'ready') {
      this.status = 'loading';
      this.emit();
    }

    try {
      const [tasks, sessions] = await Promise.all([
        this.source.tasks.list(),
        this.source.sessions.list({}),
      ]);
      if (this.disposed) {
        return;
      }
      this.tasks = tasks.filter((task) => task.deletedAt === null);
      this.sessions = sessions;
      this.today = this.todayOverride ?? localDateFromMs(this.now());
      if (this.taskId) {
        const selected = this.tasks.find((task) => task.id === this.taskId);
        if (!isOpenTask(selected)) {
          this.taskId = null;
        }
      }
      this.status = 'ready';
      this.error = null;
      this.emit();
    } catch (reason) {
      if (this.disposed) {
        return;
      }
      this.error = formatError(reason);
      this.status = this.status === 'ready' ? 'ready' : 'error';
      this.emit();
    }
  }

  selectTask(taskId: string | null): boolean {
    if (taskId === null) {
      this.taskId = null;
      this.emit();
      return true;
    }
    const task = this.tasks.find((candidate) => candidate.id === taskId);
    if (!task && this.status === 'loading') {
      // 页面可能带着 ?task= 在数据加载完成前调用；先记住，refresh 时校正。
      this.taskId = taskId;
      this.emit();
      return true;
    }
    if (!isOpenTask(task)) {
      this.taskId = null;
      this.notify('该任务已完成或不存在，请重新选择', 'danger');
      return false;
    }
    this.taskId = taskId;
    this.emit();
    return true;
  }

  setMode(mode: FocusMode): boolean {
    return this.timer.setMode(mode);
  }

  setConfig(patch: Partial<FocusTimerConfig>): boolean {
    return this.timer.setConfig(patch);
  }

  start(): void {
    this.timer.start();
  }

  pause(): void {
    this.timer.pause();
  }

  /** 从后台恢复或页面重新挂载时按真实时间追平。 */
  sync(): void {
    this.timer.sync();
  }

  reset(): void {
    this.timer.reset();
    this.notify('计时已重置', 'info');
  }

  private async recordSession(
    minutes: number,
    mode: FocusSessionMode,
    startedAtMs: number,
    endedAtMs: number,
  ): Promise<RecordResult> {
    if (this.recording) {
      return { ok: false, message: '正在保存本次专注…' };
    }
    if (!this.available) {
      return { ok: false, message: '需在桌面壳内使用本地专注库' };
    }
    if (!this.taskId) {
      return { ok: false, message: NO_TASK_MESSAGE };
    }
    if (!isValidFocusMinutes(minutes)) {
      return { ok: false, message: INVALID_MINUTES_MESSAGE };
    }

    const input: RecordFocusInput = {
      taskId: this.taskId,
      minutes,
      startedAt: localIsoFromMs(startedAtMs),
      endedAt: localIsoFromMs(endedAtMs),
      mode,
      note: '',
    };

    this.recording = true;
    this.emit();
    try {
      const session = await this.source.sessions.record(input);
      if (this.disposed) {
        return { ok: true, session };
      }
      this.sessions = [
        session,
        ...this.sessions.filter((item) => item.id !== session.id),
      ];
      this.today = this.todayOverride ?? localDateFromMs(this.now());
      return { ok: true, session };
    } catch (reason) {
      return { ok: false, message: formatError(reason) };
    } finally {
      this.recording = false;
      this.emit();
    }
  }

  private maybeHandleDue(): void {
    if (this.disposed || this.dueBusy) {
      return;
    }
    const due = this.timer.getSnapshot().due;
    if (!due) {
      return;
    }
    void this.handleDue(due);
  }

  private async handleDue(due: FocusTimerDue): Promise<void> {
    this.dueBusy = true;
    try {
      const result = await this.recordSession(
        due.minutes,
        due.mode,
        due.startedAtMs,
        due.endedAtMs,
      );
      if (result.ok) {
        this.timer.resolveDue(true);
        this.notify(`已完成 ${due.minutes} 分钟专注`, 'success');
      } else {
        this.timer.resolveDue(false, result.message);
        this.notify(result.message, 'danger');
      }
    } finally {
      this.dueBusy = false;
    }
  }

  /**
   * “完成并记录” / “结束休息”。无任务时拒绝写入并给出明确提示，
   * 不复制原型“提示成功但什么都没记”的行为。
   */
  async finish(): Promise<FocusActionResult> {
    const snapshot = this.timer.getSnapshot();

    if (snapshot.phase !== 'focus') {
      this.timer.endBreak(false);
      this.notify('已结束休息', 'info');
      return { ok: true };
    }

    if (this.dueBusy || this.recording) {
      const message = '正在保存本次专注…';
      this.notify(message, 'info');
      return { ok: false, message };
    }

    // 任务优先校验：哪怕还没开始计时，无任务点击“完成并记录”也明确拒绝。
    if (!this.taskId) {
      if (this.timer.getSnapshot().running) {
        this.timer.pause();
      }
      this.timer.resolveManual(false, null, NO_TASK_MESSAGE);
      this.notify(NO_TASK_MESSAGE, 'danger');
      return { ok: false, message: NO_TASK_MESSAGE };
    }

    let payload = snapshot.due ?? snapshot.retry;
    if (!payload) {
      payload = this.timer.captureFocus();
    }
    if (!payload) {
      this.timer.resolveManual(false, null, EMPTY_DURATION_MESSAGE);
      this.notify(EMPTY_DURATION_MESSAGE, 'danger');
      return { ok: false, message: EMPTY_DURATION_MESSAGE };
    }

    const result = await this.recordSession(
      payload.minutes,
      payload.mode,
      payload.startedAtMs,
      payload.endedAtMs,
    );
    if (result.ok) {
      this.timer.resolveManual(true, payload);
      this.notify(`已记录 ${payload.minutes} 分钟专注`, 'success');
      return { ok: true, minutes: payload.minutes };
    }
    this.timer.resolveManual(false, payload, result.message);
    this.notify(result.message, 'danger');
    return { ok: false, message: result.message };
  }

  /** 手动补记：同样必须选择任务，写入一条 `mode=manual` 的事实记录。 */
  async recordManual(minutes: number): Promise<FocusActionResult> {
    const value = Math.round(Number(minutes));
    if (!isValidFocusMinutes(value)) {
      this.notify(INVALID_MINUTES_MESSAGE, 'danger');
      return { ok: false, message: INVALID_MINUTES_MESSAGE };
    }
    if (!this.taskId) {
      this.notify(NO_TASK_MESSAGE, 'danger');
      return { ok: false, message: NO_TASK_MESSAGE };
    }
    if (!this.available) {
      const message = '需在桌面壳内使用本地专注库';
      this.notify(message, 'danger');
      return { ok: false, message };
    }
    if (this.recording) {
      const message = '正在保存本次专注…';
      this.notify(message, 'info');
      return { ok: false, message };
    }

    const now = this.now();
    const result = await this.recordSession(value, 'manual', now, now);
    if (result.ok) {
      this.notify(`已补记 ${value} 分钟专注`, 'success');
      return { ok: true, minutes: value };
    }
    this.notify(result.message, 'danger');
    return { ok: false, message: result.message };
  }

  setNoiseType(type: NoiseType | 'off'): void {
    const current = this.noise.getSnapshot();
    if (type === 'off' || current.type === type) {
      this.noise.stop();
    } else {
      this.noise.start(type);
    }
    const next = this.noise.getSnapshot();
    if (next.error) {
      this.notify(next.error, 'danger');
    }
  }

  setNoiseVolume(value: number): void {
    this.noise.setVolume(value);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribeTimer();
    this.unsubscribeNoise();
    this.timer.dispose();
    if (this.resumeHandler) {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', this.resumeHandler);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', this.resumeHandler);
      }
      this.resumeHandler = null;
    }
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.noise.stop();
    this.listeners.clear();
  }
}

/** 全应用共享实例：路由切换不重建，因此计时可以后台继续。 */
export const focusRuntime = new FocusRuntime();
