/**
 * 后台直连配置：服务地址 + 配对码 + 配对状态。
 *
 * - 配对码只在当前组件内存中存在，提交后立即清空，绝不落盘；
 * - 配对失败展示服务端/网络返回的真实错误，不伪造“已配对”；
 * - 配对成功后由宿主刷新 SyncEngine 状态并展示设备 ID、上次同步和错误。
 */

import { useEffect, useId, useState, type FormEvent } from 'react';

import type { BackendProfileView } from '../sync/types.ts';

export type BackendPairingRequest = {
  baseUrl: string;
  code: string;
  deviceName: string;
};

export type BackendConfigProps = {
  initialBaseUrl?: string;
  initialDeviceName?: string;
  profile: BackendProfileView | null;
  onPair: (input: BackendPairingRequest) => Promise<BackendProfileView>;
  onBaseUrlCommit?: (baseUrl: string, deviceName: string) => void;
  onPaired?: (profile: BackendProfileView) => void;
  disabled?: boolean;
  webOnly?: boolean;
};

function formatTime(value: string | null): string {
  if (!value) return '尚未同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return '配对失败，请重试';
}

export function BackendConfig({
  initialBaseUrl = '',
  initialDeviceName = '本机',
  profile,
  onPair,
  onBaseUrlCommit,
  onPaired,
  disabled = false,
  webOnly = false,
}: BackendConfigProps) {
  const titleId = useId();
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [deviceName, setDeviceName] = useState(initialDeviceName);
  const [code, setCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 配置从本机存储/已配对 profile 迟到时补位，但不覆盖用户正在输入的值。
  useEffect(() => {
    setBaseUrl((current) => current || initialBaseUrl);
  }, [initialBaseUrl]);
  useEffect(() => {
    setDeviceName((current) =>
      current && current !== '本机' ? current : initialDeviceName,
    );
  }, [initialDeviceName]);

  const remember = () => {
    if (!onBaseUrlCommit) return;
    onBaseUrlCommit(baseUrl.trim(), deviceName.trim() || '本机');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pairing || disabled) return;
    setPairing(true);
    setError(null);
    setNotice(null);
    try {
      const paired = await onPair({
        baseUrl: baseUrl.trim(),
        code,
        deviceName: deviceName.trim() || '本机',
      });
      setCode('');
      setNotice(`配对成功：${paired.deviceName}`);
      setBaseUrl(paired.baseUrl);
      setDeviceName(paired.deviceName);
      onPaired?.(paired);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPairing(false);
    }
  };

  const paired = profile !== null;

  return (
    <section
      className="backend-panel"
      aria-labelledby={titleId}
      data-paired={paired ? 'true' : 'false'}
    >
      <header className="backend-head">
        <div>
          <h3 id={titleId}>后台直连（知行服务端）</h3>
          <p>
            {webOnly
              ? 'Web 端固定连接后台服务；浏览器不会发起 WebDAV 请求。'
              : '连接自建知行服务端；配对后使用设备令牌同步，不需要账号登录。'}
          </p>
        </div>
        <span
          className={
            paired ? 'settings-badge is-ok' : 'settings-badge'
          }
          role="status"
          aria-live="polite"
        >
          {paired ? '已配对' : '未配对'}
        </span>
      </header>

      <form className="settings-sync-form" onSubmit={(event) => void submit(event)}>
        <label className="settings-sync-field settings-sync-field-wide">
          <span>后台地址</span>
          <input
            type="url"
            name="backendBaseUrl"
            aria-label="后台地址"
            placeholder="https://sync.example.com"
            value={baseUrl}
            disabled={disabled}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setError(null);
              setNotice(null);
            }}
            onBlur={remember}
            required
          />
        </label>
        <label className="settings-sync-field">
          <span>配对码</span>
          <input
            type="text"
            name="pairingCode"
            aria-label="配对码"
            autoComplete="one-time-code"
            spellCheck={false}
            placeholder="服务端生成的短期配对码"
            value={code}
            disabled={disabled}
            onChange={(event) => {
              setCode(event.target.value);
              setError(null);
            }}
            required
          />
          <small>只用于本次配对，不会保存。</small>
        </label>
        <label className="settings-sync-field">
          <span>设备名称</span>
          <input
            type="text"
            name="deviceName"
            aria-label="设备名称"
            value={deviceName}
            disabled={disabled}
            onChange={(event) => setDeviceName(event.target.value)}
            onBlur={remember}
          />
        </label>
        <div className="settings-sync-actions">
          <button
            type="submit"
            className="settings-sync-button is-primary"
            disabled={disabled || pairing}
          >
            {pairing ? '配对中…' : paired ? '重新配对' : '配对设备'}
          </button>
        </div>
      </form>

      {profile ? (
        <dl className="backend-profile" aria-label="后台配对状态">
          <div>
            <dt>设备</dt>
            <dd>
              {profile.deviceName}
              <code>{profile.deviceId}</code>
            </dd>
          </div>
          <div>
            <dt>已配对地址</dt>
            <dd>{profile.baseUrl}</dd>
          </div>
          <div>
            <dt>上次同步</dt>
            <dd>{formatTime(profile.lastSyncAt)}</dd>
          </div>
          {profile.lastError ? (
            <div>
              <dt>上次错误</dt>
              <dd className="is-error">{profile.lastError}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="settings-hint" role="note">
          尚未配对。填写后台地址与配对码后点击“配对设备”；配对成功后才能切换到
          后台直连模式。
        </p>
      )}

      {error ? (
        <div className="settings-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="settings-banner" role="status">
          {notice}
        </div>
      ) : null}
    </section>
  );
}
