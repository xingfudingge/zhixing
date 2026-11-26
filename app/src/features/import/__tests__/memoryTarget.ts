/**
 * 测试用内存 RestoreTarget。
 *
 * 只实现恢复计划会用到的写入语义（含同 ID 冲突、软删除、附件 SHA 唯一），
 * 用于在 jsdom 中完整验收“导出 ZIP → 解析 → 冲突预览 → 确认恢复”的流程。
 */

import { settingIdentity } from '../../export/sanitize';
import { cloneDatasetShallow } from '../../export/dataset';
import type {
  BackupAppearance,
  BackupDataset,
  RestoreOperation,
  RestoreTarget,
} from '../../export/types';

type AnyRow = {
  id: string;
  deletedAt?: string | null;
  [key: string]: unknown;
};

export type MemoryRestoreTarget = RestoreTarget & {
  dataset: BackupDataset;
  blobs: Map<string, Blob>;
  appearance: BackupAppearance | null;
  applied: RestoreOperation[];
};

function findRow(rows: AnyRow[], id: string): AnyRow | undefined {
  return rows.find((row) => row.id === id);
}

export function createMemoryRestoreTarget(
  initial: BackupDataset,
  now: () => string = () => '2026-10-26T13:00:00.000Z',
): MemoryRestoreTarget {
  const dataset = cloneDatasetShallow(initial);
  const blobs = new Map<string, Blob>();
  const applied: RestoreOperation[] = [];
  let appearance: BackupAppearance | null = null;

  const rowsOf = (collection: string): AnyRow[] => {
    const rows = (dataset as unknown as Record<string, AnyRow[]>)[collection];
    if (!Array.isArray(rows)) throw new Error(`集合不存在：${collection}`);
    return rows;
  };

  const apply = async (operation: RestoreOperation): Promise<void> => {
    switch (operation.type) {
      case 'create': {
        const rows = rowsOf(operation.collection);
        const row = operation.row as unknown as AnyRow;
        if (findRow(rows, row.id)) {
          throw new Error(`主键冲突：${operation.collection} ${row.id}`);
        }
        rows.push({ ...row, deletedAt: row.deletedAt ?? null });
        break;
      }
      case 'update': {
        const rows = rowsOf(operation.collection);
        const row = operation.row as unknown as AnyRow;
        const existing = findRow(rows, row.id);
        if (!existing) throw new Error(`对象不存在：${operation.collection} ${row.id}`);
        if (
          existing.deletedAt &&
          operation.collection !== 'tasks' &&
          operation.collection !== 'notes'
        ) {
          throw new Error(`对象在回收站中：${operation.collection} ${row.id}`);
        }
        if (existing.deletedAt) {
          existing.deletedAt = null;
          if (operation.collection === 'notes') existing.status = 'active';
        }
        Object.assign(existing, row, { deletedAt: null });
        break;
      }
      case 'delete': {
        const rows = rowsOf(operation.collection);
        const existing = findRow(rows, operation.id);
        if (!existing) throw new Error(`对象不存在：${operation.collection} ${operation.id}`);
        if (!existing.deletedAt) existing.deletedAt = now();
        break;
      }
      case 'habit-log-delete': {
        const existing = dataset.habitLogs.find(
          (row) => row.habitId === operation.habitId && row.logDate === operation.logDate,
        );
        if (!existing) throw new Error('打卡记录不存在');
        if (!existing.deletedAt) existing.deletedAt = now();
        break;
      }
      case 'board': {
        const index = dataset.boards.findIndex(
          (item) => item.board.id === operation.row.board.id,
        );
        if (operation.mode === 'create') {
          if (index >= 0) throw new Error('画板主键冲突');
          dataset.boards.push({
            board: { ...operation.row.board },
            nodes: operation.row.nodes.map((node) => ({ ...node })),
            edges: operation.row.edges.map((edge) => ({ ...edge })),
          });
        } else {
          if (index < 0) throw new Error('画板不存在');
          const existing = dataset.boards[index]!;
          const activeNodeIds = new Set(
            operation.row.nodes.filter((node) => !node.deletedAt).map((node) => node.id),
          );
          const activeEdgeIds = new Set(
            operation.row.edges.filter((edge) => !edge.deletedAt).map((edge) => edge.id),
          );
          dataset.boards[index] = {
            board: { ...operation.row.board },
            nodes: [
              ...operation.row.nodes.map((node) => ({ ...node })),
              ...existing.nodes
                .filter(
                  (node) =>
                    !activeNodeIds.has(node.id) &&
                    !operation.row.nodes.some((next) => next.id === node.id),
                )
                .map((node) => ({
                  ...node,
                  deletedAt: node.deletedAt ?? now(),
                })),
            ],
            edges: [
              ...operation.row.edges.map((edge) => ({ ...edge })),
              ...existing.edges
                .filter(
                  (edge) =>
                    !activeEdgeIds.has(edge.id) &&
                    !operation.row.edges.some((next) => next.id === edge.id),
                )
                .map((edge) => ({
                  ...edge,
                  deletedAt: edge.deletedAt ?? now(),
                })),
            ],
          };
        }
        break;
      }
      case 'review': {
        if (dataset.reviewSnapshots.some((row) => row.id === operation.row.id)) {
          throw new Error('复盘快照主键冲突');
        }
        if (dataset.notes.some((row) => row.id === operation.note.id)) {
          throw new Error('复盘笔记主键冲突');
        }
        dataset.notes.push({ ...operation.note });
        dataset.reviewSnapshots.push({ ...operation.row });
        break;
      }
      case 'attachment': {
        const existing = findRow(dataset.attachments as unknown as AnyRow[], operation.row.id);
        const shaOwner = dataset.attachments.find(
          (row) => row.sha256 === operation.row.sha256 && row.id !== operation.row.id,
        );
        if (shaOwner) throw new Error('附件 SHA-256 唯一约束冲突');
        if (!existing) {
          dataset.attachments.push({ ...operation.row });
        } else {
          Object.assign(existing, operation.row);
        }
        if (operation.blob) blobs.set(operation.row.id, operation.blob);
        break;
      }
      case 'setting': {
        const identity = settingIdentity(operation.row);
        const existing = dataset.settings.find(
          (row) => settingIdentity(row) === identity,
        );
        if (existing) {
          existing.value = operation.row.value;
          existing.deletedAt = null;
        } else {
          dataset.settings.push({ ...operation.row });
        }
        break;
      }
      case 'setting-delete': {
        const existing = dataset.settings.find((row) => row.id === operation.id);
        if (existing) existing.deletedAt = now();
        break;
      }
      case 'appearance':
        appearance = { ...operation.value };
        break;
      default:
        break;
    }
    applied.push(operation);
  };

  return {
    dataset,
    blobs,
    get appearance() {
      return appearance;
    },
    applied,
    apply,
  };
}
