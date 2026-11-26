import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link } from 'react-router-dom';

import {
  evaluateModeSwitch,
  type ModeSwitchDecision,
  type Platform,
} from '../../../../../packages/sync-webdav/src/index.ts';
import {
  LocalStorageWebDavConfigStore,
  type WebDavConfigStore,
  type WebDavSavedConfig,
} from '../../../sync/webdav/configStore.ts';
import {
  LocalStorageWebDavModeStore,
  type WebDavModeStore,
} from '../../../sync/webdav/modeController.ts';
import { detectPlatform } from '../../../sync/webdav/platform.ts';
import type {
  WebDavConnectionTester,
  WebDavFormValues,
} from '../../../sync/webdav/WebDavSettingsPanel.tsx';
import {
  BackendConfig,
  type BackendPairingRequest,
} from '../../backend/BackendConfig.tsx';
import {
  LocalStorageBackendConfigStore,
  type BackendConfigStore,
} from '../../backend/store.ts';
import { createSyncRuntime } from '../../sync/runtime.ts';
import { SyncStatusCard, type SyncStatusMessage } from '../../sync/SyncStatusCard.tsx';
import type {
  BackendProfileView,
  SyncMode,
  SyncRuntime,
  SyncStatus,
} from '../../sync/types.ts';
import { WebDavConfig } from '../../sync/WebDavConfig.tsx';
import { SettingsCard, SettingsRow } from './Controls';

export type SyncGroupProps = {
  sourceMode: 'sqlite' | 'browser';
  /** 测试/预览可覆盖平台；正式运行按 Tauri/浏览器自动判定。 */
  platform?: Platform;
  modeStore?: WebDavModeStore;
  runtime?: SyncRuntime;
  webdavConfigStore?: WebDavConfigStore;
  webdavTester?: WebDavConnectionTester;
  backendConfigStore?: BackendConfigStore;
};

type ModeMeta = {
  id: SyncMode;
  label: string;
  description: string;
};

const DESKTOP_MODES: readonly ModeMeta[] = [
  {
    id: 'local',
    label: '仅本机',
    description: 'SQLite 落盘，不联网；适合本地记录和离线使用。',
  },
  {
    id: 'webdav',
    label: 'WebDAV',
    description: '连 OpenList / Alist；不依赖 If-Match / ETag / LOCK。',
  },
  {
    id: 'backend',
    label: '后台直连',
    description: '连知行服务端；需要先完成设备配对。',
  },
] as const;

const MODE_LABEL: Record<SyncMode, string> = {
  local: '仅本机',
  webdav: 'WebDAV',
  backend: '后台直连',
};

function formatError(reason: unknown, fallback = '操作失败，请重试'): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return fallback;
}

function modeBadge(
  mode: SyncMode,
  active: boolean,
  status: SyncStatus | null,
): string {
  if (active) return '当前';
  if (mode === 'webdav') {
    return status?.webdavConfigured ? '已配置' : '未配置';
  }
  if (mode === 'backend') {
    return status?.backendProfile ? '已配对' : '未配对';
  }
  return '本机';
}

export function SyncGroup({
  sourceMode,
  platform,
  modeStore,
  runtime,
  webdavConfigStore,
  webdavTester,
  backendConfigStore,
}: SyncGroupProps) {
  const dialogTitleId = useId();
  const resolvedPlatform = platform ?? runtime?.platform ?? detectPlatform();
  const store = useMemo(
    () => modeStore ?? new LocalStorageWebDavModeStore(),
    [modeStore],
  );
  const webdavStore = useMemo(
    () => webdavConfigStore ?? new LocalStorageWebDavConfigStore(),
    [webdavConfigStore],
  );
  const backendStore = useMemo(
    () => backendConfigStore ?? new LocalStorageBackendConfigStore(),
    [backendConfigStore],
  );
  const syncRuntime = useMemo(
    () => runtime ?? createSyncRuntime({ platform: resolvedPlatform }),
    [resolvedPlatform, runtime],
  );

  const [storedMode, setStoredMode] = useState<SyncMode | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<SyncStatusMessage | null>(
    null,
  );
  const [modeError, setModeError] = useState<string | null>(null);
  const [modeMessage, setModeMessage] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{
    target: SyncMode;
    decision: ModeSwitchDecision;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [backendBaseUrl, setBackendBaseUrl] = useState('');
  const [backendDeviceName, setBackendDeviceName] = useState('本机');

  const webdavValuesRef = useRef<WebDavFormValues | null>(null);

  const webOnly = resolvedPlatform === 'web';
  const mode: SyncMode = webOnly ? 'backend' : (storedMode ?? 'local');
  const modeReady = webOnly || storedMode !== null;

  // 模式是每设备单一事实，沿用已有的 WebDavModeStore（zhixing.sync.mode.v1）。
  useEffect(() => {
    let cancelled = false;
    void store
      .load()
      .then((saved) => {
        if (!cancelled) setStoredMode(saved ?? 'local');
      })
      .catch(() => {
        if (!cancelled) setStoredMode('local');
      });
    return () => {
      cancelled = true;
    };
  }, [store]);

  useEffect(() => {
    let cancelled = false;
    void backendStore
      .load()
      .then((saved) => {
        if (cancelled || !saved) return;
        setBackendBaseUrl(saved.baseUrl);
        setBackendDeviceName(saved.deviceName);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [backendStore]);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const next = await syncRuntime.readStatus(
        mode,
        webdavValuesRef.current ?? undefined,
      );
      setStatus(next);
      setStatusError(null);
    } catch (reason) {
      setStatusError(formatError(reason, '同步状态读取失败'));
    } finally {
      setStatusLoading(false);
    }
  }, [mode, syncRuntime]);

  useEffect(() => {
    if (!modeReady) return;
    void refreshStatus();
  }, [modeReady, refreshStatus]);

  const rememberBackendConfig = useCallback(
    (baseUrl: string, deviceName: string) => {
      setBackendBaseUrl(baseUrl);
      setBackendDeviceName(deviceName);
      void backendStore
        .save({
          version: 1,
          baseUrl,
          deviceName,
          updatedAt: new Date().toISOString(),
        })
        .catch(() => undefined);
    },
    [backendStore],
  );

  const handleWebDavValues = useCallback((values: WebDavFormValues) => {
    webdavValuesRef.current = values;
  }, []);

  const handleWebDavSaved = useCallback(
    (saved: WebDavSavedConfig) => {
      setModeMessage(`WebDAV 连接信息已保存：${saved.baseUrl}`);
      void refreshStatus();
    },
    [refreshStatus],
  );

  const handlePair = useCallback(
    async (input: BackendPairingRequest): Promise<BackendProfileView> => {
      const profile = await syncRuntime.pairBackend(input);
      rememberBackendConfig(profile.baseUrl, profile.deviceName);
      setModeMessage(`后台配对成功：${profile.deviceName}`);
      const next = await syncRuntime.readStatus(
        mode,
        webdavValuesRef.current ?? undefined,
      );
      setStatus(next);
      setStatusError(null);
      return profile;
    },
    [mode, rememberBackendConfig, syncRuntime],
  );

  const applyMode = useCallback(
    async (target: SyncMode) => {
      if (webOnly) {
        setModeError('Web 端只能使用后台直连同步');
        return;
      }
      setSwitching(true);
      try {
        await store.save(target);
        setStoredMode(target);
        setModeMessage(`已切换到${MODE_LABEL[target]}模式`);
        setModeError(null);
        setPendingConfirm(null);
        setConfirmed(false);
        const next = await syncRuntime.readStatus(
          target,
          webdavValuesRef.current ?? undefined,
        );
        setStatus(next);
        setStatusError(null);
      } catch (reason) {
        setModeError(`切换失败：${formatError(reason)}`);
      } finally {
        setSwitching(false);
      }
    },
    [store, syncRuntime, webOnly],
  );

  const requestMode = useCallback(
    async (target: SyncMode) => {
      if (target === mode || switching || syncing || webOnly) return;
      setModeError(null);
      setModeMessage(null);
      setPendingConfirm(null);
      setConfirmed(false);
      setSwitching(true);
      try {
        const latest = await syncRuntime.readStatus(
          mode,
          webdavValuesRef.current ?? undefined,
        );
        setStatus(latest);
        setStatusError(null);

        const decision = evaluateModeSwitch({
          platform: resolvedPlatform,
          from: mode,
          to: target,
          pendingUploads: latest.pendingUploads,
          backendReady: latest.backendProfile !== null,
          backendCursorDrained: latest.pendingUploads === 0,
          localSynced: latest.pendingUploads === 0,
          activeOperation: syncing,
          confirmed: false,
        });

        if (decision.requiresConfirmation) {
          setPendingConfirm({ target, decision });
          return;
        }
        if (!decision.allowed) {
          setModeError(decision.message);
          return;
        }

        if (latest.pendingUploads > 0) {
          setPendingConfirm({
            target,
            decision: {
              ...decision,
              message: `本地还有 ${latest.pendingUploads} 条修改待上传。切换同步模式后，这些修改不会自动上传到新的 transport。`,
              steps: [
                '保留本机 SQLite 数据',
                '停止当前同步 transport',
                '切换完成后手动点击“立即同步”',
              ],
            },
          });
          return;
        }

        await applyMode(target);
      } catch (reason) {
        setModeError(formatError(reason));
      } finally {
        setSwitching(false);
      }
    },
    [
      applyMode,
      mode,
      resolvedPlatform,
      syncRuntime,
      switching,
      syncing,
      webOnly,
    ],
  );

  const confirmSwitch = useCallback(async () => {
    if (!pendingConfirm || !confirmed) return;
    await applyMode(pendingConfirm.target);
  }, [applyMode, confirmed, pendingConfirm]);

  const handleSyncNow = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMessage(null);
    try {
      const outcome = await syncRuntime.syncNow(
        mode,
        webdavValuesRef.current ?? undefined,
      );
      setSyncMessage({
        kind:
          outcome.kind === 'synced'
            ? 'success'
            : outcome.kind === 'failed'
              ? 'error'
              : 'info',
        text: outcome.message,
      });
      setStatus(outcome.status);
      setStatusError(null);
    } catch (reason) {
      setSyncMessage({
        kind: 'error',
        text: formatError(reason, '同步失败'),
      });
      await refreshStatus();
    } finally {
      setSyncing(false);
    }
  }, [mode, refreshStatus, syncRuntime, syncing]);

  const currentProfile = status?.backendProfile ?? null;
  const effectiveBackendBaseUrl =
    backendBaseUrl || currentProfile?.baseUrl || '';

  return (
    <SettingsCard
      title="同步与网络"
      description="每台设备只能选一种同步模式；切换模式不会删除本机数据。"
    >
      <div className="settings-subhead">
        <b>同步模式</b>
        <span>
          {webOnly
            ? 'Web 端固定后台直连，不提供 WebDAV 与仅本机选项。'
            : '仅本机短路所有网络；WebDAV 与后台直连按需联网。'}
        </span>
      </div>

      {webOnly ? (
        <div className="settings-mode-grid" aria-label="同步模式">
          <div
            className="settings-mode is-active"
            aria-label="同步模式：后台直连"
          >
            <div className="settings-mode-head">
              <b>后台直连</b>
              <span className="settings-badge">Web 唯一</span>
            </div>
            <p>Web 端只连接知行后台；不显示 WebDAV 入口。</p>
          </div>
        </div>
      ) : (
        <div className="settings-mode-grid" role="group" aria-label="同步模式">
          {DESKTOP_MODES.map((item) => {
            const active = item.id === mode;
            return (
              <button
                key={item.id}
                type="button"
                className={
                  active ? 'settings-mode is-active' : 'settings-mode'
                }
                aria-label={`同步模式：${item.label}`}
                aria-pressed={active}
                disabled={active || switching || syncing}
                onClick={() => void requestMode(item.id)}
              >
                <span className="settings-mode-head">
                  <b>{item.label}</b>
                  <span className="settings-badge">
                    {modeBadge(item.id, active, status)}
                  </span>
                </span>
                <p>{item.description}</p>
              </button>
            );
          })}
        </div>
      )}

      {modeError ? (
        <div className="settings-error" role="alert">
          {modeError}
        </div>
      ) : null}
      {modeMessage ? (
        <div className="settings-banner" role="status">
          {modeMessage}
        </div>
      ) : null}

      {statusError ? (
        <div className="settings-error" role="alert">
          同步状态读取失败：{statusError}
        </div>
      ) : null}

      <SyncStatusCard
        mode={mode}
        status={status}
        loading={statusLoading}
        syncing={syncing}
        message={syncMessage}
        onSyncNow={() => void handleSyncNow()}
        onRefresh={() => void refreshStatus()}
      />

      {!webOnly ? (
        <div className="settings-sync-block">
          <div className="settings-subhead">
            <b>WebDAV</b>
            <span>
              配置与测试需要主动操作；仅本机模式下不会自动连接。
            </span>
          </div>
          <WebDavConfig
            platform={resolvedPlatform}
            tester={webdavTester}
            configStore={webdavStore}
            onValuesChange={handleWebDavValues}
            onSaved={handleWebDavSaved}
          />
        </div>
      ) : null}

      <div className="settings-sync-block">
        <div className="settings-subhead">
          <b>后台直连</b>
          <span>配对码只用于本次配对，不落盘；设备令牌由同步存储管理。</span>
        </div>
        <BackendConfig
          initialBaseUrl={effectiveBackendBaseUrl}
          initialDeviceName={
            backendDeviceName !== '本机'
              ? backendDeviceName
              : (currentProfile?.deviceName ?? backendDeviceName)
          }
          profile={currentProfile}
          onPair={handlePair}
          onBaseUrlCommit={rememberBackendConfig}
          onPaired={(profile) => {
            setModeMessage(`配对成功：${profile.deviceName}，可切换到后台直连`);
          }}
          disabled={switching || syncing}
          webOnly={webOnly}
        />
      </div>

      <SettingsRow
        label="当前设备"
        description="数据写入本机 SQLite；浏览器预览使用 localStorage 镜像。"
      >
        <span className="settings-value">
          {sourceMode === 'sqlite' ? '本机数据库' : '浏览器预览'}
        </span>
      </SettingsRow>

      <SettingsRow
        label="账号与成员"
        description="知行是单用户产品：没有账号、登录、席位、成员或协作空间。"
      >
        <span className="settings-value">不适用</span>
      </SettingsRow>

      <SettingsRow
        label="冲突策略"
        description="结构化字段按 LWW 合并，正文与画板合并，不静默覆盖；冲突副本会保留。"
      >
        <span className="settings-value">
          {status ? `${status.pendingConflicts} 条待处理冲突` : '—'}
        </span>
      </SettingsRow>

      <div className="settings-actions">
        <Link className="settings-link" to="/settings/data">
          数据与备份
        </Link>
      </div>

      {pendingConfirm ? (
        <div
          className="settings-dialog-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setPendingConfirm(null);
              setConfirmed(false);
            }
          }}
        >
          <div
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
          >
            <h4 id={dialogTitleId}>确认切换同步模式</h4>
            <p>{pendingConfirm.decision.message}</p>
            {pendingConfirm.decision.steps.length > 0 ? (
              <ul>
                {pendingConfirm.decision.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            ) : null}
            <label className="settings-dialog-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>我已了解未上传修改的影响，仍要切换</span>
            </label>
            <div className="settings-dialog-actions">
              <button
                type="button"
                className="settings-sync-button"
                onClick={() => {
                  setPendingConfirm(null);
                  setConfirmed(false);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="settings-sync-button is-danger"
                disabled={!confirmed || switching}
                onClick={() => void confirmSwitch()}
              >
                确认切换
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </SettingsCard>
  );
}
