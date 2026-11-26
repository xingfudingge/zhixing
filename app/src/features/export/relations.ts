/**
 * 关系清单（P2-04）。
 *
 * 关系不是额外的事实来源：真正的关系仍保存在各表字段中。这里把它显式
 * 列出，用于 manifest 统计、恢复前的悬空引用检查，以及验收时确认
 * 「删除对象后关系不丢」。恢复计划不会把指向已删除对象的外键改成 null。
 */

import type { BackupDataset, BackupRelation, RelationKind } from './types';

type Index = Map<string, Set<string>>;

function add(
  relations: BackupRelation[],
  kind: RelationKind,
  fromCollection: string,
  fromId: string,
  field: string,
  toCollection: string,
  toId: string | null | undefined,
): void {
  if (!toId) return;
  relations.push({ kind, fromCollection, fromId, field, toCollection, toId });
}

export function collectRelations(dataset: BackupDataset): BackupRelation[] {
  const relations: BackupRelation[] = [];

  for (const task of dataset.tasks) {
    add(relations, 'task.list', 'tasks', task.id, 'listId', 'lists', task.listId);
    add(relations, 'task.parent', 'tasks', task.id, 'parentId', 'tasks', task.parentId);
    add(relations, 'task.note', 'tasks', task.id, 'noteId', 'notes', task.noteId);
  }
  for (const subtask of dataset.subtasks) {
    add(
      relations,
      'subtask.task',
      'subtasks',
      subtask.id,
      'taskId',
      'tasks',
      subtask.taskId,
    );
  }
  for (const block of dataset.noteBlocks) {
    add(
      relations,
      'note.block',
      'noteBlocks',
      block.id,
      'noteId',
      'notes',
      block.noteId,
    );
  }
  for (const todo of dataset.noteTodos) {
    add(
      relations,
      'note.todo',
      'noteTodos',
      todo.id,
      'noteId',
      'notes',
      todo.noteId,
    );
    add(
      relations,
      'todo.task',
      'noteTodos',
      todo.id,
      'taskId',
      'tasks',
      todo.taskId,
    );
  }
  for (const event of dataset.events) {
    add(relations, 'event.note', 'events', event.id, 'noteId', 'notes', event.noteId);
  }
  for (const session of dataset.focusSessions) {
    add(
      relations,
      'focus.task',
      'focusSessions',
      session.id,
      'taskId',
      'tasks',
      session.taskId,
    );
  }
  for (const log of dataset.habitLogs) {
    add(
      relations,
      'habit.log',
      'habitLogs',
      log.id,
      'habitId',
      'habits',
      log.habitId,
    );
  }
  for (const board of dataset.boards) {
    add(
      relations,
      'board.note',
      'boards',
      board.board.id,
      'noteId',
      'notes',
      board.board.noteId,
    );
    for (const node of board.nodes) {
      add(
        relations,
        'board.node',
        'boardNodes',
        node.id,
        'boardId',
        'boards',
        board.board.id,
      );
    }
    for (const edge of board.edges) {
      add(
        relations,
        'board.edge.from',
        'boardEdges',
        edge.id,
        'fromNodeId',
        'boardNodes',
        edge.fromNodeId,
      );
      add(
        relations,
        'board.edge.to',
        'boardEdges',
        edge.id,
        'toNodeId',
        'boardNodes',
        edge.toNodeId,
      );
    }
  }
  for (const attachment of dataset.attachments) {
    add(
      relations,
      'attachment.note',
      'attachments',
      attachment.id,
      'noteId',
      'notes',
      attachment.noteId,
    );
    add(
      relations,
      'attachment.block',
      'attachments',
      attachment.id,
      'blockId',
      'noteBlocks',
      attachment.blockId,
    );
  }
  for (const snapshot of dataset.reviewSnapshots) {
    add(
      relations,
      'review.note',
      'reviewSnapshots',
      snapshot.id,
      'noteId',
      'notes',
      snapshot.noteId,
    );
    for (const taskId of snapshot.taskIds) {
      add(
        relations,
        'review.task',
        'reviewSnapshots',
        snapshot.id,
        'taskIds',
        'tasks',
        taskId,
      );
    }
    for (const focusId of snapshot.focusIds) {
      add(
        relations,
        'review.focus',
        'reviewSnapshots',
        snapshot.id,
        'focusIds',
        'focusSessions',
        focusId,
      );
    }
    for (const habitId of snapshot.habitIds) {
      add(
        relations,
        'review.habit',
        'reviewSnapshots',
        snapshot.id,
        'habitIds',
        'habits',
        habitId,
      );
    }
  }

  return relations.sort(compareRelations);
}

function compareRelations(a: BackupRelation, b: BackupRelation): number {
  return (
    a.fromCollection.localeCompare(b.fromCollection) ||
    a.fromId.localeCompare(b.fromId) ||
    a.field.localeCompare(b.field) ||
    a.toCollection.localeCompare(b.toCollection) ||
    a.toId.localeCompare(b.toId) ||
    a.kind.localeCompare(b.kind)
  );
}

export function datasetIndexes(dataset: BackupDataset): Map<string, Index> {
  const indexes = new Map<string, Index>();
  const ensure = (collection: string): Index => {
    const existing = indexes.get(collection);
    if (existing) return existing;
    const created: Index = new Map();
    indexes.set(collection, created);
    return created;
  };
  const register = (collection: string, id: string) => {
    const index = ensure(collection);
    const values = index.get(id);
    if (values) {
      values.add(id);
    } else {
      index.set(id, new Set([id]));
    }
  };

  for (const list of dataset.lists) register('lists', list.id);
  for (const task of dataset.tasks) register('tasks', task.id);
  for (const subtask of dataset.subtasks) register('subtasks', subtask.id);
  for (const note of dataset.notes) register('notes', note.id);
  for (const block of dataset.noteBlocks) register('noteBlocks', block.id);
  for (const todo of dataset.noteTodos) register('noteTodos', todo.id);
  for (const event of dataset.events) register('events', event.id);
  for (const countdown of dataset.countdowns) register('countdowns', countdown.id);
  for (const habit of dataset.habits) register('habits', habit.id);
  for (const log of dataset.habitLogs) register('habitLogs', log.id);
  for (const session of dataset.focusSessions) register('focusSessions', session.id);
  for (const snapshot of dataset.reviewSnapshots) {
    register('reviewSnapshots', snapshot.id);
  }
  for (const board of dataset.boards) {
    register('boards', board.board.id);
    for (const node of board.nodes) register('boardNodes', node.id);
    for (const edge of board.edges) register('boardEdges', edge.id);
  }
  for (const attachment of dataset.attachments) {
    register('attachments', attachment.id);
  }
  for (const setting of dataset.settings) register('settings', setting.id);
  return indexes;
}

export function hasEntity(
  indexes: Map<string, Index>,
  collection: string,
  id: string,
): boolean {
  return indexes.get(collection)?.has(id) ?? false;
}

export function findDanglingRelations(
  relations: ReadonlyArray<BackupRelation>,
  dataset: BackupDataset,
): BackupRelation[] {
  const indexes = datasetIndexes(dataset);
  return relations.filter(
    (relation) => !hasEntity(indexes, relation.toCollection, relation.toId),
  );
}

export function relationKindCounts(
  relations: ReadonlyArray<BackupRelation>,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const relation of relations) {
    counts[relation.kind] = (counts[relation.kind] ?? 0) + 1;
  }
  return counts;
}

export function canonicalRelations(
  relations: ReadonlyArray<BackupRelation>,
): BackupRelation[] {
  return [...relations].sort(compareRelations);
}

export function relationsEqual(
  a: ReadonlyArray<BackupRelation>,
  b: ReadonlyArray<BackupRelation>,
): boolean {
  if (a.length !== b.length) return false;
  const left = canonicalRelations(a);
  const right = canonicalRelations(b);
  return left.every(
    (relation, index) =>
      relation.kind === right[index]!.kind &&
      relation.fromCollection === right[index]!.fromCollection &&
      relation.fromId === right[index]!.fromId &&
      relation.field === right[index]!.field &&
      relation.toCollection === right[index]!.toCollection &&
      relation.toId === right[index]!.toId,
  );
}
