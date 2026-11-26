/** 导出/恢复界面使用的中文标签；不在 UI 里直接展示数据库集合名。 */

import type {
  Attachment,
  Board,
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
import type { BoardBackup } from './types';
import { truncate } from './utils';

export const COLLECTION_LABELS: Readonly<Record<string, string>> = {
  lists: '清单',
  tasks: '任务',
  subtasks: '子任务',
  notes: '笔记',
  noteBlocks: '笔记块',
  noteTodos: '笔记待办',
  events: '日历事件',
  countdowns: '倒数日',
  habits: '习惯',
  habitLogs: '打卡记录',
  focusSessions: '专注记录',
  reviewSnapshots: '复盘快照',
  boards: '画板',
  attachments: '附件',
  settings: '设备偏好',
};

export function collectionLabel(collection: string): string {
  return COLLECTION_LABELS[collection] ?? collection;
}

function deletedSuffix(deletedAt: string | null): string {
  return deletedAt ? ' · 已在回收站' : '';
}

export function entityLabel(collection: string, row: unknown): string {
  const value = row as Record<string, unknown>;
  switch (collection) {
    case 'lists':
      return `${String(value.name ?? '未命名清单')}${deletedSuffix(
        (value.deletedAt as string | null) ?? null,
      )}`;
    case 'tasks':
      return `${String(value.title ?? '未命名任务')}${deletedSuffix(
        (value.deletedAt as string | null) ?? null,
      )}`;
    case 'subtasks':
      return `子任务：${String(value.title ?? '')}${deletedSuffix(
        (value.deletedAt as string | null) ?? null,
      )}`;
    case 'notes':
      return `${String(value.title ?? '未命名笔记')}${deletedSuffix(
        (value.deletedAt as string | null) ?? null,
      )}`;
    case 'noteBlocks': {
      const payload = value.payload as Record<string, unknown> | undefined;
      const text =
        typeof payload?.text === 'string'
          ? payload.text
          : typeof payload?.html === 'string'
            ? payload.html.replace(/<[^>]+>/g, ' ')
            : '';
      return `${String(value.blockType ?? '块')}：${truncate(text, 42)}${deletedSuffix(
        (value.deletedAt as string | null) ?? null,
      )}`;
    }
    case 'noteTodos':
      return `${String(value.title ?? '待办')}${deletedSuffix(
        (value.deletedAt as string | null) ?? null,
      )}`;
    case 'events':
      return `${String(value.title ?? '事件')} · ${String(value.startDate ?? '')}${deletedSuffix(
        (value.deletedAt as string | null) ?? null,
      )}`;
    case 'countdowns':
      return `${String(value.title ?? '倒数日')} · ${String(value.targetDate ?? '')}${deletedSuffix(
        (value.deletedAt as string | null) ?? null,
      )}`;
    case 'habits':
      return `${String(value.title ?? '习惯')}${deletedSuffix(
        (value.deletedAt as string | null) ?? null,
      )}`;
    case 'habitLogs':
      return `打卡 ${String(value.logDate ?? '')}${deletedSuffix(
        (value.deletedAt as string | null) ?? null,
      )}`;
    case 'focusSessions':
      return `专注 ${String(value.minutes ?? 0)} 分钟 · ${String(
        value.startedAt ?? '',
      )}${deletedSuffix((value.deletedAt as string | null) ?? null)}`;
    case 'reviewSnapshots':
      return `复盘 ${String(value.rangeStart ?? '')} → ${String(
        value.rangeEnd ?? '',
      )}${deletedSuffix((value.deletedAt as string | null) ?? null)}`;
    case 'boards': {
      const board = value.board as Board | undefined;
      if (board) {
        return `${board.title}${deletedSuffix(board.deletedAt)}`;
      }
      return String(value.title ?? '画板');
    }
    case 'attachments':
      return `${String(value.fileName ?? '附件')}${deletedSuffix(
        (value.deletedAt as string | null) ?? null,
      )}`;
    case 'settings':
      return `偏好 ${String(value.key ?? '')}`;
    default:
      return collection;
  }
}

export function rowSummary(collection: string, row: unknown): string {
  switch (collection) {
    case 'lists': {
      const item = row as List;
      return `${item.name} · ${item.isInbox ? '未安排' : '普通清单'}`;
    }
    case 'tasks': {
      const item = row as Task;
      return `${item.title} · ${item.status === 'done' ? '已完成' : item.status === 'doing' ? '进行中' : '待办'}`;
    }
    case 'subtasks':
      return (row as Subtask).title;
    case 'notes': {
      const item = row as Note;
      return `${item.title} · ${item.body.length} 字符`;
    }
    case 'noteBlocks':
      return (row as NoteBlock).blockType;
    case 'noteTodos':
      return (row as NoteTodo).title;
    case 'events':
      return `${(row as Event).title} · ${(row as Event).startDate}`;
    case 'countdowns':
      return `${(row as Countdown).title} · ${(row as Countdown).targetDate}`;
    case 'habits':
      return (row as Habit).title;
    case 'habitLogs':
      return (row as HabitLog).logDate;
    case 'focusSessions':
      return `${(row as FocusSession).minutes} 分钟`;
    case 'reviewSnapshots': {
      const item = row as ReviewSnapshot;
      return `${item.rangeStart} → ${item.rangeEnd}`;
    }
    case 'boards': {
      const item = row as BoardBackup;
      return `${item.board.title} · ${item.nodes.length} 对象 / ${item.edges.length} 连线`;
    }
    case 'attachments':
      return `${(row as Attachment).fileName} · ${(row as Attachment).sha256.slice(0, 12)}…`;
    case 'settings':
      return `${(row as Setting).key}`;
    default:
      return '';
  }
}
