import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NO_TASK_MESSAGE } from '../../../data/repositories/focus';
import {
  DEFAULT_FOCUS_CONFIG,
  FocusTimer,
  normalizeConfig,
} from '../focusTimer';

function startClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26, 8, 0, 0).getTime());
}

describe('专注计时引擎', () => {
  beforeEach(startClock);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('番茄默认 25/5/15/4：开始、暂停、继续、重置都按真实时间走', () => {
    const timer = new FocusTimer();
    expect(timer.getSnapshot().config).toEqual(DEFAULT_FOCUS_CONFIG);
    expect(timer.getSnapshot().totalMs).toBe(25 * 60_000);
    expect(timer.getSnapshot().remainingMs).toBe(25 * 60_000);
    expect(timer.getSnapshot().round).toBe(1);

    timer.start();
    vi.advanceTimersByTime(1000);
    expect(timer.getSnapshot().remainingMs).toBe(25 * 60_000 - 1000);
    expect(timer.getSnapshot().running).toBe(true);

    timer.pause();
    expect(timer.getSnapshot().running).toBe(false);
    const paused = timer.getSnapshot().remainingMs;
    vi.advanceTimersByTime(5000);
    expect(timer.getSnapshot().remainingMs).toBe(paused);

    timer.start();
    vi.advanceTimersByTime(1000);
    expect(timer.getSnapshot().remainingMs).toBe(paused - 1000);

    timer.reset();
    expect(timer.getSnapshot()).toMatchObject({
      phase: 'focus',
      running: false,
      remainingMs: 25 * 60_000,
      completedRounds: 0,
      round: 1,
    });
    timer.dispose();
  });

  it('后台暂停回调后用 sync 追平真实时间，不产生漂移', () => {
    const timer = new FocusTimer();
    timer.start();
    const startedAt = Date.now();

    // 模拟 WebView 后台期间定时器完全没跑。
    vi.setSystemTime(startedAt + 5 * 60_000);
    timer.sync();

    expect(timer.getSnapshot().remainingMs).toBe(20 * 60_000);
    expect(timer.getSnapshot().elapsedMs).toBe(5 * 60_000);

    vi.setSystemTime(startedAt + 25 * 60_000);
    timer.sync();
    expect(timer.getSnapshot().due).toMatchObject({
      minutes: 25,
      natural: true,
    });
    expect(timer.getSnapshot().running).toBe(false);
    timer.dispose();
  });

  it('自然完成 → 短休，休息结束自动回到下一轮专注', () => {
    const timer = new FocusTimer();
    timer.start();
    const startedAt = Date.now();
    vi.setSystemTime(startedAt + 25 * 60_000);
    timer.sync();

    expect(timer.getSnapshot().due?.minutes).toBe(25);
    timer.resolveDue(true);

    const breakSnapshot = timer.getSnapshot();
    expect(breakSnapshot.phase).toBe('short');
    expect(breakSnapshot.running).toBe(true);
    expect(breakSnapshot.remainingMs).toBe(5 * 60_000);
    expect(breakSnapshot.completedRounds).toBe(1);

    vi.setSystemTime(startedAt + 30 * 60_000);
    timer.sync();
    expect(timer.getSnapshot()).toMatchObject({
      phase: 'focus',
      running: true,
      remainingMs: 25 * 60_000,
      round: 2,
      completedRounds: 1,
    });
    timer.dispose();
  });

  it('轮数用尽进入长休，长休结束轮次归零', () => {
    const timer = new FocusTimer({ initialConfig: { rounds: 1 } });
    timer.start();
    const startedAt = Date.now();
    vi.setSystemTime(startedAt + 25 * 60_000);
    timer.sync();
    timer.resolveDue(true);

    expect(timer.getSnapshot().phase).toBe('long');
    expect(timer.getSnapshot().remainingMs).toBe(15 * 60_000);
    expect(timer.getSnapshot().round).toBe(1);

    vi.setSystemTime(startedAt + 40 * 60_000);
    timer.sync();
    expect(timer.getSnapshot()).toMatchObject({
      phase: 'focus',
      running: true,
      remainingMs: 25 * 60_000,
      completedRounds: 0,
      round: 1,
    });
    timer.dispose();
  });

  it('无任务导致记录失败时保留 retry，不进入休息', () => {
    const timer = new FocusTimer();
    timer.start();
    const startedAt = Date.now();
    vi.setSystemTime(startedAt + 25 * 60_000);
    timer.sync();

    timer.resolveDue(false, NO_TASK_MESSAGE);

    expect(timer.getSnapshot()).toMatchObject({
      phase: 'focus',
      running: false,
      remainingMs: 0,
      due: null,
      dueError: NO_TASK_MESSAGE,
    });
    expect(timer.getSnapshot().retry).toMatchObject({
      minutes: 25,
      natural: true,
    });
    expect(timer.captureFocus()).toMatchObject({ minutes: 25 });
    timer.dispose();
  });

  it('提前完成按已过分钟记录，并推进番茄轮次', () => {
    const timer = new FocusTimer();
    timer.start();
    const startedAt = Date.now();
    vi.setSystemTime(startedAt + 10 * 60_000);
    timer.sync();

    const payload = timer.captureFocus();
    expect(payload).toMatchObject({
      minutes: 10,
      natural: false,
      phase: 'focus',
    });
    timer.resolveManual(true, payload);

    expect(timer.getSnapshot()).toMatchObject({
      phase: 'short',
      completedRounds: 1,
      running: true,
    });
    timer.dispose();
  });

  it('自动进入下一段关闭时，完成/休息结束都停在起点等待用户', () => {
    const timer = new FocusTimer({
      initialConfig: { autoStart: false },
    });
    timer.start();
    const startedAt = Date.now();
    vi.setSystemTime(startedAt + 25 * 60_000);
    timer.sync();
    timer.resolveDue(true);

    expect(timer.getSnapshot()).toMatchObject({
      phase: 'short',
      running: false,
      remainingMs: 5 * 60_000,
    });

    timer.endBreak(false);
    expect(timer.getSnapshot()).toMatchObject({
      phase: 'focus',
      running: false,
      remainingMs: 25 * 60_000,
    });
    timer.dispose();
  });

  it('倒计时到点记录后回到完整时长，正计时按实际分钟归零', () => {
    const countdown = new FocusTimer();
    countdown.setMode('countdown');
    countdown.setConfig({ focusMinutes: 45 });
    countdown.start();
    const startedAt = Date.now();
    vi.setSystemTime(startedAt + 45 * 60_000);
    countdown.sync();
    expect(countdown.getSnapshot().due?.minutes).toBe(45);
    countdown.resolveDue(true);
    expect(countdown.getSnapshot()).toMatchObject({
      phase: 'focus',
      running: false,
      remainingMs: 45 * 60_000,
      completedRounds: 0,
    });
    countdown.dispose();

    const countup = new FocusTimer();
    countup.setMode('countup');
    countup.start();
    const countupStart = Date.now();
    vi.setSystemTime(countupStart + 12 * 60_000);
    countup.sync();
    expect(countup.getSnapshot().elapsedMs).toBe(12 * 60_000);
    const payload = countup.captureFocus();
    expect(payload?.minutes).toBe(12);
    countup.resolveManual(true, payload);
    expect(countup.getSnapshot()).toMatchObject({
      phase: 'focus',
      elapsedMs: 0,
      running: false,
    });
    countup.dispose();
  });

  it('未开始就完成返回 null；配置归一化保证分钟与轮数合法', () => {
    const timer = new FocusTimer();
    expect(timer.captureFocus()).toBeNull();

    expect(
      normalizeConfig({
        focusMinutes: 0,
        shortBreakMinutes: 999,
        longBreakMinutes: -3,
        rounds: 0,
      }),
    ).toEqual({
      focusMinutes: 1,
      shortBreakMinutes: 60,
      longBreakMinutes: 1,
      rounds: 1,
      autoStart: true,
    });
    timer.dispose();
  });
});
