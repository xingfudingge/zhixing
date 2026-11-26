/**
 * 「重置全部业务数据」确认弹层（AUD-005）。
 *
 * 只有用户勾选“不可撤销”并点击确认后才会调用重置目标；失败时保持弹层
 * 打开并明确提示事务已回滚，不把失败显示成成功。重置前提供导出 ZIP 备份
 * 的入口，避免用户在没有备份的情况下误操作。
 */

import { useEffect, useId, useMemo, useState, type RefObject } from 'react';

import { Modal } from '../../app/a11y';
import type { BusinessResetTarget, ResetDomainReport } from './reset';

export type ResetDataDialogProps = {
  open: boolean;
  target: BusinessResetTarget | null;
  onClose: () => void;
  onReset: (report: ResetDomainReport) => void;
  /** 打开后由面板执行完整的 ZIP 导出；返回是否成功。 */
  onBackup?: () => Promise<boolean>;
  /** 本次会话上次导出的说明，用于提醒用户先备份。 */
  lastBackupLabel?: string | null;
  returnFocusRef?: RefObject<HTMLElement | null>;
};

function formatError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '操作失败，请重试';
}

type Busy = 'backup' | 'reset' | null;

export function ResetDataDialog({
  open,
  target,
  onClose,
  onReset,
  onBackup,
  lastBackupLabel = null,
  returnFocusRef,
}: ResetDataDialogProps) {
  const ackId = useId();
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [backupNote, setBackupNote] = useState<string | null>(null);
  const [report, setReport] = useState<ResetDomainReport | null>(null);

  useEffect(() => {
    if (!open) return;
    setAcknowledged(false);
    setBusy(null);
    setError(null);
    setBackupNote(null);
    setReport(null);
  }, [open]);

  const backupBusy = busy === 'backup';
  const resetting = busy === 'reset';
  const finished = report !== null;
  const canReset =
    Boolean(target) && acknowledged && busy === null && !finished;

  const backupHint = useMemo(() => {
    if (backupNote) return backupNote;
    return lastBackupLabel
      ? `本会话上次导出：${lastBackupLabel}`
      : '本会话尚未导出完整备份。';
  }, [backupNote, lastBackupLabel]);

  const handleBackup = async () => {
    if (!onBackup || busy !== null) return;
    setBusy('backup');
    setError(null);
    try {
      const ok = await onBackup();
      setBackupNote(
        ok
          ? '已生成 ZIP 备份；请确认下载文件可以打开后再重置。'
          : '未能完成备份，请先处理导出错误；重置仍会继续删除业务数据。',
      );
    } catch (reason) {
      setBackupNote(`备份失败：${formatError(reason)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleReset = async () => {
    if (!target || !acknowledged || busy !== null || finished) return;
    setBusy('reset');
    setError(null);
    try {
      const result = await target.reset();
      setReport(result);
      onReset(result);
    } catch (reason) {
      setError(
        `重置失败，业务数据未改动（事务已回滚）：${formatError(reason)}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const footer = finished ? (
    <button type="button" className="settings-button" onClick={onClose}>
      完成
    </button>
  ) : (
    <>
      <button
        type="button"
        className="settings-button"
        onClick={onClose}
        disabled={busy !== null}
      >
        取消
      </button>
      <button
        type="button"
        className="settings-button"
        onClick={() => {
          void handleBackup();
        }}
        disabled={busy !== null || !onBackup}
      >
        {backupBusy ? '正在导出…' : '先导出 ZIP 备份'}
      </button>
      <button
        type="button"
        className="settings-button settings-button--danger"
        onClick={() => {
          void handleReset();
        }}
        disabled={!canReset}
      >
        {resetting ? '重置中…' : '确认重置业务数据'}
      </button>
    </>
  );

  return (
    <Modal
      open={open}
      title="重置全部业务数据"
      description="清空任务、笔记、画板、日历、习惯、专注与复盘业务表，并重新写入初始示例。此操作不可撤销。"
      onClose={onClose}
      footer={footer}
      busy={busy !== null}
      closeLabel="关闭重置确认"
      returnFocusRef={returnFocusRef}
    >
      <div className="backup-reset" aria-busy={busy !== null || undefined}>
        <div className="backup-reset-warning" role="note">
          <b>重置前请先导出完整备份</b>
          <span>
            建议先导出 ZIP 并确认文件可以打开。重置不会保留任何任务、笔记、
            画板或附件元数据。
          </span>
          <span className="backup-muted">{backupHint}</span>
        </div>

        <div className="backup-reset-columns">
          <section aria-labelledby="reset-cleared-title">
            <h3 id="reset-cleared-title">会被清空</h3>
            <ul>
              <li>任务、子任务、清单与笔记待办</li>
              <li>笔记正文、块、附件元数据与复盘快照</li>
              <li>画板、节点与连线</li>
              <li>日历事件、倒数日、习惯与打卡、专注记录</li>
            </ul>
          </section>
          <section aria-labelledby="reset-preserved-title">
            <h3 id="reset-preserved-title">会保留</h3>
            <ul>
              <li>设备偏好与空间偏好（不随业务库清除）</li>
              <li>外观、编辑器、默认清单、同步等设备/空间偏好</li>
              <li>数据库文件与 schema 版本，不会重建数据库</li>
            </ul>
          </section>
        </div>

        <label className="backup-reset-ack" htmlFor={ackId}>
          <input
            id={ackId}
            type="checkbox"
            checked={acknowledged}
            disabled={busy !== null || finished}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          我已了解重置不可撤销，并已导出需要保留的数据
        </label>

        {!target ? (
          <p className="settings-error" role="alert">
            当前环境没有可用的业务数据重置目标（需要桌面壳内的 SQLite 业务库）。
          </p>
        ) : null}

        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}

        {report ? (
          <div className="backup-success" role="status">
            <b>业务数据已重置</b>
            <span>
              已删除 {report.deletedRows} 行业务数据，写入{' '}
              {report.samplesInserted} 条初始示例；保留{' '}
              {report.preservedSettings} 条设备/空间偏好。
            </span>
            <span>设备偏好未改动。关闭后进入今天/知识/日历即读取种子数据。</span>
          </div>
        ) : null}

        {busy !== null ? (
          <p className="backup-muted" role="status" aria-live="polite">
            {backupBusy
              ? '正在生成完整备份，请保持窗口打开…'
              : '正在清空业务表并写入种子；事务未提交前不会改动磁盘数据…'}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
