/**
 * OCR 引擎适配器。
 *
 * `system-local` 在桌面壳走 macOS Apple Vision（Tauri command），在浏览器
 * 预览才回退到 Shape Detection `TextDetector`。能力不存在时明确返回
 * unavailable；不会用示例文字、随机文本或“识别成功”占位符冒充结果。
 *
 * 自定义适配器是一个明确的 HTTP 协议；远程端点必须由用户勾选允许发送
 * 图片后才会收到任何像素。
 */

import {
  OcrProtocolError,
  OcrRemoteConsentError,
  OcrUnavailableError,
  isLocalEndpoint,
  redactEndpoint,
  type OcrBlock,
  type OcrCapability,
  type OcrResult,
  type OcrSettings,
} from './types';

export type OcrEngine = {
  readonly id: string;
  readonly name: string;
  readonly local: boolean;
  probe(): Promise<OcrCapability>;
  recognize(image: Blob, options?: { languages?: string[] }): Promise<OcrResult>;
};

/** 单张图片的字节上限，与 Rust `ocr::MAX_IMAGE_BYTES` 保持一致。 */
export const MAX_OCR_IMAGE_BYTES = 20 * 1024 * 1024;

/** Tauri `ocr_capability` / `ocr_probe` 的返回结构（camelCase）。 */
export type NativeOcrCapability = {
  available: boolean;
  engineName: string;
  languages: string[];
  version: string | null;
  reason: string | null;
};

export type NativeOcrBlock = {
  text: string;
  confidence: number | null;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
};

/** Tauri `ocr_recognize` 的返回结构（camelCase）。 */
export type NativeOcrResult = {
  text: string;
  language: string | null;
  confidence: number | null;
  blocks: NativeOcrBlock[];
  durationMs: number;
  engineName: string;
  languages?: string[];
  imageWidth?: number;
  imageHeight?: number;
};

/** Rust `OcrFailure`：stage/code/message 都是真实错误信息。 */
export type NativeOcrFailure = {
  stage?: 'input' | 'decode' | 'permission' | 'language' | 'architecture' | 'request';
  code?: string;
  message?: string;
};

/** 注入点：测试用假 bridge；生产用 Tauri invoke。 */
export type NativeOcrBridge = {
  capability(): Promise<NativeOcrCapability>;
  recognize(input: {
    bytes: Uint8Array;
    languages: string[];
  }): Promise<NativeOcrResult>;
};

export type OcrEngineEnvironment = {
  isDesktop?: boolean;
  nativeBridge?: NativeOcrBridge | null;
  /** 仅用于自定义适配器的测试注入；默认使用浏览器 fetch。 */
  fetchImpl?: FetchLike;
};

/** 桌面壳（Tauri）才有 `__TAURI_INTERNALS__`；纯浏览器预览没有。 */
export function isDesktopOcrRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 只在 Tauri 运行时创建；浏览器预览返回 null，由 TextDetector 承担预览。 */
function createTauriOcrBridge(): NativeOcrBridge | null {
  if (!isDesktopOcrRuntime()) return null;
  return {
    async capability() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<NativeOcrCapability>('ocr_capability');
    },
    async recognize(input) {
      const { invoke } = await import('@tauri-apps/api/core');
      // Tauri v2 的 Vec<u8> 参数按 JSON 数组传输；前端先做字节上限校验。
      return invoke<NativeOcrResult>('ocr_recognize', {
        imageBytes: Array.from(input.bytes),
        languages: input.languages,
      });
    },
  };
}


type DetectedText = {  rawValue?: string;
  boundingBox?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
};

type TextDetectorLike = {
  detect(source: ImageBitmapSource): Promise<DetectedText[]>;
};

type TextDetectorCtor = new () => TextDetectorLike;

function getTextDetector(): TextDetectorCtor | null {
  const candidate = (globalThis as { TextDetector?: unknown }).TextDetector;
  return typeof candidate === 'function' ? (candidate as TextDetectorCtor) : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeBox(value: DetectedText['boundingBox']): OcrBlock['boundingBox'] {
  if (!value) return null;
  const x = typeof value.x === 'number' ? value.x : 0;
  const y = typeof value.y === 'number' ? value.y : 0;
  const width = typeof value.width === 'number' ? value.width : 0;
  const height = typeof value.height === 'number' ? value.height : 0;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

async function createImageSource(image: Blob): Promise<ImageBitmapSource> {
  const bitmapFactory = (globalThis as { createImageBitmap?: unknown })
    .createImageBitmap;
  if (typeof bitmapFactory === 'function') {
    return (bitmapFactory as (blob: Blob) => Promise<ImageBitmap>)(image);
  }
  if (typeof Image !== 'undefined' && typeof URL !== 'undefined') {
    const url = URL.createObjectURL(image);
    try {
      const element = new Image();
      await new Promise<void>((resolve, reject) => {
        element.onload = () => resolve();
        element.onerror = () => reject(new Error('图片解码失败'));
        element.src = url;
      });
      return element;
    } finally {
      // ImageBitmap 不存在时才走这里；元素仍需在识别期间保持可用。
      URL.revokeObjectURL(url);
    }
  }
  throw new OcrUnavailableError('当前环境无法解码图片，不能运行 OCR');
}

export class BrowserTextDetectorEngine implements OcrEngine {
  readonly id = 'system-local';
  readonly name = '系统本地 OCR（浏览器预览）';
  readonly local = true;

  async probe(): Promise<OcrCapability> {
    const detector = getTextDetector();
    if (detector) {
      return {
        engineId: this.id,
        engineName: '系统本地 OCR（TextDetector 预览）',
        kind: 'system-local',
        available: true,
        local: true,
        languages: [],
        version: '浏览器预览',
        reason:
          '当前为浏览器预览：浏览器提供 TextDetector，可做预览识别；桌面壳使用 macOS Apple Vision 本地识别。',
      };
    }
    return {
      engineId: this.id,
      engineName: this.name,
      kind: 'system-local',
      available: false,
      local: true,
      languages: [],
      version: null,
      // 不能写成“系统没有 OCR”：macOS 有 Vision，只是浏览器预览访问不到。
      reason:
        '当前为浏览器预览，需桌面壳；桌面端使用 macOS Apple Vision 本地识别（浏览器未启用 TextDetector）。',
    };
  }

  async recognize(image: Blob): Promise<OcrResult> {
    const detector = getTextDetector();
    if (!detector) {
      throw new OcrUnavailableError(
        '当前为浏览器预览，需桌面壳；桌面端使用 macOS Apple Vision 本地识别（浏览器未启用 TextDetector）。',
      );
    }
    if (image.size === 0) {
      throw new OcrProtocolError('图片为空，无法识别');
    }
    const started = Date.now();
    const source = await createImageSource(image);
    let detected: DetectedText[];
    try {
      detected = await new detector().detect(source);
    } catch (reason) {
      throw new OcrUnavailableError(
        `系统 OCR 识别失败：${reason instanceof Error ? reason.message : '未知错误'}`,
      );
    } finally {
      if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
        source.close();
      }
    }

    const blocks: OcrBlock[] = detected
      .map((item) => ({
        text: typeof item.rawValue === 'string' ? item.rawValue : '',
        confidence: null,
        boundingBox: normalizeBox(item.boundingBox),
      }))
      .filter((block) => block.text.length > 0);
    const text = blocks
      .map((block) => block.text)
      .join('\n')
      .trim();

    return {
      engineId: this.id,
      engineName: this.name,
      text,
      language: null,
      confidence: null,
      blocks,
      durationMs: Date.now() - started,
      finishedAt: nowIso(),
    };
  }
}

function nativeFailure(reason: unknown): {
  stage?: NativeOcrFailure['stage'];
  message: string;
} {
  if (reason && typeof reason === 'object' && !Array.isArray(reason)) {
    const raw = reason as NativeOcrFailure;
    return {
      stage: raw.stage,
      message:
        typeof raw.message === 'string' && raw.message.trim()
          ? raw.message
          : '原生 OCR 调用失败，未返回原因',
    };
  }
  if (typeof reason === 'string' && reason.trim()) {
    return { message: reason };
  }
  if (reason instanceof Error && reason.message) {
    return { message: reason.message };
  }
  return { message: '原生 OCR 调用失败，未返回原因' };
}

function nativeFailureToError(reason: unknown): Error {
  const failure = nativeFailure(reason);
  if (
    failure.stage === 'input' ||
    failure.stage === 'decode' ||
    failure.stage === 'language'
  ) {
    return new OcrProtocolError(failure.message);
  }
  return new OcrUnavailableError(failure.message);
}

function mapNativeBlocks(value: unknown): OcrBlock[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === 'object' && !Array.isArray(item),
    )
    .map((item) => ({
      text: typeof item.text === 'string' ? item.text : '',
      confidence:
        typeof item.confidence === 'number' && Number.isFinite(item.confidence)
          ? item.confidence
          : null,
      boundingBox: normalizeBox(
        item.boundingBox as DetectedText['boundingBox'],
      ),
    }))
    .filter((block) => block.text.length > 0);
}

/**
 * 桌面壳的系统本地 OCR：通过 Tauri command 调用 macOS Apple Vision。
 *
 * 不在这里做任何图片解码/识别兜底：命令失败就返回具体阶段的错误；
 * 浏览器预览没有 Tauri 时由 `BrowserTextDetectorEngine` 明确提示“需桌面壳”。
 */
export class NativeVisionEngine implements OcrEngine {
  readonly id = 'system-local';
  readonly name = '系统本地 OCR（Apple Vision）';
  readonly local = true;
  private readonly bridge: NativeOcrBridge;

  constructor(bridge: NativeOcrBridge) {
    this.bridge = bridge;
  }

  private unavailable(reason: string): OcrCapability {
    return {
      engineId: this.id,
      engineName: this.name,
      kind: 'system-local',
      available: false,
      local: true,
      languages: [],
      version: null,
      reason,
    };
  }

  async probe(): Promise<OcrCapability> {
    try {
      const capability = await this.bridge.capability();
      if (!capability || typeof capability.available !== 'boolean') {
        return this.unavailable('原生 OCR 能力探测返回了无效结果');
      }
      return {
        engineId: this.id,
        engineName:
          typeof capability.engineName === 'string' &&
          capability.engineName.trim()
            ? capability.engineName
            : this.name,
        kind: 'system-local',
        available: capability.available,
        local: true,
        languages: Array.isArray(capability.languages)
          ? capability.languages.filter(
              (item): item is string => typeof item === 'string',
            )
          : [],
        version:
          typeof capability.version === 'string' ? capability.version : null,
        reason: typeof capability.reason === 'string' ? capability.reason : null,
      };
    } catch (reason) {
      const failure = nativeFailure(reason);
      return this.unavailable(
        `原生 OCR 能力探测失败（${failure.stage ?? 'request'}）：${failure.message}`,
      );
    }
  }

  async recognize(
    image: Blob,
    options: { languages?: string[] } = {},
  ): Promise<OcrResult> {
    if (image.size === 0) {
      throw new OcrProtocolError('图片为空，无法识别；不会生成占位文字');
    }
    if (image.size > MAX_OCR_IMAGE_BYTES) {
      throw new OcrProtocolError(
        `图片过大（${image.size} 字节），超过 ${MAX_OCR_IMAGE_BYTES} 字节上限，未发送给原生 OCR`,
      );
    }
    const started = Date.now();
    const bytes = new Uint8Array(await image.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new OcrProtocolError('图片为空，无法识别；不会生成占位文字');
    }

    let raw: NativeOcrResult;
    try {
      raw = await this.bridge.recognize({
        bytes,
        languages: options.languages ?? [],
      });
    } catch (reason) {
      throw nativeFailureToError(reason);
    }

    if (!raw || typeof raw.text !== 'string') {
      throw new OcrProtocolError('原生 OCR 返回结果缺少 text 字段');
    }
    return {
      engineId: this.id,
      engineName:
        typeof raw.engineName === 'string' && raw.engineName.trim()
          ? raw.engineName
          : this.name,
      text: raw.text,
      language: typeof raw.language === 'string' ? raw.language : null,
      confidence:
        typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
          ? raw.confidence
          : null,
      blocks: mapNativeBlocks(raw.blocks),
      durationMs:
        typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)
          ? raw.durationMs
          : Date.now() - started,
      finishedAt: nowIso(),
    };
  }
}



function parseCustomProbe(value: unknown): {
  name: string;
  version: string | null;
  languages: string[];
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const engine =
    raw.engine && typeof raw.engine === 'object' && !Array.isArray(raw.engine)
      ? (raw.engine as Record<string, unknown>)
      : raw;
  if (typeof engine.name !== 'string' || !engine.name.trim()) return null;
  const languages = Array.isArray(engine.languages)
    ? engine.languages.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    name: engine.name.trim(),
    version: typeof engine.version === 'string' ? engine.version : null,
    languages,
  };
}

function parseCustomResult(value: unknown, endpoint: string): {
  text: string;
  language: string | null;
  confidence: number | null;
  blocks: OcrBlock[];
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OcrProtocolError(`自定义引擎 ${redactEndpoint(endpoint)} 返回的不是 JSON 对象`);
  }
  const raw = value as Record<string, unknown>;
  const result =
    raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result)
      ? (raw.result as Record<string, unknown>)
      : raw;
  if (typeof result.text !== 'string') {
    throw new OcrProtocolError(
      `自定义引擎 ${redactEndpoint(endpoint)} 响应缺少 text 字段`,
    );
  }
  const blocks = Array.isArray(result.blocks)
    ? result.blocks
        .filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === 'object' && !Array.isArray(item),
        )
        .map((item) => ({
          text: typeof item.text === 'string' ? item.text : '',
          confidence:
            typeof item.confidence === 'number' &&
            Number.isFinite(item.confidence)
              ? item.confidence
              : null,
          boundingBox: normalizeBox(
            item.boundingBox as DetectedText['boundingBox'],
          ),
        }))
        .filter((item) => item.text.length > 0)
    : [];
  return {
    text: result.text,
    language: typeof result.language === 'string' ? result.language : null,
    confidence:
      typeof result.confidence === 'number' && Number.isFinite(result.confidence)
        ? result.confidence
        : null,
    blocks,
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class CustomAdapterEngine implements OcrEngine {
  readonly id = 'custom-adapter';
  readonly name = '自定义 OCR 适配器';
  readonly local: boolean;
  private readonly endpoint: string;
  private readonly allowRemoteImages: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: {
    endpoint: string;
    allowRemoteImages: boolean;
    timeoutMs: number;
    fetchImpl?: FetchLike;
  }) {
    this.endpoint = options.endpoint;
    this.local = isLocalEndpoint(options.endpoint);
    this.allowRemoteImages = options.allowRemoteImages;
    this.timeoutMs = options.timeoutMs;
    const fetchImpl = options.fetchImpl;
    this.fetchImpl =
      fetchImpl ??
      ((input, init) => {
        if (typeof fetch !== 'function') {
          return Promise.reject(new Error('当前环境没有 fetch'));
        }
        return fetch(input, init);
      });
  }

  async probe(): Promise<OcrCapability> {
    if (!this.endpoint) {
      return {
        engineId: this.id,
        engineName: this.name,
        kind: 'custom-adapter',
        available: false,
        local: true,
        languages: [],
        version: null,
        reason: '尚未填写自定义引擎端点',
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5_000));
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          engineId: this.id,
          engineName: this.name,
          kind: 'custom-adapter',
          available: false,
          local: this.local,
          languages: [],
          version: null,
          reason: `端点探测失败（HTTP ${response.status}）`,
        };
      }
      const body = (await response.json().catch(() => null)) as unknown;
      const parsed = parseCustomProbe(body);
      if (!parsed) {
        return {
          engineId: this.id,
          engineName: this.name,
          kind: 'custom-adapter',
          available: false,
          local: this.local,
          languages: [],
          version: null,
          reason: '端点返回的能力信息不符合协议（需要 JSON name 字段）',
        };
      }
      return {
        engineId: this.id,
        engineName: parsed.name,
        kind: 'custom-adapter',
        available: true,
        local: this.local,
        languages: parsed.languages,
        version: parsed.version,
        reason: this.local
          ? null
          : '远程适配器已配置；发送图片前仍需在识别时确认',
      };
    } catch (reason) {
      return {
        engineId: this.id,
        engineName: this.name,
        kind: 'custom-adapter',
        available: false,
        local: this.local,
        languages: [],
        version: null,
        reason: `端点不可达：${redactEndpoint(this.endpoint)}（${
          reason instanceof Error ? reason.message : '未知错误'
        }）`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async recognize(image: Blob, options: { languages?: string[] } = {}): Promise<OcrResult> {
    if (!this.endpoint) {
      throw new OcrUnavailableError('尚未配置自定义 OCR 引擎端点');
    }
    if (!this.local && !this.allowRemoteImages) {
      throw new OcrRemoteConsentError(this.endpoint);
    }
    if (image.size === 0) {
      throw new OcrProtocolError('图片为空，无法识别');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': image.type || 'application/octet-stream',
          accept: 'application/json',
          'x-ocr-language': (options.languages ?? []).join(','),
        },
        body: image,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new OcrProtocolError(
          `自定义引擎 ${redactEndpoint(this.endpoint)} 识别失败（HTTP ${response.status}）`,
        );
      }
      const body = (await response.json().catch(() => null)) as unknown;
      const parsed = parseCustomResult(body, this.endpoint);
      return {
        engineId: this.id,
        engineName: this.name,
        text: parsed.text,
        language: parsed.language,
        confidence: parsed.confidence,
        blocks: parsed.blocks,
        durationMs: Date.now() - started,
        finishedAt: nowIso(),
      };
    } catch (reason) {
      if (reason instanceof OcrProtocolError) throw reason;
      if ((reason as Error)?.name === 'AbortError') {
        throw new OcrUnavailableError(
          `自定义引擎 ${redactEndpoint(this.endpoint)} 识别超时`,
        );
      }
      throw new OcrUnavailableError(
        `自定义引擎 ${redactEndpoint(this.endpoint)} 调用失败：${
          reason instanceof Error ? reason.message : '未知错误'
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

export class UnavailableOcrEngine implements OcrEngine {
  readonly id = 'none';
  readonly name = '未配置 OCR 引擎';
  readonly local = true;

  async probe(): Promise<OcrCapability> {
    return {
      engineId: this.id,
      engineName: this.name,
      kind: 'none',
      available: false,
      local: true,
      languages: [],
      version: null,
      reason: '未选择 OCR 引擎',
    };
  }

  async recognize(): Promise<OcrResult> {
    throw new OcrUnavailableError('未选择 OCR 引擎');
  }
}

function defaultOcrEnvironment(): OcrEngineEnvironment {
  const isDesktop = isDesktopOcrRuntime();
  return {
    isDesktop,
    nativeBridge: isDesktop ? createTauriOcrBridge() : null,
  };
}

function normalizeEnvironment(
  value?: OcrEngineEnvironment | FetchLike,
): OcrEngineEnvironment {
  if (typeof value === 'function') {
    return { fetchImpl: value };
  }
  return value ?? defaultOcrEnvironment();
}

export function resolveOcrEngine(
  settings: OcrSettings,
  environmentOrFetch?: OcrEngineEnvironment | FetchLike,
): OcrEngine {
  if (settings.engine === 'none') {
    return new UnavailableOcrEngine();
  }
  const environment = normalizeEnvironment(environmentOrFetch);
  if (settings.engine === 'custom-adapter') {
    return new CustomAdapterEngine({
      endpoint: settings.custom.endpoint,
      allowRemoteImages: settings.custom.allowRemoteImages,
      timeoutMs: settings.custom.timeoutMs,
      fetchImpl: environment.fetchImpl,
    });
  }
  // system-local：桌面壳优先 Apple Vision；浏览器预览才用 TextDetector。
  const bridge =
    environment.nativeBridge ??
    (environment.isDesktop ? createTauriOcrBridge() : null);
  if (bridge) {
    return new NativeVisionEngine(bridge);
  }
  return new BrowserTextDetectorEngine();
}
