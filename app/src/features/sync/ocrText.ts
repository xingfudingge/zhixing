/**
 * 同步管线中的 OCR 识别文本边车。
 *
 * 这里只处理“文本如何进入同步 outbox”，不依赖 OCR UI/作业存储：
 * - `textStorage='local'` 的文本不会调用本模块的 sink；
 * - `textStorage='sync'` 时由 OCR 服务在识别成功后调用 sink；
 * - 后台模式复用 `SyncEngine.enqueue`，WebDAV 模式复用 `WebDavSyncEngine.enqueue`，
 *   两者共用同一个 `SyncStore` outbox，因此“设置 → 同步”的立即同步会真实推送；
 * - 只同步文本、语言、引擎、来源哈希与附件 ID，不上传图片二进制；
 * - 同一附件固定实体 ID `ocr_text/<attachmentId>`，字段级合并；差异进入现有
 *   同步冲突记录。
 */

import type { Platform } from '../../../../packages/sync-webdav/src/index.ts';
import { readStoredSyncMode } from '../../sync/mode.ts';
import { createSyncEngine } from '../../sync/index.ts';
import {
  LocalStorageSyncStore,
  readStoredSyncProfile,
} from '../../sync/store.ts';
import type { SyncDeviceProfile, SyncStore } from '../../sync/types.ts';
import {
  LocalStorageWebDavConfigStore,
  readStoredWebDavConfig,
  type WebDavConfigStore,
} from '../../sync/webdav/configStore.ts';
import { WebDavSyncEngine } from '../../sync/webdav/engine.ts';
import { detectPlatform } from '../../sync/webdav/platform.ts';
import type { SyncMode } from './types.ts';

export const OCR_TEXT_ENTITY_TYPE = 'ocr_text';

export class OcrTextSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrTextSyncError';
  }
}

export type OcrTextSyncInput = {
  attachmentId: string;
  text: string;
  language: string | null;
  engineId: string;
  sourceSha256: string;
  jobId: string;
  recognizedAt: string;
  /** 只有 sync 才允许进入同步；local 会原样拒绝。 */
  textStorage: 'local' | 'sync';
};

export type OcrTextSyncResult = {
  /** 只有真正写进 outbox 才返回 true；失败一律抛错，由作业记录原因。 */
  queued: boolean;
  mode: SyncMode;
  entityId: string;
  reason: string;
};

export type OcrTextSyncSink = (
  input: OcrTextSyncInput,
) => Promise<OcrTextSyncResult>;

export type TextSyncAvailability = {
  mode: SyncMode;
  /** 当前模式是否已有真实同步目标（配对后台或已保存 WebDAV 配置）。 */
  ready: boolean;
  reason: string;
};

export type OcrTextSyncOptions = {
  store?: SyncStore;
  mode?: () => SyncMode;
  webdavConfigStore?: WebDavConfigStore;
  now?: () => number;
  platform?: () => Platform;
};

export type TextSyncAvailabilityOptions = {
  mode?: SyncMode;
  /** 测试注入；不传时同步读取本机同步存储。 */
  backendProfile?: SyncDeviceProfile | null;
  /** 测试注入；不传时同步读取本机 WebDAV 配置。 */
  webdavBaseUrl?: string | null;
};

function syncStoreOf(options: OcrTextSyncOptions): SyncStore {
  return options.store ?? new LocalStorageSyncStore();
}

function modeOf(options: OcrTextSyncOptions): SyncMode {
  return options.mode ? options.mode() : readStoredSyncMode();
}

function platformOf(options: OcrTextSyncOptions): Platform {
  return options.platform ? options.platform() : detectPlatform();
}

/** 同步实体载荷：字段都是可参与字段级合并的 JSON 标量。 */
export function ocrTextSyncPayload(input: OcrTextSyncInput): {
  attachmentId: string;
  text: string;
  language: string | null;
  engineId: string;
  sourceSha256: string;
  jobId: string;
  recognizedAt: string;
} {
  return {
    attachmentId: input.attachmentId,
    text: input.text,
    language: input.language,
    engineId: input.engineId,
    sourceSha256: input.sourceSha256,
    jobId: input.jobId,
    recognizedAt: input.recognizedAt,
  };
}

/**
 * 描述当前同步模式能否承接 OCR 文本。同步读本机状态，不联网、不发请求，
 * 避免设置页挂载时触发异步 state 更新；`ready=false` 时 UI 必须明说
 * “识别文本只在本机/待配置”，不能显示已同步。
 */
export function describeTextSyncAvailability(
  options: TextSyncAvailabilityOptions = {},
): TextSyncAvailability {
  const mode = options.mode ?? readStoredSyncMode();
  if (mode === 'local') {
    return {
      mode,
      ready: false,
      reason:
        '当前同步模式为仅本机：识别文本只保存在本机，不会上传。请先在 设置 → 同步 选择后台或 WebDAV。',
    };
  }
  if (mode === 'backend') {
    const profile =
      options.backendProfile !== undefined
        ? options.backendProfile
        : readStoredSyncProfile();
    if (!profile) {
      return {
        mode,
        ready: false,
        reason:
          '后台尚未配对：识别文本只保存在本机；完成配对后新识别的文本才会进入同步队列。',
      };
    }
    return {
      mode,
      ready: true,
      reason: `识别文本会进入后台同步队列（${profile.baseUrl}），只上传文本，不上传图片。`,
    };
  }
  const baseUrl =
    options.webdavBaseUrl !== undefined
      ? options.webdavBaseUrl
      : readStoredWebDavConfig()?.baseUrl ?? null;
  if (!baseUrl) {
    return {
      mode,
      ready: false,
      reason:
        'WebDAV 尚未配置：识别文本只保存在本机；保存 WebDAV 地址后新识别的文本才会进入同步队列。',
    };
  }
  return {
    mode,
    ready: true,
    reason: `识别文本会进入 WebDAV 同步队列（${baseUrl}），只上传文本，不上传图片。`,
  };
}

/**
 * 真实同步消费方。任何未配置/未配对都抛错，由 OCR 服务把作业标成
 * `textSyncState='failed'` 并保留原因，绝不静默丢弃。
 */
export function createOcrTextSyncSink(
  options: OcrTextSyncOptions = {},
): OcrTextSyncSink {
  return async (input) => {
    if (input.textStorage !== 'sync') {
      return {
        queued: false,
        mode: modeOf(options),
        entityId: input.attachmentId,
        reason: '识别文本设置为仅本机，不进入同步。',
      };
    }
    const mode = modeOf(options);
    if (mode === 'local') {
      throw new OcrTextSyncError(
        '当前同步模式为仅本机，识别文本无法进入同步；请先在 设置 → 同步 选择后台或 WebDAV。',
      );
    }
    const store = syncStoreOf(options);
    const payload = ocrTextSyncPayload(input);

    if (mode === 'backend') {
      const engine = createSyncEngine({ store, now: options.now });
      await engine.init();
      if (!engine.getProfile()) {
        throw new OcrTextSyncError(
          '后台尚未配对，识别文本无法进入同步；请先在 设置 → 同步 完成配对。',
        );
      }
      await engine.enqueue({
        entityType: OCR_TEXT_ENTITY_TYPE,
        entityId: input.attachmentId,
        payload,
        opType: 'patch',
      });
      return {
        queued: true,
        mode,
        entityId: input.attachmentId,
        reason: '识别文本已进入后台同步队列；下次同步会上传文本，不上传图片。',
      };
    }

    const saved = await (
      options.webdavConfigStore ?? new LocalStorageWebDavConfigStore()
    ).load();
    if (!saved?.baseUrl) {
      throw new OcrTextSyncError(
        'WebDAV 尚未配置，识别文本无法进入同步；请先在 设置 → 同步 保存 WebDAV 地址。',
      );
    }
    const platform = platformOf(options);
    if (platform === 'web') {
      throw new OcrTextSyncError(
        'Web 端只连接知行后台，不提供 WebDAV；识别文本未进入同步。',
      );
    }
    const engine = new WebDavSyncEngine(
      {
        baseUrl: saved.baseUrl,
        username: saved.username,
        // 密码不落盘；入队只需要空间与设备身份，真正上传时由同步面板提供密码。
        password: '',
        root: saved.root,
        spaceId: saved.spaceId,
        deviceId: saved.deviceId,
        deviceName: saved.deviceName,
        platform,
      },
      { store, now: options.now },
    );
    await engine.enqueue({
      entityType: OCR_TEXT_ENTITY_TYPE,
      entityId: input.attachmentId,
      payload,
      opType: 'patch',
    });
    return {
      queued: true,
      mode,
      entityId: input.attachmentId,
      reason: '识别文本已进入 WebDAV 同步队列；下次同步会上传文本，不上传图片。',
    };
  };
}
