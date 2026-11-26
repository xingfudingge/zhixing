/**
 * 恢复预览与计划（P2-04）。
 *
 * 设计原则：
 * 1. 默认跳过冲突，只有用户显式选择「覆盖本机」才会写同 ID 对象；
 * 2. 父对象被跳过或阻止时，依赖它的新对象也会被阻止，不制造半截数据；
 * 3. 「保留两者」会生成新 ID 并重映射引用；笔记/任务会复制其直属子对象；
 * 4. 指向已删除对象的关系不会被改成 null，回收站对象与关系一起恢复。
 *
 * 计划只描述操作，不接触数据库；真正写入由 RestoreTarget 完成。这样预览、
 * 冲突策略与测试可以在内存中完整复现。
 */

import type {
  Attachment,
  HabitLog,
  ReviewSnapshot,
  Setting,
} from '../../data/db/types';
import { entityLabel } from '../export/labels';
import { collectRelations } from '../export/relations';
import { settingIdentity, stableStringify } from '../export/sanitize';
import type {
  BackupDataset,
  BoardBackup,
  ParsedBackup,
  PlannedConflict,
  RestoreChoice,
  RestoreDecision,
  RestoreOperation,
  RestorePlan,
  RestoreSummary,
  BlockedRow,
  RestoreTarget,
  RestoreApplyResult,
  RestoreProgress,
} from '../export/types';
import { randomId, formatDateTime, truncate } from '../export/utils';

type AnyRow = Record<string, unknown> & {
  id: string;
  deletedAt?: string | null;
};

type PlanCollection =
  | 'lists'
  | 'tasks'
  | 'subtasks'
  | 'notes'
  | 'noteBlocks'
  | 'noteTodos'
  | 'events'
  | 'countdowns'
  | 'habits'
  | 'habitLogs'
  | 'focusSessions'
  | 'boards'
  | 'attachments'
  | 'settings'
  | 'reviewSnapshots';

type PlanAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'unchanged'
  | 'skip'
  | 'blocked'
  | 'managed';

type PlanState = {
  key: string;
  collection: PlanCollection;
  sourceId: string;
  targetId: string;
  action: PlanAction;
  local: AnyRow | null;
  source: AnyRow;
  choice?: RestoreChoice;
  deleteAfter: boolean;
  conflict?: PlannedConflict;
  reason?: string;
  boardTarget?: BoardBackup;
  noteData?: AnyRow;
};

type LocalIndex = {
  byId: Map<string, Map<string, AnyRow>>;
  boards: Map<string, BoardBackup>;
  settings: Map<string, Setting>;
  snapsById: Map<string, ReviewSnapshot>;
  snapsByRange: Map<string, ReviewSnapshot>;
  attachmentsBySha: Map<string, Attachment>;
  habitLogsByKey: Map<string, HabitLog>;
  boardNodeIds: Set<string>;
  boardEdgeIds: Set<string>;
  activeInbox: AnyRow | null;
};

const ID_PREFIX: Record<PlanCollection, string> = {
  lists: 'list',
  tasks: 'task',
  subtasks: 'subtask',
  notes: 'note',
  noteBlocks: 'block',
  noteTodos: 'todo',
  events: 'event',
  countdowns: 'countdown',
  habits: 'habit',
  habitLogs: 'log',
  focusSessions: 'focus',
  boards: 'board',
  attachments: 'attachment',
  settings: 'setting',
  reviewSnapshots: 'review',
};

const SIMPLE_COLLECTIONS: ReadonlyArray<PlanCollection> = [
  'lists',
  'tasks',
  'subtasks',
  'notes',
  'noteBlocks',
  'noteTodos',
  'events',
  'countdowns',
  'habits',
  'habitLogs',
  'focusSessions',
];

const STATE_ORDER: ReadonlyArray<PlanCollection> = [
  'lists',
  'reviewSnapshots',
  'notes',
  'noteBlocks',
  'tasks',
  'subtasks',
  'noteTodos',
  'events',
  'countdowns',
  'habits',
  'habitLogs',
  'focusSessions',
  'boards',
  'attachments',
  'settings',
];

const DELETE_ORDER: ReadonlyArray<PlanCollection> = [
  'attachments',
  'noteTodos',
  'noteBlocks',
  'subtasks',
  'focusSessions',
  'habitLogs',
  'events',
  'countdowns',
  'boards',
  'tasks',
  'notes',
  'habits',
  'lists',
  'settings',
];

function asRows(value: unknown): AnyRow[] {
  return Array.isArray(value) ? (value as AnyRow[]) : [];
}

function isDeleted(row: AnyRow | null | undefined): boolean {
  return Boolean(row && row.deletedAt);
}

function addToIndex(index: Map<string, Map<string, AnyRow>>, collection: string, rows: AnyRow[]): void {
  const map = new Map<string, AnyRow>();
  for (const row of rows) map.set(row.id, row);
  index.set(collection, map);
}

export function buildLocalIndex(dataset: BackupDataset): LocalIndex {
  const byId = new Map<string, Map<string, AnyRow>>();
  addToIndex(byId, 'lists', dataset.lists as unknown as AnyRow[]);
  addToIndex(byId, 'tasks', dataset.tasks as unknown as AnyRow[]);
  addToIndex(byId, 'subtasks', dataset.subtasks as unknown as AnyRow[]);
  addToIndex(byId, 'notes', dataset.notes as unknown as AnyRow[]);
  addToIndex(byId, 'noteBlocks', dataset.noteBlocks as unknown as AnyRow[]);
  addToIndex(byId, 'noteTodos', dataset.noteTodos as unknown as AnyRow[]);
  addToIndex(byId, 'events', dataset.events as unknown as AnyRow[]);
  addToIndex(byId, 'countdowns', dataset.countdowns as unknown as AnyRow[]);
  addToIndex(byId, 'habits', dataset.habits as unknown as AnyRow[]);
  addToIndex(byId, 'habitLogs', dataset.habitLogs as unknown as AnyRow[]);
  addToIndex(byId, 'focusSessions', dataset.focusSessions as unknown as AnyRow[]);
  addToIndex(byId, 'attachments', dataset.attachments as unknown as AnyRow[]);
  addToIndex(byId, 'settings', dataset.settings as unknown as AnyRow[]);

  const boards = new Map(dataset.boards.map((board) => [board.board.id, board]));
  const settings = new Map(
    dataset.settings.map((row) => [settingIdentity(row), row]),
  );
  const snapsById = new Map(
    dataset.reviewSnapshots.map((row) => [row.id, row]),
  );
  const snapsByRange = new Map(
    dataset.reviewSnapshots.map((row) => [`${row.rangeStart}|${row.rangeEnd}`, row]),
  );
  const attachmentsBySha = new Map(
    dataset.attachments.map((row) => [row.sha256.toLowerCase(), row]),
  );
  const habitLogsByKey = new Map(
    dataset.habitLogs.map((row) => [`${row.habitId}|${row.logDate}`, row]),
  );
  const activeInbox =
    dataset.lists.find((row) => row.isInbox && !row.deletedAt) ?? null;
  const boardNodeIds = new Set(
    dataset.boards.flatMap((board) => board.nodes.map((node) => node.id)),
  );
  const boardEdgeIds = new Set(
    dataset.boards.flatMap((board) => board.edges.map((edge) => edge.id)),
  );

  return {
    byId,
    boards,
    settings,
    snapsById,
    snapsByRange,
    attachmentsBySha,
    habitLogsByKey,
    boardNodeIds,
    boardEdgeIds,
    activeInbox: activeInbox as unknown as AnyRow | null,
  };
}

function boardRow(board: BoardBackup): AnyRow {
  return {
    ...board,
    id: board.board.id,
    deletedAt: board.board.deletedAt,
  } as unknown as AnyRow;
}

function getLocal(
  index: LocalIndex,
  collection: PlanCollection,
  id: string,
): AnyRow | null {
  if (collection === 'boards') {
    const board = index.boards.get(id);
    if (!board) return null;
    return boardRow(board);
  }
  if (collection === 'settings') {
    return null;
  }
  return index.byId.get(collection)?.get(id) ?? null;
}

function localHas(index: LocalIndex, collection: string, id: string): boolean {
  if (collection === 'boards') return index.boards.has(id);
  if (collection === 'settings') return false;
  return index.byId.get(collection)?.has(id) ?? false;
}

const META_KEYS = new Set(['createdAt', 'updatedAt', 'version']);

function withoutMeta(row: Record<string, unknown>, extra: string[] = []): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (META_KEYS.has(key)) continue;
    if (extra.includes(key)) continue;
    output[key] = value;
  }
  return output;
}

function fingerprint(collection: PlanCollection, row: AnyRow): string {
  if (collection === 'boards') {
    const board = row as unknown as BoardBackup;
    return stableStringify({
      board: withoutMeta(board.board as unknown as Record<string, unknown>),
      nodes: board.nodes.map((node) =>
        withoutMeta(node as unknown as Record<string, unknown>),
      ),
      edges: board.edges.map((edge) =>
        withoutMeta(edge as unknown as Record<string, unknown>),
      ),
    });
  }
  if (collection === 'attachments') {
    return stableStringify(
      withoutMeta(row, ['completedAt']),
    );
  }
  if (collection === 'tasks') {
    return stableStringify(withoutMeta(row, ['completedAt']));
  }
  if (collection === 'settings') {
    return stableStringify(
      withoutMeta(row, ['id', 'spaceId', 'scope', 'key']),
    );
  }
  return stableStringify(withoutMeta(row));
}

function sameEntity(collection: PlanCollection, left: AnyRow, right: AnyRow): boolean {
  return fingerprint(collection, left) === fingerprint(collection, right);
}

function conflictKey(collection: PlanCollection, row: AnyRow): string {
  if (collection === 'settings') {
    const setting = row as unknown as Setting;
    return `settings:${settingIdentity(setting)}`;
  }
  return `${collection}:${row.id}`;
}

function labelFor(collection: PlanCollection, row: AnyRow | null): string {
  if (!row) return '—';
  return entityLabel(collection, row);
}

function detailFor(collection: PlanCollection, row: AnyRow | null): string {
  if (!row) return '—';
  if (collection === 'notes') {
    const body =
      typeof row.body === 'string'
        ? row.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
    return body ? truncate(body, 96) : '（空笔记）';
  }
  if (collection === 'boards') {
    const bundle = row as unknown as BoardBackup;
    return `${bundle.nodes.length} 个对象 / ${bundle.edges.length} 条连线`;
  }
  if (collection === 'settings') {
    return truncate(stableStringify(row.value), 96);
  }
  if (collection === 'attachments') {
    const attachment = row as unknown as Attachment;
    return `${attachment.fileName} · ${attachment.byteSize} B · ${attachment.sha256.slice(0, 12)}…`;
  }
  if (collection === 'noteBlocks') {
    const payload = row.payload as Record<string, unknown> | undefined;
    const text =
      typeof payload?.text === 'string' ? payload.text : '';
    return text ? truncate(text, 96) : String(row.blockType ?? '块');
  }
  if (typeof row.notes === 'string' && row.notes.trim()) {
    return truncate(row.notes, 96);
  }
  if (typeof row.title === 'string' && row.title.trim()) {
    return truncate(row.title, 96);
  }
  return '—';
}

function timeFor(row: AnyRow | null): string {
  if (!row) return '—';
  if (row.board && typeof row.board === 'object') {
    const board = row.board as { updatedAt?: string };
    return formatDateTime(board.updatedAt ?? null);
  }
  return formatDateTime(
    typeof row.updatedAt === 'string' ? row.updatedAt : null,
  );
}

function supportedChoices(
  collection: PlanCollection,
  local: AnyRow,
  backup: AnyRow,
  context: {
    attachmentShaUsed: boolean;
  },
): RestoreChoice[] {
  if (collection === 'reviewSnapshots') return ['skip'];
  if (collection === 'settings') {
    return isDeleted(backup) ? ['skip'] : ['skip', 'overwrite'];
  }
  const localDeleted = isDeleted(local);
  const backupDeleted = isDeleted(backup);
  if (localDeleted && backupDeleted) {
    return sameEntity(collection, local, backup) ? [] : ['skip'];
  }
  if (localDeleted && !backupDeleted) {
    if (collection === 'tasks' || collection === 'notes') {
      return ['skip', 'overwrite', 'keep-both'];
    }
    if (collection === 'attachments' || collection === 'habitLogs') {
      return ['skip'];
    }
    return ['skip', 'keep-both'];
  }
  if (!localDeleted && backupDeleted) {
    return ['skip', 'overwrite'];
  }
  // 两端都活跃但内容不同。
  if (collection === 'attachments') {
    const shaSame =
      (local as unknown as Attachment).sha256.toLowerCase() ===
      (backup as unknown as Attachment).sha256.toLowerCase();
    return [
      'skip',
      ...(shaSame ? (['overwrite'] as RestoreChoice[]) : []),
      ...(!context.attachmentShaUsed ? (['keep-both'] as RestoreChoice[]) : []),
    ];
  }
  if (collection === 'habitLogs') return ['skip', 'overwrite'];
  if (collection === 'lists') {
    const localList = local as unknown as { isInbox?: boolean };
    const backupList = backup as unknown as { isInbox?: boolean };
    return [
      'skip',
      ...(Boolean(localList.isInbox) === Boolean(backupList.isInbox)
        ? (['overwrite'] as RestoreChoice[])
        : []),
      'keep-both',
    ];
  }
  return ['skip', 'overwrite', 'keep-both'];
}

function refRows(
  collection: PlanCollection,
  row: AnyRow,
  resolve: (collection: string, id: string) => { ok: boolean; id: string; reason?: string },
): { rows: AnyRow; remap: Record<string, string>; error: string | null } {
  const remap: Record<string, string> = {};
  const clone = { ...row };
  const require = (
    targetCollection: string,
    value: unknown,
    field: string,
  ): string | null => {
    if (typeof value !== 'string' || !value) return null;
    const result = resolve(targetCollection, value);
    if (!result.ok) {
      return `${field} 引用的${targetCollection} ${value} 不可用：${result.reason ?? '已跳过或阻止'}`;
    }
    remap[field] = result.id;
    (clone as Record<string, unknown>)[field] = result.id;
    return null;
  };
  let error: string | null = null;
  switch (collection) {
    case 'tasks': {
      error = require('lists', row.listId, 'listId');
      if (error) break;
      if (row.noteId) {
        error = require('notes', row.noteId, 'noteId');
        if (error) break;
      }
      if (row.parentId) {
        error = require('tasks', row.parentId, 'parentId');
      }
      break;
    }
    case 'lists': {
      if (row.parentId) {
        const result = resolve('lists', String(row.parentId));
        if (!result.ok || result.id === row.id) {
          // 父级不存在/被跳过/成环：拍平成根级，绝不丢清单或任务。
          clone.parentId = null;
        } else {
          remap.parentId = result.id;
          clone.parentId = result.id;
        }
      }
      break;
    }
    case 'subtasks':
      error = require('tasks', row.taskId, 'taskId');
      break;
    case 'noteBlocks':
      error = require('notes', row.noteId, 'noteId');
      break;
    case 'noteTodos': {
      error = require('notes', row.noteId, 'noteId');
      if (error) break;
      if (row.taskId) {
        error = require('tasks', row.taskId, 'taskId');
      }
      break;
    }
    case 'events':
      if (row.noteId) error = require('notes', row.noteId, 'noteId');
      break;
    case 'focusSessions':
      error = require('tasks', row.taskId, 'taskId');
      break;
    case 'habitLogs':
      error = require('habits', row.habitId, 'habitId');
      break;
    case 'boards': {
      const bundle = row as unknown as BoardBackup;
      if (bundle.board.noteId) {
        const result = resolve('notes', bundle.board.noteId);
        if (!result.ok) {
          error = `画板关联的笔记 ${bundle.board.noteId} 不可用：${
            result.reason ?? '已跳过或阻止'
          }`;
        } else {
          clone.noteId = result.id;
          (clone as Record<string, unknown>).board = {
            ...bundle.board,
            noteId: result.id,
          };
        }
      }
      break;
    }
    case 'attachments': {
      if (row.noteId) {
        error = require('notes', row.noteId, 'noteId');
        if (error) break;
      }
      if (row.blockId) {
        error = require('noteBlocks', row.blockId, 'blockId');
      }
      break;
    }
    default:
      break;
  }
  return { rows: clone, remap, error };
}

export type PlanRestoreOptions = {
  decisions?: RestoreDecision;
  restoreAppearance?: boolean;
  warnings?: string[];
};

export function planRestore(
  parsed: ParsedBackup,
  local: BackupDataset,
  options: PlanRestoreOptions = {},
): RestorePlan {
  const backup = parsed.payload.dataset;
  const decisions = options.decisions ?? {};
  const restoreAppearance = options.restoreAppearance !== false;
  const warnings = [...(options.warnings ?? [])];
  const localIndex = buildLocalIndex(local);
  const states = new Map<string, PlanState>();
  const rowsByCollection = new Map<PlanCollection, PlanState[]>();
  const conflicts: PlannedConflict[] = [];
  const blocked: BlockedRow[] = [];
  const forcedKeepBoth = new Set<string>();
  const managedNotes = new Set<string>();
  const usedTargetIds = new Set<string>();

  const addState = (state: PlanState) => {
    states.set(state.key, state);
    const list = rowsByCollection.get(state.collection) ?? [];
    list.push(state);
    rowsByCollection.set(state.collection, list);
    usedTargetIds.add(state.targetId);
    return state;
  };

  const newTargetId = (collection: PlanCollection): string => {
    let id = randomId(ID_PREFIX[collection]);
    while (usedTargetIds.has(id) || localHas(localIndex, collection, id)) {
      id = randomId(ID_PREFIX[collection]);
    }
    usedTargetIds.add(id);
    return id;
  };

  const newBoardNodeId = (): string => {
    let id = randomId('node');
    while (usedTargetIds.has(id) || localIndex.boardNodeIds.has(id)) {
      id = randomId('node');
    }
    usedTargetIds.add(id);
    return id;
  };

  const newBoardEdgeId = (): string => {
    let id = randomId('edge');
    while (usedTargetIds.has(id) || localIndex.boardEdgeIds.has(id)) {
      id = randomId('edge');
    }
    usedTargetIds.add(id);
    return id;
  };

  const resolveRef = (
    collection: string,
    id: string,
  ): { ok: boolean; id: string; reason?: string } => {
    const state = states.get(`${collection}:${id}`);
    if (state) {
      if (state.action === 'blocked') {
        return { ok: false, id, reason: state.reason ?? '对象被阻止' };
      }
      if (state.action === 'skip') {
        return { ok: false, id, reason: '对象选择保留本机版本（跳过）' };
      }
      return { ok: true, id: state.targetId };
    }
    if (
      (collection === 'boards' && localIndex.boards.has(id)) ||
      (collection !== 'boards' &&
        collection !== 'settings' &&
        localIndex.byId.get(collection)?.has(id))
    ) {
      return { ok: true, id };
    }
    return { ok: false, id, reason: '对象不在备份中，本机也不存在' };
  };

  const makeConflict = (
    collection: PlanCollection,
    source: AnyRow,
    localRow: AnyRow,
    choices: RestoreChoice[],
    reason?: string,
    forced = false,
  ): PlannedConflict => {
    const fallback: RestoreChoice = forced && choices.includes('keep-both')
      ? 'keep-both'
      : choices.includes('skip')
        ? 'skip'
        : (choices[0] ?? 'skip');
    const conflict: PlannedConflict = {
      key: conflictKey(collection, source),
      collection,
      id: source.id,
      label: `${labelFor(collection, source)}`,
      localLabel: `${labelFor(collection, localRow)} · ${timeFor(localRow)}`,
      backupLabel: `${labelFor(collection, source)} · ${timeFor(source)}`,
      localDetail: detailFor(collection, localRow),
      backupDetail: detailFor(collection, source),
      localDeleted: isDeleted(localRow),
      backupDeleted: isDeleted(source),
      choices: choices.length > 0 ? choices : ['skip'],
      defaultChoice: fallback,
      reason,
    };
    conflicts.push(conflict);
    return conflict;
  };

  type PlanOptions = {
    localOverride?: AnyRow | null;
    targetIdOverride?: string;
    force?: boolean;
  };

  const planRow = (
    collection: PlanCollection,
    source: AnyRow,
    opts: PlanOptions = {},
  ): PlanState => {
    const key = conflictKey(collection, source);
    const existing = states.get(key);
    if (existing) return existing;
    if (collection === 'notes' && managedNotes.has(source.id)) {
      return addState({
        key,
        collection,
        sourceId: source.id,
        targetId: source.id,
        action: 'managed',
        local: null,
        source,
        deleteAfter: false,
      });
    }

    const force = opts.force ?? forcedKeepBoth.has(key);
    const localRow = opts.localOverride ?? getLocal(localIndex, collection, source.id);
    const sourceDeleted = isDeleted(source);

    if (!localRow) {
      const dependency = refRows(collection, source, resolveRef);
      if (dependency.error) {
        const state = addState({
          key,
          collection,
          sourceId: source.id,
          targetId: opts.targetIdOverride ?? source.id,
          action: 'blocked',
          local: null,
          source,
          deleteAfter: false,
          reason: dependency.error,
        });
        blocked.push({
          key,
          collection,
          id: source.id,
          label: labelFor(collection, source),
          reason: dependency.error,
        });
        return state;
      }
      const state = addState({
        key,
        collection,
        sourceId: source.id,
        targetId: opts.targetIdOverride ?? source.id,
        action: 'create',
        local: null,
        source,
        deleteAfter: sourceDeleted,
      });
      if (collection === 'boards') {
        state.boardTarget = source as unknown as BoardBackup;
      }
      return state;
    }

    if (!force && sameEntity(collection, source, localRow)) {
      return addState({
        key,
        collection,
        sourceId: source.id,
        targetId: localRow.id,
        action: 'unchanged',
        local: localRow,
        source,
        deleteAfter: false,
      });
    }

    const attachmentShaUsed = localIndex.attachmentsBySha.has(
      String((source as unknown as Attachment).sha256 ?? '').toLowerCase(),
    );
    let choices = supportedChoices(collection, localRow, source, {
      attachmentShaUsed,
    });
    if (choices.length === 0) choices = ['skip'];
    const effectiveChoices: RestoreChoice[] = force
      ? choices.includes('keep-both')
        ? ['keep-both']
        : ['skip']
      : choices;
    const conflict = makeConflict(
      collection,
      source,
      localRow,
      effectiveChoices,
      force
        ? '父对象选择保留两者，将自动复制此对象'
        : sourceDeleted
          ? '备份中该对象已在回收站'
          : undefined,
      force,
    );

    let choice: RestoreChoice;
    if (force) {
      choice = choices.includes('keep-both') ? 'keep-both' : 'skip';
      if (choice === 'skip') {
        warnings.push(`${labelFor(collection, source)} 无法随父对象复制，已跳过`);
      }
    } else {
      const requested = decisions[conflict.key];
      if (requested && choices.includes(requested)) {
        choice = requested;
      } else {
        if (requested && !choices.includes(requested)) {
          warnings.push(
            `${labelFor(collection, source)} 不支持「${requested}」，已改为跳过`,
          );
        }
        choice = conflict.defaultChoice;
      }
    }

    let action: PlanAction;
    let targetId = localRow.id;
    let deleteAfter = false;
    if (choice === 'skip') {
      action = 'skip';
    } else if (choice === 'overwrite') {
      if (sourceDeleted) {
        action = 'delete';
        targetId = localRow.id;
      } else {
        action = 'update';
        targetId = localRow.id;
      }
    } else {
      action = 'create';
      targetId = opts.targetIdOverride ?? newTargetId(collection);
      deleteAfter = false;
      if (sourceDeleted) {
        action = 'blocked';
        const reason = '已删除的对象不能以「保留两者」方式复制';
        const state = addState({
          key,
          collection,
          sourceId: source.id,
          targetId,
          action,
          local: localRow,
          source,
          choice,
          conflict,
          deleteAfter,
          reason,
        });
        blocked.push({
          key,
          collection,
          id: source.id,
          label: labelFor(collection, source),
          reason,
        });
        return state;
      }
    }

    let dependencyError: string | null = null;
    if (action === 'create' || action === 'update') {
      const dependency = refRows(collection, source, resolveRef);
      if (dependency.error) {
        dependencyError = dependency.error;
        action = 'blocked';
      }
    }

    const state = addState({
      key,
      collection,
      sourceId: source.id,
      targetId,
      action,
      local: localRow,
      source,
      choice,
      conflict,
      deleteAfter,
      reason: dependencyError ?? undefined,
    });

    if (dependencyError) {
      blocked.push({
        key,
        collection,
        id: source.id,
        label: labelFor(collection, source),
        reason: dependencyError,
      });
      return state;
    }

    if (action === 'create' && collection === 'notes') {
      for (const block of asRows(backup.noteBlocks)) {
        if (block.noteId === source.id) forcedKeepBoth.add(`noteBlocks:${block.id}`);
      }
      for (const todo of asRows(backup.noteTodos)) {
        if (todo.noteId === source.id) forcedKeepBoth.add(`noteTodos:${todo.id}`);
      }
    }
    if (action === 'create' && collection === 'tasks') {
      for (const subtask of asRows(backup.subtasks)) {
        if (subtask.taskId === source.id) forcedKeepBoth.add(`subtasks:${subtask.id}`);
      }
    }
    if (collection === 'boards') {
      if (action === 'create' && choice === 'keep-both') {
        state.boardTarget = cloneBoardBundle(
          source as unknown as BoardBackup,
          () => newTargetId('boards'),
          newBoardNodeId,
          newBoardEdgeId,
        );
      } else {
        state.boardTarget = source as unknown as BoardBackup;
      }
    }
    return state;
  };

  // 1. 清单
  for (const raw of backup.lists) {
    const source = raw as unknown as AnyRow;
    if (source.isInbox && !isDeleted(source)) {
      const localSame = getLocal(localIndex, 'lists', source.id);
      const inbox = localIndex.activeInbox;
      if (!localSame && inbox && inbox.id !== source.id) {
        const conflict = makeConflict(
          'lists',
          source,
          inbox,
          ['skip', 'keep-both'],
          '本机已有未安排；「保留两者」会作为普通清单导入',
        );
        const requested = decisions[conflict.key];
        const choice = requested === 'keep-both' ? 'keep-both' : 'skip';
        addState({
          key: conflict.key,
          collection: 'lists',
          sourceId: source.id,
          targetId: choice === 'keep-both' ? newTargetId('lists') : source.id,
          action: choice === 'keep-both' ? 'create' : 'skip',
          local: inbox,
          source,
          choice,
          conflict,
          deleteAfter: false,
        });
        continue;
      }
    }
    planRow('lists', source);
  }

  // 2. 复盘快照：先确定哪些笔记由快照创建。
  const backupNotesById = new Map(
    backup.notes.map((note) => [note.id, note as unknown as AnyRow]),
  );
  for (const raw of backup.reviewSnapshots) {
    const source = raw as unknown as AnyRow;
    const range = `${String(source.rangeStart)}|${String(source.rangeEnd)}`;
    const localById = localIndex.snapsById.get(source.id) ?? null;
    const localByRange = localIndex.snapsByRange.get(range) ?? null;
    const localRow = localById ?? localByRange;
    if (isDeleted(source)) {
      warnings.push(`复盘快照 ${source.id} 在备份中已删除，当前仓储没有删除/恢复命令，已跳过`);
      addState({
        key: `reviewSnapshots:${source.id}`,
        collection: 'reviewSnapshots',
        sourceId: source.id,
        targetId: source.id,
        action: 'skip',
        local: localRow,
        source,
        deleteAfter: false,
        reason: '复盘快照不支持恢复回收站状态',
      });
      continue;
    }
    if (localRow) {
      if (sameEntity('reviewSnapshots', source, localRow as unknown as AnyRow)) {
        addState({
          key: `reviewSnapshots:${source.id}`,
          collection: 'reviewSnapshots',
          sourceId: source.id,
          targetId: localRow.id,
          action: 'unchanged',
          local: localRow as unknown as AnyRow,
          source,
          deleteAfter: false,
        });
      } else {
        const conflict = makeConflict(
          'reviewSnapshots',
          source,
          localRow as unknown as AnyRow,
          ['skip'],
          '复盘快照按日期范围唯一；当前仓储不支持覆盖或复制快照',
        );
        addState({
          key: conflict.key,
          collection: 'reviewSnapshots',
          sourceId: source.id,
          targetId: localRow.id,
          action: 'skip',
          local: localRow as unknown as AnyRow,
          source,
          choice: 'skip',
          conflict,
          deleteAfter: false,
        });
      }
      continue;
    }

    const note = source.noteId ? backupNotesById.get(String(source.noteId)) : null;
    if (!note) {
      const reason = '复盘快照关联的笔记不在备份中';
      const state = addState({
        key: `reviewSnapshots:${source.id}`,
        collection: 'reviewSnapshots',
        sourceId: source.id,
        targetId: source.id,
        action: 'blocked',
        local: null,
        source,
        deleteAfter: false,
        reason,
      });
      blocked.push({
        key: state.key,
        collection: 'reviewSnapshots',
        id: source.id,
        label: labelFor('reviewSnapshots', source),
        reason,
      });
      continue;
    }
    if (localIndex.byId.get('notes')?.has(String(source.noteId))) {
      const reason = '复盘笔记 ID 已存在于本机；当前仓储无法复用该笔记保存快照';
      const state = addState({
        key: `reviewSnapshots:${source.id}`,
        collection: 'reviewSnapshots',
        sourceId: source.id,
        targetId: source.id,
        action: 'blocked',
        local: null,
        source,
        deleteAfter: false,
        reason,
      });
      blocked.push({
        key: state.key,
        collection: 'reviewSnapshots',
        id: source.id,
        label: labelFor('reviewSnapshots', source),
        reason,
      });
      continue;
    }
    managedNotes.add(String(source.noteId));
    addState({
      key: `notes:${String(source.noteId)}`,
      collection: 'notes',
      sourceId: String(source.noteId),
      targetId: String(source.noteId),
      action: 'managed',
      local: null,
      source: note,
      deleteAfter: Boolean(note.deletedAt),
    });
    addState({
      key: `reviewSnapshots:${source.id}`,
      collection: 'reviewSnapshots',
      sourceId: source.id,
      targetId: source.id,
      action: 'create',
      local: null,
      source,
      deleteAfter: false,
      noteData: note,
    });
  }

  // 3. 笔记（跳过由快照托管的笔记）
  for (const raw of backup.notes) {
    const source = raw as unknown as AnyRow;
    if (managedNotes.has(source.id)) continue;
    planRow('notes', source);
  }

  // 4. 笔记块
  const blockRows = [...backup.noteBlocks].sort((a, b) => a.orderKey - b.orderKey);
  for (const raw of blockRows) {
    planRow('noteBlocks', raw as unknown as AnyRow);
  }

  // 5. 任务：按父子依赖多轮规划，避免父级尚未建立。
  const unplannedTasks = new Map(
    backup.tasks.map((task) => [task.id, task as unknown as AnyRow]),
  );
  let progress = true;
  while (unplannedTasks.size > 0 && progress) {
    progress = false;
    for (const [id, task] of Array.from(unplannedTasks.entries())) {
      const parentId = typeof task.parentId === 'string' ? task.parentId : null;
      if (
        parentId &&
        unplannedTasks.has(parentId) &&
        !states.has(`tasks:${parentId}`)
      ) {
        continue;
      }
      planRow('tasks', task);
      unplannedTasks.delete(id);
      progress = true;
    }
  }
  for (const task of unplannedTasks.values()) {
    const reason = '任务父子关系存在循环引用，无法确定创建顺序';
    const state = addState({
      key: `tasks:${task.id}`,
      collection: 'tasks',
      sourceId: task.id,
      targetId: task.id,
      action: 'blocked',
      local: getLocal(localIndex, 'tasks', task.id),
      source: task,
      deleteAfter: false,
      reason,
    });
    blocked.push({
      key: state.key,
      collection: 'tasks',
      id: task.id,
      label: labelFor('tasks', task),
      reason,
    });
  }

  // 6. 子任务
  for (const raw of backup.subtasks) {
    planRow('subtasks', raw as unknown as AnyRow);
  }

  // 7. 笔记待办（依赖任务）
  for (const raw of backup.noteTodos) {
    planRow('noteTodos', raw as unknown as AnyRow);
  }

  // 8. 日历、倒数日、习惯、打卡、专注
  for (const raw of backup.events) planRow('events', raw as unknown as AnyRow);
  for (const raw of backup.countdowns) planRow('countdowns', raw as unknown as AnyRow);
  for (const raw of backup.habits) planRow('habits', raw as unknown as AnyRow);
  for (const raw of backup.habitLogs) {
    const source = raw as unknown as AnyRow;
    const sameId = getLocal(localIndex, 'habitLogs', source.id);
    const key = `${String(source.habitId)}|${String(source.logDate)}`;
    const localByKey = localIndex.habitLogsByKey.get(key);
    if (!sameId && localByKey && localByKey.id !== source.id) {
      planRow('habitLogs', source, {
        localOverride: localByKey as unknown as AnyRow,
      });
    } else {
      planRow('habitLogs', source);
    }
  }
  for (const raw of backup.focusSessions) {
    planRow('focusSessions', raw as unknown as AnyRow);
  }

  // 9. 画板（整包冲突）
  for (const board of backup.boards) {
    planRow('boards', boardRow(board));
  }

  // 10. 附件
  for (const raw of backup.attachments) {
    const source = raw as unknown as AnyRow;
    const localSame = getLocal(localIndex, 'attachments', source.id);
    const sha = String(source.sha256).toLowerCase();
    const localBySha = localIndex.attachmentsBySha.get(sha);
    if (!localSame && localBySha && localBySha.id !== source.id) {
      const reason = '本机已有相同 SHA-256 的附件（数据库唯一约束），不能重复导入';
      const state = addState({
        key: `attachments:${source.id}`,
        collection: 'attachments',
        sourceId: source.id,
        targetId: source.id,
        action: 'blocked',
        local: localBySha as unknown as AnyRow,
        source,
        deleteAfter: false,
        reason,
      });
      blocked.push({
        key: state.key,
        collection: 'attachments',
        id: source.id,
        label: labelFor('attachments', source),
        reason,
      });
      continue;
    }
    planRow('attachments', source);
  }

  // 11. 设备偏好（按 key 识别，而不是 id）
  const backupSettings = [...backup.settings].sort((a, b) => a.key.localeCompare(b.key));
  for (const setting of backupSettings) {
    const raw = setting as unknown as AnyRow;
    if (isDeleted(raw)) {
      warnings.push(`已删除的偏好 ${setting.key} 不参与恢复`);
      addState({
        key: `settings:${settingIdentity(setting)}`,
        collection: 'settings',
        sourceId: setting.id,
        targetId: setting.id,
        action: 'skip',
        local: null,
        source: raw,
        deleteAfter: false,
        reason: '已删除的偏好不恢复',
      });
      continue;
    }
    const localRow = localIndex.settings.get(settingIdentity(setting)) ?? null;
    if (!localRow) {
      addState({
        key: `settings:${settingIdentity(setting)}`,
        collection: 'settings',
        sourceId: setting.id,
        targetId: setting.id,
        action: 'create',
        local: null,
        source: raw,
        deleteAfter: false,
      });
      continue;
    }
    if (sameEntity('settings', raw, localRow as unknown as AnyRow)) {
      addState({
        key: `settings:${settingIdentity(setting)}`,
        collection: 'settings',
        sourceId: setting.id,
        targetId: localRow.id,
        action: 'unchanged',
        local: localRow as unknown as AnyRow,
        source: raw,
        deleteAfter: false,
      });
      continue;
    }
    const conflict = makeConflict(
      'settings',
      raw,
      localRow as unknown as AnyRow,
      ['skip', 'overwrite'],
    );
    const requested = decisions[conflict.key];
    const choice =
      requested === 'overwrite' ? 'overwrite' : conflict.defaultChoice;
    addState({
      key: conflict.key,
      collection: 'settings',
      sourceId: setting.id,
      targetId: localRow.id,
      action: choice === 'overwrite' ? 'update' : 'skip',
      local: localRow as unknown as AnyRow,
      source: raw,
      choice,
      conflict,
      deleteAfter: false,
    });
  }

  // 清单父级成环时拍平为根级并提示；宁可丢层级，也不能丢清单/任务。
  {
    const listStates = rowsByCollection.get('lists') ?? [];
    const bySourceId = new Map(
      listStates.map((state) => [String(state.source.id), state]),
    );
    for (const state of listStates) {
      if (state.action !== 'create' && state.action !== 'update') continue;
      const seen = new Set<string>([String(state.source.id)]);
      let current = state.source;
      let guard = 0;
      let cycle = false;
      let depth = 1;
      while (typeof current.parentId === 'string' && current.parentId) {
        guard += 1;
        depth += 1;
        if (guard > 32) {
          cycle = true;
          break;
        }
        const parent = bySourceId.get(current.parentId);
        if (!parent) break;
        if (seen.has(String(parent.source.id))) {
          cycle = true;
          break;
        }
        seen.add(String(parent.source.id));
        current = parent.source;
      }
      if (cycle) {
        state.source = { ...state.source, parentId: null };
        warnings.push(
          `清单 ${String(state.source.id)} 的父级关系成环，已拍平为根级（未丢清单/任务）`,
        );
      } else if (depth > 3) {
        state.source = { ...state.source, parentId: null };
        warnings.push(
          `清单 ${String(state.source.id)} 超过 3 层，已拍平为根级（未丢清单/任务）`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 生成操作
  // -------------------------------------------------------------------------
  const operations: RestoreOperation[] = [];
  const deleteOperations: RestoreOperation[] = [];

  const remap = (collection: PlanCollection, row: AnyRow, targetId: string): AnyRow => {
    const cloned: AnyRow = { ...row, id: targetId };
    const setRef = (field: string, refCollection: string) => {
      const value = cloned[field];
      if (typeof value !== 'string' || !value) return;
      const state = states.get(`${refCollection}:${value}`);
      if (state) {
        (cloned as Record<string, unknown>)[field] = state.targetId;
      }
    };
    switch (collection) {
      case 'tasks':
        setRef('listId', 'lists');
        setRef('noteId', 'notes');
        setRef('parentId', 'tasks');
        break;
      case 'subtasks':
        setRef('taskId', 'tasks');
        break;
      case 'noteBlocks':
        setRef('noteId', 'notes');
        break;
      case 'noteTodos':
        setRef('noteId', 'notes');
        setRef('taskId', 'tasks');
        break;
      case 'events':
        setRef('noteId', 'notes');
        break;
      case 'focusSessions':
        setRef('taskId', 'tasks');
        break;
      case 'habitLogs':
        setRef('habitId', 'habits');
        break;
      case 'attachments':
        setRef('noteId', 'notes');
        setRef('blockId', 'noteBlocks');
        break;
      case 'lists':
        setRef('parentId', 'lists');
        if (collection === 'lists') {
          const original = states.get(`lists:${row.id}`);
          if (original?.choice === 'keep-both') {
            (cloned as Record<string, unknown>).isInbox = false;
          }
        }
        break;
      default:
        break;
    }
    return cloned;
  };

  const boardBundleFor = (state: PlanState): BoardBackup => {
    if (state.boardTarget) {
      if (state.choice !== 'keep-both') {
        const bundle = state.boardTarget;
        const noteId = bundle.board.noteId
          ? states.get(`notes:${bundle.board.noteId}`)?.targetId ??
            bundle.board.noteId
          : null;
        return { ...bundle, board: { ...bundle.board, noteId } };
      }
      const noteId = state.boardTarget.board.noteId
        ? states.get(`notes:${state.boardTarget.board.noteId}`)?.targetId ??
          state.boardTarget.board.noteId
        : null;
      return {
        ...state.boardTarget,
        board: { ...state.boardTarget.board, noteId },
      };
    }
    return state.source as unknown as BoardBackup;
  };

  const emitState = (state: PlanState) => {
    if (state.action === 'delete') {
      return;
    }
    if (state.action !== 'create' && state.action !== 'update') {
      return;
    }
    const source = state.source;
    if (state.collection === 'boards') {
      operations.push({
        type: 'board',
        mode: state.action === 'create' ? 'create' : 'update',
        row: boardBundleFor(state),
      });
      return;
    }
    if (state.collection === 'attachments') {
      const row = remap(
        'attachments',
        source,
        state.targetId,
      ) as unknown as Attachment;
      operations.push({
        type: 'attachment',
        row,
        blob: parsed.blobs.get(source.id) ?? null,
      });
      return;
    }
    if (state.collection === 'reviewSnapshots') {
      const snapshot = source as unknown as ReviewSnapshot;
      const note = state.noteData as unknown as AnyRow;
      if (!note) return;
      operations.push({
        type: 'review',
        row: snapshot,
        note: note as never,
      });
      return;
    }
    if (state.collection === 'settings') {
      const row = {
        ...(source as unknown as Setting),
        id: state.targetId,
      };
      operations.push({ type: 'setting', row });
      return;
    }
    if (!SIMPLE_COLLECTIONS.includes(state.collection)) return;
    const row = remap(
      state.collection,
      source,
      state.targetId,
    ) as never;
    operations.push({
      type: state.action,
      collection: state.collection as never,
      row,
    } as RestoreOperation);
  };

  for (const collection of STATE_ORDER) {
    const list = [...(rowsByCollection.get(collection) ?? [])];
    if (collection === 'lists') {
      // 父清单必须先于子清单创建；父级被跳过时 refRows 已拍平为根级。
      const bySource = new Map(list.map((state) => [state.source.id, state]));
      const depth = (state: PlanState, guard = 0): number => {
        if (guard > 32) return 0;
        const parentId = state.source.parentId;
        if (typeof parentId !== 'string' || !parentId) return 0;
        const parent = bySource.get(parentId);
        return parent ? 1 + depth(parent, guard + 1) : 0;
      };
      list.sort((a, b) => depth(a) - depth(b));
    }
    for (const state of list) emitState(state);
  }

  // 删除放在最后，保证被引用的行在子对象写完后仍存在。
  for (const collection of DELETE_ORDER) {
    const list = rowsByCollection.get(collection) ?? [];
    for (const state of list) {
      const shouldDelete =
        state.action === 'delete' ||
        (state.deleteAfter &&
          (state.action === 'create' ||
            state.action === 'update' ||
            state.action === 'managed'));
      if (!shouldDelete) continue;
      if (collection === 'settings') {
        deleteOperations.push({ type: 'setting-delete', id: state.targetId });
      } else if (collection === 'habitLogs') {
        deleteOperations.push({
          type: 'habit-log-delete',
          habitId: String(state.source.habitId ?? ''),
          logDate: String(state.source.logDate ?? ''),
        });
      } else if (
        collection === 'boards' ||
        collection === 'attachments' ||
        SIMPLE_COLLECTIONS.includes(collection)
      ) {
        deleteOperations.push({
          type: 'delete',
          collection: collection as never,
          id: state.targetId,
        });
      }
    }
  }

  // 未恢复的复盘笔记：快照跳过时笔记交由普通笔记计划处理；这里只提示。
  const reviewNoteIds = new Set(
    backup.reviewSnapshots
      .map((snapshot) => snapshot.noteId)
      .filter((id): id is string => Boolean(id)),
  );
  for (const noteId of reviewNoteIds) {
    const noteState = states.get(`notes:${noteId}`);
    if (noteState?.action === 'skip') {
      warnings.push(`复盘笔记 ${noteId} 选择跳过，复盘快照不会被创建`);
    }
  }

  const allOperations = [...operations, ...deleteOperations];
  const summary: RestoreSummary = {
    create: 0,
    update: 0,
    delete: 0,
    skip: 0,
    blocked: 0,
    unchanged: 0,
    attachmentsWithBlob: 0,
    attachmentsWithoutBlob: 0,
    restoreAppearance: restoreAppearance && Boolean(parsed.payload.appearance),
  };
  for (const list of rowsByCollection.values()) {
    for (const state of list) {
      if (state.action === 'create') summary.create += 1;
      else if (state.action === 'update') summary.update += 1;
      else if (state.action === 'delete') summary.delete += 1;
      else if (state.action === 'skip') summary.skip += 1;
      else if (state.action === 'blocked') summary.blocked += 1;
      else if (state.action === 'unchanged') summary.unchanged += 1;
      if (state.deleteAfter && state.action === 'create') summary.delete += 1;
      if (state.collection === 'attachments') {
        if (parsed.blobs.has(state.sourceId)) summary.attachmentsWithBlob += 1;
        else summary.attachmentsWithoutBlob += 1;
      }
    }
  }
  // 复盘快照会在写入时顺带创建笔记；这些笔记不在 rowsByCollection 中，
  // 但摘要应把它们计入新增/回收站，避免用户看到少一个对象。
  for (const noteId of managedNotes) {
    const state = states.get(`notes:${noteId}`);
    if (state?.action === 'managed') {
      summary.create += 1;
      if (state.source.deletedAt) summary.delete += 1;
    }
  }
  if (summary.restoreAppearance) {
    allOperations.push({
      type: 'appearance',
      value: parsed.payload.appearance!,
    });
  }

  // 让 blocked 去重并保持稳定顺序。
  const blockedKeys = new Set<string>();
  const uniqueBlocked = blocked.filter((item) => {
    if (blockedKeys.has(item.key)) return false;
    blockedKeys.add(item.key);
    return true;
  });

  return {
    operations: allOperations,
    conflicts,
    blocked: uniqueBlocked,
    warnings: Array.from(new Set(warnings)),
    decisions,
    restoreAppearance: summary.restoreAppearance,
    summary,
  };
}

function cloneBoardBundle(
  source: BoardBackup,
  newBoardId: () => string,
  newNodeId: () => string,
  newEdgeId: () => string,
): BoardBackup {
  const boardId = newBoardId();
  const nodeMap = new Map<string, string>();
  const nodes = source.nodes.map((node) => {
    const id = newNodeId();
    nodeMap.set(node.id, id);
    return {
      ...node,
      id,
      boardId,
    };
  });
  const edges = source.edges.map((edge) => ({
    ...edge,
    id: newEdgeId(),
    boardId,
    fromNodeId: nodeMap.get(edge.fromNodeId) ?? edge.fromNodeId,
    toNodeId: nodeMap.get(edge.toNodeId) ?? edge.toNodeId,
  }));
  return {
    board: { ...source.board, id: boardId },
    nodes,
    edges,
  };
}

/** 比较两个数据集的关系与对象数量，用于恢复后验收。 */
export function countRelations(dataset: BackupDataset): number {
  return collectRelations(dataset).length;
}

export async function applyRestorePlan(
  plan: RestorePlan,
  target: RestoreTarget,
  options: {
    onProgress?: (progress: RestoreProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<RestoreApplyResult> {
  let applied = 0;
  const total = plan.operations.length;
  for (const operation of plan.operations) {
    if (options.signal?.aborted) {
      return {
        applied,
        failed: 0,
        error: '恢复已取消',
        stoppedAt: operationLabel(operation),
      };
    }
    try {
      await target.apply(operation);
      applied += 1;
      options.onProgress?.({
        applied,
        total,
        label: operationLabel(operation),
      });
    } catch (error) {
      const reason =
        error instanceof Error && error.message
          ? error.message
          : typeof error === 'string'
            ? error
            : '未知错误';
      return {
        applied,
        failed: 1,
        error: reason,
        stoppedAt: operationLabel(operation),
      };
    }
  }
  return { applied, failed: 0, error: null, stoppedAt: null };
}

export function operationLabel(operation: RestoreOperation): string {
  switch (operation.type) {
    case 'create':
      return `新增${entityLabel(operation.collection, operation.row)}`;
    case 'update':
      return `更新${entityLabel(operation.collection, operation.row)}`;
    case 'delete':
      return `移入回收站：${operation.collection} ${operation.id}`;
    case 'habit-log-delete':
      return `移入回收站：打卡 ${operation.logDate}`;
    case 'board':
      return `${operation.mode === 'create' ? '新增' : '更新'}画板「${operation.row.board.title}」`;
    case 'review':
      return `新增复盘快照 ${operation.row.rangeStart} → ${operation.row.rangeEnd}`;
    case 'attachment':
      return `恢复附件「${operation.row.fileName}」`;
    case 'setting':
      return `恢复偏好 ${operation.row.key}`;
    case 'setting-delete':
      return `删除偏好 ${operation.id}`;
    case 'appearance':
      return '恢复外观偏好';
  }
}
