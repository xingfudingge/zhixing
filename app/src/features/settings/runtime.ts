/**
 * 设置运行时桥（P1-05）。
 *
 * 应用的业务页面没有全局设置 Provider，而设置必须“真实生效”：
 * - 编辑器排版通过 <html> 上的 CSS 变量 + density.css 作用到知识页编辑器；
 * - 默认清单/新笔记目录在新建对象时补齐，不伪造一个只保存的开关。
 *
 * 桥接只在模块加载时安装一次。它包住 `db.tasks.create` / `db.notes.create`，
 * 读取失败时原样放行，绝不让偏好故障阻塞对象创建。
 */

import { db, isTauriRuntime, type DbClient } from '../../data/db/client';
import type { List, NewNote, NewTask } from '../../data/db/types';
import { NOTE_FOLDERS } from '../../data/repositories/notes';
import {
  createSettingsRepository,
  readLocalSettings,
  writeLocalSettings,
  type AppSettings,
  type EditorTitleMode,
} from '../../data/repositories/settings';
import { SETTINGS_CHANGED_EVENT } from './events';

const GENERIC_NOTE_TITLE = '未命名笔记';

let runtimeSettings: AppSettings = readLocalSettings();
let hydration: Promise<void> | null = null;
/** 防止启动时发出的 DB 读取在用户刚保存后把新值覆盖回旧值。 */
let runtimeRevision = 0;

type EditableRoot = HTMLElement & {
  style: CSSStyleDeclaration;
  dataset: DOMStringMap;
};

function rootElement(): EditableRoot | null {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.documentElement as EditableRoot;
}

/**
 * 把设置写成 CSS 变量与 data 属性。density.css 只消费这些值，
 * 因此设置页、知识页编辑器和刷新后的首屏看到的是同一套事实。
 */
export function applySettingsToDocument(
  settings: AppSettings,
  root: EditableRoot | null = rootElement(),
): void {
  if (!root) {
    return;
  }

  const { editor } = settings;
  root.style.setProperty('--editor-font-size', `${editor.fontSize}px`);
  root.style.setProperty(
    '--editor-paragraph-gap',
    `${editor.paragraphSpacing}px`,
  );
  root.style.setProperty('--editor-indent', `${editor.textIndent}em`);
  root.style.setProperty(
    '--editor-width',
    editor.width === '100%' ? '100%' : `${editor.width}px`,
  );
  root.style.setProperty(
    '--editor-ink',
    editor.textColor === 'auto' ? 'var(--ink)' : editor.textColor,
  );

  root.dataset.editorFontSize = String(editor.fontSize);
  root.dataset.editorParagraphSpacing = String(editor.paragraphSpacing);
  root.dataset.editorTextIndent = String(editor.textIndent);
  root.dataset.editorWidth = String(editor.width);
  root.dataset.editorTitleMode = editor.titleMode;
  root.dataset.editorBlockIcons = editor.showBlockIcon ? 'on' : 'off';
  root.dataset.editorTextColor = editor.textColor;
}

export function getRuntimeSettings(): AppSettings {
  return runtimeSettings;
}

function broadcastSettings(settings: AppSettings): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: settings }),
  );
}

/** 设置页保存后调用：更新缓存、localStorage 镜像与 <html>。 */
export function setRuntimeSettings(next: AppSettings): void {
  runtimeRevision += 1;
  runtimeSettings = next;
  writeLocalSettings(next);
  applySettingsToDocument(next);
  broadcastSettings(next);
}

/** 从 localStorage 重新读取（首屏/测试模拟刷新时使用）。 */
export function refreshRuntimeFromLocal(): AppSettings {
  runtimeSettings = readLocalSettings();
  applySettingsToDocument(runtimeSettings);
  return runtimeSettings;
}

/**
 * 桌面端从 SQLite 校准一次；失败时保留 localStorage 镜像，不阻塞界面。
 */
export function ensureRuntimeSettings(
  client: DbClient = db,
): Promise<AppSettings> {
  if (!isTauriRuntime()) {
    return Promise.resolve(runtimeSettings);
  }
  if (!hydration) {
    const startRevision = runtimeRevision;
    hydration = createSettingsRepository(client)
      .load()
      .then((settings) => {
        if (runtimeRevision === startRevision) {
          setRuntimeSettings(settings);
        }
      })
      .catch(() => undefined);
  }
  // hydration 只负责启动时校准一次；调用方必须拿到“当前”缓存，
  // 否则用户刚在设置页改过的默认值会被启动时的旧 promise 结果覆盖。
  const pending = hydration;
  return pending.then(() => runtimeSettings);
}

export function fmtDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}`;
}

export function fmtDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${fmtDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function defaultNoteTitle(
  mode: EditorTitleMode,
  now: Date = new Date(),
): string {
  if (mode === 'date') {
    return fmtDate(now);
  }
  if (mode === 'datetime') {
    return fmtDateTime(now);
  }
  return GENERIC_NOTE_TITLE;
}

/**
 * 快速创建/今天/清单的新建任务在 UI 里默认落到“第一个非收件箱清单”。
 * 只有仍停留在该自动选择时，才替换为用户设置的默认清单；已经选了其他清单则尊重。
 * 无日期任务按产品规则进收件箱，不受默认清单影响。
 */
export function applyTaskDefaults(
  input: NewTask,
  lists: readonly List[],
  settings: AppSettings,
): NewTask {
  if (!input.dueDate) {
    return input;
  }

  const inboxId = lists.find((list) => list.isInbox)?.id;
  if (inboxId && input.listId === inboxId) {
    return input;
  }

  const firstUsable = lists.find((list) => !list.isInbox)?.id;
  if (!firstUsable) {
    return input;
  }
  if (input.listId && input.listId !== firstUsable) {
    return input;
  }

  const configuredId = settings.task.defaultListId;
  if (!configuredId) {
    return input;
  }
  const configured = lists.find(
    (list) => list.id === configuredId && !list.isInbox,
  );
  if (!configured) {
    return input;
  }

  return { ...input, listId: configured.id };
}

/**
 * 知识页的“新建笔记”固定使用 `未命名笔记` + 第一个目录。设置页的默认目录与
 * 默认标题只补这个通用创建路径；执行笔记、复盘笔记等带业务标题的创建不受影响。
 */
export function applyNoteDefaults(
  input: NewNote,
  settings: AppSettings,
  now: Date = new Date(),
): NewNote {
  if (input.title !== GENERIC_NOTE_TITLE) {
    return input;
  }

  const next: NewNote = { ...input };
  const folderId = settings.task.noteFolderId;
  const firstFolderId = NOTE_FOLDERS[0]?.id ?? null;
  const folderIsGeneric =
    input.folderId === undefined ||
    input.folderId === null ||
    input.folderId === firstFolderId;

  if (
    folderId &&
    folderIsGeneric &&
    NOTE_FOLDERS.some((folder) => folder.id === folderId)
  ) {
    next.folderId = folderId;
  }

  if (settings.editor.titleMode !== 'empty') {
    next.title = defaultNoteTitle(settings.editor.titleMode, now);
  }

  return next;
}

const installedClients = new WeakSet<object>();

/**
 * 安装运行时桥。测试可传入自己的 client；真实应用只安装一次全局 db。
 */
export function installSettingsBridge(client: DbClient = db): void {
  if (installedClients.has(client)) {
    return;
  }
  installedClients.add(client);

  const createTask = client.tasks.create.bind(client.tasks);
  client.tasks.create = async (input: NewTask) => {
    let resolved = input;
    try {
      const settings = await ensureRuntimeSettings(client);
      const lists = await client.lists.list();
      resolved = applyTaskDefaults(input, lists, settings);
    } catch {
      // 偏好或清单读取失败时保持原输入，不阻塞任务创建。
    }
    return createTask(resolved);
  };

  const createNote = client.notes.create.bind(client.notes);
  client.notes.create = async (input: NewNote) => {
    let resolved = input;
    try {
      const settings = await ensureRuntimeSettings(client);
      resolved = applyNoteDefaults(input, settings);
    } catch {
      // 同上：设置桥永远不是创建路径的故障点。
    }
    return createNote(resolved);
  };
}

// 首屏立即应用 localStorage 镜像（桌面端稍后由 ensureRuntimeSettings 校准）。
applySettingsToDocument(runtimeSettings);
installSettingsBridge();

if (isTauriRuntime()) {
  void ensureRuntimeSettings().catch(() => undefined);
}
