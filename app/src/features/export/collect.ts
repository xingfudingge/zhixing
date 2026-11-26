/**
 * 从 SQLite 仓储收集完整备份（P2-04）。
 *
 * 所有列表都带 `includeDeleted`：回收站里的对象如果被其他对象引用，
 * 关系必须能在一份完整备份里重建，不能在导出时被过滤掉。附件二进制在
 * 本机 IndexedDB 中按 `attachments/<sha256>` 内容寻址；导出前重新计算
 * 哈希，损坏/缺失的附件不冒充有效文件。
 */

import { readAppearance } from '../../app/shell/appearance';
import { db, isTauriRuntime, type DbClient } from '../../data/db/client';
import type { Attachment } from '../../data/db/types';
import { isSha256Hex, sha256Blob } from '../attachments/sha256';
import { bytesKey } from '../attachments/types';
import {
  IndexedDbBlobStore,
  isIndexedDbAvailable,
  type BlobStore,
} from '../attachments/blobStore';
import { APP_VERSION, BACKUP_GENERATOR } from './dataset';
import { filterSafeSettings } from './sanitize';
import type {
  BackupCollectOptions,
  BackupDataset,
  BackupPayload,
  BackupSource,
  BackupSourceResult,
} from './types';
import { BACKUP_APP, BACKUP_FORMAT_VERSION, BACKUP_KIND } from './types';
import { mapLimit } from './utils';

export type CollectedDataset = {
  dataset: BackupDataset;
  schemaVersion: number;
  excludedSettings: string[];
  warnings: string[];
};

class NullBlobStore implements BlobStore {
  async put(): Promise<void> {}
  async get(): Promise<Blob | null> {
    return null;
  }
  async has(): Promise<boolean> {
    return false;
  }
  async delete(): Promise<void> {}
}

export async function collectDataset(
  client: DbClient,
): Promise<CollectedDataset> {
  const warnings: string[] = [];
  const [
    lists,
    tasks,
    notes,
    events,
    countdowns,
    habits,
    focusSessions,
    reviewSnapshots,
    attachments,
    settingRows,
  ] = await Promise.all([
    client.lists.list(true),
    client.tasks.list({ includeDeleted: true }),
    // 加密笔记必须走原始导出：普通 list 在锁定时会返回空内容，不能用于备份。
    client.notes.exportRows
      ? client.notes.exportRows()
      : client.notes.list({ includeDeleted: true }),
    client.events.list({ includeDeleted: true }),
    client.countdowns.list({ includeDeleted: true }),
    client.habits.list({ includeDeleted: true }),
    client.focusSessions.list({ includeDeleted: true }),
    client.reviewSnapshots.list({ includeDeleted: true }),
    client.attachments.list({ includeDeleted: true }),
    client.settings.list({ scope: 'device', includeDeleted: true }),
  ]);

  const subtasks = (
    await mapLimit(tasks, 8, (task) =>
      client.tasks.subtasks.list(task.id, true),
    )
  ).flat();
  const noteBlocks = client.notes.blocks.exportRows
    ? await client.notes.blocks.exportRows()
    : (
        await mapLimit(notes, 8, (note) =>
          client.notes.blocks.list(note.id, true),
        )
      ).flat();
  const noteTodos = client.noteTodos.exportRows
    ? await client.noteTodos.exportRows()
    : (
        await mapLimit(notes, 8, (note) =>
          client.noteTodos.list(note.id, true),
        )
      ).flat();
  const habitLogs = (
    await mapLimit(habits, 8, (habit) =>
      client.habits.logs.list(habit.id, { includeDeleted: true }),
    )
  ).flat();

  const boardRows = await client.boards.list({ includeDeleted: true });
  const boards = await mapLimit(boardRows, 6, async (board) => {
    const [nodes, edges] = await Promise.all([
      client.boards.nodes.list(board.id, true),
      client.boards.edges.list(board.id, true),
    ]);
    return { board, nodes, edges };
  });

  const filtered = filterSafeSettings(settingRows);
  const excludedSettings = [...filtered.excludedKeys];
  if (excludedSettings.length > 0) {
    warnings.push(
      `设置表中有 ${excludedSettings.length} 个非白名单键未导出：${excludedSettings.join('、')}`,
    );
  }

  const encryptedNotes = notes.filter((note) => note.encrypted).length;
  if (encryptedNotes > 0) {
    warnings.push(
      `完整备份包含 ${encryptedNotes} 篇加密笔记的密文；备份不包含明文密钥。恢复时需要原设备钥匙串，或先导入受口令保护的密钥信封。`,
    );
  }

  let schemaVersion = 0;
  try {
    schemaVersion = (await client.system.status()).schemaVersion;
  } catch {
    warnings.push('无法读取本机数据库版本，manifest 中的 schemaVersion 记为 0');
  }

  return {
    dataset: {
      lists,
      tasks,
      subtasks,
      notes,
      noteBlocks,
      noteTodos,
      events,
      countdowns,
      habits,
      habitLogs,
      focusSessions,
      reviewSnapshots,
      boards,
      attachments,
      settings: filtered.safe,
    },
    schemaVersion,
    excludedSettings,
    warnings,
  };
}

async function readVerifiedAttachment(
  attachment: Attachment,
  blobStore: BlobStore,
): Promise<{ blob: Blob | null; warning: string | null }> {
  if (!isSha256Hex(attachment.sha256)) {
    return { blob: null, warning: `附件 ${attachment.fileName} 的哈希格式无效` };
  }
  let blob: Blob | null = null;
  try {
    blob = await blobStore.get(bytesKey(attachment.sha256));
  } catch {
    blob = null;
  }
  if (!blob) {
    return {
      blob: null,
      warning: `附件 ${attachment.fileName} 的二进制不在本机，ZIP 未包含该文件`,
    };
  }
  if (blob.size !== attachment.byteSize) {
    return {
      blob: null,
      warning: `附件 ${attachment.fileName} 的大小与元数据不一致，已拒绝导出二进制`,
    };
  }
  const actual = await sha256Blob(blob);
  if (actual !== attachment.sha256) {
    return {
      blob: null,
      warning: `附件 ${attachment.fileName} 的 SHA-256 校验失败，已拒绝导出二进制`,
    };
  }
  return { blob, warning: null };
}

export function createDbBackupSource(
  client: DbClient = db,
  blobStore: BlobStore = isIndexedDbAvailable()
    ? new IndexedDbBlobStore()
    : new NullBlobStore(),
  now: () => Date = () => new Date(),
): BackupSource {
  return {
    async collect(
      options: BackupCollectOptions = {},
    ): Promise<BackupSourceResult> {
      const collected = await collectDataset(client);
      const warnings = [...collected.warnings];
      const missingAttachmentIds: string[] = [];
      const blobs = new Map<string, Blob>();

      if (options.includeBlobs !== false) {
        const results = await mapLimit(
          collected.dataset.attachments,
          4,
          async (attachment) => ({
            attachment,
            ...(await readVerifiedAttachment(attachment, blobStore)),
          }),
        );
        for (const result of results) {
          if (result.warning) {
            warnings.push(result.warning);
            missingAttachmentIds.push(result.attachment.id);
          }
          if (result.blob) {
            blobs.set(result.attachment.id, result.blob);
          }
        }
      }

      let appearance: BackupPayload['appearance'] = null;
      try {
        const current = readAppearance();
        appearance = {
          theme: current.theme,
          accent: current.accent,
          density: current.density,
        };
      } catch {
        appearance = null;
      }

      return {
        payload: {
          app: BACKUP_APP,
          kind: BACKUP_KIND,
          formatVersion: BACKUP_FORMAT_VERSION,
          exportedAt: now().toISOString(),
          appVersion: APP_VERSION,
          schemaVersion: collected.schemaVersion,
          appearance,
          dataset: collected.dataset,
          excludedSettings: collected.excludedSettings,
        },
        blobs,
        missingAttachmentIds,
        warnings,
      };
    },
  };
}

export function createDefaultBackupSource(
  client: DbClient = db,
  blobStore?: BlobStore,
): BackupSource | null {
  if (!isTauriRuntime()) {
    return null;
  }
  return createDbBackupSource(
    client,
    blobStore ??
      (isIndexedDbAvailable()
        ? new IndexedDbBlobStore()
        : new NullBlobStore()),
  );
}

/** manifest 生成器标识；测试可直接引用。 */
export const BACKUP_GENERATOR_ID = BACKUP_GENERATOR;
