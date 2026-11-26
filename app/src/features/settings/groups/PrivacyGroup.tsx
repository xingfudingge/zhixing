import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { Modal } from '../../../app/a11y';
import {
  normalizePrivacyClipboardClearSeconds,
  PRIVACY_CLIPBOARD_CLEAR_SECONDS,
} from '../../../data/repositories/settings';
import { monitor, runDiagnosticsDownload } from '../../export/monitoring';
import { downloadTextFile } from '../backup';
import {
  changeNoteEncryptionPassphrase,
  disableNoteEncryption,
  enableNoteEncryption,
  exportNoteEncryptionEnvelope,
  formatNoteEncryptionError,
  getNoteEncryptionStatus,
  importNoteEncryptionEnvelope,
  lockNoteEncryption,
  NOTE_ENCRYPTION_CHANGED_EVENT,
  noteEncryptionSupported,
  unlockNoteEncryption,
  type NoteEncryptionReport,
  type NoteEncryptionStatus,
} from '../noteEncryption';
import type { SettingsWorkspaceValue } from '../useSettingsWorkspace';
import {
  SelectField,
  SettingsCard,
  SettingsRow,
  SettingsSwitch,
} from './Controls';

const CLIPBOARD_CLEAR_LABELS: Record<
  (typeof PRIVACY_CLIPBOARD_CLEAR_SECONDS)[number],
  string
> = {
  0: '关闭（不由应用清空）',
  15: '15 秒后清空',
  30: '30 秒后清空',
  60: '60 秒后清空',
};

type EncryptionDialog = 'enable' | 'unlock' | 'change' | 'disable';

function storageLabel(storage: NoteEncryptionStatus['storage']): string {
  switch (storage) {
    case 'keychain':
      return '系统钥匙串';
    case 'file':
      return '本机 0600 文件（钥匙串不可用时的回退）';
    default:
      return '未保存';
  }
}

function encryptionStateLabel(status: NoteEncryptionStatus): string {
  if (!status.supported) return '仅桌面壳可用';
  if (status.keyMissing) return '缺少密钥信封';
  if (!status.configured && !status.enabled) return '未开启';
  if (status.pendingEncryption) return '加密未完成';
  if (status.enabled && status.locked) return '已加密 · 已锁定';
  if (status.enabled) return '已加密 · 已解锁';
  return '已配置密钥 · 未启用';
}

function reportMessage(report: NoteEncryptionReport): string {
  const parts = [
    `已加密 ${report.transformed.notes} 篇笔记`,
    `${report.transformed.blocks} 个块`,
    `${report.transformed.todos} 条笔记待办`,
  ];
  if (report.warning) {
    parts.push(report.warning);
  }
  return parts.join('；');
}

export function PrivacyGroup({
  workspace,
}: {
  workspace: SettingsWorkspaceValue;
}) {
  const { settings, sourceMode, updatePrivacy } = workspace;
  const privacy = settings.privacy;

  const [status, setStatus] = useState<NoteEncryptionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<EncryptionDialog | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [currentPassphrase, setCurrentPassphrase] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const envelopeInput = useRef<HTMLInputElement>(null);

  const change = (patch: Parameters<typeof updatePrivacy>[0]) => {
    void updatePrivacy(patch).catch(() => undefined);
  };

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getNoteEncryptionStatus();
      setStatus(next);
      setStatusError(next.error);
    } catch (reason) {
      setStatusError(formatNoteEncryptionError(reason));
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const onChanged = () => {
      void refreshStatus();
    };
    window.addEventListener(NOTE_ENCRYPTION_CHANGED_EVENT, onChanged);
    return () => {
      window.removeEventListener(NOTE_ENCRYPTION_CHANGED_EVENT, onChanged);
    };
  }, [refreshStatus]);

  const closeDialog = () => {
    if (busy) return;
    setDialog(null);
    setPassphrase('');
    setPassphraseConfirm('');
    setCurrentPassphrase('');
    setDialogError(null);
    setConfirmDisable(false);
  };

  const openDialog = (next: EncryptionDialog) => {
    setDialog(next);
    setPassphrase('');
    setPassphraseConfirm('');
    setCurrentPassphrase('');
    setDialogError(null);
    setConfirmDisable(false);
  };

  const submitDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog) return;
    setDialogError(null);

    if (dialog === 'enable' || dialog === 'change') {
      if (passphrase.length < 8) {
        setDialogError('口令至少需要 8 个字符');
        return;
      }
      if (passphrase !== passphraseConfirm) {
        setDialogError('两次输入的口令不一致');
        return;
      }
    }
    if (dialog === 'disable' && status?.locked && !passphrase) {
      setDialogError('请输入当前口令以解密全部笔记');
      return;
    }
    if (dialog === 'disable' && !confirmDisable) {
      setDialogError('请勾选确认：关闭加密会把笔记解密为明文');
      return;
    }

    setBusy(true);
    try {
      if (dialog === 'enable') {
        const report = await enableNoteEncryption(passphrase);
        setNotice(reportMessage(report));
      } else if (dialog === 'unlock') {
        await unlockNoteEncryption(passphrase);
        setNotice('笔记已解锁；锁定后列表与搜索不再返回明文。');
      } else if (dialog === 'change') {
        await changeNoteEncryptionPassphrase(currentPassphrase, passphrase);
        setNotice('口令已更换；旧口令立即失效，笔记密文未改动。');
      } else {
        const report = await disableNoteEncryption(
          status?.locked ? passphrase : undefined,
        );
        setNotice(
          report.warning
            ? `笔记已解密；${report.warning}`
            : `已关闭笔记加密并解密 ${report.transformed.notes} 篇笔记。`,
        );
      }
      await refreshStatus();
      closeDialog();
    } catch (reason) {
      setDialogError(formatNoteEncryptionError(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleLock = async () => {
    setBusy(true);
    setStatusError(null);
    try {
      await lockNoteEncryption();
      setNotice('笔记已锁定：列表只显示“已加密笔记”，搜索与导出不返回明文。');
      await refreshStatus();
    } catch (reason) {
      setStatusError(formatNoteEncryptionError(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleImportEnvelope = async (file: File | undefined) => {
    if (!file) return;
    setStatusError(null);
    try {
      const text = await file.text();
      await importNoteEncryptionEnvelope(text);
      setNotice('密钥信封已导入；请输入该信封对应的口令解锁。');
      await refreshStatus();
    } catch (reason) {
      setStatusError(formatNoteEncryptionError(reason));
    } finally {
      if (envelopeInput.current) {
        envelopeInput.current.value = '';
      }
    }
  };

  const handleExportEnvelope = async () => {
    setStatusError(null);
    try {
      const json = await exportNoteEncryptionEnvelope();
      if (!json) {
        setStatusError('尚未配置笔记加密，没有可导出的密钥信封。');
        return;
      }
      const ok = await downloadTextFile(
        'zhixing-note-encryption-envelope.json',
        json,
      );
      setNotice(
        ok
          ? '已导出密钥信封。它受口令保护；没有口令无法解出主密钥，请与口令分开保管。'
          : '当前环境不支持下载；信封内容已在内存中生成。',
      );
    } catch (reason) {
      setStatusError(formatNoteEncryptionError(reason));
    }
  };

  const toggleDiagnostics = (next: boolean) => {
    void updatePrivacy({ diagnosticsEnabled: next })
      .then(() => {
        monitor.setEnabled(next);
        setNotice(
          next
            ? '已开启本机诊断记录：只保存脱敏耗时/错误摘要，不上传，可随时清除。'
            : '已关闭诊断记录并清空本机缓冲。',
        );
      })
      .catch((reason) => {
        // 保存失败时恢复监控开关，避免“看起来开启、重启后消失”。
        monitor.setEnabled(!next);
        setStatusError(formatNoteEncryptionError(reason));
      });
  };

  const clearDiagnostics = () => {
    monitor.reset();
    setNotice('已清除本机诊断缓冲。');
  };

  const downloadDiagnostics = async () => {
    if (!privacy.diagnosticsEnabled) {
      setStatusError('请先开启本机诊断记录，再下载诊断 JSON。');
      return;
    }
    const ok = await downloadTextFile(
      `zhixing-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      runDiagnosticsDownload(),
    );
    setNotice(ok ? '诊断 JSON 已生成并下载；不包含笔记/任务内容。' : '当前环境不支持下载。');
  };

  const supported = status?.supported ?? noteEncryptionSupported();
  const canEnable = (status?.noteAttachments ?? 0) === 0;
  const encryptionReady = status?.configured ?? false;
  const encryptionEnabled = status?.enabled ?? false;
  const unlocked = Boolean(encryptionEnabled && !status?.locked);
  const dialogTitle: Record<EncryptionDialog, string> = {
    enable: '设置口令并加密全部笔记',
    unlock: '解锁笔记',
    change: '更改加密口令',
    disable: '关闭笔记加密',
  };

  return (
    <SettingsCard
      title="隐私与安全"
      description="单用户、本机优先；没有账号、云空间或协作成员。加密密钥只在本机钥匙串与进程内存中。"
    >
      <SettingsRow
        label="数据位置"
        description={
          sourceMode === 'sqlite'
            ? '任务、笔记、画板与偏好保存在本机 SQLite；不会上传到账号云空间。'
            : '浏览器预览只把设备偏好放在本机 localStorage；业务数据需要桌面壳。'
        }
      >
        <span className="settings-value">
          {sourceMode === 'sqlite' ? '本机 SQLite' : '本机浏览器'}
        </span>
      </SettingsRow>

      <SettingsRow
        label="失焦遮挡"
        description="应用失焦、切到后台或系统锁屏时，用不透明覆盖层遮住笔记正文与任务标题；恢复后需手动点击「显示内容」，不会自动露出。"
      >
        <SettingsSwitch
          label="失焦时遮挡内容"
          checked={privacy.hideOnBlur}
          onChange={(next) => change({ hideOnBlur: next })}
        />
      </SettingsRow>

      <SettingsRow
        label="剪贴板保护"
        description="从笔记、任务等敏感视图复制内容后，在设定时间清空系统剪贴板；清空前会核对剪贴板仍是本次复制的内容，不误清后来复制的其他内容。"
      >
        <SelectField
          label="剪贴板自动清空"
          value={String(privacy.clipboardClearSeconds)}
          onChange={(value) =>
            change({
              clipboardClearSeconds: normalizePrivacyClipboardClearSeconds(
                value,
              ),
            })
          }
          hint="只清空本应用写入且内容未变的剪贴板；提示条提供「撤销清空」。不记录复制内容，也不读取剪贴板历史。"
        >
          {PRIVACY_CLIPBOARD_CLEAR_SECONDS.map((seconds) => (
            <option key={seconds} value={seconds}>
              {CLIPBOARD_CLEAR_LABELS[seconds]}
            </option>
          ))}
        </SelectField>
      </SettingsRow>

      <p className="settings-hint settings-privacy-boundary">
        边界：失焦遮挡只覆盖应用窗口内容，不承诺防截屏或防录屏；macOS
        的截屏保护 API 已被 Apple 标记为 legacy，知行不做虚假承诺。
      </p>

      <div className="settings-subhead">
        <b>笔记内容加密</b>
        <span>逐字段 AEAD · 密钥在系统钥匙串 · 锁定时不返回明文</span>
      </div>

      {!supported ? (
        <SettingsRow
          label="加密笔记"
          description="浏览器预览没有 SQLite 与系统钥匙串；这里只展示状态，不提供可误导的开关。请使用桌面壳。"
        >
          <span className="settings-badge">仅桌面壳</span>
        </SettingsRow>
      ) : (
        <div className="settings-encryption">
          <div className="settings-encryption-head">
            <div>
              <b>状态：{status ? encryptionStateLabel(status) : '读取中…'}</b>
              {status ? (
                <span className="settings-hint">
                  {status.encryptedNotes}/{status.totalNotes} 篇笔记已加密
                  {status.keyId ? ` · keyId ${status.keyId.slice(0, 8)}` : ''}
                  {status.configured ? ` · 密钥存储：${storageLabel(status.storage)}` : ''}
                </span>
              ) : null}
            </div>
            <div className="settings-encryption-actions">
              {!encryptionReady && !status?.keyMissing ? (
                <button
                  type="button"
                  className="settings-button settings-button--primary"
                  disabled={busy || !canEnable}
                  onClick={() => openDialog('enable')}
                >
                  设置口令并加密全部笔记
                </button>
              ) : null}
              {encryptionReady &&
              !encryptionEnabled &&
              !status?.keyMissing ? (
                <button
                  type="button"
                  className="settings-button settings-button--primary"
                  disabled={busy || !canEnable}
                  onClick={() => openDialog('enable')}
                >
                  启用加密
                </button>
              ) : null}
              {status?.pendingEncryption ? (
                <button
                  type="button"
                  className="settings-button settings-button--primary"
                  disabled={busy}
                  onClick={() =>
                    unlocked ? void openDialog('enable') : openDialog('unlock')
                  }
                >
                  继续加密剩余笔记
                </button>
              ) : null}
              {status?.enabled && status.locked ? (
                <button
                  type="button"
                  className="settings-button settings-button--primary"
                  disabled={busy}
                  onClick={() => openDialog('unlock')}
                >
                  解锁
                </button>
              ) : null}
              {status?.enabled && !status.locked ? (
                <button
                  type="button"
                  className="settings-button"
                  disabled={busy}
                  onClick={() => void handleLock()}
                >
                  锁定
                </button>
              ) : null}
              {status?.configured ? (
                <button
                  type="button"
                  className="settings-button settings-button--small"
                  disabled={busy}
                  onClick={() => openDialog('change')}
                >
                  更改口令
                </button>
              ) : null}
              {status?.enabled ? (
                <button
                  type="button"
                  className="settings-button settings-button--danger settings-button--small"
                  disabled={busy}
                  onClick={() => openDialog('disable')}
                >
                  关闭加密并解密
                </button>
              ) : null}
              <button
                type="button"
                className="settings-button settings-button--small"
                disabled={busy || !status?.configured}
                onClick={() => void handleExportEnvelope()}
              >
                导出密钥信封
              </button>
              <button
                type="button"
                className="settings-button settings-button--small"
                disabled={busy}
                onClick={() => envelopeInput.current?.click()}
              >
                导入密钥信封
              </button>
              <input
                ref={envelopeInput}
                type="file"
                accept=".json,application/json"
                hidden
                aria-label="导入笔记加密密钥信封"
                onChange={(event) =>
                  void handleImportEnvelope(event.target.files?.[0])
                }
              />
            </div>
          </div>

          {status && status.noteAttachments > 0 ? (
            <p className="settings-error" role="alert">
              有 {status.noteAttachments} 个笔记附件未纳入加密边界。附件二进制与
              OCR 文本不在 SQLite 密文内；请先删除笔记附件再开启加密。
            </p>
          ) : null}

          {statusError ? (
            <p className="settings-error" role="alert">
              {statusError}
            </p>
          ) : null}

          <ul className="settings-encryption-boundary">
            <li>
              加密范围：笔记标题、正文、标签、块 payload、笔记待办标题；每篇/每块/每条使用独立
              nonce，密文不能跨笔记搬运。
            </li>
            <li>
              仍是明文：笔记 id、目录、状态、收藏/置顶、时间戳与附件文件名/二进制。目录用于导航，不承诺隐藏。
            </li>
            <li>
              锁定后：列表只显示「已加密笔记」，搜索、导出、OCR 与编辑都不返回明文；写命令直接拒绝。
            </li>
            <li>
              兼容性：解锁后搜索在内存中解密后过滤；完整备份保存密文，不包含明文密钥；导出密钥信封受口令保护。
            </li>
            <li>
              OCR：加密开启时禁用笔记附件的 OCR 入队，避免识别文本绕过 SQLite 加密边界。
            </li>
          </ul>
        </div>
      )}

      <div className="settings-subhead">
        <b>诊断数据</b>
        <span>默认关闭 · 匿名本机摘要 · 不上传 · 可清除</span>
      </div>

      <SettingsRow
        label="本机诊断记录"
        description="开启后只记录脱敏后的错误类型、慢操作名称/耗时与 OS 族；不记录笔记/任务正文、文件路径、账号、口令或密钥。只保存在本机内存（最多 80 条），没有任何上传端点，关闭即清空。"
      >
        <SettingsSwitch
          label="开启本机诊断记录"
          checked={privacy.diagnosticsEnabled}
          onChange={toggleDiagnostics}
        />
      </SettingsRow>

      <SettingsRow
        label="诊断数据"
        description="诊断 JSON 只含匿名摘要；下载前再次脱敏。清除只影响本机内存缓冲，不影响业务数据。"
      >
        <div className="settings-encryption-actions">
          <button
            type="button"
            className="settings-button settings-button--small"
            disabled={!privacy.diagnosticsEnabled}
            onClick={() => void downloadDiagnostics()}
          >
            下载诊断 JSON
          </button>
          <button
            type="button"
            className="settings-button settings-button--small"
            disabled={busy}
            onClick={clearDiagnostics}
          >
            清除本机诊断数据
          </button>
        </div>
      </SettingsRow>

      {notice ? (
        <div className="settings-banner" role="status" aria-live="polite">
          <b>完成</b>
          <span>{notice}</span>
        </div>
      ) : null}

      <div className="settings-actions">
        <Link className="settings-link" to="/settings/data">
          前往数据与备份
        </Link>
        <span className="settings-hint">
          重置入口只重置本机偏好，不删除任务与笔记
        </span>
      </div>

      <Modal
        open={dialog !== null}
        title={dialog ? dialogTitle[dialog] : ''}
        description={
          dialog === 'disable'
            ? '关闭加密会把全部笔记解密为明文，并删除本机密钥信封。请确认已了解丢失设备后的风险。'
            : dialog === 'change'
              ? '旧口令会立即失效；笔记密文不变，只重新包裹主密钥。'
              : '口令不会写入设置、日志或 localStorage；忘记口令将无法在其他设备恢复笔记。'
        }
        onClose={closeDialog}
        busy={busy}
        footer={
          <>
            <button
              type="button"
              className="settings-button"
              onClick={closeDialog}
              disabled={busy}
            >
              取消
            </button>
            <button
              type="submit"
              form="note-encryption-form"
              className={
                dialog === 'disable'
                  ? 'settings-button settings-button--danger'
                  : 'settings-button settings-button--primary'
              }
              disabled={busy}
            >
              {busy
                ? '处理中…'
                : dialog === 'enable'
                  ? '加密全部笔记'
                  : dialog === 'unlock'
                    ? '解锁'
                    : dialog === 'change'
                      ? '更换口令'
                      : '关闭加密并解密'}
            </button>
          </>
        }
      >
        <form
          id="note-encryption-form"
          className="settings-encryption-form"
          onSubmit={(event) => void submitDialog(event)}
        >
          {dialog === 'change' ? (
            <label>
              <span>当前口令</span>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassphrase}
                onChange={(event) => setCurrentPassphrase(event.target.value)}
                required
              />
            </label>
          ) : null}
          {dialog === 'enable' || dialog === 'change' || dialog === 'unlock' ? (
            <label>
              <span>{dialog === 'change' ? '新口令' : '口令'}</span>
              <input
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                minLength={dialog === 'unlock' ? undefined : 8}
                required
              />
            </label>
          ) : null}
          {dialog === 'enable' || dialog === 'change' ? (
            <label>
              <span>确认新口令</span>
              <input
                type="password"
                autoComplete="new-password"
                value={passphraseConfirm}
                onChange={(event) => setPassphraseConfirm(event.target.value)}
                minLength={8}
                required
              />
            </label>
          ) : null}
          {dialog === 'disable' && status?.locked ? (
            <label>
              <span>当前口令（用于解密）</span>
              <input
                type="password"
                autoComplete="current-password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                required
              />
            </label>
          ) : null}
          {dialog === 'disable' ? (
            <label className="settings-encryption-check">
              <input
                type="checkbox"
                checked={confirmDisable}
                onChange={(event) => setConfirmDisable(event.target.checked)}
              />
              <span>我确认关闭加密，笔记将以明文保存在本机 SQLite。</span>
            </label>
          ) : null}
          {dialogError ? (
            <p className="settings-error" role="alert">
              {dialogError}
            </p>
          ) : null}
        </form>
      </Modal>
    </SettingsCard>
  );
}
