/**
 * 设置页「数据与备份」面板（P2-04）。
 *
 * - 备份与恢复（可回导）：ZIP 完整备份（含附件与校验）、从备份恢复；
 * - 单向导出（不可回导）：结构化数据 JSON、Markdown、CSV、PDF；
 * - 诊断：下载脱敏后的耗时/错误环形缓冲区。
 *
 * 浏览器预览没有 SQLite 业务库：这里显示“需桌面壳”，不伪造可用的
 * 完整备份入口；偏好备份仍在 DataGroup 上方独立工作。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { isTauriRuntime } from '../../data/db/client';
import { db } from '../../data/db/client';
import {
  IndexedDbAttachmentStateStore,
  IndexedDbBlobStore,
  isIndexedDbAvailable,
  type AttachmentStateStore,
  type BlobStore,
} from '../attachments/blobStore';
import { SettingsRow } from '../settings/groups/Controls';
import {
  createDbRestoreTarget,
} from '../import/restoreTarget';
import { parseBackupFile } from '../import/parseBackup';
import { RestorePreviewDialog } from '../import/RestorePreviewDialog';
import { createDefaultBackupSource } from './collect';
import { browserDownloader } from './download';
import { backupTimestamp, sanitizeFileName } from './sanitize';
import {
  buildCsvArchive,
  buildJsonBackup,
  buildMarkdownExport,
  buildZipBackup,
} from './serialize';
import { buildPdfExport, PdfUnavailableError } from './pdf';
import { monitor, runDiagnosticsDownload } from './monitoring';
import {
  createDefaultResetTarget,
  type BusinessResetTarget,
  type ResetDomainReport,
} from './reset';
import { ResetDataDialog } from './ResetDataDialog';
import type {
  BackupDataset,
  BackupSource,
  FileDownloader,
  ParsedBackup,
  RestoreTarget,
} from './types';
import { formatBytes } from './utils';
import './export.css';

export const DATA_RESTORED_EVENT = 'zhixing:data-restored';
export const DATA_RESET_EVENT = 'zhixing:data-reset';

export type DataBackupPanelProps = {
  /** 不传时：桌面壳自动装配 SQLite 源；浏览器为 null。传 null 可强制不可用。 */
  source?: BackupSource | null;
  /** 不传时：桌面壳自动装配写入目标；浏览器为 null。 */
  target?: RestoreTarget | null;
  /** 不传时：桌面壳自动装配业务数据重置命令；浏览器为 null。 */
  resetTarget?: BusinessResetTarget | null;
  blobStore?: BlobStore;
  stateStore?: AttachmentStateStore;
  downloader?: FileDownloader;
  now?: () => Date;
};

type ExportKind = 'zip' | 'json' | 'markdown' | 'csv' | 'pdf';

const EXPORT_LABELS: Record<ExportKind, string> = {
  zip: 'ZIP 完整备份',
  json: '结构化数据（JSON）',
  markdown: 'Markdown',
  csv: 'CSV',
  pdf: 'PDF',
};

function formatError(reason: unknown): string {
  if (reason instanceof PdfUnavailableError) {
    return `${reason.message}；请改用 Markdown、CSV 或 ZIP。`;
  }
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '操作失败，请重试';
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error('无法读取备份文件'));
      }
    };
    reader.onerror = () => reject(new Error('无法读取备份文件'));
    reader.readAsArrayBuffer(file);
  });
}

function elapsed(started: number): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now() - started
    : Date.now() - started;
}

export function DataBackupPanel({
  source: sourceProp,
  target: targetProp,
  resetTarget: resetTargetProp,
  blobStore: blobStoreProp,
  stateStore: stateStoreProp,
  downloader: downloaderProp,
  now = () => new Date(),
}: DataBackupPanelProps) {
  const blobStore = useMemo<BlobStore | undefined>(() => {
    if (blobStoreProp) return blobStoreProp;
    return isIndexedDbAvailable() ? new IndexedDbBlobStore() : undefined;
  }, [blobStoreProp]);

  const stateStore = useMemo<AttachmentStateStore | undefined>(() => {
    if (stateStoreProp) return stateStoreProp;
    return isIndexedDbAvailable()
      ? new IndexedDbAttachmentStateStore()
      : undefined;
  }, [stateStoreProp]);

  const source = useMemo<BackupSource | null>(() => {
    if (sourceProp !== undefined) return sourceProp;
    return createDefaultBackupSource(db, blobStore);
  }, [sourceProp, blobStore]);

  const target = useMemo<RestoreTarget | null>(() => {
    if (targetProp !== undefined) return targetProp;
    if (!isTauriRuntime()) return null;
    return createDbRestoreTarget(db, {
      blobStore,
      stateStore,
    });
  }, [targetProp, blobStore, stateStore]);

  const resetTarget = useMemo<BusinessResetTarget | null>(() => {
    if (resetTargetProp !== undefined) return resetTargetProp;
    return createDefaultResetTarget();
  }, [resetTargetProp]);

  const downloader = downloaderProp ?? browserDownloader;
  const fileRef = useRef<HTMLInputElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const resetButtonRef = useRef<HTMLButtonElement>(null);
  const exportInFlightRef = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastExport, setLastExport] = useState<{
    kind: ExportKind;
    fileName: string;
    byteSize: number;
    durationMs: number;
    warnings: string[];
  } | null>(null);
  const [preview, setPreview] = useState<{
    parsed: ParsedBackup;
    local: BackupDataset;
  } | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [diagnosticsEnabled, setDiagnosticsEnabled] = useState(() =>
    monitor.isEnabled(),
  );

  useEffect(() => {
    const sync = () => setDiagnosticsEnabled(monitor.isEnabled());
    window.addEventListener('zhixing:monitoring-enabled', sync);
    return () => window.removeEventListener('zhixing:monitoring-enabled', sync);
  }, []);
  const [resetOpen, setResetOpen] = useState(false);

  const exportBackup = async (kind: ExportKind): Promise<boolean> => {
    if (!source || exportInFlightRef.current) return false;
    exportInFlightRef.current = true;
    const started = performance.now();
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const collected = await source.collect({
        includeBlobs: kind === 'zip',
      });
      const payload = collected.payload;
      let serialized;
      switch (kind) {
        case 'zip':
          serialized = await buildZipBackup(payload, collected.blobs, now());
          break;
        case 'json':
          serialized = buildJsonBackup(payload, now());
          break;
        case 'markdown':
          serialized = buildMarkdownExport(payload, now());
          break;
        case 'csv':
          serialized = buildCsvArchive(payload, now());
          break;
        case 'pdf':
          serialized = await buildPdfExport(payload, { now: now() });
          break;
      }
      const ok = await downloader({
        fileName: serialized.fileName,
        blob: new Blob([serialized.bytes.slice().buffer], {
          type: serialized.mime,
        }),
      });
      if (!ok) {
        throw new Error('当前环境无法自动下载文件；请使用桌面壳或允许下载');
      }
      const durationMs = elapsed(started);
      const warnings = [...collected.warnings, ...serialized.warnings];
      monitor.timing(`export.${kind}`, durationMs, {
        format: kind,
        byteSize: serialized.bytes.byteLength,
        warnings: warnings.length,
      });
      setLastExport({
        kind,
        fileName: serialized.fileName,
        byteSize: serialized.bytes.byteLength,
        durationMs,
        warnings,
      });
      setNotice(
        `已导出 ${EXPORT_LABELS[kind]}：${serialized.fileName}（${formatBytes(
          serialized.bytes.byteLength,
        )}，${Math.round(durationMs)} ms）`,
      );
      return true;
    } catch (reason) {
      const message = formatError(reason);
      monitor.error(`export.${kind}`, reason);
      setError(message);
      return false;
    } finally {
      exportInFlightRef.current = false;
      setBusy(null);
    }
  };

  const openPreview = async (file: File | undefined) => {
    if (!file) return;
    if (!source) {
      setError('完整数据恢复需要桌面壳内的 SQLite 业务库');
      return;
    }
    setBusy('parse');
    setError(null);
    setNotice(null);
    const started = performance.now();
    try {
      const bytes = await readFileBytes(file);
      const parsed = await parseBackupFile(bytes, file.name);
      const local = await source.collect({ includeBlobs: false });
      monitor.timing('restore.parse', elapsed(started), {
        format: parsed.format,
        entries: parsed.manifest.entries.length,
        bytes: bytes.byteLength,
      });
      setPreview({ parsed, local: local.payload.dataset });
      setRestoreOpen(true);
    } catch (reason) {
      const message = formatError(reason);
      monitor.error('restore.parse', reason);
      setError(message);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const downloadDiagnostics = async () => {
    setBusy('diagnostics');
    setError(null);
    try {
      if (!diagnosticsEnabled) {
        setError('请先在「设置 → 隐私与安全」开启本机诊断记录。');
        return;
      }
      const text = runDiagnosticsDownload();
      const ok = await downloader({
        fileName: `zhixing-diagnostics-${backupTimestamp(now())}.json`,
        blob: new Blob([text], { type: 'application/json;charset=utf-8' }),
      });
      if (!ok) throw new Error('当前环境无法自动下载诊断文件');
      setNotice('已下载脱敏诊断 JSON（仅本机内存中的耗时与错误记录）');
    } catch (reason) {
      setError(formatError(reason));
    } finally {
      setBusy(null);
    }
  };

  const handleResetApplied = (report: ResetDomainReport) => {
    setError(null);
    setNotice(
      `已重置业务数据：删除 ${report.deletedRows} 行，写入 ${report.samplesInserted} 条初始示例；保留 ${report.preservedSettings} 条设备/空间偏好。`,
    );
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent(DATA_RESET_EVENT, { detail: report }),
      );
    }
  };

  if (!source) {
    return (
      <>
        <div className="settings-subhead">
          <b>备份与恢复</b>
          <span>可回导；任务、笔记、画板、附件、关系与设备偏好</span>
        </div>
        <SettingsRow
          label="导出完整备份（ZIP）"
          description="ZIP 内含 manifest、附件二进制、关系清单与每块画板 JSON，并带每个文件的 SHA-256 校验；可完整恢复。需要桌面壳内的 SQLite 业务库。"
        >
          <span className="settings-badge">需桌面壳</span>
        </SettingsRow>
        <SettingsRow
          label="从备份恢复"
          description="恢复预览、冲突确认与关系重建需要桌面壳；浏览器预览不会伪造业务数据。"
        >
          <span className="settings-badge">需桌面壳</span>
        </SettingsRow>
        <div className="settings-subhead">
          <b>单向导出</b>
          <span>只导出，不可恢复；恢复请用上方 ZIP 完整备份</span>
        </div>
        <SettingsRow
          label="导出为其他格式"
          description="Markdown、CSV、PDF 为单向导出；结构化数据 JSON 不含附件二进制，不是备份格式，也不保证跨版本回导。均需要桌面壳内的 SQLite 业务库。"
        >
          <span className="settings-badge">需桌面壳</span>
        </SettingsRow>
        <SettingsRow
          label="重置全部数据"
          description="浏览器预览没有 SQLite 业务库；业务数据重置只在桌面壳内可用。上方的「重置本机偏好」仍可恢复浏览器偏好。"
        >
          <span className="settings-badge">需桌面壳</span>
        </SettingsRow>
        <p className="backup-security">
          浏览器预览仍可导出/导入上方的「偏好备份」；完整备份不会包含账号、令牌、
          密钥或 WebDAV 密码。业务数据重置需要桌面壳内的 SQLite 事务。
        </p>
      </>
    );
  }

  const disabled = busy !== null;

  return (
    <>
      <div className="settings-subhead">
        <b>备份与恢复</b>
        <span>
          可回导；任务、笔记、画板、附件、关系与白名单设备偏好
          {lastExport
            ? ` · 上次 ${EXPORT_LABELS[lastExport.kind]} ${formatBytes(
                lastExport.byteSize,
              )}`
            : ''}
        </span>
      </div>

      <SettingsRow
        label="导出完整备份（ZIP）"
        description="ZIP 内含 manifest、每个文件的 SHA-256、附件二进制、关系清单与每块画板 JSON；含附件，可完整恢复。"
      >
        <button
          type="button"
          className="settings-button settings-button--primary"
          disabled={disabled}
          onClick={() => {
            void exportBackup('zip');
          }}
        >
          {busy === 'zip' ? '打包中…' : '导出 ZIP'}
        </button>
      </SettingsRow>

      <SettingsRow
        label="从备份恢复"
        description="先校验 manifest、哈希与关系，再打开冲突预览；默认跳过冲突，覆盖需要勾选确认。以 ZIP 完整备份为准；旧版 JSON 备份仍可兼容读取（不含附件二进制）。"
      >
        <div className="settings-data-actions">
          <input
            ref={fileRef}
            type="file"
            accept=".zip,.json,application/zip,application/json"
            aria-label="选择完整备份文件"
            className="settings-file-input"
            disabled={disabled}
            onChange={(event) => {
              void openPreview(event.target.files?.[0]);
            }}
          />
          <button
            ref={restoreButtonRef}
            type="button"
            className="settings-button"
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
          >
            {busy === 'parse' ? '校验中…' : '选择备份文件'}
          </button>
        </div>
      </SettingsRow>

      <div className="settings-subhead">
        <b>单向导出</b>
        <span>只导出，不可恢复；恢复请用上方 ZIP 完整备份</span>
      </div>

      <SettingsRow
        label="导出为其他格式"
        description="Markdown、CSV、PDF 不可回导；结构化数据 JSON 不含附件二进制，不是备份格式，也不保证跨版本回导。"
      >
        <div className="backup-actions" role="group" aria-label="单向导出">
          <button
            type="button"
            className="settings-button"
            disabled={disabled}
            onClick={() => {
              void exportBackup('json');
            }}
          >
            {busy === 'json'
              ? '生成中…'
              : '结构化数据（JSON，供开发/迁移）'}
          </button>
          <button
            type="button"
            className="settings-button"
            disabled={disabled}
            onClick={() => {
              void exportBackup('markdown');
            }}
          >
            {busy === 'markdown' ? '生成中…' : 'Markdown'}
          </button>
          <button
            type="button"
            className="settings-button"
            disabled={disabled}
            onClick={() => {
              void exportBackup('csv');
            }}
          >
            {busy === 'csv' ? '生成中…' : 'CSV'}
          </button>
          <button
            type="button"
            className="settings-button"
            disabled={disabled}
            onClick={() => {
              void exportBackup('pdf');
            }}
          >
            {busy === 'pdf' ? '排版中…' : 'PDF'}
          </button>
        </div>
      </SettingsRow>

      <div className="settings-subhead">
        <b>诊断与性能</b>
        <span>脱敏耗时与错误；不是备份，不能恢复</span>
      </div>

      <SettingsRow
        label="诊断与性能记录"
        description="默认关闭；在「设置 → 隐私与安全」开启后，才记录本机内存中的脱敏错误、慢操作与导出耗时。下载前再次脱敏，不上传。"
      >
        <button
          type="button"
          className="settings-button settings-button--small"
          disabled={disabled || !diagnosticsEnabled}
          onClick={() => {
            void downloadDiagnostics();
          }}
        >
          {busy === 'diagnostics'
            ? '生成中…'
            : diagnosticsEnabled
              ? '下载诊断 JSON'
              : '诊断未开启'}
        </button>
      </SettingsRow>

      {notice ? (
        <div className="settings-banner" role="status" aria-live="polite">
          <b>完成</b>
          <span>{notice}</span>
        </div>
      ) : null}

      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}

      {lastExport && lastExport.warnings.length > 0 ? (
        <details className="backup-details backup-last-warnings">
          <summary>上次导出的 {lastExport.warnings.length} 条提示</summary>
          <ul className="backup-issue-list">
            {lastExport.warnings.map((warning) => (
              <li key={warning}>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <SettingsRow
        label="重置全部数据"
        description="清空任务、笔记、画板、日历、习惯、专注与复盘业务表，并重新写入初始示例；保留设备/空间偏好。请先导出完整备份。"
      >
        {resetTarget ? (
          <button
            ref={resetButtonRef}
            type="button"
            className="settings-button settings-button--danger"
            disabled={disabled}
            onClick={() => setResetOpen(true)}
          >
            重置全部数据
          </button>
        ) : (
          <span className="settings-badge">需桌面壳</span>
        )}
      </SettingsRow>

      <p className="backup-security">
        备份不包含账号、设备令牌、密钥、WebDAV 密码、同步游标或设备密钥；
        设置表只导出白名单内的设备偏好。恢复按对象逐项写入，失败会停止并报告
        已应用数量，不静默覆盖。业务数据重置在同一 SQLite 事务内清空并重新执行
        种子，失败自动回滚。
      </p>

      <RestorePreviewDialog
        open={restoreOpen}
        parsed={preview?.parsed ?? null}
        local={preview?.local ?? null}
        target={target}
        returnFocusRef={restoreButtonRef}
        onClose={() => {
          setRestoreOpen(false);
          setPreview(null);
        }}
        onApplied={(summary, result) => {
          setNotice(
            `恢复完成：新增 ${summary.create}，更新 ${summary.update}，移入回收站 ${summary.delete}，跳过 ${summary.skip}，阻止 ${summary.blocked}，写入 ${result.applied} 项。`,
          );
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent(DATA_RESTORED_EVENT, { detail: summary }),
            );
          }
        }}
      />

      <ResetDataDialog
        open={resetOpen}
        target={resetTarget}
        onClose={() => setResetOpen(false)}
        onReset={handleResetApplied}
        onBackup={() => exportBackup('zip')}
        lastBackupLabel={
          lastExport
            ? `${EXPORT_LABELS[lastExport.kind]} · ${lastExport.fileName}`
            : null
        }
        returnFocusRef={resetButtonRef}
      />
    </>
  );
}

/** 供测试/其他页面生成安全文件名。 */
export function backupFileNameFor(prefix: string, extension: string, now: Date): string {
  return `${sanitizeFileName(prefix)}-${backupTimestamp(now)}.${extension}`;
}
