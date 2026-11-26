import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BrowserTextDetectorEngine,
  CustomAdapterEngine,
  NativeVisionEngine,
  resolveOcrEngine,
  type NativeOcrBridge,
  type NativeOcrResult,
} from '../engines';
import {
  DEFAULT_OCR_SETTINGS,
  OcrProtocolError,
  OcrRemoteConsentError,
  OcrUnavailableError,
} from '../types';
import { normalizeOcrSettings } from '../settings';

const PNG = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], {
  type: 'image/png',
});

function nativeResult(): NativeOcrResult {
  return {
    text: '真实识别文本',
    language: null,
    confidence: 0.9,
    blocks: [
      {
        text: '真实识别文本',
        confidence: 0.9,
        boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      },
    ],
    durationMs: 12,
    engineName: 'Apple Vision',
    languages: ['zh-Hans', 'en-US'],
    imageWidth: 640,
    imageHeight: 480,
  };
}

function nativeBridge(
  overrides: Partial<NativeOcrBridge> = {},
): NativeOcrBridge {
  return {
    capability: async () => ({
      available: true,
      engineName: 'Apple Vision',
      languages: ['zh-Hans', 'en'],
      version: 'Version 15.8.1',
      reason: null,
    }),
    recognize: async () => nativeResult(),
    ...overrides,
  };
}

afterEach(() => {
  delete (globalThis as { TextDetector?: unknown }).TextDetector;
  delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function installDetector(results: Array<{ rawValue: string }>): void {
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () =>
    ({ close: () => undefined } as unknown as ImageBitmap);
  (globalThis as { TextDetector?: unknown }).TextDetector = class {
    async detect() {
      return results.map((item) => ({
        rawValue: item.rawValue,
        boundingBox: { x: 1, y: 2, width: 30, height: 12 },
      }));
    }
  };
}

describe('系统本地 OCR 引擎', () => {
  it('没有 TextDetector 时明确提示浏览器预览需桌面壳，不误报系统没有 OCR', async () => {
    const engine = new BrowserTextDetectorEngine();
    const capability = await engine.probe();
    expect(capability.available).toBe(false);
    expect(capability.reason).toContain('浏览器预览');
    expect(capability.reason).toContain('需桌面壳');
    expect(capability.reason).toContain('TextDetector');
    expect(capability.reason).not.toContain('系统没有 OCR');
    await expect(engine.recognize(PNG)).rejects.toBeInstanceOf(
      OcrUnavailableError,
    );
  });

  it('使用系统 TextDetector 的真实返回值', async () => {
    installDetector([{ rawValue: '第一行' }, { rawValue: 'Second line' }]);
    const engine = new BrowserTextDetectorEngine();
    expect((await engine.probe()).available).toBe(true);
    const result = await engine.recognize(PNG);
    expect(result.text).toBe('第一行\nSecond line');
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]?.boundingBox).toEqual({
      x: 1,
      y: 2,
      width: 30,
      height: 12,
    });
  });

  it('引擎返回空结果时 text 为空，不编造内容', async () => {
    installDetector([]);
    const result = await new BrowserTextDetectorEngine().recognize(PNG);
    expect(result.text).toBe('');
    expect(result.blocks).toEqual([]);
  });
});

describe('桌面 Apple Vision 引擎', () => {
  it('probe 使用原生能力，返回 Apple Vision 与支持语言', async () => {
    const engine = new NativeVisionEngine(nativeBridge());
    const capability = await engine.probe();
    expect(capability).toMatchObject({
      engineId: 'system-local',
      engineName: 'Apple Vision',
      kind: 'system-local',
      available: true,
      local: true,
      languages: ['zh-Hans', 'en'],
      version: 'Version 15.8.1',
      reason: null,
    });
  });

  it('recognize 把真实字节与语言交给原生桥，并映射文本块', async () => {
    const recognize = vi.fn(
      async (_input: { bytes: Uint8Array; languages: string[] }) =>
        nativeResult(),
    );
    const engine = new NativeVisionEngine(nativeBridge({ recognize }));
    const result = await engine.recognize(PNG, {
      languages: ['zh-Hans', 'en'],
    });
    expect(recognize).toHaveBeenCalledTimes(1);
    const call = recognize.mock.calls[0][0];
    expect(Array.from(call.bytes)).toEqual([137, 80, 78, 71, 1, 2, 3]);
    expect(call.languages).toEqual(['zh-Hans', 'en']);
    expect(result.text).toBe('真实识别文本');
    expect(result.engineName).toBe('Apple Vision');
    expect(result.blocks).toEqual([
      {
        text: '真实识别文本',
        confidence: 0.9,
        boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      },
    ]);
  });

  it('原生错误按 stage 映射，不吞掉具体原因', async () => {
    const languageFailure = new NativeVisionEngine(
      nativeBridge({
        recognize: async () => {
          throw {
            stage: 'language',
            code: 'unsupported_language',
            message: 'Apple Vision 当前不支持识别语言：xx。',
          };
        },
      }),
    );
    await expect(languageFailure.recognize(PNG)).rejects.toBeInstanceOf(
      OcrProtocolError,
    );
    await expect(languageFailure.recognize(PNG)).rejects.toThrow(
      'Apple Vision 当前不支持识别语言：xx。',
    );

    const requestFailure = new NativeVisionEngine(
      nativeBridge({
        capability: async () => {
          throw {
            stage: 'request',
            code: 'vision_request_failed',
            message: 'Apple Vision 识别失败：模型不可用',
          };
        },
      }),
    );
    const capability = await requestFailure.probe();
    expect(capability.available).toBe(false);
    expect(capability.reason).toContain('request');
    expect(capability.reason).toContain('模型不可用');
  });

  it('空图片不会调用原生桥', async () => {
    const recognize = vi.fn(
      async (_input: { bytes: Uint8Array; languages: string[] }) =>
        nativeResult(),
    );
    const engine = new NativeVisionEngine(nativeBridge({ recognize }));
    const empty = new Blob([], { type: 'image/png' });
    await expect(engine.recognize(empty)).rejects.toBeInstanceOf(
      OcrProtocolError,
    );
    expect(recognize).not.toHaveBeenCalled();
  });

  it('resolveOcrEngine 在桌面环境选择原生引擎，浏览器环境退回 TextDetector', () => {
    const desktop = resolveOcrEngine(
      { ...DEFAULT_OCR_SETTINGS, engine: 'system-local' },
      { isDesktop: true, nativeBridge: nativeBridge() },
    );
    expect(desktop).toBeInstanceOf(NativeVisionEngine);

    const browser = resolveOcrEngine(
      { ...DEFAULT_OCR_SETTINGS, engine: 'system-local' },
      { isDesktop: false, nativeBridge: null },
    );
    expect(browser).toBeInstanceOf(BrowserTextDetectorEngine);
  });

  it('检测到 Tauri 时默认桥接调用 ocr_capability / ocr_recognize', async () => {
    const invoke = vi.fn(
      async (
        command: string,
        args?: { languages?: string[]; imageBytes?: number[] },
      ) => {
        if (command === 'ocr_capability') {
          return {
            available: true,
            engineName: 'Apple Vision',
            languages: ['zh-Hans', 'en'],
            version: 'Version 15.8.1',
            reason: null,
          };
        }
        if (command === 'ocr_recognize') {
          expect(args?.languages).toEqual(['en']);
          return nativeResult();
        }
        throw new Error(`unexpected command: ${command}`);
      },
    );
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    });

    const engine = resolveOcrEngine({
      ...DEFAULT_OCR_SETTINGS,
      engine: 'system-local',
    });
    expect(engine).toBeInstanceOf(NativeVisionEngine);
    await expect(engine.probe()).resolves.toMatchObject({
      available: true,
      engineName: 'Apple Vision',
    });
    await expect(
      engine.recognize(PNG, { languages: ['en'] }),
    ).resolves.toMatchObject({ text: '真实识别文本' });
    expect(invoke).toHaveBeenCalledWith(
      'ocr_capability',
      {},
      undefined,
    );
    const recognizeCall = invoke.mock.calls.find(
      ([command]) => command === 'ocr_recognize',
    );
    expect(recognizeCall?.[1]).toMatchObject({
      imageBytes: [137, 80, 78, 71, 1, 2, 3],
      languages: ['en'],
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('自定义 OCR 适配器', () => {
  it('本机端点无需远程确认；远程端点默认拒绝发送图片', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ text: '来自本机引擎' }),
    );
    const local = new CustomAdapterEngine({
      endpoint: 'http://127.0.0.1:8080/ocr',
      allowRemoteImages: false,
      timeoutMs: 2000,
      fetchImpl,
    });
    const result = await local.recognize(PNG);
    expect(result.text).toBe('来自本机引擎');

    const remote = new CustomAdapterEngine({
      endpoint: 'https://ocr.example.com/ocr',
      allowRemoteImages: false,
      timeoutMs: 2000,
      fetchImpl,
    });
    await expect(remote.recognize(PNG)).rejects.toBeInstanceOf(
      OcrRemoteConsentError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const allowed = new CustomAdapterEngine({
      endpoint: 'https://ocr.example.com/ocr',
      allowRemoteImages: true,
      timeoutMs: 2000,
      fetchImpl,
    });
    await expect(allowed.recognize(PNG)).resolves.toMatchObject({
      text: '来自本机引擎',
    });
  });

  it('探测需要符合协议的能力信息', async () => {
    const ok = new CustomAdapterEngine({
      endpoint: 'http://localhost:9009/ocr',
      allowRemoteImages: false,
      timeoutMs: 2000,
      fetchImpl: async () =>
        jsonResponse({ engine: { name: 'PaddleOCR 自建', version: '2.7', languages: ['zh-Hans'] } }),
    });
    await expect(ok.probe()).resolves.toMatchObject({
      available: true,
      engineName: 'PaddleOCR 自建',
      version: '2.7',
      languages: ['zh-Hans'],
    });

    const bad = new CustomAdapterEngine({
      endpoint: 'http://localhost:9009/ocr',
      allowRemoteImages: false,
      timeoutMs: 2000,
      fetchImpl: async () => jsonResponse({ hello: 'world' }),
    });
    const capability = await bad.probe();
    expect(capability.available).toBe(false);
    expect(capability.reason).toContain('能力信息');
  });

  it('响应缺少 text 时视为协议错误，不补空字符串', async () => {
    const engine = new CustomAdapterEngine({
      endpoint: 'http://localhost:9009/ocr',
      allowRemoteImages: false,
      timeoutMs: 2000,
      fetchImpl: async () => jsonResponse({ blocks: [] }),
    });
    await expect(engine.recognize(PNG)).rejects.toBeInstanceOf(OcrProtocolError);
  });

  it('resolveOcrEngine 尊重 none 与自定义端点', async () => {
    expect(
      await resolveOcrEngine({
        ...DEFAULT_OCR_SETTINGS,
        engine: 'none',
      }).probe(),
    ).toMatchObject({ available: false, kind: 'none' });
    expect(
      resolveOcrEngine({
        ...DEFAULT_OCR_SETTINGS,
        engine: 'custom-adapter',
        custom: {
          endpoint: 'http://127.0.0.1:8080/ocr',
          allowRemoteImages: false,
          timeoutMs: 2000,
        },
      }).id,
    ).toBe('custom-adapter');
  });

  it('设置归一化：默认关闭、坏端点丢弃、语言去重', () => {
    const settings = normalizeOcrSettings({
      enabled: 'yes',
      engine: 'evil',
      languages: ['zh-Hans', 'zh-Hans', 'xx'],
      custom: { endpoint: 'file:///etc/passwd', allowRemoteImages: 1 },
    });
    expect(settings.enabled).toBe(false);
    expect(settings.engine).toBe('system-local');
    expect(settings.languages).toEqual(['zh-Hans']);
    expect(settings.custom.endpoint).toBe('');
    expect(settings.custom.allowRemoteImages).toBe(false);
  });
});
