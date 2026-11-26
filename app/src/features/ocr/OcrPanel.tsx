/**
 * OCR 设置与队列面板。
 *
 * 默认关闭；打开后仍必须有一个真实可用的引擎。测试识别会调用当前引擎，
 * 引擎不可用/未配置时只显示原因，不显示示例文字。
 */

import { useCallback, useEffect, useState } from 'react';

import { NOTE_FOLDERS } from '../../data/repositories/notes';
import type { OcrImageResolver, OcrService } from './service';
import { isDesktopOcrRuntime } from './engines';
import { OCR_LANGUAGES, normalizeEndpoint } from './settings';
import {
  describeTextSyncAvailability,
  type TextSyncAvailability,
} from './textSync';
import {
  isLocalEndpoint,
  isScopeConfigured,
  jobStatusLabel,
  redactEndpoint,
  scopeLabel,
  textSyncStateLabel,
  type OcrCapability,
  type OcrImageCandidate,
  type OcrJob,
  type OcrResult,
  type OcrSettings,
} from './types';
import './ocr.css';

export type OcrPanelProps = {
  service: OcrService;
  resolveImage?: OcrImageResolver;
  /** 按识别范围排队时列出真实附件图片；缺失时按钮禁用并明确提示。 */
  listImages?: () => Promise<OcrImageCandidate[]>;
  onNotice?: (message: string) => void;
};

function capabilityTone(capability: OcrCapability | null): string {
  if (!capability) return 'neutral';
  return capability.available ? 'ok' : 'warn';
}

function folderName(folderId: string | null): string {
  if (!folderId) return '未选择';
  return (
    NOTE_FOLDERS.find((folder) => folder.id === folderId)?.name ??
    `已保存目录（${folderId}）`
  );
}

function imageDestination(
  settings: OcrSettings,
  remoteEndpointSelected: boolean,
): string {
  if (!settings.enabled) {
    return '图片 OCR 当前关闭，不会读取或上传任何图片。';
  }
  if (settings.engine === 'none') {
    return '未选择引擎，不会处理任何图片。';
  }
  if (settings.engine === 'system-local') {
    return '图片在本机解码，不上传、不发送到网络；引擎缺失时不会处理。';
  }
  if (!settings.custom.endpoint) {
    return '尚未配置自定义端点，不会处理任何图片。';
  }
  const endpoint = redactEndpoint(settings.custom.endpoint);
  if (!isLocalEndpoint(settings.custom.endpoint)) {
    return remoteEndpointSelected
      ? `会把这台设备上的图片发送到你配置的远程端点 ${endpoint}（已显式允许）。`
      : `远程端点 ${endpoint} 默认拒绝发送图片；未勾选“允许远程处理图片”前不会发出任何像素。`;
  }
  return `图片只发送到本机端点 ${endpoint}，不会发往互联网。`;
}

export function OcrPanel({
  service,
  resolveImage,
  listImages,
  onNotice,
}: OcrPanelProps) {
  const [settings, setSettings] = useState<OcrSettings>(() => service.settings());
  const desktopRuntime = isDesktopOcrRuntime();
  const [endpointDraft, setEndpointDraft] = useState(
    () => service.settings().custom.endpoint,
  );
  const [capability, setCapability] = useState<OcrCapability | null>(null);
  const [probing, setProbing] = useState(false);
  const [jobs, setJobs] = useState<OcrJob[]>([]);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [recognizing, setRecognizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [scopeResult, setScopeResult] = useState<string | null>(null);
  // 同步读取本机模式/配对状态，避免挂载时异步 setState；模式变化后重新渲染即可。
  const syncAvailability: TextSyncAvailability =
    describeTextSyncAvailability();

  const publish = useCallback((next: OcrSettings) => {
    setSettings(next);
  }, []);

  const persist = useCallback(
    (patch: Partial<OcrSettings>, options?: { probe?: boolean }) => {
      const next = service.saveSettings({ ...settings, ...patch });
      publish(next);
      // 端点输入过程中不要逐字探测：一旦 URL 语法成立就会向用户刚输入的
      // 地址发网络请求。改为用户点击“测试引擎可用性”时显式探测。
      if (options?.probe !== false) {
        void service.capability().then(setCapability);
      } else {
        // 端点草稿变化后旧的能力结果已过期；等用户点击测试或重新选择引擎。
        setCapability(null);
      }
      return next;
    },
    [publish, service, settings],
  );

  const probe = useCallback(async () => {
    setProbing(true);
    setError(null);
    try {
      const current = await service.capability();
      setCapability(current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '引擎探测失败');
    } finally {
      setProbing(false);
    }
  }, [service]);

  const refreshJobs = useCallback(async () => {
    try {
      setJobs(await service.listJobs());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取 OCR 队列失败');
    }
  }, [service]);

  useEffect(() => {
    void probe();
    void refreshJobs();
  }, [probe, refreshJobs]);

  // 端点输入保持本地草稿，不能每敲一个字就回写归一化值：
  // 例如 `http://1` 会被 URL 解析成 `http://0.0.0.1/`，逐字同步会打断输入。
  // 有效地址即时保存，但草稿始终保留用户正在输入的文本；失焦时再校验。

  const handleTestImage = useCallback(
    async (fileList: FileList | null) => {
      const file = fileList?.[0];
      if (!file) return;
      setRecognizing(true);
      setError(null);
      setResult(null);
      try {
        const next = await service.recognizeTestImage(file);
        setResult(next);
        onNotice?.(
          next.text.trim()
            ? '识别完成。文本来自本地/已确认的引擎，未做任何补全。'
            : '引擎返回空文本，没有识别到文字。',
        );
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'OCR 识别失败');
      } finally {
        setRecognizing(false);
      }
    },
    [onNotice, service],
  );

  const handleProcess = useCallback(async () => {
    if (!resolveImage) return;
    setProcessing(true);
    setError(null);
    try {
      await service.processAll(resolveImage);
      await refreshJobs();
      onNotice?.('OCR 队列处理完成。失败作业保留错误原因，可重试。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'OCR 队列处理失败');
    } finally {
      setProcessing(false);
    }
  }, [onNotice, refreshJobs, resolveImage, service]);

  const handleQueueScope = useCallback(async () => {
    if (!listImages || !resolveImage) {
      setError('当前运行没有本机附件目录读取器，无法按范围排队。');
      return;
    }
    setQueueing(true);
    setError(null);
    setScopeResult(null);
    try {
      const candidates = await listImages();
      const outcome = await service.enqueueForScope(candidates, resolveImage);
      await refreshJobs();
      const summary = `已按“${scopeLabel(
        service.settings().scope,
      )}”排队：新增 ${outcome.queued}，跳过 ${outcome.skipped}，失败 ${outcome.failed}。`;
      setScopeResult(
        outcome.reasons.length > 0
          ? `${summary} ${outcome.reasons.slice(0, 3).join('；')}`
          : summary,
      );
      onNotice?.(summary);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '按范围排队失败');
    } finally {
      setQueueing(false);
    }
  }, [listImages, onNotice, refreshJobs, resolveImage, service]);

  const folderReady = isScopeConfigured(settings);
  const queueScopeDisabled =
    !settings.enabled ||
    !listImages ||
    !resolveImage ||
    !folderReady ||
    queueing;

  const customRemote =
    settings.engine === 'custom-adapter' &&
    settings.custom.endpoint !== '' &&
    !isLocalEndpoint(settings.custom.endpoint);

  return (
    <section className="zx-ocr" aria-label="图片 OCR">
      <header className="zx-ocr-head">
        <div>
          <h2>图片 OCR</h2>
          <p>默认关闭。只有真实可用的本地引擎，或你明确允许的适配器，才会处理图片。</p>
        </div>
        <span
          className={`zx-ocr-badge is-${capabilityTone(capability)}`}
          role="status"
        >
          {probing
            ? '正在探测…'
            : !capability
              ? '尚未探测'
              : capability.available
                ? '引擎可用'
                : '引擎不可用'}
        </span>
      </header>

      <label className="zx-ocr-toggle">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => persist({ enabled: event.target.checked })}
        />
        <span>
          <b>启用图片 OCR</b>
          <small>关闭后不再排新任务；已有识别文本不会被删除</small>
        </span>
      </label>

      <div className="zx-ocr-grid">
        <label className="zx-ocr-field">
          <span>识别引擎</span>
          <select
            value={settings.engine}
            onChange={(event) =>
              persist({ engine: event.target.value as OcrSettings['engine'] })
            }
          >
            <option value="system-local">系统本地 OCR（桌面 Apple Vision）</option>
            <option value="custom-adapter">自定义本地/远程适配器</option>
            <option value="none">不使用引擎</option>
          </select>
        </label>

        <label className="zx-ocr-field">
          <span>识别范围</span>
          <select
            aria-label="识别范围"
            value={settings.scope}
            onChange={(event) =>
              persist({ scope: event.target.value as OcrSettings['scope'] })
            }
          >
            <option value="new-images">仅新图片</option>
            <option value="all-images">全部图片</option>
            <option value="folder">指定目录</option>
          </select>
          <small className="zx-ocr-field-hint">
            仅新图片：已有识别记录的图片直接复用原结果；全部图片：允许重新识别；
            指定目录：只处理所选知识库目录。
          </small>
        </label>
      </div>

      {settings.scope === 'folder' ? (
        <label className="zx-ocr-field">
          <span>知识库目录</span>
          <select
            aria-label="OCR 指定目录"
            value={settings.scopeFolderId ?? ''}
            onChange={(event) =>
              persist({ scopeFolderId: event.target.value || null })
            }
          >
            <option value="">请选择目录</option>
            {NOTE_FOLDERS.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
            {settings.scopeFolderId &&
            !NOTE_FOLDERS.some((folder) => folder.id === settings.scopeFolderId) ? (
              <option value={settings.scopeFolderId}>
                已保存目录（{settings.scopeFolderId}）
              </option>
            ) : null}
          </select>
          <small className="zx-ocr-field-hint">
            只处理该知识库目录内笔记下的图片；目录由知识库维护，不扫描任意本机文件夹。
          </small>
        </label>
      ) : null}

      {settings.scope === 'folder' && !settings.scopeFolderId ? (
        <p className="zx-ocr-warn" role="alert">
          尚未选择知识库目录：指定目录范围不会入队任何图片，“按范围排队”已禁用。请先选择目录，
          或改用“仅新图片/全部图片”。
        </p>
      ) : null}

      {settings.engine === 'system-local' && !desktopRuntime ? (
        <p className="zx-ocr-field-hint" role="status">
          当前为浏览器预览，需桌面壳；桌面端使用 macOS Apple Vision
          本地识别，不会误报“系统没有 OCR”。
        </p>
      ) : null}

      <fieldset className="zx-ocr-fieldset">
        <legend>识别语言</legend>
        <div className="zx-ocr-chips">
          {OCR_LANGUAGES.map((language) => {
            const checked = settings.languages.includes(language.id);
            return (
              <label key={language.id} className="zx-ocr-chip">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    const next = checked
                      ? settings.languages.filter((item) => item !== language.id)
                      : [...settings.languages, language.id];
                    persist({ languages: next });
                  }}
                />
                {language.label}
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="zx-ocr-fieldset">
        <legend>识别文本保存位置</legend>
        <label className="zx-ocr-radio">
          <input
            type="radio"
            name="ocr-text-storage"
            checked={settings.textStorage === 'local'}
            onChange={() => persist({ textStorage: 'local' })}
          />
          <span>
            仅本机 <small>默认；识别文本不进入同步</small>
          </span>
        </label>
        <label className="zx-ocr-radio">
          <input
            type="radio"
            name="ocr-text-storage"
            checked={settings.textStorage === 'sync'}
            onChange={() => persist({ textStorage: 'sync' })}
          />
          <span>
            随附件同步 <small>只同步识别文本、语言与来源哈希，不上传图片；文本可能暴露图片中的信息</small>
          </span>
        </label>
        {settings.textStorage === 'sync' ? (
          <p
            className={
              syncAvailability.ready ? 'zx-ocr-field-hint' : 'zx-ocr-warn'
            }
            role="status"
          >
            {syncAvailability.reason}
            {' '}
            同附件并发识别按字段合并，差异会进入 设置 → 同步 的冲突记录。
          </p>
        ) : null}
      </fieldset>

      {settings.engine === 'custom-adapter' ? (
        <div className="zx-ocr-custom">
          <label className="zx-ocr-field">
            <span>适配器端点</span>
            <input
              type="url"
              value={endpointDraft}
              placeholder="http://127.0.0.1:8080/ocr"
              aria-label="自定义适配器端点"
              onChange={(event) => {
                const value = event.target.value;
                setEndpointDraft(value);
                const normalized = normalizeEndpoint(value);
                if (normalized) {
                  persist(
                    {
                      custom: { ...settings.custom, endpoint: normalized },
                    },
                    { probe: false },
                  );
                } else if (!value.trim()) {
                  persist(
                    { custom: { ...settings.custom, endpoint: '' } },
                    { probe: false },
                  );
                }
              }}
              onBlur={() => {
                const normalized = normalizeEndpoint(endpointDraft);
                if (endpointDraft.trim() && !normalized) {
                  setError('适配器端点需为有效的 http(s) 地址，且不能包含账号密码；当前内容不会保存。');
                  return;
                }
                setEndpointDraft(normalized);
                if (normalized !== settings.custom.endpoint) {
                  persist(
                    {
                      custom: { ...settings.custom, endpoint: normalized },
                    },
                    { probe: false },
                  );
                }
              }}
            />
            <small className="zx-ocr-field-hint">
              端点不会保存账号密码；远程端点还需显式允许发送图片。
            </small>
          </label>
          <label className="zx-ocr-toggle is-small">
            <input
              type="checkbox"
              checked={settings.custom.allowRemoteImages}
              onChange={(event) =>
                persist({
                  custom: {
                    ...settings.custom,
                    allowRemoteImages: event.target.checked,
                  },
                })
              }
            />
            <span>
              <b>允许远程处理图片</b>
              <small>关闭时，非本机端点不会收到任何图片数据</small>
            </span>
          </label>
          {customRemote && !settings.custom.allowRemoteImages ? (
            <p className="zx-ocr-warn" role="alert">
              端点 {redactEndpoint(settings.custom.endpoint)} 不在本机；
              发送图片前必须显式允许远程处理。
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="zx-ocr-status">
        <div className="zx-ocr-status-main">
          <b>{capability?.engineName ?? '尚未探测'}</b>
          <span>
            {capability
              ? capability.reason ??
                (capability.available
                  ? '当前引擎可用于本机识别'
                  : '引擎不可用')
              : probing
                ? '正在探测引擎…'
                : '尚未探测引擎'}
          </span>
          {capability?.version ? <small>版本：{capability.version}</small> : null}
          {capability && capability.languages.length > 0 ? (
            <small>支持语言：{capability.languages.join('、')}</small>
          ) : null}
          {capability && !capability.available ? (
            <small>不会用模拟文字代替识别结果。</small>
          ) : null}
        </div>
        <button
          type="button"
          className="zx-ocr-button"
          onClick={() => void probe()}
          disabled={probing}
        >
          {probing ? '测试中…' : '测试引擎可用性'}
        </button>
      </div>

      <div className="zx-ocr-dest" aria-label="OCR 数据去向">
        <b>数据去向</b>
        <ul>
          <li>
            <span>图片</span>
            <em>
              {imageDestination(
                settings,
                settings.custom.allowRemoteImages,
              )}
            </em>
          </li>
          <li>
            <span>识别文本</span>
            <em>
              {settings.textStorage === 'local'
                ? '默认只保存在本机，不参与同步。'
                : `${syncAvailability.reason} 只同步文本，不上传图片；文本可能暴露图片中的信息。`}
            </em>
          </li>
          <li>
            <span>识别范围</span>
            <em>
              {scopeLabel(settings.scope)}
              {settings.scope === 'folder'
                ? `：${folderName(settings.scopeFolderId)}`
                : ''}
              ；关闭图片 OCR 后不再排新任务，已有识别文本保留，可手动清理。
            </em>
          </li>
        </ul>
      </div>

      <div className="zx-ocr-test">
        <label className="zx-ocr-button is-primary">
          {recognizing ? '识别中…' : '测试识别（选择图片）'}
          <input
            type="file"
            accept="image/*"
            className="zx-ocr-file"
            aria-label="选择 OCR 测试图片"
            disabled={recognizing || !settings.enabled}
            onChange={(event) => void handleTestImage(event.target.files)}
          />
        </label>
        {!settings.enabled ? (
          <small>先启用图片 OCR；默认关闭。</small>
        ) : null}
      </div>

      {error ? (
        <p className="zx-ocr-error" role="alert">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="zx-ocr-result" aria-label="OCR 识别结果">
          <header>
            <b>识别结果</b>
            <span>
              {result.engineName} · {result.durationMs}ms ·{' '}
              {result.blocks.length} 个文本块
            </span>
          </header>
          {result.text.trim() ? (
            <pre>{result.text}</pre>
          ) : (
            <p>引擎返回空文本：这张图片没有识别到文字（不是模拟结果）。</p>
          )}
          <small>
            {settings.textStorage === 'local'
              ? '测试识别结果只显示在当前页面，不写入队列；正式识别的结果只保存在本机，不参与同步。'
              : '测试识别结果只显示在当前页面，不写入队列；正式识别时结果会随附件同步（仅文本，不上传图片）。'}
          </small>
        </div>
      ) : null}

      <div className="zx-ocr-queue">
        <header>
          <b>识别队列</b>
          <span>
            待处理 {jobs.filter((job) => job.status === 'pending').length} ·
            识别中 {jobs.filter((job) => job.status === 'processing').length} ·
            失败 {jobs.filter((job) => job.status === 'failed').length}
          </span>
          <button
            type="button"
            className="zx-ocr-button"
            onClick={() => void handleQueueScope()}
            disabled={queueScopeDisabled}
            title={
              !listImages
                ? '当前运行没有本机附件目录读取器，无法按范围排队'
                : !folderReady
                  ? '指定目录尚未选择，不能按范围排队'
                  : '按当前识别范围把图片加入识别队列'
            }
          >
            {queueing ? '排队中…' : '按范围排队'}
          </button>
          <button
            type="button"
            className="zx-ocr-button"
            onClick={() => void handleProcess()}
            disabled={!resolveImage || processing || !settings.enabled}
            title={
              resolveImage
                ? '处理所有待识别作业'
                : '缺少原图读取器，无法在设置页直接处理队列'
            }
          >
            {processing ? '处理中…' : '处理队列'}
          </button>
        </header>
        {scopeResult ? (
          <p className="zx-ocr-field-hint" role="status">
            {scopeResult}
          </p>
        ) : null}
        {!listImages && settings.enabled ? (
          <p className="zx-ocr-field-hint">
            浏览器预览没有本机附件目录；按范围排队需桌面壳。处理队列仍会读取真实原图，不可用时保留具体原因。
          </p>
        ) : null}
        {jobs.length === 0 ? (
          <p className="zx-ocr-empty">暂无 OCR 作业。关闭时不会排队。</p>
        ) : (
          <ul className="zx-ocr-jobs">
            {jobs.map((job) => (
              <li key={job.id} data-status={job.status}>
                <div>
                  <b>{job.attachmentId}</b>
                  <small>
                    {jobStatusLabel(job.status)} · 尝试 {job.attempts} 次 ·{' '}
                    {job.textStorage === 'local' ? '仅本机' : '随附件同步'} ·{' '}
                    {textSyncStateLabel(job.textSyncState)}
                  </small>
                  {job.error ? <em>{job.error}</em> : null}
                  {job.textSyncState === 'failed' && job.textSyncError ? (
                    <em>{job.textSyncError}</em>
                  ) : null}
                  {job.status === 'succeeded' &&
                  job.textStorage === 'sync' &&
                  job.textSyncState === 'queued' ? (
                    <small>已写入同步 outbox；在 设置 → 同步 执行同步后上传文本。</small>
                  ) : null}
                  {job.status === 'succeeded' ? (
                    <pre>{job.text?.trim() || '（引擎返回空文本）'}</pre>
                  ) : null}
                </div>
                {job.status === 'failed' || job.status === 'canceled' ? (
                  <button
                    type="button"
                    className="zx-ocr-button"
                    onClick={() => {
                      void service.retry(job.id).then(refreshJobs);
                    }}
                  >
                    重试
                  </button>
                ) : job.status === 'pending' || job.status === 'processing' ? (
                  <button
                    type="button"
                    className="zx-ocr-button"
                    onClick={() => {
                      void service.cancel(job.id).then(refreshJobs);
                    }}
                  >
                    取消
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
