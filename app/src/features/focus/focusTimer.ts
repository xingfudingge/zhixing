/**
 * 专注计时引擎（与 React 生命周期解耦）。
 *
 * 关键约束（P0-08）：
 * * 计时状态只在内存：不写 localStorage、不写路由；
 * * 用“截止时间 / 真实时间差”计算剩余，而不是每秒递减。标签页节流、
 *   窗口切后台后即使回调被推迟，下一次 tick/sync 也会追平，不会漂移；
 * * 专注阶段结束只产出 `due` 事实，是否真正写库由 FocusRuntime 决定；
 * * 没有任务时由上层拒绝，引擎不会“先记一笔再说”。
 */

import type { FocusMode } from '../../data/repositories/focus';

const MS_PER_MINUTE = 60_000;
const TICK_MS = 250;

export type FocusPhase = 'focus' | 'short' | 'long';

export type FocusTimerConfig = {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  rounds: number;
  autoStart: boolean;
};

export const DEFAULT_FOCUS_CONFIG: FocusTimerConfig = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  rounds: 4,
  autoStart: true,
};

export type FocusTimerDue = {
  mode: FocusMode;
  phase: 'focus';
  minutes: number;
  startedAtMs: number;
  endedAtMs: number;
  natural: boolean;
};

export type FocusTimerSnapshot = {
  mode: FocusMode;
  phase: FocusPhase;
  running: boolean;
  totalMs: number;
  remainingMs: number;
  elapsedMs: number;
  round: number;
  completedRounds: number;
  config: FocusTimerConfig;
  /** 自然到点、等待上层落库的待办事实。 */
  due: FocusTimerDue | null;
  /** 上一次记录失败的原因；有 retry 时可再次“完成并记录”。 */
  dueError: string | null;
  retry: FocusTimerDue | null;
  segmentStartedAtMs: number | null;
};

export type FocusTimerOptions = {
  now?: () => number;
  initialConfig?: Partial<FocusTimerConfig>;
  tickMs?: number;
};

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

export function normalizeConfig(
  config: Partial<FocusTimerConfig>,
  base: FocusTimerConfig = DEFAULT_FOCUS_CONFIG,
): FocusTimerConfig {
  return {
    focusMinutes: clampInt(
      config.focusMinutes,
      1,
      180,
      base.focusMinutes,
    ),
    shortBreakMinutes: clampInt(
      config.shortBreakMinutes,
      1,
      60,
      base.shortBreakMinutes,
    ),
    longBreakMinutes: clampInt(
      config.longBreakMinutes,
      1,
      120,
      base.longBreakMinutes,
    ),
    rounds: clampInt(config.rounds, 1, 12, base.rounds),
    autoStart:
      typeof config.autoStart === 'boolean'
        ? config.autoStart
        : base.autoStart,
  };
}

export class FocusTimer {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => FocusTimerSnapshot;

  private listeners = new Set<() => void>();
  private snapshot: FocusTimerSnapshot;
  private now: () => number;
  private tickMs: number;
  private interval: ReturnType<typeof setInterval> | null = null;
  private deadlineMs = 0;
  private countupAccumulatedMs = 0;
  private countupRunningSince: number | null = null;

  private mode: FocusMode;
  private phase: FocusPhase = 'focus';
  private running = false;
  private config: FocusTimerConfig;
  private totalMs: number;
  private remainingMs: number;
  private elapsedMs = 0;
  private completedRounds = 0;
  private due: FocusTimerDue | null = null;
  private dueError: string | null = null;
  private retry: FocusTimerDue | null = null;
  private segmentStartedAtMs: number | null = null;

  constructor(options: FocusTimerOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.tickMs = Math.max(50, options.tickMs ?? TICK_MS);
    this.config = normalizeConfig(options.initialConfig ?? {});
    this.mode = 'pomodoro';
    this.totalMs = this.config.focusMinutes * MS_PER_MINUTE;
    this.remainingMs = this.totalMs;
    this.snapshot = this.buildSnapshot();

    this.subscribe = (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    };
    this.getSnapshot = () => this.snapshot;
  }

  private focusMs(): number {
    return this.config.focusMinutes * MS_PER_MINUTE;
  }

  private breakMs(phase: FocusPhase): number {
    return (phase === 'long'
      ? this.config.longBreakMinutes
      : this.config.shortBreakMinutes) * MS_PER_MINUTE;
  }

  private roundForSnapshot(): number {
    if (this.mode !== 'pomodoro') {
      return Math.min(this.config.rounds, this.completedRounds + 1);
    }
    if (this.phase === 'long') {
      return this.config.rounds;
    }
    return Math.min(
      this.config.rounds,
      Math.max(1, this.completedRounds + 1),
    );
  }

  private buildSnapshot(): FocusTimerSnapshot {
    return {
      mode: this.mode,
      phase: this.phase,
      running: this.running,
      totalMs: this.totalMs,
      remainingMs: this.remainingMs,
      elapsedMs: this.mode === 'countup' ? this.elapsedMs : Math.max(
        0,
        this.totalMs - this.remainingMs,
      ),
      round: this.roundForSnapshot(),
      completedRounds: this.completedRounds,
      config: this.config,
      due: this.due,
      dueError: this.dueError,
      retry: this.retry,
      segmentStartedAtMs: this.segmentStartedAtMs,
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private clearInterval(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private startInterval(): void {
    if (this.interval !== null) {
      return;
    }
    this.interval = setInterval(() => this.tick(), this.tickMs);
  }

  /** 重置到当前模式的起点，不清除配置。 */
  private resetFocusState(): void {
    this.clearInterval();
    this.running = false;
    this.phase = 'focus';
    this.completedRounds = 0;
    this.due = null;
    this.dueError = null;
    this.retry = null;
    this.segmentStartedAtMs = null;
    this.countupAccumulatedMs = 0;
    this.countupRunningSince = null;
    this.deadlineMs = 0;

    if (this.mode === 'countup') {
      this.totalMs = 0;
      this.remainingMs = 0;
      this.elapsedMs = 0;
    } else {
      this.totalMs = this.focusMs();
      this.remainingMs = this.totalMs;
      this.elapsedMs = 0;
    }
  }

  private beginPhase(phase: FocusPhase, autoStart: boolean): void {
    this.clearInterval();
    this.running = false;
    this.phase = phase;
    this.totalMs = phase === 'focus' ? this.focusMs() : this.breakMs(phase);
    this.remainingMs = this.totalMs;
    this.elapsedMs = 0;
    this.segmentStartedAtMs = null;
    this.deadlineMs = 0;
    this.due = null;
    this.dueError = null;
    this.retry = null;

    if (autoStart) {
      this.start();
      return;
    }
    this.emit();
  }

  /** 开始或继续当前段。到点未记录时直接开始会被视为放弃旧段。 */
  start(): boolean {
    if (this.running) {
      return false;
    }
    this.dueError = null;
    const now = this.now();

    if (this.phase === 'focus' && this.mode === 'countup') {
      if (this.elapsedMs === 0) {
        this.segmentStartedAtMs = now;
      }
      if (this.segmentStartedAtMs === null) {
        this.segmentStartedAtMs = now;
      }
      this.countupRunningSince = now;
      this.running = true;
      this.startInterval();
      this.emit();
      return true;
    }

    if (
      this.phase === 'focus' &&
      (this.due !== null || this.retry !== null || this.remainingMs <= 0)
    ) {
      this.due = null;
      this.retry = null;
      this.dueError = null;
      this.remainingMs = this.totalMs;
      this.segmentStartedAtMs = null;
    }
    if (this.remainingMs <= 0) {
      this.remainingMs = this.totalMs;
    }
    if (this.segmentStartedAtMs === null) {
      this.segmentStartedAtMs = now;
    }

    this.deadlineMs = now + this.remainingMs;
    this.running = true;
    this.startInterval();
    this.emit();
    return true;
  }

  pause(): boolean {
    if (!this.running) {
      return false;
    }
    const now = this.now();

    if (this.mode === 'countup' && this.phase === 'focus') {
      if (this.countupRunningSince !== null) {
        this.countupAccumulatedMs += Math.max(
          0,
          now - this.countupRunningSince,
        );
      }
      this.countupRunningSince = null;
      this.elapsedMs = this.countupAccumulatedMs;
    } else {
      this.remainingMs = Math.max(0, this.deadlineMs - now);
      this.elapsedMs = this.totalMs - this.remainingMs;
    }

    this.running = false;
    this.clearInterval();
    this.emit();
    return true;
  }

  reset(): void {
    this.resetFocusState();
    this.emit();
  }

  /** 窗口重新可见 / 测试中手动追平时调用。 */
  sync(): void {
    if (this.running) {
      this.tick();
    }
  }

  setMode(mode: FocusMode): boolean {
    if (this.running || this.mode === mode) {
      return false;
    }
    this.mode = mode;
    this.resetFocusState();
    this.emit();
    return true;
  }

  setConfig(patch: Partial<FocusTimerConfig>): boolean {
    if (this.running) {
      return false;
    }
    const next = normalizeConfig(patch, this.config);
    const timingChanged =
      next.focusMinutes !== this.config.focusMinutes ||
      next.shortBreakMinutes !== this.config.shortBreakMinutes ||
      next.longBreakMinutes !== this.config.longBreakMinutes ||
      next.rounds !== this.config.rounds;
    this.config = next;
    if (timingChanged) {
      this.resetFocusState();
    }
    this.emit();
    return true;
  }

  /**
   * 自然到点：只设置 due，等上层落库成功后再 resolve。
   * 失败时 `retry` 保留完整事实，用户选中任务后可再次完成。
   */
  private completeFocus(now: number): void {
    this.running = false;
    this.clearInterval();
    this.remainingMs = 0;
    this.elapsedMs = this.totalMs;
    const endedAtMs = this.deadlineMs > 0 ? this.deadlineMs : now;
    const minutes = Math.max(
      1,
      Math.round(this.totalMs / MS_PER_MINUTE),
    );
    this.due = {
      mode: this.mode,
      phase: 'focus',
      minutes,
      startedAtMs: this.segmentStartedAtMs ?? endedAtMs - this.totalMs,
      endedAtMs,
      natural: true,
    };
    this.dueError = null;
    this.emit();
  }

  private completeBreak(): void {
    this.running = false;
    this.clearInterval();
    this.endBreak(this.config.autoStart);
  }

  private advanceAfterFocus(mode: FocusMode): void {
    if (mode === 'pomodoro') {
      this.completedRounds = Math.min(
        this.config.rounds,
        this.completedRounds + 1,
      );
      const next: FocusPhase =
        this.completedRounds >= this.config.rounds ? 'long' : 'short';
      this.beginPhase(next, this.config.autoStart);
      return;
    }

    if (mode === 'countdown') {
      this.clearInterval();
      this.running = false;
      this.phase = 'focus';
      this.totalMs = this.focusMs();
      this.remainingMs = this.totalMs;
      this.elapsedMs = 0;
      this.segmentStartedAtMs = null;
      this.deadlineMs = 0;
      this.due = null;
      this.dueError = null;
      this.retry = null;
      this.emit();
      return;
    }

    // countup：记录后归零，下一次从 0 开始。
    this.clearInterval();
    this.running = false;
    this.phase = 'focus';
    this.totalMs = 0;
    this.remainingMs = 0;
    this.elapsedMs = 0;
    this.countupAccumulatedMs = 0;
    this.countupRunningSince = null;
    this.segmentStartedAtMs = null;
    this.due = null;
    this.dueError = null;
    this.retry = null;
    this.emit();
  }

  /** 上层落库成功后推进循环；失败则保留 retry 并停在当前状态。 */
  resolveDue(success: boolean, message?: string): void {
    const due = this.due;
    if (!due) {
      return;
    }
    if (!success) {
      this.due = null;
      this.retry = due;
      this.dueError = message ?? '专注记录保存失败';
      this.running = false;
      this.clearInterval();
      this.emit();
      return;
    }
    this.due = null;
    this.dueError = null;
    this.retry = null;
    this.advanceAfterFocus(due.mode);
  }

  /**
   * 手动“完成并记录”的结果。成功推进/归零；失败保留可重试事实。
   * 与自然到点共用同一套落库后状态机。
   */
  resolveManual(
    success: boolean,
    payload: FocusTimerDue | null,
    message?: string,
  ): void {
    if (!success) {
      this.due = null;
      this.retry = payload ?? this.retry;
      this.dueError = message ?? '专注记录保存失败';
      this.running = false;
      this.clearInterval();
      this.emit();
      return;
    }
    const mode = payload?.mode ?? this.mode;
    this.due = null;
    this.dueError = null;
    this.retry = null;
    this.advanceAfterFocus(mode);
  }

  /**
   * 测量当前专注段（会先暂停），供“完成并记录”使用。
   * 返回 null 表示还没开始/不足 1 秒，不应产生记录。
   */
  captureFocus(): FocusTimerDue | null {
    if (this.phase !== 'focus') {
      return null;
    }
    if (this.due) {
      return this.due;
    }
    if (this.retry) {
      return this.retry;
    }
    if (this.running) {
      this.pause();
    }

    const now = this.now();
    if (this.mode === 'countup') {
      if (this.elapsedMs < 1000) {
        return null;
      }
      return {
        mode: 'countup',
        phase: 'focus',
        minutes: Math.max(1, Math.round(this.elapsedMs / MS_PER_MINUTE)),
        startedAtMs: this.segmentStartedAtMs ?? now,
        endedAtMs: now,
        natural: false,
      };
    }

    const elapsed =
      this.remainingMs <= 0 ? this.totalMs : this.totalMs - this.remainingMs;
    if (elapsed < 1000) {
      return null;
    }
    return {
      mode: this.mode,
      phase: 'focus',
      minutes:
        this.remainingMs <= 0
          ? Math.max(1, Math.round(this.totalMs / MS_PER_MINUTE))
          : Math.max(1, Math.round(elapsed / MS_PER_MINUTE)),
      startedAtMs: this.segmentStartedAtMs ?? now,
      endedAtMs: now,
      natural: this.remainingMs <= 0,
    };
  }

  /** 结束休息，回到专注起点。返回是否确实处于休息阶段。 */
  endBreak(autoStart = false): boolean {
    if (this.phase === 'focus') {
      return false;
    }
    if (this.phase === 'long') {
      this.completedRounds = 0;
    }
    this.beginPhase('focus', autoStart);
    return true;
  }

  getConfig(): FocusTimerConfig {
    return this.config;
  }

  private tick(): void {
    if (!this.running) {
      return;
    }
    const now = this.now();

    if (this.mode === 'countup' && this.phase === 'focus') {
      this.elapsedMs =
        this.countupRunningSince === null
          ? this.countupAccumulatedMs
          : this.countupAccumulatedMs +
            Math.max(0, now - this.countupRunningSince);
      this.emit();
      return;
    }

    const remaining = Math.max(0, this.deadlineMs - now);
    this.remainingMs = remaining;
    this.elapsedMs = this.totalMs - remaining;

    if (remaining <= 0) {
      if (this.phase === 'focus') {
        this.completeFocus(now);
      } else {
        this.completeBreak();
      }
      return;
    }
    this.emit();
  }

  dispose(): void {
    this.clearInterval();
    this.listeners.clear();
  }
}
