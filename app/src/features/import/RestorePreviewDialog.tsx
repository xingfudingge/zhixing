/**
 * 恢复预览对话框（P2-04）。
 *
 * 打开前只解析与校验；打开后展示新增/冲突/阻止/附件校验结果。所有冲突
 * 默认「跳过（保留本机）」；覆盖需要额外勾选确认。点击「确认恢复」后才
 * 调用 RestoreTarget 写库，写入过程与失败都会逐项报告。
 */

import { useEffect, useMemo, useState, type RefObject } from 'react';

import { Modal } from '../../app/a11y';
import type {
  BackupDataset,
  ParsedBackup,
  RestoreApplyResult,
  RestoreChoice,
  RestoreDecision,
  RestoreSummary,
  RestoreTarget,
} from '../export/types';
import { formatDateTime } from '../export/utils';
import {
  applyRestorePlan,
  operationLabel,
  planRestore,
} from './planRestore';

export type RestorePreviewDialogProps = {
  open: boolean;
  parsed: ParsedBackup | null;
  local: BackupDataset | null;
  target: RestoreTarget | null;
  onClose: () => void;
  onApplied: (summary: RestoreSummary, result: RestoreApplyResult) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

const CHOICE_LABELS: Record<RestoreChoice, string> = {
  skip: '跳过（保留本机）',
  overwrite: '覆盖本机',
  'keep-both': '保留两者',
};

export function RestorePreviewDialog({
  open,
  parsed,
  local,
  target,
  onClose,
  onApplied,
  returnFocusRef,
}: RestorePreviewDialogProps) {
  const [decisions, setDecisions] = useState<RestoreDecision>({});
  const [allowOverwrite, setAllowOverwrite] = useState(false);
  const [restoreAppearance, setRestoreAppearance] = useState(true);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<{
    applied: number;
    total: number;
    label: string;
  } | null>(null);
  const [result, setResult] = useState<RestoreApplyResult | null>(null);
  const [summary, setSummary] = useState<RestoreSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDecisions({});
    setAllowOverwrite(false);
    setRestoreAppearance(true);
    setApplying(false);
    setProgress(null);
    setResult(null);
    setSummary(null);
    setError(null);
  }, [open, parsed]);

  const warnings = useMemo(
    () => parsed?.warnings.map((item) => item.message) ?? [],
    [parsed],
  );

  const plan = useMemo(() => {
    if (!parsed || !local) return null;
    return planRestore(parsed, local, {
      decisions,
      restoreAppearance,
      warnings,
    });
  }, [parsed, local, decisions, restoreAppearance, warnings]);

  if (!open || !parsed || !local || !plan) {
    return null;
  }

  const conflictCount = plan.conflicts.length;
  const busy = applying;
  const canApply =
    Boolean(target) && plan.operations.length > 0 && !busy && result === null;
  const done = result !== null && result.error === null;
  const finished = result !== null;

  const choose = (key: string, choice: RestoreChoice) => {
    setDecisions((current) => ({ ...current, [key]: choice }));
  };

  const handleAllowOverwrite = (next: boolean) => {
    setAllowOverwrite(next);
    if (!next) {
      setDecisions((current) => {
        const updated: RestoreDecision = { ...current };
        for (const [key, value] of Object.entries(updated)) {
          if (value === 'overwrite') updated[key] = 'skip';
        }
        return updated;
      });
    }
  };

  const apply = async () => {
    if (!target || busy) return;
    setApplying(true);
    setError(null);
    setProgress({ applied: 0, total: plan.operations.length, label: '准备写入' });
    const applied = await applyRestorePlan(plan, target, {
      onProgress: setProgress,
    });
    setApplying(false);
    setResult(applied);
    if (applied.error) {
      setError(
        `恢复在第 ${applied.applied + 1} 项停止：${applied.error}${
          applied.stoppedAt ? `（${applied.stoppedAt}）` : ''
        }`,
      );
      return;
    }
    setSummary(plan.summary);
    onApplied(plan.summary, applied);
  };

  const footer = done ? (
    <button type="button" className="settings-button" onClick={onClose}>
      完成
    </button>
  ) : (
    <>
      <button
        type="button"
        className="settings-button"
        onClick={onClose}
        disabled={busy}
      >
        取消
      </button>
      <button
        type="button"
        className="settings-button settings-button--primary"
        onClick={() => {
          void apply();
        }}
        disabled={!canApply}
      >
        {busy ? '恢复中…' : '确认恢复'}
      </button>
    </>
  );

  return (
    <Modal
      open={open}
      title="恢复预览"
      description={`来自 ${parsed.format.toUpperCase()} 备份 · 导出于 ${formatDateTime(
        parsed.payload.exportedAt,
      )}。默认跳过所有冲突，不会静默覆盖本机数据。`}
      onClose={onClose}
      footer={footer}
      busy={busy}
      size="lg"
      closeLabel="关闭恢复预览"
      returnFocusRef={returnFocusRef}
    >
      <div className="backup-preview" aria-busy={busy || undefined}>
        <div className="backup-summary-grid" aria-label="恢复摘要">
          <SummaryTile label="新增" value={plan.summary.create} tone="ok" />
          <SummaryTile label="更新" value={plan.summary.update} tone="accent" />
          <SummaryTile
            label="移入回收站"
            value={plan.summary.delete}
            tone="warn"
          />
          <SummaryTile label="跳过" value={plan.summary.skip} />
          <SummaryTile label="阻止" value={plan.summary.blocked} tone="danger" />
          <SummaryTile label="未变化" value={plan.summary.unchanged} />
        </div>

        <p className="backup-inline-note">
          对象总数 {plan.summary.create + plan.summary.update + plan.summary.unchanged} · 冲突{' '}
          {conflictCount} · 附件二进制 {plan.summary.attachmentsWithBlob} 个，
          仅元数据 {plan.summary.attachmentsWithoutBlob} 个 · 操作{' '}
          {plan.operations.length} 步
        </p>

        {error ? (
          <div className="settings-banner is-error" role="alert">
            <b>恢复未完整完成</b>
            <span>{error}</span>
          </div>
        ) : null}

        {done && summary ? (
          <div className="backup-success" role="status">
            <b>恢复完成</b>
            <span>
              新增 {summary.create} · 更新 {summary.update} · 回收站{' '}
              {summary.delete} · 跳过 {summary.skip} · 阻止 {summary.blocked}
            </span>
            <span>已写入 {result?.applied ?? 0} 项操作。</span>
          </div>
        ) : null}

        {warnings.length > 0 || plan.warnings.length > 0 || plan.blocked.length > 0 ? (
          <details className="backup-details" open={plan.blocked.length > 0}>
            <summary>
              校验与阻止项（{plan.blocked.length} 个阻止，{' '}
              {new Set([...warnings, ...plan.warnings]).size} 条提示）
            </summary>
            <ul className="backup-issue-list">
              {plan.blocked.map((item) => (
                <li key={item.key} className="is-blocked">
                  <b>{item.label}</b>
                  <span>{item.reason}</span>
                </li>
              ))}
              {Array.from(new Set([...warnings, ...plan.warnings])).map((item) => (
                <li key={item}>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <section className="backup-conflicts" aria-labelledby="backup-conflicts-title">
          <div className="backup-section-head">
            <h3 id="backup-conflicts-title">冲突处理</h3>
            <label className="backup-overwrite-toggle">
              <input
                type="checkbox"
                checked={allowOverwrite}
                disabled={busy || finished}
                onChange={(event) =>
                  handleAllowOverwrite(event.target.checked)
                }
              />
              允许覆盖本机同 ID 对象（不可撤销）
            </label>
          </div>

          {plan.conflicts.length === 0 ? (
            <p className="backup-empty">没有冲突；新增对象会直接写入。</p>
          ) : (
            <div className="backup-conflict-list">
              {plan.conflicts.map((conflict) => {
                const selected =
                  decisions[conflict.key] ?? conflict.defaultChoice;
                return (
                  <fieldset
                    key={conflict.key}
                    className="backup-conflict"
                    aria-label={conflict.label}
                  >
                    <legend>
                      <span className="backup-conflict-label">
                        {conflict.label}
                      </span>
                      <span className="backup-conflict-meta">
                        {conflict.localDeleted || conflict.backupDeleted
                          ? '涉及回收站状态 · '
                          : ''}
                        {conflict.choices.length === 1
                          ? '仅支持跳过'
                          : '请选择处理方式'}
                      </span>
                    </legend>
                    <div className="backup-conflict-compare">
                      <div>
                        <span className="backup-compare-label">本机</span>
                        <span>{conflict.localLabel}</span>
                        <span className="backup-compare-detail">
                          {conflict.localDetail}
                        </span>
                      </div>
                      <div>
                        <span className="backup-compare-label">备份</span>
                        <span>{conflict.backupLabel}</span>
                        <span className="backup-compare-detail">
                          {conflict.backupDetail}
                        </span>
                      </div>
                    </div>
                    {conflict.reason ? (
                      <p className="backup-conflict-reason">{conflict.reason}</p>
                    ) : null}
                    <div className="backup-choice-row">
                      {conflict.choices.map((choice) => {
                        const disabled =
                          busy ||
                          finished ||
                          (choice === 'overwrite' && !allowOverwrite);
                        return (
                          <label
                            key={choice}
                            className={
                              disabled
                                ? 'backup-choice is-disabled'
                                : 'backup-choice'
                            }
                          >
                            <input
                              type="radio"
                              name={conflict.key}
                              value={choice}
                              checked={selected === choice}
                              disabled={disabled}
                              onChange={() => choose(conflict.key, choice)}
                            />
                            {CHOICE_LABELS[choice]}
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>
                );
              })}
            </div>
          )}
        </section>

        <section className="backup-appearance" aria-label="外观偏好">
          <label>
            <input
              type="checkbox"
              checked={restoreAppearance}
              disabled={busy || finished || !parsed.payload.appearance}
              onChange={(event) => setRestoreAppearance(event.target.checked)}
            />
            恢复备份中的外观偏好（主题 / 强调色 / 密度）
          </label>
          {!parsed.payload.appearance ? (
            <span className="backup-muted">备份没有外观偏好</span>
          ) : null}
        </section>

        {progress ? (
          <div className="backup-progress" role="status" aria-live="polite">
            <progress
              value={progress.total === 0 ? 0 : progress.applied}
              max={Math.max(1, progress.total)}
            />
            <span>
              {progress.applied} / {progress.total} · {progress.label}
            </span>
          </div>
        ) : null}

        {!target ? (
          <p className="settings-error" role="alert">
            当前环境没有可用的恢复写入目标（完整恢复需要桌面壳）。
          </p>
        ) : null}

        {plan.operations.length === 0 && !done ? (
          <p className="backup-muted">
            没有可写入的变更；所有对象都选择跳过或与
            {' '}
            本机一致。
          </p>
        ) : null}

        {busy ? (
          <p className="backup-muted">
            正在写入，请保持窗口打开。Esc 与关闭按钮已暂时禁用。
          </p>
        ) : null}

        <details className="backup-details">
          <summary>查看恢复步骤（{plan.operations.length} 步）</summary>
          <ol className="backup-operation-list">
            {plan.operations.map((operation, index) => (
              <li key={`${operation.type}-${index}`}>
                {operationLabel(operation)}
              </li>
            ))}
          </ol>
        </details>
      </div>
    </Modal>
  );
}

function SummaryTile({
  label,
  value,
  tone = 'muted',
}: {
  label: string;
  value: number;
  tone?: 'ok' | 'accent' | 'warn' | 'danger' | 'muted';
}) {
  return (
    <div className={`backup-summary-tile is-${tone}`}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}
