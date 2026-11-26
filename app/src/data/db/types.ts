/**
 * SQLite 领域模型的 TypeScript 映射（与 Rust `repositories` 的 serde camelCase 字段一致）。
 * 渲染层只使用这些类型，不直接拼 SQL、不把 localStorage 当权威库。
 */

export const DEFAULT_SPACE_ID = 'personal';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type TaskStatus = 'todo' | 'doing' | 'done';
export type NoteStatus = 'active' | 'trashed';
export type BodyFormat = 'html' | 'blocks';
export type CalendarType = 'solar' | 'lunar';
export type SettingScope = 'device' | 'space';

export type DbStatus = {
  path: string;
  ready: boolean;
  schemaVersion: number;
  journalMode: string;
  foreignKeys: boolean;
  applied: string[];
  error: string | null;
};

// ---------------------------------------------------------------------------
// 清单
// ---------------------------------------------------------------------------

export type List = {
  id: string;
  spaceId: string;
  name: string;
  color: string;
  icon: string;
  /** 根级为 null；收件箱必须为 null。 */
  parentId: string | null;
  sortOrder: number;
  isInbox: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type NewList = {
  id?: string;
  spaceId?: string;
  name: string;
  color?: string;
  icon?: string;
  parentId?: string | null;
  sortOrder?: number;
  isInbox?: boolean;
};

export type ListUpdate = {
  name: string;
  color: string;
  icon?: string | null;
  sortOrder: number;
};

/** 独立移动命令的入参；parentId=null 明确表示移到根级。 */
export type ListMove = {
  parentId: string | null;
  sortOrder: number;
};

export type ListDeleteResult = {
  movedTasks: number;
  /** 被删除清单的直接子清单数量（删除后上移一级）。 */
  promotedLists: number;
  inboxId: string;
};

// ---------------------------------------------------------------------------
// 任务与子任务
// ---------------------------------------------------------------------------

export type Task = {
  id: string;
  spaceId: string;
  listId: string;
  parentId: string | null;
  noteId: string | null;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: number;
  quadrant: number;
  dueDate: string | null;
  dueTime: string | null;
  dueAt: string | null;
  tz: string;
  reminder: string;
  sortOrder: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type NewTask = {
  id?: string;
  spaceId?: string;
  listId: string;
  parentId?: string | null;
  noteId?: string | null;
  title: string;
  notes?: string;
  status?: TaskStatus;
  priority?: number;
  quadrant?: number;
  dueDate?: string | null;
  dueTime?: string | null;
  dueAt?: string | null;
  tz?: string;
  reminder?: string;
  sortOrder?: number;
};

export type TaskUpdate = {
  listId: string;
  parentId: string | null;
  noteId: string | null;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: number;
  quadrant: number;
  dueDate: string | null;
  dueTime: string | null;
  dueAt: string | null;
  tz?: string;
  reminder?: string;
  sortOrder?: number;
};

export type TaskQuery = {
  listId?: string | null;
  status?: TaskStatus | null;
  dueDate?: string | null;
  dueBefore?: string | null;
  inbox?: boolean | null;
  includeDeleted?: boolean | null;
};

export type Subtask = {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type NewSubtask = {
  id?: string;
  taskId: string;
  title: string;
  done?: boolean;
  sortOrder?: number;
};

export type SubtaskUpdate = {
  title: string;
  done: boolean;
  sortOrder: number;
};

// ---------------------------------------------------------------------------
// 笔记、块投影、笔记待办
// ---------------------------------------------------------------------------

export type Note = {
  id: string;
  spaceId: string;
  title: string;
  folderId: string | null;
  tags: string[];
  body: string;
  bodyFormat: BodyFormat;
  status: NoteStatus;
  favorite: boolean;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
  /** 内容是否已加密；锁定时 title/body/tags 为空。 */
  encrypted?: boolean;
  locked?: boolean;
  /** 仅完整备份原始导出使用；普通读取不返回密文。 */
  encryptedTagsJson?: string | null;
};

export type NewNote = {
  id?: string;
  spaceId?: string;
  title: string;
  folderId?: string | null;
  tags?: string[];
  body?: string;
  bodyFormat?: BodyFormat;
  status?: NoteStatus;
  favorite?: boolean;
  pinned?: boolean;
  /** 备份恢复：字段已是密文时原样落库（需本机已有密钥信封）。 */
  encrypted?: boolean;
  encryptedTagsJson?: string | null;
};

export type NoteUpdate = {
  title: string;
  folderId: string | null;
  tags: string[];
  body: string;
  bodyFormat: BodyFormat;
  favorite: boolean;
  pinned: boolean;
  encrypted?: boolean;
  encryptedTagsJson?: string | null;
};

export type NoteQuery = {
  folderId?: string | null;
  status?: NoteStatus | null;
  favorite?: boolean | null;
  search?: string | null;
  includeDeleted?: boolean | null;
};

export type NoteBlock = {
  id: string;
  noteId: string;
  blockType: string;
  orderKey: number;
  payload: JsonValue;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
  encrypted?: boolean;
  locked?: boolean;
  encryptedPayloadJson?: string | null;
};

export type NewNoteBlock = {
  id?: string;
  noteId: string;
  blockType: string;
  orderKey?: number;
  payload?: JsonValue;
  schemaVersion?: number;
  encrypted?: boolean;
  encryptedPayloadJson?: string | null;
};

export type NoteBlockUpdate = {
  blockType: string;
  orderKey: number;
  payload: JsonValue;
  schemaVersion?: number;
  encrypted?: boolean;
  encryptedPayloadJson?: string | null;
};

export type NoteTodo = {
  id: string;
  spaceId: string;
  noteId: string;
  taskId: string | null;
  title: string;
  done: boolean;
  dueDate: string | null;
  reminderEnabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
  encrypted?: boolean;
  locked?: boolean;
};

export type NewNoteTodo = {
  id?: string;
  spaceId?: string;
  noteId: string;
  taskId?: string | null;
  title: string;
  done?: boolean;
  dueDate?: string | null;
  reminderEnabled?: boolean;
  sortOrder?: number;
  encrypted?: boolean;
};

export type NoteTodoUpdate = {
  taskId: string | null;
  title: string;
  done: boolean;
  dueDate: string | null;
  reminderEnabled: boolean;
  sortOrder: number;
};

// ---------------------------------------------------------------------------
// 笔记文件导入（ZX-IO-04）
// ---------------------------------------------------------------------------

/**
 * 一次导入的原子输入：笔记、正文块、笔记待办在同一个 SQLite 事务内写入。
 * 任何一块失败都整体回滚，避免出现“有笔记没有正文”或“有待办没有正文块”
 * 的半成品。
 */
export type ImportNoteBlock = {
  id: string;
  blockType: string;
  orderKey: number;
  payload: JsonValue;
  schemaVersion?: number;
};

export type ImportNoteTodo = {
  id: string;
  title: string;
  done: boolean;
  sortOrder: number;
};

export type ImportNoteInput = {
  note: NewNote;
  blocks: ImportNoteBlock[];
  todos: ImportNoteTodo[];
};

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

export type Event = {
  id: string;
  spaceId: string;
  title: string;
  eventType: string;
  allDay: boolean;
  startDate: string;
  startAt: string | null;
  endAt: string | null;
  tz: string;
  source: string;
  externalUid: string | null;
  repeatRule: string;
  /** 公历/农历标记；只做标记，不把农历事件换算成下一次公历日期。 */
  calendarType: CalendarType;
  noteId: string | null;
  color: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type NewEvent = {
  id?: string;
  spaceId?: string;
  title: string;
  eventType?: string;
  allDay?: boolean;
  startDate: string;
  startAt?: string | null;
  endAt?: string | null;
  tz?: string;
  source?: string;
  externalUid?: string | null;
  repeatRule?: string;
  calendarType?: CalendarType;
  noteId?: string | null;
  color?: string;
};

export type EventUpdate = {
  title: string;
  eventType: string;
  allDay: boolean;
  startDate: string;
  startAt: string | null;
  endAt: string | null;
  tz?: string;
  source?: string;
  externalUid?: string | null;
  repeatRule?: string;
  calendarType: CalendarType;
  noteId?: string | null;
  color?: string;
};

export type EventQuery = {
  from?: string | null;
  to?: string | null;
  noteId?: string | null;
  includeDeleted?: boolean | null;
};

export type Countdown = {
  id: string;
  spaceId: string;
  title: string;
  category: string;
  calendarType: CalendarType;
  targetDate: string;
  repeatRule: string;
  lunarMonth: string | null;
  lunarDay: number | null;
  note: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type NewCountdown = {
  id?: string;
  spaceId?: string;
  title: string;
  category?: string;
  calendarType?: CalendarType;
  targetDate: string;
  repeatRule?: string;
  lunarMonth?: string | null;
  lunarDay?: number | null;
  note?: string;
  color?: string;
};

export type CountdownUpdate = {
  title: string;
  category: string;
  calendarType: CalendarType;
  targetDate: string;
  repeatRule: string;
  lunarMonth: string | null;
  lunarDay: number | null;
  note: string;
  color?: string;
};

export type CountdownQuery = {
  category?: string | null;
  includeDeleted?: boolean | null;
};

// ---------------------------------------------------------------------------
// 习惯与打卡
// ---------------------------------------------------------------------------

export type Habit = {
  id: string;
  spaceId: string;
  title: string;
  schedule: string;
  icon: string;
  color: string;
  goalPerWeek: number;
  sortOrder: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type NewHabit = {
  id?: string;
  spaceId?: string;
  title: string;
  schedule?: string;
  icon?: string;
  color?: string;
  goalPerWeek?: number;
  sortOrder?: number;
  archived?: boolean;
};

export type HabitUpdate = {
  title: string;
  schedule: string;
  icon?: string | null;
  color?: string | null;
  goalPerWeek: number;
  sortOrder: number;
  archived: boolean;
};

export type HabitQuery = {
  includeArchived?: boolean | null;
  includeDeleted?: boolean | null;
};

export type HabitLog = {
  id: string;
  spaceId: string;
  habitId: string;
  logDate: string;
  done: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type HabitLogQuery = {
  from?: string | null;
  to?: string | null;
  includeDeleted?: boolean | null;
};

// ---------------------------------------------------------------------------
// 专注
// ---------------------------------------------------------------------------

export type FocusSession = {
  id: string;
  spaceId: string;
  taskId: string;
  minutes: number;
  startedAt: string;
  endedAt: string | null;
  mode: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type NewFocusSession = {
  id?: string;
  spaceId?: string;
  taskId: string;
  minutes: number;
  startedAt: string;
  endedAt?: string | null;
  mode?: string;
  note?: string;
};

export type FocusSessionUpdate = {
  taskId: string;
  minutes: number;
  startedAt: string;
  endedAt: string | null;
  mode: string;
  note: string;
};

export type FocusSessionQuery = {
  from?: string | null;
  to?: string | null;
  taskId?: string | null;
  includeDeleted?: boolean | null;
};

// ---------------------------------------------------------------------------
// 复盘快照
// ---------------------------------------------------------------------------

export type ReviewSnapshot = {
  id: string;
  spaceId: string;
  rangeStart: string;
  rangeEnd: string;
  taskIds: string[];
  focusIds: string[];
  habitIds: string[];
  noteId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type ReviewSnapshotQuery = {
  from?: string | null;
  to?: string | null;
  noteId?: string | null;
  includeDeleted?: boolean | null;
};

/**
 * 保存复盘：一次事务内创建「复盘笔记 + 快照」。
 * 同范围重复保存时后端返回已有快照与笔记，`created` 为 false。
 */
export type SaveReviewInput = {
  id?: string;
  spaceId?: string;
  rangeStart: string;
  rangeEnd: string;
  taskIds: string[];
  focusIds: string[];
  habitIds: string[];
  note: NewNote;
};

export type SavedReview = {
  snapshot: ReviewSnapshot;
  note: Note;
  created: boolean;
};

// ---------------------------------------------------------------------------
// 画板
// ---------------------------------------------------------------------------

export type Board = {
  id: string;
  spaceId: string;
  noteId: string | null;
  title: string;
  background: string;
  snapshot: JsonValue;
  thumbnailKey: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type NewBoard = {
  id?: string;
  spaceId?: string;
  noteId?: string | null;
  title: string;
  background?: string;
  snapshot?: JsonValue;
  thumbnailKey?: string | null;
};

export type BoardUpdate = {
  noteId: string | null;
  title: string;
  background: string;
  snapshot: JsonValue;
  thumbnailKey: string | null;
};

export type BoardQuery = {
  noteId?: string | null;
  includeDeleted?: boolean | null;
};

export type BoardNode = {
  id: string;
  boardId: string;
  nodeType: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  text: string;
  payload: JsonValue;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type NewBoardNode = {
  id?: string;
  boardId: string;
  nodeType?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  zIndex?: number;
  text?: string;
  payload?: JsonValue;
};

export type BoardNodeUpdate = {
  nodeType: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  text: string;
  payload: JsonValue;
};

export type BoardEdge = {
  id: string;
  boardId: string;
  fromNodeId: string;
  toNodeId: string;
  label: string;
  style: JsonValue;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type NewBoardEdge = {
  id?: string;
  boardId: string;
  fromNodeId: string;
  toNodeId: string;
  label?: string;
  style?: JsonValue;
};

export type BoardEdgeUpdate = {
  fromNodeId: string;
  toNodeId: string;
  label: string;
  style: JsonValue;
};

// ---------------------------------------------------------------------------
// 附件与设置
// ---------------------------------------------------------------------------

export type Attachment = {
  id: string;
  spaceId: string;
  noteId: string | null;
  blockId: string | null;
  fileName: string;
  sha256: string;
  byteSize: number;
  mime: string;
  storageKey: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type NewAttachment = {
  id?: string;
  spaceId?: string;
  noteId?: string | null;
  blockId?: string | null;
  fileName: string;
  sha256: string;
  byteSize: number;
  mime?: string;
  storageKey: string;
};

export type AttachmentUpdate = {
  noteId: string | null;
  blockId: string | null;
  fileName: string;
  mime: string;
  storageKey: string;
};

export type AttachmentQuery = {
  noteId?: string | null;
  includeDeleted?: boolean | null;
};

export type Setting = {
  id: string;
  spaceId: string;
  scope: SettingScope;
  key: string;
  value: JsonValue;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
};

export type NewSetting = {
  id?: string;
  spaceId?: string;
  scope?: SettingScope;
  key: string;
  value: JsonValue;
};

export type SettingQuery = {
  scope?: SettingScope | null;
  includeDeleted?: boolean | null;
};

// ---------------------------------------------------------------------------
// 笔记内容加密
// ---------------------------------------------------------------------------

export type NoteEncryptionStorage = 'keychain' | 'file' | 'none';

export type NoteEncryptionStatus = {
  supported: boolean;
  configured: boolean;
  enabled: boolean;
  locked: boolean;
  keyMissing: boolean;
  storage: NoteEncryptionStorage;
  algorithm: string;
  keyId: string | null;
  encryptedNotes: number;
  totalNotes: number;
  plaintextNotes: number;
  noteAttachments: number;
  pendingEncryption: boolean;
  error: string | null;
};

export type NoteEncryptionTransformReport = {
  notes: number;
  blocks: number;
  todos: number;
};

/** Rust `NoteEncryptionReport` 使用 `#[serde(flatten)]`，状态字段在顶层。 */
export type NoteEncryptionReport = NoteEncryptionStatus & {
  transformed: NoteEncryptionTransformReport;
  warning: string | null;
};
