/**
 * 完整备份的公共类型（P2-04）。
 *
 * 备份以 SQLite 领域表为权威：每一行保留 id、时间戳、软删除标记与版本；
 * 画板按「画板 + 节点 + 连线」组成一个事务单位。导入预览与恢复计划都使用
 * 这里的数据结构，UI 不直接接触文件格式。
 */

import type { Appearance } from '../../app/shell/appearance';
import type {
  Attachment,
  Board,
  BoardEdge,
  BoardNode,
  Countdown,
  Event,
  FocusSession,
  Habit,
  HabitLog,
  List,
  Note,
  NoteBlock,
  NoteTodo,
  ReviewSnapshot,
  Setting,
  Subtask,
  Task,
} from '../../data/db/types';

export const BACKUP_APP = 'zhixing';
export const BACKUP_KIND = 'backup';
export const BACKUP_FORMAT_VERSION = 1;

export type BackupAppearance = Pick<Appearance, 'theme' | 'accent' | 'density'>;

export type BoardBackup = {
  board: Board;
  nodes: BoardNode[];
  edges: BoardEdge[];
};

/** 权威备份数据；画板以 BoardBackup 聚合，其余表保持原始行。 */
export type BackupDataset = {
  lists: List[];
  tasks: Task[];
  subtasks: Subtask[];
  notes: Note[];
  noteBlocks: NoteBlock[];
  noteTodos: NoteTodo[];
  events: Event[];
  countdowns: Countdown[];
  habits: Habit[];
  habitLogs: HabitLog[];
  focusSessions: FocusSession[];
  reviewSnapshots: ReviewSnapshot[];
  boards: BoardBackup[];
  attachments: Attachment[];
  settings: Setting[];
};

export type BackupDatasetKey = keyof BackupDataset;

export const BACKUP_DATASET_KEYS: ReadonlyArray<BackupDatasetKey> = [
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
  'reviewSnapshots',
  'boards',
  'attachments',
  'settings',
];

export type BackupIssue = {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  collection?: string;
  id?: string;
};

export type RelationKind =
  | 'list.tasks'
  | 'task.list'
  | 'task.parent'
  | 'task.note'
  | 'subtask.task'
  | 'note.block'
  | 'note.todo'
  | 'todo.task'
  | 'event.note'
  | 'focus.task'
  | 'habit.log'
  | 'board.note'
  | 'board.node'
  | 'board.edge.from'
  | 'board.edge.to'
  | 'attachment.note'
  | 'attachment.block'
  | 'review.note'
  | 'review.task'
  | 'review.focus'
  | 'review.habit';

export type BackupRelation = {
  kind: RelationKind;
  fromCollection: string;
  fromId: string;
  field: string;
  toCollection: string;
  toId: string;
};

export type BackupAttachmentEntry = {
  id: string;
  fileName: string;
  mime: string;
  sha256: string;
  byteSize: number;
  /** ZIP 内路径；JSON 导出为 null（不含二进制）。 */
  path: string | null;
  deletedAt: string | null;
};

export type BackupBoardEntry = {
  id: string;
  title: string;
  noteId: string | null;
  path: string;
  sha256: string;
  nodeCount: number;
  edgeCount: number;
};

export type BackupManifestEntry = {
  path: string;
  byteSize: number;
  sha256: string;
};

export type BackupRelationSummary = {
  total: number;
  byKind: Record<string, number>;
  dangling: BackupRelation[];
};

export type BackupManifest = {
  app: typeof BACKUP_APP;
  kind: typeof BACKUP_KIND;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  exportedAt: string;
  appVersion: string;
  schemaVersion: number;
  generator: string;
  counts: {
    lists: number;
    tasks: number;
    subtasks: number;
    notes: number;
    noteBlocks: number;
    noteTodos: number;
    events: number;
    countdowns: number;
    habits: number;
    habitLogs: number;
    focusSessions: number;
    reviewSnapshots: number;
    boards: number;
    boardNodes: number;
    boardEdges: number;
    attachments: number;
    settings: number;
  };
  entries: BackupManifestEntry[];
  boards: BackupBoardEntry[];
  attachments: BackupAttachmentEntry[];
  relations: BackupRelationSummary;
  settings: {
    exportedKeys: string[];
    excludedKeys: string[];
  };
  security: {
    secretsExcluded: true;
    excludedScopes: string[];
    /** 完整备份中加密笔记的数量；密文可恢复，但备份不含明文密钥。 */
    encryptedNotes?: number;
    noteEncryptionKeyIncluded?: false;
  };
  notes: string[];
};

export type BackupPayload = {
  app: typeof BACKUP_APP;
  kind: typeof BACKUP_KIND;
  formatVersion: typeof BACKUP_FORMAT_VERSION;
  exportedAt: string;
  appVersion: string;
  schemaVersion: number;
  appearance: BackupAppearance | null;
  dataset: BackupDataset;
  excludedSettings: string[];
};

export type BackupSourceResult = {
  payload: BackupPayload;
  /** 附件 id → 二进制；ZIP 导出必须包含，JSON 导出只写清单。 */
  blobs: Map<string, Blob>;
  missingAttachmentIds: string[];
  warnings: string[];
};

export type BackupCollectOptions = {
  /** JSON/Markdown/CSV/PDF 不需要把附件二进制读进内存。 */
  includeBlobs?: boolean;
};

export interface BackupSource {
  collect(options?: BackupCollectOptions): Promise<BackupSourceResult>;
}

export type ParsedBackup = {
  format: 'zip' | 'json';
  payload: BackupPayload;
  manifest: BackupManifest;
  blobs: Map<string, Blob>;
  issues: BackupIssue[];
  warnings: BackupIssue[];
  relations: BackupRelation[];
  danglingRelations: BackupRelation[];
};

export type FileDownloader = (file: {
  fileName: string;
  blob: Blob;
}) => boolean | Promise<boolean>;

export type RestoreCollection =
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
  | 'focusSessions';

export type RestoreEntityMap = {
  lists: List;
  tasks: Task;
  subtasks: Subtask;
  notes: Note;
  noteBlocks: NoteBlock;
  noteTodos: NoteTodo;
  events: Event;
  countdowns: Countdown;
  habits: Habit;
  habitLogs: HabitLog;
  focusSessions: FocusSession;
};

export type RestoreOperation =
  | {
      [K in RestoreCollection]:
        | { type: 'create'; collection: K; row: RestoreEntityMap[K] }
        | { type: 'update'; collection: K; row: RestoreEntityMap[K] };
    }[RestoreCollection]
  | { type: 'delete'; collection: RestoreCollection; id: string }
  | { type: 'habit-log-delete'; habitId: string; logDate: string }
  | { type: 'board'; mode: 'create' | 'update'; row: BoardBackup }
  | { type: 'review'; row: ReviewSnapshot; note: Note }
  | { type: 'attachment'; row: Attachment; blob: Blob | null }
  | { type: 'setting'; row: Setting }
  | { type: 'setting-delete'; id: string }
  | { type: 'appearance'; value: BackupAppearance };

export type RestoreChoice = 'skip' | 'overwrite' | 'keep-both';

export type RestoreDecision = Record<string, RestoreChoice>;

export type PlannedConflict = {
  key: string;
  collection: string;
  id: string;
  label: string;
  localLabel: string;
  backupLabel: string;
  localDetail: string;
  backupDetail: string;
  localDeleted: boolean;
  backupDeleted: boolean;
  choices: RestoreChoice[];
  defaultChoice: RestoreChoice;
  reason?: string;
};

export type BlockedRow = {
  key: string;
  collection: string;
  id: string;
  label: string;
  reason: string;
};

export type RestoreSummary = {
  create: number;
  update: number;
  delete: number;
  skip: number;
  blocked: number;
  unchanged: number;
  attachmentsWithBlob: number;
  attachmentsWithoutBlob: number;
  restoreAppearance: boolean;
};

export type RestorePlan = {
  operations: RestoreOperation[];
  conflicts: PlannedConflict[];
  blocked: BlockedRow[];
  warnings: string[];
  decisions: RestoreDecision;
  restoreAppearance: boolean;
  summary: RestoreSummary;
};

export interface RestoreTarget {
  apply(operation: RestoreOperation): Promise<void>;
}

export type RestoreApplyResult = {
  applied: number;
  failed: number;
  error: string | null;
  stoppedAt: string | null;
};

export type RestoreProgress = {
  applied: number;
  total: number;
  label: string;
};
