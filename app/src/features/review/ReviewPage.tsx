/**
 * 复盘页（P0-09）：最近 7 天三卡、日柱状图、最近完成、专注 Top5 与
 * 保存复盘笔记。
 *
 * 页面只消费 `ReviewRepository`：
 * * 统计来自任务 / 专注 / 习惯事实行，编辑复盘正文不会反算统计；
 * * 保存由后端单事务创建「复盘笔记 + 快照」，同范围幂等；
 * * 浏览器预览没有 IPC 时明确提示，不展示伪造数据。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { isTauriRuntime } from '../../data/db/client';
import type { ReviewRepository } from '../../data/repositories/review';
import { repositories } from '../../data/repositories';
import { notifyNotesChanged } from '../notes/createFromTask';
import {
  barPercent,
  focusCardValue,
  formatDuration,
  metricMax,
  metricValue,
  REVIEW_METRICS,
  type ReviewAggregate,
  type ReviewDay,
  type ReviewMetric,
} from './model';
import './review.css';

export type ReviewPageProps = {
  /** 测试注入；不传时使用真实 SQLite 仓储。 */
  source?: ReviewRepository;
  /** 固定“今天”，测试可注入稳定日期。 */
  today?: string;
  /** 默认最近 7 天。 */
  days?: number;
};

type Status = 'loading' | 'ready' | 'unavailable' | 'error';

type Notice = {
  tone: 'success' | 'danger';
  message: string;
};

function formatError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '读取复盘数据失败，请重试';
}

function dayLabel(day: ReviewDay): string {
  return `${day.weekday} ${day.date.slice(5)}`;
}

function MiniBars({
  days,
  metric,
  label,
}: {
  days: ReviewDay[];
  metric: ReviewMetric;
  label: string;
}) {
  const max = metricMax(days, metric);
  return (
    <div className="review-mini-bars" aria-hidden="true">
      {days.map((day) => {
        const value = metricValue(day, metric);
        return (
          <span className="review-mini-track" key={day.date}>
            <span
              className={`review-mini-bar review-mini-bar--${metric}${
                value === 0 ? ' is-empty' : ''
              }`}
              data-date={day.date}
              data-metric={metric}
              data-value={value}
              data-percent={barPercent(value, max)}
              title={`${dayLabel(day)} · ${label} ${value}`}
              style={{ height: `${barPercent(value, max)}%` }}
            />
          </span>
        );
      })}
    </div>
  );
}

function StatCard({
  metric,
  label,
  value,
  unit,
  sub,
  days,
}: {
  metric: ReviewMetric;
  label: string;
  value: string;
  unit: string;
  sub: string;
  days: ReviewDay[];
}) {
  return (
    <article className="review-stat" aria-label={label}>
      <p className="review-stat-label">{label}</p>
      <p className="review-stat-value">
        <strong>{value}</strong>
        <span>{unit}</span>
      </p>
      <p className="review-stat-sub">{sub}</p>
      <MiniBars days={days} metric={metric} label={label} />
    </article>
  );
}

export function ReviewPage({
  source,
  today,
  days = 7,
}: ReviewPageProps = {}) {
  const navigate = useNavigate();
  const activeSource = source ?? repositories.review;
  const available = source !== undefined || isTauriRuntime();
  const [status, setStatus] = useState<Status>(
    available ? 'loading' : 'unavailable',
  );
  const [aggregate, setAggregate] = useState<ReviewAggregate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<ReviewMetric>('tasks');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!available) {
      setStatus('unavailable');
      return;
    }
    setStatus((current) => (current === 'ready' ? 'ready' : 'loading'));
    try {
      const next = await activeSource.load({ today, days });
      setAggregate(next);
      setError(null);
      setStatus('ready');
    } catch (reason) {
      setError(formatError(reason));
      setStatus('error');
    }
  }, [activeSource, available, days, today]);

  useEffect(() => {
    void load();
  }, [load]);

  const metricConfig = useMemo(
    () => REVIEW_METRICS.find((item) => item.value === metric) ?? REVIEW_METRICS[0],
    [metric],
  );

  const save = async () => {
    if (!aggregate || saving) {
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const saved = await activeSource.save(aggregate);
      notifyNotesChanged(saved.note.id);
      setNotice({
        tone: 'success',
        message: saved.created
          ? `已保存「${saved.note.title}」`
          : `已打开同范围复盘「${saved.note.title}」`,
      });
      navigate(`/knowledge?note=${encodeURIComponent(saved.note.id)}`);
    } catch (reason) {
      setNotice({ tone: 'danger', message: formatError(reason) });
    } finally {
      setSaving(false);
    }
  };

  const focusValue = aggregate
    ? focusCardValue(aggregate.totals.focusMinutes)
    : focusCardValue(0);
  const chartMax = aggregate ? metricMax(aggregate.days, metric) : 1;

  return (
    <div className="page review-page">
      <header className="review-head">
        <div>
          <p className="review-eyebrow">节奏 · 复盘</p>
          <h1>复盘</h1>
          <p className="review-sub">
            回看最近 7 天的任务完成、专注与习惯打卡；复盘只做汇总，
            不会反写任务、专注或习惯记录。
          </p>
        </div>
        <div className="review-actions">
          <button
            type="button"
            className="review-button"
            onClick={() => navigate('/habits')}
          >
            看习惯
          </button>
          <button
            type="button"
            className="review-button"
            onClick={() => navigate('/focus')}
          >
            看专注
          </button>
          <button
            type="button"
            className="review-button review-button--primary"
            disabled={!aggregate || saving || status !== 'ready'}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存为复盘笔记'}
          </button>
        </div>
      </header>

      {status === 'unavailable' ? (
        <div className="review-banner" role="status">
          <strong>浏览器预览</strong>
          <span>
            复盘统计需要读取本机 SQLite；请在桌面壳内打开。这里不会用
            localStorage 伪造数据。
          </span>
        </div>
      ) : null}

      {status === 'loading' ? (
        <div className="review-state-card" role="status" aria-live="polite">
          <h2>正在汇总最近 7 天…</h2>
          <p>任务完成、专注记录与习惯打卡会从各自事实行读取。</p>
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="review-state-card review-state-card--danger" role="alert">
          <h2>复盘读取失败</h2>
          <p>{error ?? '未知错误，请稍后重试。'}</p>
          <button
            type="button"
            className="review-button"
            onClick={() => void load()}
          >
            重试
          </button>
        </div>
      ) : null}

      {notice ? (
        <p
          className={`review-notice review-notice--${notice.tone}`}
          role="status"
        >
          {notice.message}
        </p>
      ) : null}

      {status === 'ready' && aggregate ? (
        <>
          <section className="review-stats" aria-label="最近 7 天统计">
            <StatCard
              metric="tasks"
              label="完成任务"
              value={String(aggregate.totals.tasks)}
              unit="项"
              sub={`最近 7 天 · 共 ${aggregate.totals.tasks} 项已完成`}
              days={aggregate.days}
            />
            <StatCard
              metric="focus"
              label="专注时长"
              value={focusValue.value}
              unit={focusValue.unit}
              sub={`${aggregate.sourceIds.focusIds.length} 段记录 · ${formatDuration(
                aggregate.totals.focusMinutes,
              )}`}
              days={aggregate.days}
            />
            <StatCard
              metric="habits"
              label="习惯打卡"
              value={String(aggregate.totals.habits)}
              unit="次"
              sub={`${aggregate.habitCount} 个习惯 · 最近 7 天`}
              days={aggregate.days}
            />
          </section>

          <section
            className="review-chart-card"
            aria-labelledby="review-chart-title"
          >
            <header className="review-chart-head">
              <div>
                <h2 id="review-chart-title">每日趋势</h2>
                <p>{aggregate.rangeLabel} · 今天柱与上方三卡同源</p>
              </div>
              <div className="review-metrics" role="group" aria-label="柱状图指标">
                {REVIEW_METRICS.map((item) => (
                  <button
                    type="button"
                    key={item.value}
                    className={`review-metric${
                      metric === item.value ? ' is-active' : ''
                    }`}
                    aria-pressed={metric === item.value}
                    onClick={() => setMetric(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </header>

            <div
              className="review-chart"
              role="img"
              aria-label={`${metricConfig.label}日柱状图`}
            >
              {aggregate.days.map((day) => {
                const value = metricValue(day, metric);
                const isToday = day.date === aggregate.range.to;
                return (
                  <div className="review-chart-col" key={day.date}>
                    <span className="review-chart-value">
                      {value > 0 ? value : ''}
                    </span>
                    <span className="review-chart-track">
                      <span
                        className={`review-chart-bar review-chart-bar--${metric}${
                          isToday ? ' is-today' : ''
                        }${value === 0 ? ' is-empty' : ''}`}
                        data-date={day.date}
                        data-metric={metric}
                        data-value={value}
                        data-percent={barPercent(value, chartMax)}
                        title={`${dayLabel(day)} · ${metricConfig.label} ${value}`}
                        style={{ height: `${barPercent(value, chartMax)}%` }}
                      />
                    </span>
                    <span
                      className={`review-chart-label${isToday ? ' is-today' : ''}`}
                    >
                      <b>{day.weekday}</b>
                      <small>{day.date.slice(5)}</small>
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="review-lists">
            <section className="review-list-card" aria-labelledby="review-completed-title">
              <header className="review-list-head">
                <h2 id="review-completed-title">最近完成</h2>
                <span>{aggregate.totals.tasks} 项</span>
              </header>
              {aggregate.recentCompleted.length === 0 ? (
                <p className="review-empty">这段时间还没有完成任务</p>
              ) : (
                <ul className="review-rows">
                  {aggregate.recentCompleted.map((item) => (
                    <li key={item.id} className="review-row">
                      <span className="review-row-main">
                        <b>{item.title}</b>
                        <small>{item.listName}</small>
                      </span>
                      <span className="review-row-meta">
                        {item.completedDate}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="review-list-card" aria-labelledby="review-focus-title">
              <header className="review-list-head">
                <h2 id="review-focus-title">专注 Top 5</h2>
                <span>{formatDuration(aggregate.totals.focusMinutes)}</span>
              </header>
              {aggregate.focusTop.length === 0 ? (
                <p className="review-empty">还没有专注记录</p>
              ) : (
                <ul className="review-rows">
                  {aggregate.focusTop.map((item, index) => (
                    <li key={item.taskId} className="review-row review-focus-row">
                      <span className="review-focus-index">{index + 1}</span>
                      <span className="review-row-main">
                        <b>{item.title}</b>
                        <span className="review-focus-track" aria-hidden="true">
                          <span
                            className="review-focus-fill"
                            style={{ width: `${item.share}%` }}
                          />
                        </span>
                      </span>
                      <span className="review-row-meta">{item.minutes} 分钟</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section className="review-note-card">
            <div>
              <h2>保存为复盘笔记</h2>
              <p>
                创建「{aggregate.note.title}」，正文包含范围、三卡数字、分日明细
                与任务 / 专注 / 习惯来源 ID。同范围重复保存会打开已有笔记，
                不会生成第二份快照；之后编辑笔记正文也不会改变这里的统计。
              </p>
            </div>
            <button
              type="button"
              className="review-button review-button--primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '保存本次复盘'}
            </button>
          </section>
        </>
      ) : null}
    </div>
  );
}
