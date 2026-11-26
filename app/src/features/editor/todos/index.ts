/**
 * P1-03 笔记待办公共入口。
 *
 * 知识工作区用 `<NoteTodosWorkspace noteId={note.id} />` 组装；测试可注入
 * 块仓储、笔记待办仓储和任务/清单源。
 */

export { NoteTodosWorkspace } from './NoteTodosWorkspace';
export type {
  NoteTodosEditorProps,
  NoteTodosTaskSource,
  NoteTodosWorkspaceProps,
} from './NoteTodosWorkspace';
export { TodoSummary } from './TodoSummary';
export type { TodoSummaryProps } from './TodoSummary';
export { TodoLinkDialog } from './TodoLinkDialog';
export type { TodoLinkDialogProps } from './TodoLinkDialog';
export {
  createNoteTodoBlockSource,
} from './todoBlockSource';
export type {
  DeletedTodoSnapshot,
  NoteTodoBlockSource,
  NoteTodoBlockSourceOptions,
  RestoredTodo,
} from './todoBlockSource';
export {
  createNoteTodoRepository,
  normalizeNoteTodoTitle,
  noteTodoSnapshot,
  noteTodoSummary,
  sortNoteTodos,
  toNoteTodoUpdate,
  NOTE_TODO_FALLBACK_TITLE,
} from '../../../data/repositories/noteTodos';
export type {
  NoteTodoPatch,
  NoteTodoRepository,
  NoteTodoSnapshot,
} from '../../../data/repositories/noteTodos';
export {
  buildTaskInputForTodo,
  createTodoTaskLinkService,
  describeTodoTask,
  linkedTaskIsDeleted,
  taskStatusLabel,
} from '../../tasks/linkTodo';
export type {
  TodoTaskChoice,
  TodoTaskLinkService,
  TodoTaskSource,
  TodoTaskState,
} from '../../tasks/linkTodo';
