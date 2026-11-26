import { useRef, useState } from 'react';

import { isTauriRuntime } from '../../../data/db/client';
import { DataBackupPanel } from '../../export/DataBackupPanel';
import { pickExportDirectory } from '../../export/location';
import type { BusinessResetTarget } from '../../export/reset';
import type {
  BackupSource,
  FileDownloader,
  RestoreTarget,
} from '../../export/types';
import type { SettingsWorkspaceValue } from '../useSettingsWorkspace';
import { SettingsCard, SettingsRow } from './Controls';

function formatError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '操作失败，请重试';
}

async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('无法读取备份文件'));
    reader.readAsText(file);
  });
}

export type DataGroupProps = {
  workspace: SettingsWorkspaceValue;
  /** 测试/嵌入时可注入完整备份与业务重置目标；默认由桌面壳装配。 */
  backupSource?: BackupSource | null;
  restoreTarget?: RestoreTarget | null;
  resetTarget?: BusinessResetTarget | null;
  downloader?: FileDownloader;
  /** 测试注入：默认调用 Rust 的文件夹选择器。 */
  pickDirectory?: () => Promise<string | null>;
  /** 测试注入：默认按当前运行环境判断是否支持固定目录。 */
  desktop?: boolean;
};

export function DataGroup({
  workspace,
  backupSource,
  restoreTarget,
  resetTarget,
  downloader,
  pickDirectory = pickExportDirectory,
  desktop = isTauriRuntime(),
}: DataGroupProps) {
  const { sourceMode, dbStatus, exportBackup, importBackup, resetPreferences } =
    workspace;
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);

  const exportDirectory = workspace.settings.export.directory;

  const handlePickDirectory = async () => {
    setPickingDirectory(true);
    setDirectoryError(null);
    try {
      const picked = await pickDirectory();
      // 取消不改设置：保持原来的“每次询问 / 之前选择的目录”。
      if (picked) {
        await workspace.updateExportDirectory(picked);
      }
    } catch (reason) {
      setDirectoryError(formatError(reason));
    } finally {
      setPickingDirectory(false);
    }
  };

  const handleClearDirectory = async () => {
    setDirectoryError(null);
    try {
      await workspace.updateExportDirectory(null);
    } catch (reason) {
      setDirectoryError(formatError(reason));
    }
  };

  const handleImport = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const text = await readFileText(file);
      await importBackup(text);
    } catch (reason) {
      setImportError(formatError(reason));
    } finally {
      setImporting(false);
      if (fileRef.current) {
        fileRef.current.value = '';
      }
    }
  };

  const handleReset = async () => {
    setResetting(true);
    setImportError(null);
    try {
      await resetPreferences();
      setConfirmReset(false);
    } catch (reason) {
      setImportError(formatError(reason));
    } finally {
      setResetting(false);
    }
  };

  return (
    <SettingsCard
      title="数据与备份"
      description="本机是唯一事实。偏好备份始终可用；完整业务备份与业务数据重置需要桌面壳内的 SQLite 业务库。"
    >
      <SettingsRow
        label="本机数据库"
        description={
          sourceMode === 'sqlite'
            ? 'SQLite WAL；导出偏好不会复制业务数据。'
            : '浏览器预览：偏好保存在本机 localStorage；业务数据需要桌面壳。'
        }
      >
        <span className="settings-value">
          {sourceMode === 'sqlite'
            ? dbStatus
              ? `v${dbStatus.schemaVersion} · ${dbStatus.journalMode.toUpperCase()}`
              : workspace.status === 'loading'
                ? '正在读取…'
                : '状态未知'
            : 'localStorage'}
        </span>
      </SettingsRow>

      <SettingsRow
        label="默认导出目录"
        description={
          exportDirectory
            ? '笔记 Word/PDF/Markdown、画板 PNG 与附件另存都会从该目录打开保存面板；最终文件名与位置仍由你确认。'
            : desktop
              ? '未设置：每次保存都由系统保存面板选择位置（沿用系统上次位置），不会自动写入 Downloads 或 Documents。'
              : '浏览器预览不支持固定目录；保存时仍会每次弹出面板。桌面版可选择默认目录。'
        }
      >
        <div className="settings-export-directory">
          <code
            className={
              exportDirectory
                ? 'settings-export-path'
                : 'settings-export-path is-empty'
            }
            title={exportDirectory ?? undefined}
          >
            {exportDirectory ?? '未设置（每次保存时选择）'}
          </code>
          <div className="settings-data-actions">
            <button
              type="button"
              className="settings-button"
              disabled={pickingDirectory || !desktop}
              onClick={() => {
                void handlePickDirectory();
              }}
            >
              {pickingDirectory ? '选择中…' : '选择目录'}
            </button>
            {exportDirectory ? (
              <button
                type="button"
                className="settings-button"
                disabled={!desktop}
                onClick={() => {
                  void handleClearDirectory();
                }}
              >
                清除
              </button>
            ) : null}
          </div>
        </div>
      </SettingsRow>

      <div className="settings-subhead">
        <b>偏好备份</b>
        <span>外观、编辑器排版、默认清单/目录、导出目录与农历显示</span>
      </div>

      <SettingsRow
        label="导出偏好备份"
        description="下载 JSON；导入后应得到相同的偏好。"
      >
        <button
          type="button"
          className="settings-button settings-button--primary"
          onClick={() => {
            exportBackup();
          }}
        >
          导出 JSON
        </button>
      </SettingsRow>

      <SettingsRow
        label="导入偏好备份"
        description="校验格式后覆盖本机偏好；不会动任务与笔记。"
      >
        <div className="settings-data-actions">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            aria-label="选择偏好备份文件"
            className="settings-file-input"
            onChange={(event) => {
              void handleImport(event.target.files?.[0]);
            }}
          />
          <button
            type="button"
            className="settings-button"
            disabled={importing}
            onClick={() => fileRef.current?.click()}
          >
            {importing ? '导入中…' : '选择文件'}
          </button>
        </div>
      </SettingsRow>

      <SettingsRow
        label="重置本机偏好"
        description="恢复外观、编辑器、默认清单/目录、导出目录与农历默认值；不删除任务、笔记或画板。"
      >
        {confirmReset ? (
          <div
            className="settings-reset-confirm"
            role="group"
            aria-label="确认重置本机偏好"
          >
            <button
              type="button"
              className="settings-button settings-button--danger"
              disabled={resetting}
              onClick={() => {
                void handleReset();
              }}
            >
              {resetting ? '重置中…' : '确认重置'}
            </button>
            <button
              type="button"
              className="settings-button"
              disabled={resetting}
              onClick={() => setConfirmReset(false)}
            >
              取消
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="settings-button settings-button--danger"
            onClick={() => setConfirmReset(true)}
          >
            重置本机偏好
          </button>
        )}
      </SettingsRow>

      {directoryError ? (
        <p className="settings-error" role="alert">
          {directoryError}
        </p>
      ) : null}

      {importError ? (
        <p className="settings-error" role="alert">
          {importError}
        </p>
      ) : null}

      <DataBackupPanel
        source={backupSource}
        target={restoreTarget}
        resetTarget={resetTarget}
        downloader={downloader}
      />
    </SettingsCard>
  );
}
