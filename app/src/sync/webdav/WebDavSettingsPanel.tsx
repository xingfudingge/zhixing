/**
 * WebDAV 设置面板（可直接挂到设置 → 同步与网络）。
 *
 * - Web 平台不渲染任何输入框/按钮，只显示“只连后台”的说明；
 * - 连接测试是真实请求，逐项展示 PROPFIND/MKCOL/PUT/GET/DELETE/分片结果；
 * - 密码只留在当前组件状态，保存配置时显式不落盘；
 * - 模式切换按钮只在调用方提供 `onModeChange` 时出现，未上传修改必须先确认。
 */

import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';

import {
  evaluateModeSwitch,
  type ConnectionCheck,
  type ConnectionTestResult,
  type ModeSwitchDecision,
  type Platform,
  type SyncMode,
  WebDavClient,
  toUserFacingError,
} from '../../../../packages/sync-webdav/src/index.ts';
import {
  defaultWebDavConfig,
  LocalStorageWebDavConfigStore,
  type WebDavConfigStore,
  type WebDavSavedConfig,
} from './configStore.ts';
import { detectPlatform } from './platform.ts';
import './webdav.css';

export type WebDavFormValues = {
  baseUrl: string;
  username: string;
  password: string;
  root: string;
  spaceId: string;
  deviceId: string;
  deviceName: string;
};

export type WebDavConnectionTester = (
  values: WebDavFormValues,
  platform: Platform,
) => Promise<ConnectionTestResult>;

export type WebDavSettingsPanelProps = {
  platform?: Platform;
  initialValues?: Partial<WebDavFormValues>;
  tester?: WebDavConnectionTester;
  configStore?: WebDavConfigStore;
  currentMode?: SyncMode;
  pendingUploads?: number;
  onModeChange?: (
    target: SyncMode,
    decision: ModeSwitchDecision,
  ) => void | Promise<void>;
  /** 嵌入设置分组时由宿主统一渲染模式选择器。 */
  showModeSwitch?: boolean;
  /** 把当前表单值（含仅内存密码）交给宿主，供“立即同步”使用。 */
  onValuesChange?: (values: WebDavFormValues) => void;
  onSaved?: (config: WebDavSavedConfig) => void;
};

const MODES: { id: SyncMode; label: string }[] = [
  { id: 'local', label: '仅本机' },
  { id: 'webdav', label: 'WebDAV' },
  { id: 'backend', label: '后台直连' },
];

function safeConfig(values: WebDavFormValues): WebDavSavedConfig {
  return {
    version: 1,
    baseUrl: values.baseUrl.trim(),
    username: values.username,
    root: values.root.trim() || '/zhixing',
    spaceId: values.spaceId.trim() || 'personal',
    deviceId: values.deviceId,
    deviceName: values.deviceName.trim() || '本机',
    passwordSaved: false,
    updatedAt: new Date().toISOString(),
  };
}

function defaultTester(
  values: WebDavFormValues,
  platform: Platform,
): Promise<ConnectionTestResult> {
  const client = new WebDavClient({
    baseUrl: values.baseUrl,
    username: values.username,
    password: values.password,
    root: values.root,
    spaceId: values.spaceId,
    deviceId: values.deviceId,
    platform,
  });
  return client.testConnection();
}

function checkLabel(status: ConnectionCheck['status']): string {
  if (status === 'ok') return '通过';
  if (status === 'failed') return '失败';
  return '跳过';
}

export function WebDavSettingsPanel({
  platform = detectPlatform(),
  initialValues,
  tester = defaultTester,
  configStore,
  currentMode = 'local',
  pendingUploads = 0,
  onModeChange,
  showModeSwitch = true,
  onValuesChange,
  onSaved,
}: WebDavSettingsPanelProps) {
  const formId = useId();
  const defaults = useMemo(() => defaultWebDavConfig(), []);
  const store = useMemo(
    () => configStore ?? new LocalStorageWebDavConfigStore(),
    [configStore],
  );
  const [values, setValues] = useState<WebDavFormValues>({
    baseUrl: initialValues?.baseUrl ?? defaults.baseUrl,
    username: initialValues?.username ?? defaults.username,
    password: initialValues?.password ?? '',
    root: initialValues?.root ?? defaults.root,
    spaceId: initialValues?.spaceId ?? defaults.spaceId,
    deviceId: initialValues?.deviceId ?? defaults.deviceId,
    deviceName: initialValues?.deviceName ?? defaults.deviceName,
  });
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [failure, setFailure] = useState<{
    title: string;
    message: string;
    hint: string | null;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<{
    decision: ModeSwitchDecision;
    target: SyncMode;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  useEffect(() => {
    onValuesChange?.(values);
  }, [onValuesChange, values]);

  // 有持久化配置时回填；密码永远不回填。
  useEffect(() => {
    if (initialValues) return;
    let cancelled = false;
    void store.load().then((saved) => {
      if (cancelled || !saved) return;
      setValues({
        baseUrl: saved.baseUrl,
        username: saved.username,
        password: '',
        root: saved.root,
        spaceId: saved.spaceId,
        deviceId: saved.deviceId,
        deviceName: saved.deviceName,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [initialValues, store]);

  // Web 端明确没有入口：不渲染任何表单控件，避免“看似能用”。
  if (platform === 'web') {
    return (
      <section
        className="webdav-panel webdav-panel-blocked"
        aria-labelledby={`${formId}-blocked-title`}
      >
        <h3 id={`${formId}-blocked-title`}>WebDAV</h3>
        <p role="status">
          Web 端只连接知行后台，不提供 WebDAV 入口。浏览器受 CORS
          与认证限制，请使用桌面/移动客户端配置 OpenList / Alist。
        </p>
      </section>
    );
  }

  const update = <K extends keyof WebDavFormValues>(
    key: K,
    value: WebDavFormValues[K],
  ) => {
    setValues((current) => ({ ...current, [key]: value }));
    setResult(null);
    setFailure(null);
    setNotice(null);
  };

  const runTest = async (event?: FormEvent) => {
    event?.preventDefault();
    if (testing) return;
    setTesting(true);
    setFailure(null);
    setResult(null);
    setNotice(null);
    try {
      const tested = await tester(values, platform);
      setResult(tested);
      if (!tested.ok) {
        setFailure({
          title: '连接测试未通过',
          message: tested.error?.message ?? '请检查地址、账号与目录权限',
          hint: tested.error?.hint ?? null,
        });
      }
    } catch (error) {
      const friendly = toUserFacingError(error);
      setFailure({
        title: friendly.title,
        message: friendly.message,
        hint: friendly.hint,
      });
    } finally {
      setTesting(false);
    }
  };

  const saveConfig = async () => {
    if (saving) return;
    setSaving(true);
    setFailure(null);
    try {
      const config = safeConfig(values);
      await store.save(config);
      setNotice('连接信息已保存；应用密码不落盘，下次连接需重新输入。');
      onSaved?.(config);
    } catch (error) {
      const friendly = toUserFacingError(error);
      setFailure({
        title: friendly.title,
        message: friendly.message,
        hint: friendly.hint,
      });
    } finally {
      setSaving(false);
    }
  };

  const requestMode = (target: SyncMode) => {
    setModeError(null);
    setPendingSwitch(null);
    setConfirmed(false);
    const decision = evaluateModeSwitch({
      platform,
      from: currentMode,
      to: target,
      pendingUploads,
      confirmed: false,
    });
    if (decision.requiresConfirmation) {
      setPendingSwitch({ decision, target });
      return;
    }
    if (!decision.allowed) {
      setModeError(decision.message);
      return;
    }
    void onModeChange?.(target, decision);
  };

  const confirmMode = async () => {
    if (!pendingSwitch || !confirmed || !onModeChange) return;
    const decision = evaluateModeSwitch({
      platform,
      from: currentMode,
      to: pendingSwitch.target,
      pendingUploads,
      confirmed: true,
    });
    if (!decision.allowed) {
      setModeError(decision.message);
      setPendingSwitch(null);
      return;
    }
    try {
      await onModeChange(pendingSwitch.target, decision);
      setPendingSwitch(null);
      setConfirmed(false);
    } catch (error) {
      setModeError(error instanceof Error ? error.message : '切换失败');
    }
  };

  const testedOk = result?.ok === true;

  return (
    <section className="webdav-panel" aria-labelledby={`${formId}-title`}>
      <header className="webdav-head">
        <div>
          <h3 id={`${formId}-title`}>WebDAV（OpenList / Alist）</h3>
          <p>
            不依赖 If-Match / ETag / LOCK。远端只写不可变文件，状态由目录清单推导。
          </p>
        </div>
        <span className="webdav-platform">{platform}</span>
      </header>

      <form className="webdav-form" onSubmit={runTest}>
        <label className="webdav-field webdav-field-wide">
          <span>WebDAV 地址</span>
          <input
            type="url"
            name="baseUrl"
            aria-label="WebDAV 地址"
            placeholder="https://dav.example.com/dav"
            value={values.baseUrl}
            onChange={(event) => update('baseUrl', event.target.value)}
            required
          />
        </label>
        <label className="webdav-field">
          <span>用户名</span>
          <input
            name="username"
            aria-label="WebDAV 用户名"
            autoComplete="username"
            value={values.username}
            onChange={(event) => update('username', event.target.value)}
          />
        </label>
        <label className="webdav-field">
          <span>应用密码</span>
          <input
            type="password"
            name="password"
            aria-label="WebDAV 应用密码"
            autoComplete="new-password"
            value={values.password}
            onChange={(event) => update('password', event.target.value)}
          />
          <small>当前版本不落盘；接入 OS 安全存储前每次连接重新输入。</small>
        </label>
        <label className="webdav-field">
          <span>根目录</span>
          <input
            name="root"
            aria-label="WebDAV 根目录"
            value={values.root}
            onChange={(event) => update('root', event.target.value)}
          />
        </label>
        <label className="webdav-field">
          <span>空间 ID</span>
          <input
            name="spaceId"
            aria-label="同步空间 ID"
            value={values.spaceId}
            onChange={(event) => update('spaceId', event.target.value)}
          />
        </label>
        <label className="webdav-field">
          <span>设备 ID</span>
          <input
            name="deviceId"
            aria-label="设备 ID"
            value={values.deviceId}
            onChange={(event) => update('deviceId', event.target.value)}
          />
        </label>

        <div className="webdav-actions">
          <button type="submit" className="webdav-button is-primary" disabled={testing}>
            {testing ? '探测中…' : '测试连接'}
          </button>
          <button
            type="button"
            className="webdav-button"
            onClick={() => void saveConfig()}
            disabled={!testedOk || saving}
          >
            {saving ? '保存中…' : '保存连接信息'}
          </button>
        </div>
      </form>

      {failure ? (
        <div className="webdav-alert" role="alert">
          <b>{failure.title}</b>
          <span>{failure.message}</span>
          {failure.hint ? <small>{failure.hint}</small> : null}
        </div>
      ) : null}

      {notice ? (
        <div className="webdav-notice" role="status">
          {notice}
        </div>
      ) : null}

      {result ? (
        <div className="webdav-checks" aria-label="连接测试结果">
          <div className={result.ok ? 'webdav-result is-ok' : 'webdav-result is-failed'}>
            {result.ok ? '连接可用' : '连接不可用'}
            <span>{result.testedAt}</span>
          </div>
          <ul>
            {result.checks.map((check) => (
              <li key={check.id} data-status={check.status}>
                <span className={`webdav-dot is-${check.status}`} aria-hidden="true" />
                <b>{check.label}</b>
                <em>{checkLabel(check.status)}</em>
                {check.detail ? <small>{check.detail}</small> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {showModeSwitch ? (
        <section className="webdav-modes" aria-label="同步模式">
          <header>
            <h4>同步模式</h4>
            <span>当前：{MODE_LABEL[currentMode]}</span>
          </header>
          {pendingUploads > 0 ? (
            <p className="webdav-pending" role="status">
              本机有 {pendingUploads} 条修改待上传。切换到仅本机或更换 transport 前需要确认。
            </p>
          ) : null}
          <div className="webdav-mode-buttons">
            {MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={
                  mode.id === currentMode
                    ? 'webdav-mode is-active'
                    : 'webdav-mode'
                }
                aria-pressed={mode.id === currentMode}
                onClick={() => requestMode(mode.id)}
                disabled={mode.id === currentMode || !onModeChange}
              >
                {mode.label}
              </button>
            ))}
          </div>
          {!onModeChange ? (
            <p className="webdav-hint">
              模式切换由同步引擎/设置页宿主提供回调；此处不伪造切换按钮行为。
            </p>
          ) : null}
          {modeError ? (
            <div className="webdav-alert" role="alert">
              <b>切换被阻止</b>
              <span>{modeError}</span>
            </div>
          ) : null}
        </section>
      ) : null}

      {showModeSwitch && pendingSwitch ? (
        <div
          className="webdav-dialog-backdrop"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setPendingSwitch(null);
          }}
        >
          <div
            className="webdav-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${formId}-confirm-title`}
          >
            <h4 id={`${formId}-confirm-title`}>确认切换同步模式</h4>
            <p>{pendingSwitch.decision.message}</p>
            <ul>
              {pendingSwitch.decision.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
            <label className="webdav-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>我已了解未上传修改的影响，仍要切换</span>
            </label>
            <div className="webdav-dialog-actions">
              <button
                type="button"
                className="webdav-button"
                onClick={() => setPendingSwitch(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="webdav-button is-danger"
                disabled={!confirmed}
                onClick={() => void confirmMode()}
              >
                确认切换
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const MODE_LABEL: Record<SyncMode, string> = {
  local: '仅本机',
  webdav: 'WebDAV',
  backend: '后台直连',
};
