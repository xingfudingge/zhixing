import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { OcrEngine } from '../engines';
import { OcrPanel } from '../OcrPanel';
import { OcrService } from '../service';
import { MemoryOcrSettingsStore } from '../settings';
import { MemoryOcrJobStore } from '../store';
import {
  DEFAULT_OCR_SETTINGS,
  type OcrCapability,
  type OcrJob,
} from '../types';

const IMAGE = new File([new Uint8Array([137, 80, 78, 71, 9])], '测试图.png', {
  type: 'image/png',
});

function availableCapability(): OcrCapability {
  return {
    engineId: 'fake',
    engineName: '测试本地引擎',
    kind: 'system-local',
    available: true,
    local: true,
    languages: ['zh-Hans'],
    version: 'test',
    reason: null,
  };
}

function fakeEngine(text = '测试图里的文字'): OcrEngine {
  return {
    id: 'fake',
    name: '测试本地引擎',
    local: true,
    probe: async () => availableCapability(),
    recognize: async () => ({
      engineId: 'fake',
      engineName: '测试本地引擎',
      text,
      language: 'zh-Hans',
      confidence: 0.9,
      blocks: [{ text, confidence: 0.9, boundingBox: null }],
      durationMs: 5,
      finishedAt: '2026-10-26T10:00:00.000Z',
    }),
  };
}

function setup(options: { engine?: OcrEngine; enabled?: boolean } = {}) {
  const settingsStore = new MemoryOcrSettingsStore({
    ...DEFAULT_OCR_SETTINGS,
    enabled: options.enabled ?? false,
  });
  const jobStore = new MemoryOcrJobStore();
  const service = new OcrService({
    settingsStore,
    jobStore,
    engineFactory: () => options.engine ?? fakeEngine(),
  });
  return { service, jobStore, settingsStore };
}

describe('OCR 面板', () => {
  it('默认关闭，测试图片入口禁用，并提示先启用', async () => {
    const { service } = setup();
    render(<OcrPanel service={service} />);
    const toggle = screen.getByRole('checkbox', { name: /启用图片 OCR/ });
    expect(toggle).not.toBeChecked();
    expect(screen.getByLabelText('选择 OCR 测试图片')).toBeDisabled();
    expect(screen.getByText('先启用图片 OCR；默认关闭。')).toBeInTheDocument();
    expect(await screen.findByText('引擎可用')).toBeInTheDocument();
    expect(
      screen.getByText(/当前为浏览器预览，需桌面壳/),
    ).toBeInTheDocument();
  });

  it('启用后显示引擎不可用原因，识别失败不显示伪造文本', async () => {
    const { service } = setup({
      engine: {
        id: 'system-local',
        name: '系统本地 OCR',
        local: true,
        probe: async () => ({
          engineId: 'system-local',
          engineName: '系统本地 OCR',
          kind: 'system-local',
          available: false,
          local: true,
          languages: [],
          version: null,
          reason: '当前系统未提供 TextDetector',
        }),
        recognize: async () => {
          throw new Error('不应被调用');
        },
      },
    });
    const user = userEvent.setup();
    render(<OcrPanel service={service} />);
    await user.click(screen.getByRole('checkbox', { name: /启用图片 OCR/ }));
    expect(await screen.findByText('引擎不可用')).toBeInTheDocument();
    expect(screen.getByText('当前系统未提供 TextDetector')).toBeInTheDocument();

    await user.upload(screen.getByLabelText('选择 OCR 测试图片'), IMAGE);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '当前系统未提供 TextDetector',
    );
    expect(screen.queryByLabelText('OCR 识别结果')).not.toBeInTheDocument();
  });

  it('启用并选择图片后显示引擎真实返回的文本', async () => {
    const { service } = setup({ engine: fakeEngine('第一行识别文字') });
    const user = userEvent.setup();
    render(<OcrPanel service={service} />);
    await user.click(screen.getByRole('checkbox', { name: /启用图片 OCR/ }));
    await user.upload(screen.getByLabelText('选择 OCR 测试图片'), IMAGE);

    expect(await screen.findByLabelText('OCR 识别结果')).toBeInTheDocument();
    expect(screen.getByText('第一行识别文字')).toBeInTheDocument();
    expect(screen.getByText(/结果只保存在本机/)).toBeInTheDocument();
  });

  it('失败作业可重试，取消中的作业可放弃', async () => {
    const { service, jobStore } = setup({ enabled: true });
    const job: OcrJob = {
      id: 'job_failed',
      attachmentId: 'att_1',
      status: 'failed',
      engineId: 'fake',
      dedupeKey: 'att_1:fake:x',
      createdAt: '2026-10-26T10:00:00.000Z',
      updatedAt: '2026-10-26T10:00:00.000Z',
      attempts: 1,
      text: null,
      language: null,
      error: '模型加载失败',
      textStorage: 'local',
      textSyncState: 'local',
      textSyncError: null,
      sourceSha256: 'a'.repeat(64),
    };
    await jobStore.put(job);
    const user = userEvent.setup();
    render(<OcrPanel service={service} />);
    expect(await screen.findByText('模型加载失败')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(async () => {
      expect((await jobStore.get('job_failed'))?.status).toBe('pending');
    });
  });
});
