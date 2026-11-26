import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentPanel } from '../../attachments/AttachmentPanel';
import { ImageBlock } from '../../attachments/ImageBlock';
import {
  MemoryAttachmentStateStore,
  MemoryBlobStore,
} from '../../attachments/blobStore';
import { AttachmentManager } from '../../attachments/manager';
import { MemoryAttachmentMetadataRepository } from '../../attachments/repository';
import { OcrGroup } from '../../settings/groups/OcrGroup';
import type { OcrEngine } from '../engines';
import { OcrService } from '../service';
import {
  OCR_SETTINGS_KEY,
  MemoryOcrSettingsStore,
} from '../settings';
import { MemoryOcrJobStore } from '../store';
import {
  DEFAULT_OCR_SETTINGS,
  type OcrCapability,
  type OcrJob,
  type OcrResult,
} from '../types';

const IMAGE = new File([new Uint8Array([137, 80, 78, 71, 4, 5, 6])], '发票.png', {
  type: 'image/png',
});

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

function capability(available: boolean, reason: string | null = null): OcrCapability {
  return {
    engineId: 'fake',
    engineName: '测试本地引擎',
    kind: 'system-local',
    available,
    local: true,
    languages: ['zh-Hans'],
    version: 'test',
    reason,
  };
}

function result(text: string): OcrResult {
  return {
    engineId: 'fake',
    engineName: '测试本地引擎',
    text,
    language: 'zh-Hans',
    confidence: 0.9,
    blocks: [{ text, confidence: 0.9, boundingBox: null }],
    durationMs: 4,
    finishedAt: '2026-10-27T00:00:00.000Z',
  };
}

function fakeEngine(options: {
  available?: boolean;
  text?: string;
  reason?: string | null;
} = {}): OcrEngine {
  const available = options.available ?? true;
  return {
    id: 'fake',
    name: '测试本地引擎',
    local: true,
    probe: async () => capability(available, options.reason ?? null),
    recognize: async () => result(options.text ?? '发票编号 123'),
  };
}

function createOcr(options: {
  enabled?: boolean;
  engine?: OcrEngine;
} = {}): OcrService {
  return createOcrHarness(options).service;
}

function createOcrHarness(options: {
  enabled?: boolean;
  engine?: OcrEngine;
} = {}) {
  const settingsStore = new MemoryOcrSettingsStore({
    ...DEFAULT_OCR_SETTINGS,
    enabled: options.enabled ?? true,
  });
  const jobStore = new MemoryOcrJobStore();
  const service = new OcrService({
    settingsStore,
    jobStore,
    engineFactory: () => options.engine ?? fakeEngine(),
  });
  return { service, settingsStore, jobStore };
}

function createManager(): AttachmentManager {
  let sequence = 0;
  return new AttachmentManager({
    repository: new MemoryAttachmentMetadataRepository(),
    blobStore: new MemoryBlobStore(),
    stateStore: new MemoryAttachmentStateStore(),
    newId: () => `ocr_ui_${++sequence}`,
  });
}

describe('OCR 设置页', () => {
  it('默认关闭；开关、范围、语言与引擎可持久化，重新挂载后保持', async () => {
    const user = userEvent.setup();
    const first = render(<OcrGroup />);

    const toggle = screen.getByRole('checkbox', { name: /启用图片 OCR/ });
    expect(toggle).not.toBeChecked();
    expect(await screen.findByText('引擎不可用')).toBeInTheDocument();

    await user.click(toggle);
    await user.selectOptions(screen.getByLabelText('识别范围'), 'all-images');
    await user.selectOptions(screen.getByLabelText('识别引擎'), 'none');
    await user.click(screen.getByRole('checkbox', { name: '英文' }));
    await user.click(screen.getByRole('checkbox', { name: '日文' }));

    const saved = JSON.parse(
      window.localStorage.getItem(OCR_SETTINGS_KEY) ?? 'null',
    );
    expect(saved).toMatchObject({
      enabled: true,
      scope: 'all-images',
      engine: 'none',
      languages: ['zh-Hans', 'ja'],
    });

    first.unmount();
    render(<OcrGroup />);

    expect(
      screen.getByRole('checkbox', { name: /启用图片 OCR/ }),
    ).toBeChecked();
    expect(screen.getByLabelText('识别范围')).toHaveValue('all-images');
    expect(screen.getByLabelText('识别引擎')).toHaveValue('none');
    expect(screen.getByRole('checkbox', { name: '英文' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '日文' })).toBeChecked();
  });

  it('指定目录选择持久化；未选择目录时禁用按范围排队并提示', async () => {
    const user = userEvent.setup();
    const first = render(<OcrGroup />);

    await user.click(screen.getByRole('checkbox', { name: /启用图片 OCR/ }));
    await user.selectOptions(screen.getByLabelText('识别范围'), 'folder');

    expect(screen.getByRole('button', { name: '处理队列' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: '按范围排队' })).toBeDisabled();
    expect(screen.getByText(/尚未选择知识库目录/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('OCR 指定目录'), 'f2');
    const saved = JSON.parse(
      window.localStorage.getItem(OCR_SETTINGS_KEY) ?? 'null',
    );
    expect(saved).toMatchObject({ scope: 'folder', scopeFolderId: 'f2' });

    first.unmount();
    render(<OcrGroup />);
    expect(screen.getByLabelText('识别范围')).toHaveValue('folder');
    expect(screen.getByLabelText('OCR 指定目录')).toHaveValue('f2');
  });

  it('设置页处理队列使用真实原图读取器，作业状态从待处理变为成功', async () => {
    const user = userEvent.setup();
    const { service, jobStore } = createOcrHarness({
      enabled: true,
      engine: fakeEngine({ text: '队列真实结果' }),
    });
    const pending: OcrJob = {
      id: 'job_pending',
      attachmentId: 'att_queue',
      status: 'pending',
      engineId: 'fake',
      dedupeKey: 'att_queue:fake:x',
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
      attempts: 0,
      text: null,
      language: null,
      error: null,
      textStorage: 'local',
      textSyncState: 'local',
      textSyncError: null,
      sourceSha256: 'b'.repeat(64),
    };
    await jobStore.put(pending);

    render(
      <OcrGroup
        service={service}
        resolveImage={async () => IMAGE}
        listImages={async () => []}
      />,
    );

    const processButton = screen.getByRole('button', { name: '处理队列' });
    expect(processButton).not.toBeDisabled();
    await user.click(processButton);

    await waitFor(async () => {
      expect((await jobStore.get('job_pending'))?.status).toBe('succeeded');
    });
    expect(await screen.findByText('队列真实结果')).toBeInTheDocument();
  });

  it('按范围排队把真实候选加入队列，并显示新增/跳过数量', async () => {
    const user = userEvent.setup();
    const { service, jobStore } = createOcrHarness({ enabled: true });

    render(
      <OcrGroup
        service={service}
        resolveImage={async () => IMAGE}
        listImages={async () => [
          { attachmentId: 'att_scope_1', folderId: null },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: '按范围排队' }));
    await waitFor(async () => {
      expect(await jobStore.list()).toHaveLength(1);
    });
    expect(
      await screen.findByText(/新增 1，跳过 0，失败 0/),
    ).toBeInTheDocument();
  });

  it('远程适配器在未允许前明确提示不会发送图片', async () => {
    const user = userEvent.setup();
    render(<OcrGroup />);

    await user.click(screen.getByRole('checkbox', { name: /启用图片 OCR/ }));
    await user.selectOptions(screen.getByLabelText('识别引擎'), 'custom-adapter');
    const endpoint = screen.getByLabelText('自定义适配器端点');
    await user.type(endpoint, 'https://ocr.example.com/ocr');
    expect(endpoint).toHaveValue('https://ocr.example.com/ocr');
    await user.tab();

    expect(
      await screen.findByText(/远程端点.*默认拒绝发送图片/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('checkbox', { name: /允许远程处理图片/ }),
    ).not.toBeChecked();
  });
});

describe('附件图片 OCR 入口', () => {
  it('默认关闭时按钮禁用，并提示到设置页开启', async () => {
    const user = userEvent.setup();
    const manager = createManager();
    render(
      <AttachmentPanel
        manager={manager}
        noteId="note-ocr-off"
        ocrService={createOcr({ enabled: false })}
      />,
    );

    await user.upload(screen.getByLabelText('选择附件文件'), IMAGE);
    await screen.findByText('发票.png');

    expect(
      screen.getByRole('button', { name: 'OCR 识别 发票.png' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/图片 OCR 默认关闭；在 设置 → 知识库与 OCR 开启/),
    ).toBeInTheDocument();
  });

  it('使用设置中的引擎识别本机原图并显示真实文本', async () => {
    const user = userEvent.setup();
    const manager = createManager();
    const onNotice = vi.fn();
    render(
      <AttachmentPanel
        manager={manager}
        noteId="note-ocr-on"
        ocrService={createOcr({ engine: fakeEngine({ text: '报销金额 88.00' }) })}
        onNotice={onNotice}
      />,
    );

    await user.upload(screen.getByLabelText('选择附件文件'), IMAGE);
    await screen.findByText('发票.png');
    await user.click(screen.getByRole('button', { name: 'OCR 识别 发票.png' }));

    expect(
      await screen.findByLabelText('OCR 识别结果：发票.png'),
    ).toHaveTextContent('报销金额 88.00');
    expect(onNotice).toHaveBeenCalledWith(
      expect.stringContaining('OCR 识别完成'),
    );
  });

  it('引擎不可用时显示真实错误，不显示识别结果', async () => {
    const user = userEvent.setup();
    const manager = createManager();
    render(
      <AttachmentPanel
        manager={manager}
        noteId="note-ocr-unavailable"
        ocrService={createOcr({
          engine: fakeEngine({
            available: false,
            reason: '当前系统未提供 TextDetector',
          }),
        })}
      />,
    );

    await user.upload(screen.getByLabelText('选择附件文件'), IMAGE);
    await screen.findByText('发票.png');
    await user.click(screen.getByRole('button', { name: 'OCR 识别 发票.png' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '当前系统未提供 TextDetector',
    );
    expect(
      screen.queryByLabelText('OCR 识别结果：发票.png'),
    ).not.toBeInTheDocument();
  });

  it('识别文本按设置的保存位置提示去向', async () => {
    const user = userEvent.setup();
    const manager = createManager();
    render(
      <AttachmentPanel
        manager={manager}
        noteId="note-ocr-local"
        ocrService={createOcr({ engine: fakeEngine({ text: '' }) })}
      />,
    );

    await user.upload(screen.getByLabelText('选择附件文件'), IMAGE);
    await screen.findByText('发票.png');
    expect(screen.getByText('识别文本只保存在本机，不参与同步。')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'OCR 识别 发票.png' }));
    expect(
      await screen.findByText(/这张图片没有识别到文字（不是模拟结果）/),
    ).toBeInTheDocument();
  });

  it('图片块入口使用同一份设置识别本机图片', async () => {
    const user = userEvent.setup();
    const blobStore = new MemoryBlobStore();
    const manager = new AttachmentManager({
      repository: new MemoryAttachmentMetadataRepository(),
      blobStore,
      stateStore: new MemoryAttachmentStateStore(),
      newId: () => 'ocr_block_1',
    });
    const ingested = await manager.ingest(IMAGE, { noteId: 'note-block' });

    render(
      <ImageBlock
        attachment={ingested.attachment}
        blobStore={blobStore}
        ocrService={createOcr({
          engine: fakeEngine({ text: '图片块里的文字' }),
        })}
      />,
    );

    await screen.findByRole('img', { name: '发票.png' });
    await user.click(screen.getByRole('button', { name: 'OCR 识别 发票.png' }));

    expect(
      await screen.findByLabelText('OCR 识别结果：发票.png'),
    ).toHaveTextContent('图片块里的文字');
  });
});
