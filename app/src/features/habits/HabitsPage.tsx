/**
 * 习惯页：周打卡、月热力图、历史补卡、连续/最佳、新建/编辑/删除、安排行动。
 *
 * 数据全部来自 HabitStore → SQLite；浏览器预览没有 IPC 时明确空态，不回退
 * localStorage。安排行动创建的是普通任务，不写回打卡，也不建立习惯关系。
 */

import { useEffect, useRef, useState } from 'react';
import { useInRouterContext, useSearchParams } from 'react-router-dom';

import type { Habit } from '../../data/db/types';
import { formatError, HabitToastProvider, useHabitToast } from './Feedback';
import { HabitDialog, type HabitDraft } from './HabitDialog';
import { HabitHeatmap } from './HabitHeatmap';
import { HabitIcon } from './HabitIcon';
import { HabitRow } from './HabitRow';
import {
  HabitStoreProvider,
  useHabitStore,
  type HabitSource,
} from './HabitStore';
import {
  DEFAULT_HABIT_ICON,
  longestBest,
  weeklyCompletion,
} from './stats';
import './habits.css';

export type HabitsPageProps = {
  /** 测试注入；不传时使用真实 SQLite 仓储。 */
  source?: HabitSource;
  /** 固定“今天”，测试可传入稳定日期。 */
  today?: string;
  available?: boolean;
};

export function HabitsPage({
  source,
  today,
  available,
}: HabitsPageProps = {}) {
  return (
    <HabitToastProvider>
      <HabitStoreProvider
        source={source}
        today={today}
        available={available}
      >
        <HabitsScreen />
      </HabitStoreProvider>
    </HabitToastProvider>
  );
}

function HabitsScreen() {
  const store = useHabitStore();
  const toast = useHabitToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Habit | null>(null);
  const [busyHabitId, setBusyHabitId] = useState<string | null>(null);
  const arrangeLockRef = useRef(new Set<string>());
  const arrangeCooldownRef = useRef(new Map<string, number>());

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (habit: Habit) => {
    setEditing(habit);
    setDialogOpen(true);
  };

  const saveHabit = async (draft: HabitDraft) => {
    if (editing) {
      await store.updateHabit(editing, draft);
      toast('习惯已更新', 'success');
      return;
    }
    await store.createHabit({
      title: draft.title,
      schedule: draft.schedule,
      icon: draft.icon,
      color: draft.color,
      goalPerWeek: 7,
    });
    toast('已创建习惯', 'success');
  };

  const deleteHabit = async () => {
    if (!editing) {
      return;
    }
    await store.deleteHabit(editing.id);
    toast('习惯已删除，打卡记录已同步删除', 'success');
  };

  const toggle = async (habit: Habit, date: string) => {
    try {
      const result = await store.toggleLog(habit.id, date);
      toast(
        result.checked ? `已打卡 ${date}` : `已撤销 ${date} 的打卡`,
        'success',
      );
    } catch (reason) {
      toast(formatError(reason), 'danger');
    }
  };

  const openLinkedHabit = (habit: Habit) => {
    setEditing(habit);
    setDialogOpen(true);
  };

  const arrange = async (habit: Habit) => {
    const now = Date.now();
    if (
      arrangeLockRef.current.has(habit.id) ||
      now - (arrangeCooldownRef.current.get(habit.id) ?? 0) < 1000
    ) {
      return;
    }
    arrangeCooldownRef.current.set(habit.id, now);
    arrangeLockRef.current.add(habit.id);
    setBusyHabitId(habit.id);
    try {
      const { task } = await store.arrangeAction(habit);
      toast(`已加入今天任务：${task.title}`, 'success');
    } catch (reason) {
      toast(formatError(reason), 'danger');
    } finally {
      arrangeLockRef.current.delete(habit.id);
      setBusyHabitId(null);
    }
  };

  const weekly = weeklyCompletion(
    store.habits,
    store.logsByHabit,
    store.today,
  );
  const longest = longestBest(store.habits, store.logsByHabit, store.today);

  return (
    <section className="page habits-page" aria-labelledby="habits-title">
      <header className="habit-page-head">
        <div>
          <p className="habit-eyebrow">节奏 · 习惯</p>
          <h1 id="habits-title">习惯</h1>
          <p className="habit-page-sub">
            连续记录，也允许偶尔中断后重新开始。习惯只记录节奏，不会自动生成每日任务。
          </p>
        </div>
        <div className="habit-page-actions">
          <button
            type="button"
            className="habit-button habit-button--primary"
            onClick={openNew}
          >
            ＋ 新习惯
          </button>
        </div>
      </header>

      {store.status === 'unavailable' ? (
        <div className="habit-state-card" role="status">
          <span className="habit-state-mark" aria-hidden="true">
            库
          </span>
          <h2>需在桌面壳内使用本地习惯库</h2>
          <p>
            习惯与打卡记录保存在本机 SQLite，浏览器预览没有 Tauri IPC
            通道。请使用
            <code>pnpm --filter app tauri dev</code>
            启动桌面壳后再使用习惯。
          </p>
          <p className="habit-state-note">
            这里不会回退到 localStorage，也不会生成演示数据。
          </p>
        </div>
      ) : null}

      {store.status === 'loading' ? (
        <div className="habit-state-card" role="status" aria-live="polite">
          <h2>正在读取本地习惯库…</h2>
          <p>习惯、打卡记录和本周节奏都从本机 SQLite 读取。</p>
        </div>
      ) : null}

      {store.status === 'error' ? (
        <div className="habit-state-card" role="alert">
          <h2>习惯库读取失败</h2>
          <p>{store.error ?? '未知错误，请稍后重试。'}</p>
          <button
            type="button"
            className="habit-button"
            onClick={() => {
              void store.refresh().catch(() => undefined);
            }}
          >
            重试
          </button>
        </div>
      ) : null}

      {store.status === 'ready' ? (
        <>
          <div className="habit-summary">
            <div className="habit-summary-main">
              <b>本周节奏</b>
              <span data-testid="habit-week-rate">
                {weekly.checked} / {weekly.total} 次 · 完成度 {weekly.percent}%
              </span>
            </div>
            <div
              className="habit-progress"
              role="progressbar"
              aria-label="本周习惯完成率"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={weekly.percent}
            >
              <i style={{ width: `${weekly.percent}%` }} />
            </div>
            <div className="habit-summary-stats">
              <div>
                <b data-testid="habit-week-checks">{weekly.checked}</b>
                本周打卡
              </div>
              <div>
                <b data-testid="habit-longest-best">{longest}</b>
                最长连续
              </div>
              <div>
                <b>{store.habits.length}</b>
                个习惯
              </div>
            </div>
          </div>

          {store.habits.length === 0 ? (
            <div className="habit-empty">
              <span className="habit-empty-icon">
                <HabitIcon icon={DEFAULT_HABIT_ICON} size={26} />
              </span>
              <h2>还没有习惯</h2>
              <p>先新建一个想持续记录的小习惯；需要具体行动时再用「安排行动」。</p>
              <button
                type="button"
                className="habit-button habit-button--primary"
                onClick={openNew}
              >
                ＋ 新建第一个习惯
              </button>
            </div>
          ) : (
            <>
              <HabitHeatmap
                habits={store.habits}
                logsByHabit={store.logsByHabit}
                today={store.today}
                month={store.month}
                onMonthChange={store.setMonth}
                onToggle={(habit, date) => void toggle(habit, date)}
              />

              <div className="habit-list" aria-label="习惯列表">
                {store.habits.map((habit) => (
                  <HabitRow
                    key={habit.id}
                    habit={habit}
                    logs={store.logsByHabit[habit.id]}
                    today={store.today}
                    busy={busyHabitId === habit.id}
                    onToggle={(date) => void toggle(habit, date)}
                    onArrange={() => void arrange(habit)}
                    onEdit={() => openEdit(habit)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      ) : null}

      <HabitsDeepLink
        ready={store.status === 'ready'}
        habits={store.habits}
        onOpen={openLinkedHabit}
        onMissing={() => toast('习惯不存在或已被删除', 'danger')}
      />

      <HabitDialog
        open={dialogOpen}
        habit={editing}
        onClose={() => setDialogOpen(false)}
        onSave={saveHabit}
        onDelete={editing ? deleteHabit : undefined}
      />
    </section>
  );
}

type HabitsDeepLinkProps = {
  ready: boolean;
  habits: Habit[];
  onOpen: (habit: Habit) => void;
  onMissing: () => void;
};

/**
 * 搜索结果 `/habits?habit=<id>` 深链。
 *
 * `HabitsPage` 也被不包 Router 的单元测试直接渲染，所以先用
 * `useInRouterContext` 判断，再在子组件里调用 `useSearchParams`，避免为测试
 * 强行加路由依赖。
 */
function HabitsDeepLink(props: HabitsDeepLinkProps) {
  const inRouter = useInRouterContext();
  if (!inRouter) {
    return null;
  }
  return <HabitsDeepLinkRouter {...props} />;
}

function HabitsDeepLinkRouter({
  ready,
  habits,
  onOpen,
  onMissing,
}: HabitsDeepLinkProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const handled = useRef<string | null>(null);

  useEffect(() => {
    const habitId = searchParams.get('habit');
    if (!habitId) {
      handled.current = null;
      return;
    }
    if (!ready || handled.current === habitId) {
      return;
    }
    handled.current = habitId;
    const habit = habits.find((item) => item.id === habitId);
    if (habit) {
      onOpen(habit);
    } else {
      onMissing();
    }
    const next = new URLSearchParams(searchParams);
    next.delete('habit');
    setSearchParams(next, { replace: true });
  }, [ready, habits, onOpen, onMissing, searchParams, setSearchParams]);

  return null;
}
