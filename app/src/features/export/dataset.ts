/** 备份数据集的空值、计数与浅拷贝工具。 */

import type { BackupDataset, BackupManifest } from './types';

export const APP_VERSION = '0.1.0';
export const BACKUP_GENERATOR = `zhixing-desktop/${APP_VERSION}`;

export function emptyBackupDataset(): BackupDataset {
  return {
    lists: [],
    tasks: [],
    subtasks: [],
    notes: [],
    noteBlocks: [],
    noteTodos: [],
    events: [],
    countdowns: [],
    habits: [],
    habitLogs: [],
    focusSessions: [],
    reviewSnapshots: [],
    boards: [],
    attachments: [],
    settings: [],
  };
}

export function datasetCounts(dataset: BackupDataset): BackupManifest['counts'] {
  return {
    lists: dataset.lists.length,
    tasks: dataset.tasks.length,
    subtasks: dataset.subtasks.length,
    notes: dataset.notes.length,
    noteBlocks: dataset.noteBlocks.length,
    noteTodos: dataset.noteTodos.length,
    events: dataset.events.length,
    countdowns: dataset.countdowns.length,
    habits: dataset.habits.length,
    habitLogs: dataset.habitLogs.length,
    focusSessions: dataset.focusSessions.length,
    reviewSnapshots: dataset.reviewSnapshots.length,
    boards: dataset.boards.length,
    boardNodes: dataset.boards.reduce((sum, item) => sum + item.nodes.length, 0),
    boardEdges: dataset.boards.reduce((sum, item) => sum + item.edges.length, 0),
    attachments: dataset.attachments.length,
    settings: dataset.settings.length,
  };
}

export function totalObjects(dataset: BackupDataset): number {
  const counts = datasetCounts(dataset);
  return (
    counts.lists +
    counts.tasks +
    counts.subtasks +
    counts.notes +
    counts.noteBlocks +
    counts.noteTodos +
    counts.events +
    counts.countdowns +
    counts.habits +
    counts.habitLogs +
    counts.focusSessions +
    counts.reviewSnapshots +
    counts.boards +
    counts.boardNodes +
    counts.boardEdges +
    counts.attachments +
    counts.settings
  );
}

export function cloneDatasetShallow(dataset: BackupDataset): BackupDataset {
  return {
    lists: [...dataset.lists],
    tasks: [...dataset.tasks],
    subtasks: [...dataset.subtasks],
    notes: [...dataset.notes],
    noteBlocks: [...dataset.noteBlocks],
    noteTodos: [...dataset.noteTodos],
    events: [...dataset.events],
    countdowns: [...dataset.countdowns],
    habits: [...dataset.habits],
    habitLogs: [...dataset.habitLogs],
    focusSessions: [...dataset.focusSessions],
    reviewSnapshots: [...dataset.reviewSnapshots],
    boards: dataset.boards.map((board) => ({
      board: { ...board.board },
      nodes: board.nodes.map((node) => ({ ...node })),
      edges: board.edges.map((edge) => ({ ...edge })),
    })),
    attachments: [...dataset.attachments],
    settings: [...dataset.settings],
  };
}
