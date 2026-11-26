/**
 * 专注页：番茄 / 倒计时 / 正计时、任务关联、今日/本周统计、手动补记与白噪音。
 *
 * 计时与数据都在 `FocusRuntime` 外部 store 中，页面卸载不会停止计时；
 * 记录只写 SQLite，绝不把计时状态写 localStorage。
 */

import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  NOISE_LABELS,
  type NoiseType,
} from '../../audio/noise';
import type { FocusSession, Task } from '../../data/db/types';
import type { FocusMode } from '../../data/repositories/focus';
import {
  focusRuntime,
  type FocusRuntime,
} from './FocusRuntime';
import { recentFocusSessions, summarizeFocus } from './stats';
import './focus.css';

export type FocusPageProps = {
  /** 测试注入；生产使用全应用共享实例，保证切页计时继续。 */
  runtime?: FocusRuntime;
};

const MODES: { value: FocusMode; label: string }[] = [
  { value: 'pomodoro', label: '番茄循环' },
  { value: 'countdown', label: '倒计时' },
  { value: 'countup', label: '正计时' },
];

const FOCUS_MINUTE_OPTIONS = [15, 25, 45, 60, 90];
const SHORT_BREAK_OPTIONS = [5, 10, 15];
const LONG_BREAK_OPTIONS = [15, 20, 30];
const ROUND_OPTIONS = [2, 3, 4, 5, 6];

/** 仅记录"用户主动关掉说明"这一设备偏好；计时与专注记录仍只写 SQLite。 */
export const NOISE_HINT_STORAGE_KEY = 'zx.focus.noiseHintDismissed.v1';

/** 各声音的遮蔽频段不同，用一句话说明，避免只看到名字不知道用途。 */
const NOISE_HINTS: Partial<Record<NoiseType, string>> = {
  white: '均匀遮蔽',
  pink: '柔和均衡',
  brown: '低频稳定',
  rain: '高频遮蔽',
};

const NOISE_OPTIONS: {
  value: NoiseType | 'off';
  label: string;
  hint?: string;
}[] = [
  { value: 'off', label: NOISE_LABELS.off },
  { value: 'white', label: NOISE_LABELS.white, hint: NOISE_HINTS.white },
  { value: 'pink', label: NOISE_LABELS.pink, hint: NOISE_HINTS.pink },
  { value: 'brown', label: NOISE_LABELS.brown, hint: NOISE_HINTS.brown },
  { value: 'rain', label: NOISE_LABELS.rain, hint: NOISE_HINTS.rain },
];

function readNoiseHintDismissed(): boolean {
  try {
    return (
      window.localStorage.getItem(NOISE_HINT_STORAGE_KEY) === '1'
    );
  } catch {
    // 隐私模式等禁止 localStorage 时仍显示说明，只是无法跨次记住关闭。
    return false;
  }
}

function persistNoiseHintDismissed(): void {
  try {
    window.localStorage.setItem(NOISE_HINT_STORAGE_KEY, '1');
  } catch {
    // 存储不可用不影响本次关闭。
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 计时展示：分钟可超过 99（例如 90 分钟倒计时）。 */
export function formatFocusClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  return `${pad2(Math.floor(totalSeconds / 60))}:${pad2(
    totalSeconds % 60,
  )}`;
}

function phaseLabel(phase: 'focus' | 'short' | 'long'): string {
  if (phase === 'short') {
    return '短休息';
  }
  if (phase === 'long') {
    return '长休息';
  }
  return '专注中';
}

function taskTitle(
  tasks: Map<string, Task>,
  session: FocusSession,
): string {
  return tasks.get(session.taskId)?.title ?? '任务不存在';
}

export function FocusPage({ runtime = focusRuntime }: FocusPageProps = {}) {
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const [manualMinutes, setManualMinutes] = useState('30');
  const [noiseHintDismissed, setNoiseHintDismissed] = useState(
    readNoiseHintDismissed,
  );

  const dismissNoiseHint = () => {
    setNoiseHintDismissed(true);
    persistNoiseHintDismissed();
  };

  useEffect(() => {
    const linkedTask = new URLSearchParams(window.location.search).get('task');
    void runtime.init().then(() => {
      if (linkedTask) {
        runtime.selectTask(linkedTask);
      }
    });
  }, [runtime]);

  useEffect(() => {
    runtime.sync();
  }, [runtime]);

  const timer = snapshot.timer;
  const summary = summarizeFocus(snapshot.sessions, snapshot.today, 7);
  const recent = useMemo(
    () => recentFocusSessions(snapshot.sessions, 6),
    [snapshot.sessions],
  );
  const openTasks = useMemo(
    () =>
      snapshot.tasks.filter(
        (task) => task.deletedAt === null && task.status !== 'done',
      ),
    [snapshot.tasks],
  );
  const taskTitles = useMemo(
    () => new Map(snapshot.tasks.map((task) => [task.id, task])),
    [snapshot.tasks],
  );
  const selectedTask = snapshot.taskId
    ? taskTitles.get(snapshot.taskId) ?? null
    : null;

  const breakPhase = timer.phase !== 'focus';
  const displayMs =
    timer.mode === 'countup' ? timer.elapsedMs : timer.remainingMs;
  const clock = formatFocusClock(displayMs);
  const [clockMinutes, clockSeconds] = clock.split(':');

  const pausedMidSession =
    timer.mode === 'countup'
      ? timer.elapsedMs > 0
      : timer.remainingMs > 0 && timer.remainingMs < timer.totalMs;
  const startLabel = timer.running
    ? '暂停'
    : breakPhase
      ? '开始休息'
      : timer.dueError && timer.remainingMs <= 0
        ? '重新开始'
        : timer.mode === 'countup'
          ? pausedMidSession
            ? '继续计时'
            : '开始计时'
          : pausedMidSession
            ? '继续专注'
            : '开始专注';

  const selectedNoiseLabel =
    snapshot.noise.type === 'off'
      ? '未播放'
      : `播放中 · ${NOISE_LABELS[snapshot.noise.type]}`;

  return (
    <div className="page focus-page">
      <header className="focus-head">
        <div>
          <p className="focus-eyebrow">节奏 · 专注</p>
          <h1>专注</h1>
          <p className="focus-sub">
            番茄、倒计时与正计时。完成的每一段都会写入所选任务，并进入今日、
            本周与复盘统计。
          </p>
        </div>
        <div className="focus-head-meta" aria-label="专注数据状态">
          <span>{openTasks.length} 个待办任务</span>
          <span>·</span>
          <span>{summary.todayCount} 段今日记录</span>
        </div>
      </header>

      {snapshot.status === 'loading' ? (
        <div className="focus-banner" role="status">
          正在载入任务与专注记录…
        </div>
      ) : null}

      {snapshot.status === 'unavailable' ? (
        <div className="focus-banner" role="note">
          <strong>浏览器预览</strong>
          <span>
            计时只保留在内存；专注记录需在桌面壳内写入本地库，不会伪造成功。
          </span>
        </div>
      ) : null}

      {snapshot.error ? (
        <div className="focus-banner focus-banner--danger" role="alert">
          <span>{snapshot.error}</span>
          <button
            type="button"
            className="focus-btn"
            onClick={() => void runtime.init()}
          >
            重试
          </button>
        </div>
      ) : null}

      <div className="focus-layout">
        <div className="focus-main">
          <section
            className="focus-timer-card"
            aria-labelledby="focus-timer-heading"
          >
            <div className="focus-modes" role="group" aria-label="计时模式">
              {MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  className={
                    timer.mode === mode.value
                      ? 'focus-mode is-active'
                      : 'focus-mode'
                  }
                  aria-pressed={timer.mode === mode.value}
                  disabled={timer.running}
                  onClick={() => runtime.setMode(mode.value)}
                >
                  {mode.label}
                </button>
              ))}
            </div>

            <div className="focus-phase" data-testid="focus-phase">
              <span
                className={timer.running ? 'focus-dot is-running' : 'focus-dot'}
                aria-hidden="true"
              />
              <span>{phaseLabel(timer.phase)}</span>
              {timer.mode === 'pomodoro' ? (
                <span className="focus-round-label">
                  · 第 {timer.round} / {timer.config.rounds} 轮
                </span>
              ) : null}
            </div>

            <h2 id="focus-timer-heading" className="focus-task-title">
              {breakPhase
                ? '休息一下'
                : selectedTask?.title ?? '选择一个任务'}
            </h2>
            <p className="focus-task-sub">
              {breakPhase
                ? '离开屏幕，喝口水；休息段不写入专注分钟。'
                : selectedTask
                  ? selectedTask.dueDate
                    ? `截止 ${selectedTask.dueDate} · 完成时写入该任务与复盘`
                    : '完成时写入该任务与复盘'
                  : '先选择任务；没有任务时完成会被拒绝，不会产生记录。'}
            </p>

            <div
              className="focus-clock"
              data-testid="focus-clock"
              role="timer"
              aria-label={`${
                timer.mode === 'countup' ? '已用时间' : '剩余时间'
              } ${clock}`}
            >
              <span>{clockMinutes}</span>
              <span className="focus-clock-colon">:</span>
              <span>{clockSeconds}</span>
            </div>

            {timer.mode === 'pomodoro' ? (
              <div
                className="focus-rounds"
                aria-label={`已完成 ${timer.completedRounds} / ${timer.config.rounds} 轮`}
              >
                {Array.from({ length: timer.config.rounds }, (_, index) => (
                  <i
                    key={index}
                    className={[
                      'focus-round-dot',
                      index < timer.completedRounds ? 'is-done' : '',
                      index === timer.round - 1 ? 'is-current' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  />
                ))}
              </div>
            ) : null}

            <div className="focus-actions">
              <button
                type="button"
                className="focus-btn focus-btn--primary focus-btn--lg"
                onClick={() =>
                  timer.running ? runtime.pause() : runtime.start()
                }
              >
                {startLabel}
              </button>
              <button
                type="button"
                className="focus-btn"
                onClick={() => runtime.reset()}
              >
                重置
              </button>
              <button
                type="button"
                className="focus-btn"
                disabled={snapshot.recording}
                onClick={() => void runtime.finish()}
              >
                {snapshot.recording
                  ? '记录中…'
                  : breakPhase
                    ? '结束休息'
                    : '完成并记录'}
              </button>
            </div>

            {timer.dueError ? (
              <div className="focus-inline-error" role="alert">
                未记录 · {timer.dueError}
              </div>
            ) : null}

            <div className="focus-task-select">
              <label htmlFor="focus-task">关联任务</label>
              <select
                id="focus-task"
                value={snapshot.taskId ?? ''}
                onChange={(event) =>
                  runtime.selectTask(event.target.value || null)
                }
              >
                <option value="">选择任务…</option>
                {openTasks.length === 0 ? (
                  <option value="" disabled>
                    暂无未完成任务
                  </option>
                ) : (
                  openTasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="focus-config">
              {timer.mode === 'pomodoro' ? (
                <>
                  <label htmlFor="focus-minutes">
                    专注
                    <select
                      id="focus-minutes"
                      aria-label="专注时长"
                      value={timer.config.focusMinutes}
                      disabled={timer.running}
                      onChange={(event) =>
                        runtime.setConfig({
                          focusMinutes: Number(event.target.value),
                        })
                      }
                    >
                      {FOCUS_MINUTE_OPTIONS.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes} 分钟
                        </option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor="focus-short-break">
                    短休
                    <select
                      id="focus-short-break"
                      aria-label="短休时长"
                      value={timer.config.shortBreakMinutes}
                      disabled={timer.running}
                      onChange={(event) =>
                        runtime.setConfig({
                          shortBreakMinutes: Number(event.target.value),
                        })
                      }
                    >
                      {SHORT_BREAK_OPTIONS.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes} 分钟
                        </option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor="focus-long-break">
                    长休
                    <select
                      id="focus-long-break"
                      aria-label="长休时长"
                      value={timer.config.longBreakMinutes}
                      disabled={timer.running}
                      onChange={(event) =>
                        runtime.setConfig({
                          longBreakMinutes: Number(event.target.value),
                        })
                      }
                    >
                      {LONG_BREAK_OPTIONS.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes} 分钟
                        </option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor="focus-rounds">
                    轮数
                    <select
                      id="focus-rounds"
                      aria-label="轮数"
                      value={timer.config.rounds}
                      disabled={timer.running}
                      onChange={(event) =>
                        runtime.setConfig({
                          rounds: Number(event.target.value),
                        })
                      }
                    >
                      {ROUND_OPTIONS.map((rounds) => (
                        <option key={rounds} value={rounds}>
                          {rounds} 轮
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="focus-check" htmlFor="focus-auto-start">
                    <input
                      id="focus-auto-start"
                      type="checkbox"
                      checked={timer.config.autoStart}
                      disabled={timer.running}
                      onChange={(event) =>
                        runtime.setConfig({
                          autoStart: event.target.checked,
                        })
                      }
                    />
                    自动进入下一段
                  </label>
                </>
              ) : timer.mode === 'countdown' ? (
                <label htmlFor="focus-countdown-minutes">
                  时长
                  <select
                    id="focus-countdown-minutes"
                    aria-label="专注时长"
                    value={timer.config.focusMinutes}
                    disabled={timer.running}
                    onChange={(event) =>
                      runtime.setConfig({
                        focusMinutes: Number(event.target.value),
                      })
                    }
                  >
                    {FOCUS_MINUTE_OPTIONS.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {minutes} 分钟
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="focus-config-hint">
                  从 0 向上累计，完成后按实际分钟记录
                </span>
              )}
            </div>

            <p className="focus-note">
              计时按真实时间计算：切页或窗口切到后台不会停；关闭应用会结束本次
              内存计时。系统通知尚未实现。
            </p>
          </section>

          <section
            className="focus-panel focus-noise"
            aria-labelledby="focus-noise-heading"
          >
            <div className="focus-panel-head">
              <h3 id="focus-noise-heading">白噪音</h3>
              <span
                className={
                  snapshot.noise.playing
                    ? 'focus-noise-state is-playing'
                    : 'focus-noise-state'
                }
                data-testid="noise-state"
              >
                {selectedNoiseLabel}
              </span>
            </div>
            <p
              className="focus-panel-sub focus-noise-desc"
              data-testid="noise-description"
            >
              用于屏蔽环境噪声、辅助进入专注。声音由本机 AudioContext
              实时生成，不上传、不下载、不采集麦克风；默认关闭，点类型才会播放。
            </p>
            {noiseHintDismissed ? null : (
              <div
                className="focus-noise-hint"
                role="note"
                data-testid="noise-hint"
              >
                <span>
                  小提示：雨声偏高频遮蔽，棕噪偏低频稳定；点任意类型开始，点
                  “关闭”停止。
                </span>
                <button
                  type="button"
                  className="focus-noise-hint-close"
                  aria-label="关闭白噪音提示"
                  onClick={dismissNoiseHint}
                >
                  知道了
                </button>
              </div>
            )}
            <div
              className="focus-noise-buttons"
              role="group"
              aria-label="白噪音类型"
            >
              {NOISE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={
                    snapshot.noise.type === option.value
                      ? 'focus-noise-button is-active'
                      : 'focus-noise-button'
                  }
                  aria-label={option.label}
                  aria-describedby={
                    option.hint
                      ? `focus-noise-hint-${option.value}`
                      : undefined
                  }
                  aria-pressed={snapshot.noise.type === option.value}
                  title={
                    option.hint
                      ? `${option.label}：${option.hint}`
                      : option.label
                  }
                  onClick={() => runtime.setNoiseType(option.value)}
                >
                  <span className="focus-noise-button-label">
                    {option.label}
                  </span>
                  {option.hint ? (
                    <span
                      id={`focus-noise-hint-${option.value}`}
                      className="focus-noise-button-hint"
                    >
                      {option.hint}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="focus-volume">
              <label htmlFor="focus-noise-volume">音量</label>
              <input
                id="focus-noise-volume"
                type="range"
                min={0}
                max={100}
                step={1}
                value={snapshot.noise.volume}
                aria-label="白噪音音量"
                onChange={(event) =>
                  runtime.setNoiseVolume(Number(event.target.value))
                }
              />
              <span>{snapshot.noise.volume}%</span>
            </div>
            {snapshot.noise.error ? (
              <p className="focus-inline-error" role="alert">
                {snapshot.noise.error}
              </p>
            ) : null}
          </section>
        </div>

        <aside className="focus-side" aria-label="专注统计与补记">
          <section className="focus-panel focus-today" aria-label="今日与本周统计">
            <small>今天专注</small>
            <b data-testid="focus-today-minutes">
              {summary.todayMinutes} 分钟
            </b>
            <span>
              <b data-testid="focus-today-count">{summary.todayCount}</b> 段 ·
              本周{' '}
              <b data-testid="focus-week-minutes">{summary.weekMinutes}</b>{' '}
              分钟
            </span>
          </section>

          <section className="focus-panel" aria-labelledby="focus-recent-heading">
            <div className="focus-panel-head">
              <h3 id="focus-recent-heading">最近记录</h3>
              <span>{recent.length} 条</span>
            </div>
            {recent.length === 0 ? (
              <p className="focus-empty">还没有专注记录</p>
            ) : (
              <ul className="focus-recent" aria-label="最近专注记录">
                {recent.map((session) => (
                  <li className="focus-session-row" key={session.id}>
                    <b>{taskTitle(taskTitles, session)}</b>
                    <span>{session.minutes} 分钟</span>
                    <span className="focus-session-date">
                      {session.startedAt.slice(5, 10)}
                    </span>
                    {session.mode === 'manual' ? (
                      <em className="focus-tag">补记</em>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="focus-panel" aria-labelledby="focus-manual-heading">
            <div className="focus-panel-head">
              <h3 id="focus-manual-heading">手动补记</h3>
              <span>{selectedTask ? '写入所选任务' : '需先选任务'}</span>
            </div>
            <form
              className="focus-manual"
              onSubmit={(event) => {
                event.preventDefault();
                void runtime.recordManual(Number(manualMinutes));
              }}
            >
              <label htmlFor="focus-manual-minutes">补记分钟</label>
              <div className="focus-manual-row">
                <input
                  id="focus-manual-minutes"
                  type="number"
                  min={1}
                  max={1440}
                  step={1}
                  value={manualMinutes}
                  onChange={(event) => setManualMinutes(event.target.value)}
                />
                <button
                  type="submit"
                  className="focus-btn focus-btn--primary"
                  disabled={snapshot.recording}
                >
                  手动补记
                </button>
              </div>
            </form>
            <p className="focus-panel-sub">
              补记写入一条事实记录，立即计入今日/本周与后续复盘：
              {selectedTask ? ` ${selectedTask.title}` : ' 先选择一个任务。'}
            </p>
          </section>
        </aside>
      </div>

      {snapshot.notice ? (
        <div
          className={`focus-toast focus-toast--${snapshot.notice.tone}`}
          role="status"
          aria-live="polite"
          data-testid="focus-toast"
        >
          {snapshot.notice.message}
        </div>
      ) : null}
    </div>
  );
}
