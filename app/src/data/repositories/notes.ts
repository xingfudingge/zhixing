/**
 * 笔记仓储封装（P1-01）。
 *
 * 页面只通过这里完成笔记生命周期：列表、创建、重命名/移动/收藏/置顶、
 * 软删除与恢复、Markdown 导出。所有写入仍走 Tauri IPC 的 `notes_*` 命令，
 * 不在渲染层直接拼 SQL，也不把 localStorage 当权威库。
 *
 * 目录：P0 领域表的 `notes.folder_id` 是自由文本，当前迁移还没有 `folders`
 * 表。这里只维护知识页已确认的目录清单（与原型/种子数据一致），不伪造
 * 目录 CRUD；后续卡接入 folders 表时只需替换 `NOTE_FOLDERS` 的来源。
 */

import type { DbClient } from '../db/client';
import type {
  ImportNoteInput,
  NewNote,
  Note,
  NoteQuery,
  NoteUpdate,
} from '../db/types';
import { internalNoteIdsInText } from '../../features/editor/security';
import { codeFenceLanguage } from '../../features/editor/types';
import {
  saveBlobWithDialog,
  type SaveResult,
} from '../../features/attachments/fileActions';

export type NoteFolder = {
  id: string;
  name: string;
};

/** 笔记目录默认值；目录可由用户新建/重命名/删除。 */
export const NOTE_FOLDERS: ReadonlyArray<NoteFolder> = [
  { id: 'f1', name: '产品设计' },
  { id: 'f2', name: '用户研究' },
  { id: 'f3', name: '工作记录' },
  { id: 'f4', name: '个人成长' },
  { id: 'f5', name: '剪藏' },
];

export type NotePatch = Partial<
  Pick<
    Note,
    'title' | 'folderId' | 'tags' | 'body' | 'bodyFormat' | 'favorite' | 'pinned'
  >
>;

/** 页面可注入的数据源；只强制 list，便于 P0-05 的只读测试源继续复用。 */
export type NoteSource = {
  list: (query?: NoteQuery) => Promise<Note[]>;
  create?: (input: NewNote) => Promise<Note>;
  update?: (id: string, input: NoteUpdate) => Promise<Note>;
  remove?: (id: string) => Promise<void>;
  restore?: (id: string) => Promise<Note>;
  /**
   * 文件导入的原子写入。实现必须保证笔记、块、待办在同一事务内成功或
   * 全部回滚；页面不自行拆分调用 create + blocks.create。
   */
  import?: (input: ImportNoteInput) => Promise<Note>;
};

export class NoteTitleError extends Error {
  constructor() {
    super('笔记标题不能为空');
    this.name = 'NoteTitleError';
  }
}

/** 锁定笔记没有明文内容；导出/复制必须失败，而不是写出一份空文件。 */
export class NoteLockedError extends Error {
  constructor() {
    super('笔记已加密并锁定；请先在设置 → 隐私与安全中解锁再导出');
    this.name = 'NoteLockedError';
  }
}

export function normalizeNoteTitle(value: string): string {
  const title = value.trim();
  if (!title) {
    throw new NoteTitleError();
  }
  return title;
}

export function toNoteUpdate(note: Note, patch: NotePatch): NoteUpdate {
  const next = { ...note, ...patch };
  return {
    title: next.title,
    folderId: next.folderId,
    tags: next.tags,
    body: next.body,
    bodyFormat: next.bodyFormat,
    favorite: next.favorite,
    pinned: next.pinned,
  };
}

export function isTrashedNote(note: Note): boolean {
  return note.status === 'trashed' || note.deletedAt !== null;
}

export function sortNotes(notes: ReadonlyArray<Note>): Note[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) {
      return a.pinned ? -1 : 1;
    }
    if (a.updatedAt !== b.updatedAt) {
      return a.updatedAt < b.updatedAt ? 1 : -1;
    }
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });
}

export function noteFolderName(folderId: string | null | undefined): string {
  if (!folderId) {
    return '未分类';
  }
  return NOTE_FOLDERS.find((folder) => folder.id === folderId)?.name ?? folderId;
}

/** 从一份完整笔记生成 Markdown，供右键菜单/信息面板导出。 */
export function noteToMarkdown(
  note: Pick<Note, 'title' | 'body'> & { locked?: boolean },
): string {
  if (note.locked) {
    throw new NoteLockedError();
  }
  const title = note.title.trim() || '未命名笔记';
  const body = htmlToMarkdown(note.body).trim();
  return body ? `# ${title}\n\n${body}\n` : `# ${title}\n`;
}

/** 单篇导出文件名：去路径非法字符、保留扩展名、空标题回落“未命名笔记”。 */
export function exportNoteFileName(
  title: string,
  extension: 'md' | 'docx' | 'pdf',
): string {
  const safe = title
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/g, '')
    .slice(0, 120);
  return `${safe || '未命名笔记'}.${extension}`;
}

export function exportMarkdownFileName(title: string): string {
  return exportNoteFileName(title, 'md');
}

/**
 * 导出 Markdown：与附件另存共用同一个文件动作链路。
 *
 * 桌面走 Tauri 保存面板、浏览器走 File System Access 保存面板；取消时
 * 返回 `canceled` 且不写文件，不会退化成默认 Downloads 下载。
 */
export async function downloadNoteMarkdown(
  note: Pick<Note, 'title' | 'body'> & { locked?: boolean },
): Promise<SaveResult> {
  const markdown = noteToMarkdown(note);
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  return saveBlobWithDialog(blob, exportMarkdownFileName(note.title));
}

export function htmlToPlainText(html: string): string {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// HTML → Markdown
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function inlineChildren(node: Node): string {
  return Array.from(node.childNodes)
    .map((child) => inlineNode(child))
    .join('');
}

function inlineNode(node: Node): string {
  if (node.nodeType === 3) {
    return escapeMarkdown(node.textContent ?? '');
  }
  if (node.nodeType !== 1) {
    return '';
  }
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  switch (tag) {
    case 'br':
      return '\n';
    case 'strong':
    case 'b':
      return `**${inlineChildren(element)}**`;
    case 'em':
    case 'i':
      return `*${inlineChildren(element)}*`;
    case 'del':
    case 's':
    case 'strike':
      return `~~${inlineChildren(element)}~~`;
    case 'code':
      return `\`${element.textContent ?? ''}\``;
    case 'a': {
      const href = element.getAttribute('href') ?? '';
      const label = inlineChildren(element).trim() || href;
      if (!href || href === '#' || /^javascript:/i.test(href)) {
        return label;
      }
      return `[${label}](${href})`;
    }
    case 'img': {
      const alt = escapeMarkdown(element.getAttribute('alt') ?? '');
      const src = element.getAttribute('src') ?? '';
      return src ? `![${alt}](${src})` : alt;
    }
    case 'input':
    case 'button':
      return '';
    default:
      return inlineChildren(element);
  }
}

function listDepthIndent(depth: number): string {
  return '  '.repeat(depth);
}

function serializeList(list: Element, depth: number): string {
  const ordered = list.tagName.toLowerCase() === 'ol';
  const items = Array.from(list.children).filter(
    (child) => child.tagName.toLowerCase() === 'li',
  );
  return items
    .map((item, index) => {
      const nested: Element[] = [];
      const contentNodes = Array.from(item.childNodes).filter((node) => {
        if (
          node.nodeType === 1 &&
          ['ul', 'ol'].includes((node as Element).tagName.toLowerCase())
        ) {
          nested.push(node as Element);
          return false;
        }
        return true;
      });
      const checkbox = item.querySelector('input[type="checkbox"]');
      const checked = checkbox
        ? (checkbox as HTMLInputElement).hasAttribute('checked') ||
          (checkbox as HTMLInputElement).checked
        : false;
      const text = contentNodes
        .map((node) => inlineNode(node))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      const marker = ordered ? `${index + 1}. ` : '- ';
      const todo = checkbox ? `[${checked ? 'x' : ' '}] ` : '';
      const lines = [`${listDepthIndent(depth)}${marker}${todo}${text}`];
      for (const nestedList of nested) {
        const nestedText = serializeList(nestedList, depth + 1);
        if (nestedText) {
          lines.push(nestedText);
        }
      }
      return lines.join('\n');
    })
    .join('\n');
}

function serializeTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'))
    .map((row) =>
      Array.from(row.children).map((cell) =>
        inlineChildren(cell).trim().replace(/\|/g, '\\|'),
      ),
    )
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) {
    return '';
  }
  const header = rows[0];
  const separator = header.map(() => '---');
  return [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...rows.slice(1).map((cells) => `| ${cells.join(' | ')} |`),
  ].join('\n');
}

function serializeTodo(element: Element): string {
  const done = element.classList.contains('done');
  const textBox = element.querySelector('.ittext');
  const text = (textBox?.textContent ?? element.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return `- [${done ? 'x' : ' '}] ${escapeMarkdown(text || '待办事项')}`;
}

function serializeBlock(element: Element, depth: number): string {
  const tag = element.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const text = inlineChildren(element).trim();
    return text ? `${'#'.repeat(level)} ${text}` : '';
  }
  if (tag === 'p') {
    return inlineChildren(element).trim();
  }
  if (tag === 'ul' || tag === 'ol') {
    return serializeList(element, depth);
  }
  if (tag === 'blockquote') {
    const inner = serializeBlocks(element, depth).join('\n\n');
    return inner
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');
  }
  if (tag === 'pre') {
    const code = (element.textContent ?? '').replace(/\n+$/, '');
    // 编辑器缓存同时写 data-language 与 language-* class；任一处存在即可。
    // 未知语言也保留（Markdown 围栏允许任意 info string），但先清洗字符，
    // 避免把反引号/换行注入围栏行。
    const className = Array.from(element.classList).find((name) =>
      name.startsWith('language-'),
    );
    const rawLanguage =
      element.getAttribute('data-language') ??
      (className ? className.slice('language-'.length) : '');
    const language = codeFenceLanguage(rawLanguage);
    return `\`\`\`${language}\n${code}\n\`\`\``;
  }
  if (tag === 'hr') {
    return '---';
  }
  if (tag === 'table') {
    return serializeTable(element);
  }
  if (tag === 'div') {
    if (element.classList.contains('itodo')) {
      return serializeTodo(element);
    }
    if (element.classList.contains('boardembed')) {
      return '[画板]';
    }
    if (element.classList.contains('filecard')) {
      const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
      return `**[附件]** ${escapeMarkdown(text)}`;
    }
    if (element.classList.contains('callout')) {
      const inner = serializeBlocks(element, depth).join('\n\n');
      return inner
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    }
    const inner = serializeBlocks(element, depth).join('\n\n');
    return inner;
  }
  return inlineChildren(element).trim();
}

function serializeBlocks(root: Node, depth: number): string[] {
  const blocks: string[] = [];
  let inlineBuffer = '';
  const flush = () => {
    const text = inlineBuffer.trim();
    if (text) {
      blocks.push(text);
    }
    inlineBuffer = '';
  };

  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 3) {
      inlineBuffer += inlineNode(child);
      continue;
    }
    if (child.nodeType !== 1) {
      continue;
    }
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    const isTodoBlock = element.classList.contains('itodo');
    if (BLOCK_TAGS.has(tag) || isTodoBlock) {
      flush();
      const block = serializeBlock(element, depth);
      if (block.trim()) {
        blocks.push(block);
      }
    } else {
      inlineBuffer += inlineNode(element);
    }
  }
  flush();
  return blocks;
}

function fallbackHtmlToMarkdown(html: string): string {
  return html
    .replace(
      /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
      (_match, level: string, text: string) =>
        `${'#'.repeat(Number(level))} ${stripTags(text)}\n\n`,
    )
    .replace(
      /<li[^>]*>([\s\S]*?)<\/li>/gi,
      (_match, text: string) => `- ${stripTags(text)}\n`,
    )
    .replace(
      /<p[^>]*>([\s\S]*?)<\/p>/gi,
      (_match, text: string) => `${stripTags(text)}\n\n`,
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function htmlToMarkdown(html: string): string {
  if (!html.trim()) {
    return '';
  }
  if (typeof DOMParser === 'undefined') {
    return fallbackHtmlToMarkdown(html);
  }
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return serializeBlocks(doc.body, 0).join('\n\n').replace(/\n{3,}/g, '\n\n');
  } catch {
    return fallbackHtmlToMarkdown(html);
  }
}

// ---------------------------------------------------------------------------
// 笔记内链关系图（ZX-GRAPH-01）
// ---------------------------------------------------------------------------

/**
 * 关系图只统计 `zhixing://note/<id>` 站内内链：
 * - 外部 http/https/mailto 链接不产生边；
 * - 指向不存在或已删除笔记的内链变成「断链」幽灵节点，不伪造目标；
 * - 自链接不产生边，避免无意义自环。
 *
 * 返回结构保持纯数据，渲染层只负责布局/缩放/平移，方便 100 篇/1000 边规模
 * 下单独测试与缓存。
 */
export type NoteLinkDepth = 1 | 2 | 'all';

export type NoteLinkGraphNode = {
  id: string;
  title: string;
  kind: 'note' | 'broken';
  brokenReason?: 'missing' | 'trashed';
  /** 与当前笔记的最短无向距离；`all` 模式下不可达为 null。 */
  depth: number | null;
  isolated: boolean;
  isRoot: boolean;
};

export type NoteLinkGraphEdge = {
  id: string;
  sourceId: string;
  targetId: string;
  broken: boolean;
};

export type NoteLinkGraph = {
  rootId: string | null;
  depth: NoteLinkDepth;
  nodes: NoteLinkGraphNode[];
  edges: NoteLinkGraphEdge[];
  /** 可见笔记数（不含断链幽灵节点）。 */
  noteCount: number;
  edgeCount: number;
  brokenCount: number;
  isolatedCount: number;
};

export type NoteLinkGraphOptions = {
  rootId?: string | null;
  depth?: NoteLinkDepth;
};

function truncatedLinkTitle(note: Note | undefined, fallbackId: string): string {
  const title = note?.title.trim();
  return title || fallbackId;
}

export function buildNoteLinkGraph(
  notes: ReadonlyArray<Note>,
  options: NoteLinkGraphOptions = {},
): NoteLinkGraph {
  const depth = options.depth ?? 'all';
  const byId = new Map(notes.map((note) => [note.id, note]));
  const activeById = new Map(
    notes.filter((note) => !isTrashedNote(note)).map((note) => [note.id, note]),
  );

  // 所有有效边先按整库计算：一跳/两跳筛选依赖完整拓扑。
  const outgoing = new Map<string, string[]>();
  const undirected = new Map<string, Set<string>>();
  for (const note of activeById.values()) {
    const targets = internalNoteIdsInText(note.body).filter(
      (id) => id !== note.id,
    );
    outgoing.set(note.id, targets);
    if (!undirected.has(note.id)) {
      undirected.set(note.id, new Set());
    }
    for (const targetId of targets) {
      if (!activeById.has(targetId)) {
        continue;
      }
      const set = undirected.get(note.id) ?? new Set<string>();
      set.add(targetId);
      undirected.set(note.id, set);
      const reverse =
        undirected.get(targetId) ?? new Set<string>();
      reverse.add(note.id);
      undirected.set(targetId, reverse);
    }
  }

  const rootId =
    typeof options.rootId === 'string' && activeById.has(options.rootId)
      ? options.rootId
      : null;
  const distances = new Map<string, number>();
  if (rootId) {
    distances.set(rootId, 0);
    const queue = [rootId];
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      const nextDepth = (distances.get(current) ?? 0) + 1;
      for (const neighbor of undirected.get(current) ?? []) {
        if (!distances.has(neighbor)) {
          distances.set(neighbor, nextDepth);
          queue.push(neighbor);
        }
      }
    }
  }

  const visible = new Set<string>();
  for (const id of activeById.keys()) {
    if (depth === 'all' || !rootId) {
      visible.add(id);
      continue;
    }
    const distance = distances.get(id);
    if (distance !== undefined && distance <= depth) {
      visible.add(id);
    }
  }

  const nodes = new Map<string, NoteLinkGraphNode>();
  for (const id of visible) {
    const note = activeById.get(id);
    if (!note) {
      continue;
    }
    nodes.set(id, {
      id,
      title: note.title.trim() || '未命名笔记',
      kind: 'note',
      depth: distances.get(id) ?? null,
      isolated: true,
      isRoot: id === rootId,
    });
  }

  const edges: NoteLinkGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const appendEdge = (
    sourceId: string,
    targetId: string,
    broken: boolean,
  ) => {
    const key = `${sourceId}\u0000${targetId}`;
    if (edgeKeys.has(key)) {
      return;
    }
    edgeKeys.add(key);
    edges.push({
      id: `${sourceId}->${targetId}`,
      sourceId,
      targetId,
      broken,
    });
  };

  for (const sourceId of visible) {
    for (const targetId of outgoing.get(sourceId) ?? []) {
      if (targetId === sourceId) {
        continue;
      }
      if (activeById.has(targetId)) {
        // 目标存在但被当前跳数筛掉时，不画出这条边。
        if (visible.has(targetId)) {
          appendEdge(sourceId, targetId, false);
        }
        continue;
      }
      const trashed = byId.get(targetId);
      const brokenId = `broken:${targetId}`;
      if (!nodes.has(brokenId)) {
        nodes.set(brokenId, {
          id: brokenId,
          title: trashed
            ? `断链：${truncatedLinkTitle(trashed, targetId)}`
            : `断链：${targetId}`,
          kind: 'broken',
          brokenReason: trashed ? 'trashed' : 'missing',
          depth: (nodes.get(sourceId)?.depth ?? 0) + 1,
          isolated: false,
          isRoot: false,
        });
      }
      appendEdge(sourceId, brokenId, true);
    }
  }

  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.sourceId, (degree.get(edge.sourceId) ?? 0) + 1);
    degree.set(edge.targetId, (degree.get(edge.targetId) ?? 0) + 1);
  }
  for (const node of nodes.values()) {
    node.isolated =
      node.kind === 'note' && (degree.get(node.id) ?? 0) === 0;
  }

  const orderedNodes = [...nodes.values()].sort((a, b) => {
    if (a.isRoot !== b.isRoot) {
      return a.isRoot ? -1 : 1;
    }
    if (a.kind !== b.kind) {
      return a.kind === 'note' ? -1 : 1;
    }
    const depthA = a.depth ?? Number.MAX_SAFE_INTEGER;
    const depthB = b.depth ?? Number.MAX_SAFE_INTEGER;
    if (depthA !== depthB) {
      return depthA - depthB;
    }
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });

  const noteCount = orderedNodes.filter(
    (node) => node.kind === 'note',
  ).length;
  const brokenCount = edges.filter((edge) => edge.broken).length;
  return {
    rootId,
    depth,
    nodes: orderedNodes,
    edges,
    noteCount,
    edgeCount: edges.length - brokenCount,
    brokenCount,
    isolatedCount: orderedNodes.filter(
      (node) => node.kind === 'note' && node.isolated,
    ).length,
  };
}

// ---------------------------------------------------------------------------
// 仓储
// ---------------------------------------------------------------------------

export function createNoteRepository(client: DbClient) {
  return {
    list: async (query: NoteQuery = {}): Promise<Note[]> =>
      sortNotes(await client.notes.list(query)),
    get: (id: string): Promise<Note> => client.notes.get(id),
    create: async (input: NewNote): Promise<Note> => {
      const title = normalizeNoteTitle(input.title);
      return client.notes.create({ ...input, title });
    },
    import: async (input: ImportNoteInput): Promise<Note> => {
      const title = normalizeNoteTitle(input.note.title);
      return client.notes.import({
        ...input,
        note: { ...input.note, title },
      });
    },
    update: async (id: string, input: NoteUpdate): Promise<Note> => {
      const title = normalizeNoteTitle(input.title);
      return client.notes.update(id, { ...input, title });
    },
    patch: async (note: Note, patch: NotePatch): Promise<Note> => {
      const title = normalizeNoteTitle((patch.title ?? note.title).trim());
      return client.notes.update(
        note.id,
        toNoteUpdate(note, { ...patch, title }),
      );
    },
    remove: (id: string): Promise<void> => client.notes.remove(id),
    restore: (id: string): Promise<Note> => client.notes.restore(id),
    exportMarkdown: (note: Pick<Note, 'title' | 'body'>): string =>
      noteToMarkdown(note),
  };
}

export type NoteRepository = ReturnType<typeof createNoteRepository>;
