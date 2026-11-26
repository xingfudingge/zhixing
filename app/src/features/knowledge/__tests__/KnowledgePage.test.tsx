import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { ImportNoteInput } from '../../../data/db/types';

import {
  createFakeBlockSource,
  makeBlock,
  type FakeBlockSource,
} from '../../editor/__tests__/fakeBlockSource';
import { restoreSelectionByOffsets } from '../../editor/inline';
import type { BoardDocument, BoardSource } from '../../board/types';
import { createFakeBoardSource } from '../../board/__tests__/fakeBoardSource';
import {
  createFakeNoteTodoSource,
  makeNoteTodo,
  type FakeNoteTodoSource,
} from '../../editor/todos/__tests__/fakeNoteTodoSource';
import {
  createFakeTodoTaskSource,
  makeFakeList,
  makeFakeTask,
  type FakeTodoTaskSource,
} from '../../editor/todos/__tests__/fakeTodoTaskSource';
import { KnowledgePage } from '../KnowledgePage';
import { formatMenuShortcut } from '../contextMenu';
import {
  AttachmentManager,
  AttachmentUploader,
  MemoryAttachmentMetadataRepository,
  MemoryAttachmentStateStore,
  MemoryBlobStore,
} from '../../attachments';
import { bytesKey, defaultState } from '../../attachments/types';
import { createFakeTransport } from '../../attachments/__tests__/fakeTransport';
import { sha256Blob } from '../../attachments/sha256';
import { createFakeNoteSource, makeNote, type FakeNoteSource } from './fakeNoteSource';

function seedNotes() {
  return [
    makeNote({
      id: 'note-a',
      title: '产品设计笔记',
      folderId: 'f1',
      tags: ['产品'],
      body: '<h2>背景</h2><ul><li>访谈</li><li>评审</li></ul>',
      updatedAt: '2026-10-22T08:00:00.000Z',
    }),
    makeNote({
      id: 'note-b',
      title: '用户研究笔记',
      folderId: 'f2',
      tags: ['研究'],
      favorite: true,
      body: '<h2>结论</h2><p>用户需要更短的任务路径。</p>',
      updatedAt: '2026-10-21T08:00:00.000Z',
    }),
    makeNote({
      id: 'note-c',
      title: '普通笔记',
      folderId: 'f1',
      tags: ['日常'],
      body: '<p>随手记录。</p>',
      updatedAt: '2026-10-20T08:00:00.000Z',
    }),
  ];
}

function createAttachmentHarness() {
  const repository = new MemoryAttachmentMetadataRepository();
  const blobStore = new MemoryBlobStore();
  const stateStore = new MemoryAttachmentStateStore();
  const manager = new AttachmentManager({
    repository,
    blobStore,
    stateStore,
    newId: () => `att_${repository.all().length + 1}`,
  });
  const uploader = new AttachmentUploader({
    manager,
    transport: createFakeTransport(),
    chunkSize: 64 * 1024,
  });
  return { repository, blobStore, stateStore, manager, uploader };
}

function renderKnowledge(
  source: FakeNoteSource,
  entry = '/knowledge',
  blockSource: FakeBlockSource = createFakeBlockSource(),
  boardSource?: BoardSource,
  noteTodoSource: FakeNoteTodoSource = createFakeNoteTodoSource(),
  taskSource: FakeTodoTaskSource = createFakeTodoTaskSource(
    [],
    [makeFakeList({ id: 'inbox', name: '收件箱', isInbox: true, sortOrder: 0 })],
  ),
  attachments?: { manager?: AttachmentManager | null; uploader?: AttachmentUploader | null },
) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/knowledge"
          element={
            <KnowledgePage
              source={source}
              blockSource={blockSource}
              boardSource={boardSource}
              noteTodoSource={noteTodoSource}
              taskSource={{
                tasks: taskSource.tasks,
                lists: taskSource.lists,
              }}
              attachmentManager={attachments?.manager}
              attachmentUploader={attachments?.uploader}
            />
          }
        />
        <Route path="/today" element={<h1>今天</h1>} />
        <Route
          path="/board/:boardId"
          element={<h1>画板工作区</h1>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function noteById(source: FakeNoteSource, id: string) {
  const note = source.snapshot().find((item) => item.id === id);
  if (!note) {
    throw new Error(`缺少测试笔记：${id}`);
  }
  return note;
}

function boardDocument(
  boardId: string,
  noteId: string | null,
  title: string,
): BoardDocument {
  return {
    version: 1,
    boardId,
    noteId,
    title,
    background: 'dot',
    nodes: [],
    edges: [],
  };
}

/** 多画板内存源：孤儿画板用例需要 list 返回不止一条记录。 */
function createMemoryBoardSource(initial: BoardDocument[]) {
  let documents = initial.map((document) => JSON.parse(JSON.stringify(document)) as BoardDocument);
  const removed: string[] = [];
  const source: BoardSource = {
    list: async () =>
      documents.map((document) => ({
        id: document.boardId,
        title: document.title,
        noteId: document.noteId,
        updatedAt: '2026-10-26T00:00:00.000Z',
      })),
    load: async (boardId) => {
      const document = documents.find((item) => item.boardId === boardId);
      if (!document) {
        throw new Error(`画板不存在：${boardId}`);
      }
      return JSON.parse(JSON.stringify(document)) as BoardDocument;
    },
    create: async (input = {}) => {
      const document = boardDocument(
        input.id ?? `board-created-${documents.length + 1}`,
        input.noteId ?? null,
        input.title ?? '未命名画板',
      );
      documents = [...documents, document];
      return JSON.parse(JSON.stringify(document)) as BoardDocument;
    },
    save: async (boardId, document) => {
      const saved = { ...document, boardId };
      documents = documents.map((item) =>
        item.boardId === boardId ? saved : item,
      );
      return JSON.parse(JSON.stringify(saved)) as BoardDocument;
    },
    remove: async (boardId) => {
      removed.push(boardId);
      documents = documents.filter((item) => item.boardId !== boardId);
    },
  };
  return {
    source,
    removed,
    documents: () =>
      documents.map((document) => JSON.parse(JSON.stringify(document)) as BoardDocument),
  };
}

function todoBlockFor(
  noteId: string,
  id: string,
  title: string,
  options: {
    todoId?: string;
    checked?: boolean;
    orderKey?: number;
  } = {},
) {
  return makeBlock({
    id,
    noteId,
    type: 'todo',
    orderKey: options.orderKey ?? 1024,
    payload: {
      runs: [{ text: title }],
      checked: options.checked ?? false,
      ...(options.todoId ? { todoId: options.todoId } : {}),
    },
  });
}

describe('知识页 · 标签页与筛选', () => {
  it('打开两篇出现两个标签；关闭当前标签打开相邻标签', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source);

    // 首次进入自动打开最新一篇；再点两篇后共有三个标签。
    await screen.findByRole('button', { name: '打开笔记：产品设计笔记' });
    await user.click(
      screen.getByRole('button', { name: '打开笔记：用户研究笔记' }),
    );
    expect(screen.getAllByRole('tab')).toHaveLength(2);

    await user.click(
      screen.getByRole('button', { name: '打开笔记：普通笔记' }),
    );
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(
      screen.getByRole('tab', { name: '切换到标签：普通笔记' }),
    ).toHaveAttribute('aria-selected', 'true');

    await user.click(
      screen.getByRole('button', { name: '关闭标签：普通笔记' }),
    );

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    const selected = screen.getByRole('tab', {
      name: '切换到标签：用户研究笔记',
    });
    expect(selected).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('笔记标题')).toHaveValue('用户研究笔记');
  });

  it('切换笔记保留各自正文滚动位置，不跳到底部', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    const paragraphBlocks = (noteId: string, prefix: string) =>
      Array.from({ length: 10 }, (_, index) =>
        makeBlock({
          id: `${noteId}-p${index + 1}`,
          noteId,
          type: 'paragraph',
          orderKey: (index + 1) * 1024,
          payload: { runs: [{ text: `${prefix} 第 ${index + 1} 段` }] },
        }),
      );
    const blocks = createFakeBlockSource([
      ...paragraphBlocks('note-a', 'A'),
      ...paragraphBlocks('note-b', 'B'),
    ]);
    const { container } = renderKnowledge(source, '/knowledge', blocks);

    await screen.findByRole('button', { name: '打开笔记：产品设计笔记' });
    await waitFor(() =>
      expect(container.querySelectorAll('[data-block-id]')).toHaveLength(10),
    );
    const firstScroller = container.querySelector('.zxe-body') as HTMLElement;
    firstScroller.scrollTop = 360;
    fireEvent.scroll(firstScroller);

    await user.click(
      screen.getByRole('button', { name: '打开笔记：用户研究笔记' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('笔记标题')).toHaveValue('用户研究笔记'),
    );
    await waitFor(() =>
      expect(container.querySelector('.zxe-body')).not.toBe(firstScroller),
    );
    const secondScroller = container.querySelector('.zxe-body') as HTMLElement;
    expect(secondScroller.scrollTop).toBe(0);
    secondScroller.scrollTop = 120;
    fireEvent.scroll(secondScroller);

    await user.click(
      screen.getByRole('tab', { name: '切换到标签：产品设计笔记' }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('笔记标题')).toHaveValue('产品设计笔记'),
    );
    await waitFor(() => {
      const restored = container.querySelector('.zxe-body') as HTMLElement;
      expect(restored).not.toBe(secondScroller);
      expect(restored.scrollTop).toBe(360);
    });

    // 再切回用户研究笔记，各自记住自己的位置，不串用。
    await user.click(
      screen.getByRole('tab', { name: '切换到标签：用户研究笔记' }),
    );
    await waitFor(() => {
      const restored = container.querySelector('.zxe-body') as HTMLElement;
      expect(restored.scrollTop).toBe(120);
    });
  });

  it('收藏筛选只显示收藏笔记，不再出现原型的“收藏显示全部”', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source);

    await user.click(
      await screen.findByRole('button', { name: '收藏：产品设计笔记' }),
    );
    await screen.findByText('已收藏');

    await user.click(screen.getByRole('button', { name: '收藏' }));

    expect(
      screen.getByRole('button', { name: '打开笔记：产品设计笔记' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开笔记：用户研究笔记' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '打开笔记：普通笔记' }),
    ).not.toBeInTheDocument();
    expect(noteById(source, 'note-a').favorite).toBe(true);
    expect(noteById(source, 'note-b').favorite).toBe(true);
    expect(noteById(source, 'note-c').favorite).toBe(false);
  });

  it('置顶后进入置顶筛选，且列表按置顶优先排序', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source);

    await user.click(
      await screen.findByRole('button', { name: '更多操作：普通笔记' }),
    );
    await user.click(screen.getByRole('menuitem', { name: /^置顶/ }));
    await screen.findByText('已置顶');

    await user.click(screen.getByRole('button', { name: '置顶' }));

    expect(
      screen.getByRole('button', { name: '打开笔记：普通笔记' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '打开笔记：产品设计笔记' }),
    ).not.toBeInTheDocument();
    expect(noteById(source, 'note-c').pinned).toBe(true);

    await user.click(screen.getByRole('button', { name: '全部笔记' }));
    const rows = screen.getAllByRole('button', { name: /^打开笔记：/ });
    expect(rows[0]).toHaveAccessibleName('打开笔记：普通笔记');
  });
});

describe('知识页 · 目录树 / 标签页右键菜单（ZX7-MENU-02）', () => {
  it('目录行菜单用 i18n 文案；新建落到目标目录，Escape 焦点回到目录行', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source);

    const folder = await screen.findByRole('button', {
      name: '目录：用户研究',
    });
    fireEvent.contextMenu(folder, { clientX: 120, clientY: 180 });
    const menu = await screen.findByRole('menu', { name: '目录树菜单' });
    expect(
      within(menu).getByRole('menuitem', { name: /^新建笔记/ }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: /^在列表中打开/ }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: /^刷新列表/ }),
    ).toBeInTheDocument();
    const copyName = within(menu).getByRole('menuitem', {
      name: /^复制目录名称/,
    });
    expect(copyName).not.toHaveAttribute('aria-disabled');

    await user.click(
      within(menu).getByRole('menuitem', { name: /^新建笔记/ }),
    );
    await waitFor(() => {
      expect(
        source
          .snapshot()
          .some(
            (note) => note.title === '未命名笔记' && note.folderId === 'f2',
          ),
      ).toBe(true);
    });

    // 再次打开后 Escape：焦点回到目录按钮，而不是 body。
    fireEvent.contextMenu(folder, { clientX: 120, clientY: 180 });
    expect(await screen.findByRole('menu', { name: '目录树菜单' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(folder).toHaveFocus();
  });

  it('系统视图禁用“复制目录名称”；空白处只保留新建与刷新', async () => {
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source);

    const all = await screen.findByRole('button', { name: '全部笔记' });
    fireEvent.contextMenu(all, { clientX: 90, clientY: 120 });
    const menu = await screen.findByRole('menu', { name: '目录树菜单' });
    expect(
      within(menu).getByRole('menuitem', { name: /^复制目录名称/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });

    const tree = screen.getByRole('navigation', { name: '知识目录' });
    fireEvent.contextMenu(tree, { clientX: 90, clientY: 320 });
    const blank = await screen.findByRole('menu', { name: '目录树菜单' });
    expect(
      within(blank).getByRole('menuitem', { name: /^新建笔记/ }),
    ).toBeInTheDocument();
    expect(
      within(blank).getByRole('menuitem', { name: /^刷新列表/ }),
    ).toBeInTheDocument();
    expect(
      within(blank).queryByRole('menuitem', { name: /^在列表中打开/ }),
    ).not.toBeInTheDocument();
  });

  it('标签页菜单：关闭其他/全部、复制内链快捷键与 Escape 焦点归还', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source);

    await screen.findByRole('button', { name: '打开笔记：产品设计笔记' });
    await user.click(
      screen.getByRole('button', { name: '打开笔记：用户研究笔记' }),
    );
    await user.click(
      screen.getByRole('button', { name: '打开笔记：普通笔记' }),
    );

    const tab = screen.getByRole('tab', { name: '切换到标签：普通笔记' });
    const tabWrap = tab.closest('.kn-tab');
    expect(tabWrap).not.toBeNull();

    fireEvent.contextMenu(tabWrap as Element, { clientX: 200, clientY: 160 });
    const menu = await screen.findByRole('menu', { name: '标签页菜单' });
    const copyLink = within(menu).getByRole('menuitem', {
      name: /^复制笔记内链/,
    });
    expect(copyLink).toHaveTextContent(formatMenuShortcut('Mod+Shift+L'));
    expect(copyLink).not.toHaveTextContent(formatMenuShortcut('Mod+C'));
    expect(
      within(menu).getByRole('menuitem', { name: /^关闭其他/ }),
    ).not.toHaveAttribute('aria-disabled');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(tab).toHaveFocus();

    fireEvent.contextMenu(tabWrap as Element, { clientX: 200, clientY: 160 });
    await user.click(
      within(await screen.findByRole('menu', { name: '标签页菜单' })).getByRole(
        'menuitem',
        { name: /^关闭其他/ },
      ),
    );
    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(1);
    });
    expect(
      screen.getByRole('tab', { name: '切换到标签：普通笔记' }),
    ).toHaveAttribute('aria-selected', 'true');

    const onlyTab = screen.getByRole('tab', { name: '切换到标签：普通笔记' });
    fireEvent.contextMenu(onlyTab.closest('.kn-tab') as Element, {
      clientX: 200,
      clientY: 160,
    });
    const onlyMenu = await screen.findByRole('menu', { name: '标签页菜单' });
    expect(
      within(onlyMenu).getByRole('menuitem', { name: /^关闭其他/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    await user.click(
      within(onlyMenu).getByRole('menuitem', { name: '关闭全部' }),
    );
    await waitFor(() => {
      expect(screen.queryAllByRole('tab')).toHaveLength(0);
    });
  });

  it('笔记行菜单区分“打开”和“在新标签页打开”，修正复制内链快捷键', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    const { container } = renderKnowledge(source);

    await screen.findByRole('button', { name: '打开笔记：产品设计笔记' });
    await user.click(
      screen.getByRole('button', { name: '打开笔记：用户研究笔记' }),
    );
    expect(screen.getAllByRole('tab')).toHaveLength(2);

    const rowC = container.querySelector('[data-note-id="note-c"]');
    expect(rowC).not.toBeNull();
    fireEvent.contextMenu(rowC as Element, { clientX: 140, clientY: 220 });
    const menu = await screen.findByRole('menu', { name: '笔记操作' });
    const copyLink = within(menu).getByRole('menuitem', {
      name: /^复制笔记内链/,
    });
    expect(copyLink).toHaveTextContent(formatMenuShortcut('Mod+Shift+L'));
    expect(copyLink).not.toHaveTextContent(formatMenuShortcut('Mod+C'));

    // “打开”复用当前标签：仍为 2 个标签，当前页替换为普通笔记。
    await user.click(
      within(menu).getByRole('menuitem', { name: /^打开(?!新)/ }),
    );
    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(2);
    });
    expect(
      screen.getByRole('tab', { name: '切换到标签：普通笔记' }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.queryByRole('tab', { name: '切换到标签：用户研究笔记' }),
    ).not.toBeInTheDocument();

    // “在新标签页打开”追加标签。
    const rowB = container.querySelector('[data-note-id="note-b"]');
    fireEvent.contextMenu(rowB as Element, { clientX: 140, clientY: 200 });
    await user.click(
      within(await screen.findByRole('menu', { name: '笔记操作' })).getByRole(
        'menuitem',
        { name: /^在新标签页打开/ },
      ),
    );
    await waitFor(() => {
      expect(screen.getAllByRole('tab')).toHaveLength(3);
    });
    expect(
      screen.getByRole('tab', { name: '切换到标签：用户研究笔记' }),
    ).toHaveAttribute('aria-selected', 'true');
  });
});

describe('知识页 · 删除与恢复', () => {
  it('应用内确认后进回收站，恢复后标题/正文/目录/标签/收藏/置顶完整', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source);

    const before = noteById(source, 'note-b');
    expect(
      screen.queryByRole('button', { name: '删除笔记' }),
    ).not.toBeInTheDocument();

    await user.click(
      await screen.findByRole('button', { name: '更多操作：用户研究笔记' }),
    );
    await user.click(screen.getByRole('menuitem', { name: /^删除笔记/ }));

    const dialog = await screen.findByRole('dialog', { name: '删除笔记' });
    expect(dialog).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('button', { name: '确认删除' }),
    );

    await waitFor(() => {
      const trashed = noteById(source, 'note-b');
      expect(trashed.status).toBe('trashed');
      expect(trashed.deletedAt).not.toBeNull();
    });

    await user.click(screen.getByRole('button', { name: '回收站' }));
    expect(
      await screen.findByRole('button', {
        name: '打开笔记：用户研究笔记',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '打开笔记：产品设计笔记' }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: '更多操作：用户研究笔记' }),
    );
    await user.click(screen.getByRole('menuitem', { name: /^恢复笔记/ }));
    await screen.findByText('已恢复笔记');

    await waitFor(() => {
      const restored = noteById(source, 'note-b');
      expect(restored.status).toBe('active');
      expect(restored.deletedAt).toBeNull();
      expect(restored.title).toBe(before.title);
      expect(restored.body).toBe(before.body);
      expect(restored.folderId).toBe(before.folderId);
      expect(restored.tags).toEqual(before.tags);
      expect(restored.favorite).toBe(before.favorite);
      expect(restored.pinned).toBe(before.pinned);
    });

    expect(
      await screen.findByRole('button', { name: '打开笔记：用户研究笔记' }),
    ).toBeInTheDocument();
  });

  it('信息面板是第二个删除入口，且列表行没有悬浮删除按钮', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source);

    await screen.findByRole('button', { name: '打开笔记：产品设计笔记' });
    expect(
      screen.queryByRole('button', { name: '删除笔记' }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '笔记信息' }));
    const panel = screen.getByRole('complementary', { name: '笔记信息' });
    await user.click(
      within(panel).getByRole('button', { name: '删除笔记' }),
    );

    expect(
      await screen.findByRole('dialog', { name: '删除笔记' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('知识页 · 重命名与移动', () => {
  it('重命名空标题被拒，输入有效标题后列表与仓储同步', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source);

    await user.click(
      await screen.findByRole('button', { name: '更多操作：产品设计笔记' }),
    );
    await user.click(screen.getByRole('menuitem', { name: /^重命名/ }));

    const dialog = await screen.findByRole('dialog', { name: '重命名笔记' });
    const input = within(dialog).getByLabelText('标题');
    expect(input).toHaveValue('产品设计笔记');

    await user.clear(input);
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '标题不能为空',
    );
    expect(noteById(source, 'note-a').title).toBe('产品设计笔记');
    expect(screen.getByRole('dialog', { name: '重命名笔记' })).toBeInTheDocument();

    await user.type(input, '  产品设计笔记 v2  ');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(noteById(source, 'note-a').title).toBe('产品设计笔记 v2');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开笔记：产品设计笔记 v2' }),
    ).toBeInTheDocument();
  });

  it('移动到目录后目录计数与筛选同步', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source);

    await user.click(
      await screen.findByRole('button', { name: '更多操作：产品设计笔记' }),
    );
    await user.click(screen.getByRole('menuitem', { name: /^移动到目录/ }));

    const dialog = await screen.findByRole('dialog', { name: '移动到目录' });
    await user.selectOptions(within(dialog).getByLabelText('目录'), 'f2');
    await user.click(within(dialog).getByRole('button', { name: '移动' }));

    await waitFor(() => {
      expect(noteById(source, 'note-a').folderId).toBe('f2');
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '目录：用户研究' }));
    expect(
      screen.getByRole('button', { name: '打开笔记：产品设计笔记' }),
    ).toBeInTheDocument();
  });

  it('编辑器标题为空时失焦回退，块正文写入仓储并同步 HTML 缓存', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    const { container } = renderKnowledge(source);

    await screen.findByRole('button', { name: '打开笔记：产品设计笔记' });
    const title = await screen.findByLabelText('笔记标题');
    await user.clear(title);
    await user.tab();

    expect(await screen.findByText('标题不能为空')).toBeInTheDocument();
    expect(screen.getByLabelText('笔记标题')).toHaveValue('产品设计笔记');
    expect(noteById(source, 'note-a').title).toBe('产品设计笔记');

    // 旧 HTML 正文会投影成块；这里编辑列表块文字，验证块落库后
    // 兼容缓存 notes.body 也被同步。
    const [listItem] = await screen.findAllByRole('textbox', {
      name: '无序列表项',
    });
    await user.click(listItem);
    await user.type(listItem, '补一段新的执行说明。');

    await waitFor(
      () => {
        expect(noteById(source, 'note-a').body).toContain(
          '补一段新的执行说明。',
        );
      },
      { timeout: 4000 },
    );
    expect(container.querySelector('.kn-save-state')).toHaveTextContent(
      '已保存到本机',
    );
  });

  it('右键列表行打开应用内菜单，Escape 关闭', async () => {
    const source = createFakeNoteSource(seedNotes());
    const { container } = renderKnowledge(source);

    await screen.findByRole('button', { name: '打开笔记：产品设计笔记' });
    const row = container.querySelector('[data-note-id="note-a"]');
    expect(row).not.toBeNull();

    fireEvent.contextMenu(row as Element, { clientX: 120, clientY: 160 });
    const menu = await screen.findByRole('menu', { name: '笔记操作' });
    expect(
      within(menu).getByRole('menuitem', { name: '导出…' }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  it('菜单导出门默认 Word，切 Markdown 后走用户可见保存面板并清洗文件名', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    const write = vi.fn().mockResolvedValue(undefined);
    const picker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({
        write,
        close: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn(),
      }),
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    });

    try {
      renderKnowledge(source);
      await user.click(
        await screen.findByRole('button', {
          name: '更多操作：产品设计笔记',
        }),
      );
      await user.click(screen.getByRole('menuitem', { name: '导出…' }));

      const dialog = await screen.findByRole('dialog', {
        name: /导出「产品设计笔记」/,
      });
      expect(
        within(dialog).getByRole('radio', { name: /Word 文档/ }),
      ).toBeChecked();
      expect(
        within(dialog).getByText(/内容清单：/),
      ).toBeInTheDocument();

      await user.click(
        within(dialog).getByRole('radio', { name: /Markdown/ }),
      );
      expect(
        within(dialog).getByText(/Markdown 会丢失文字颜色/),
      ).toBeInTheDocument();
      await user.click(
        within(dialog).getByRole('button', { name: '继续' }),
      );

      expect(
        await screen.findByRole('dialog', { name: '已导出 Markdown' }),
      ).toBeInTheDocument();
      expect(picker).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedName: '产品设计笔记.md' }),
      );
      const blob = write.mock.calls[0]![0] as Blob;
      expect(await blob.text()).toContain('# 产品设计笔记');
      // 不再使用 <a download> 偷偷写进 Downloads。
      expect(anchorClick).not.toHaveBeenCalled();
    } finally {
      anchorClick.mockRestore();
      delete (window as Window & { showSaveFilePicker?: unknown })
        .showSaveFilePicker;
    }
  });

  it('导出弹窗走共享 Modal：body 滚动、footer 固定、Escape 关闭', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source);

    await user.click(
      await screen.findByRole('button', { name: '更多操作：产品设计笔记' }),
    );
    await user.click(screen.getByRole('menuitem', { name: '导出…' }));

    const dialog = await screen.findByRole('dialog', {
      name: /导出「产品设计笔记」/,
    });
    expect(dialog.closest('.zx-modal-backdrop')).not.toBeNull();
    expect(document.querySelector('.kn-modal-backdrop')).toBeNull();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    const body = dialog.querySelector('.zx-modal-body');
    const footer = dialog.querySelector('.zx-modal-foot');
    expect(body).not.toBeNull();
    expect(footer).not.toBeNull();
    // 长内容只滚 body；操作栏在 body 之外，始终可见。
    expect(body!.contains(footer)).toBe(false);
    expect(
      within(footer as HTMLElement).getByRole('button', { name: '继续' }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('导出菜单包含知行笔记包；笔记包选项禁用元信息/图片并说明不可替代备份', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source);

    await user.click(await screen.findByRole('button', { name: '导出笔记' }));
    const menu = await screen.findByRole('menu', { name: '导出' });
    expect(
      within(menu).getByRole('menuitem', {
        name: '知行笔记包（.zxnote）',
      }),
    ).toBeInTheDocument();
    await user.click(
      within(menu).getByRole('menuitem', {
        name: '知行笔记包（.zxnote）',
      }),
    );

    const dialog = await screen.findByRole('dialog', {
      name: /导出「产品设计笔记」/,
    });
    expect(
      within(dialog).getByRole('radio', { name: /知行笔记包/ }),
    ).toBeChecked();
    expect(
      within(dialog).getByRole('checkbox', { name: /包含创建\/更新/ }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole('checkbox', { name: /包含图片/ }),
    ).toBeDisabled();
    expect(
      within(dialog).getByText(/不受下方“元信息\/图片”开关影响/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(
      screen.queryByRole('dialog', { name: /导出「产品设计笔记」/ }),
    ).not.toBeInTheDocument();
  });
});

describe('知识页 · 深链与既有执行笔记兼容', () => {
  it('?note=id 直接打开对应笔记并加入标签', async () => {
    const source = createFakeNoteSource(seedNotes());
    renderKnowledge(source, '/knowledge?note=note-c');

    expect(
      await screen.findByRole('tab', { name: '切换到标签：普通笔记' }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('笔记标题')).toHaveValue('普通笔记');
  });
});

function selectText(element: HTMLElement, start: number, end: number) {
  restoreSelectionByOffsets(element, start, end);
  fireEvent.mouseUp(element);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

async function insertFromMenu(
  user: ReturnType<typeof userEvent.setup>,
  trigger: HTMLElement,
  name: RegExp | string,
) {
  await user.click(trigger);
  const menu = await screen.findByRole('menu', { name: '插入块' });
  await user.click(within(menu).getByRole('menuitem', { name }));
}

describe('知识页 · 块编辑器接线', () => {
  it('正文使用块编辑器：无固定格式栏，空块显示 ＋、非空块显示 ⠿', async () => {
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-editor-ui',
        title: '块编辑器接线',
        updatedAt: '2026-10-25T08:00:00.000Z',
      }),
    ]);
    const blocks = createFakeBlockSource([
      makeBlock({
        id: 'non-empty',
        noteId: 'note-editor-ui',
        type: 'paragraph',
        payload: { runs: [{ text: '已有内容' }] },
      }),
      makeBlock({
        id: 'empty',
        noteId: 'note-editor-ui',
        type: 'paragraph',
        orderKey: 2048,
        payload: { runs: [] },
      }),
    ]);

    renderKnowledge(source, '/knowledge', blocks);

    expect(
      await screen.findByRole('button', { name: '块操作' }),
    ).toHaveTextContent('⠿');
    expect(
      screen.getByRole('button', { name: '插入内容' }),
    ).toHaveTextContent('＋');
    expect(
      screen.getByRole('region', { name: '块编辑器' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('textbox', { name: '笔记正文' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: '文字格式' })).toBeNull();
  });

  it('页脚「保存状态 + 字数」旁有撤销/重做，且不新增工具轨条目', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-history',
        title: '撤销页脚',
        body: '',
        updatedAt: '2026-10-25T08:00:00.000Z',
      }),
    ]);
    const blocks = createFakeBlockSource([
      makeBlock({
        id: 'history-paragraph',
        noteId: 'note-history',
        type: 'paragraph',
        payload: { runs: [{ text: '原文' }] },
      }),
    ]);
    renderKnowledge(source, '/knowledge', blocks, undefined, undefined, undefined, {
      manager: null,
      uploader: null,
    });

    const textbox = await screen.findByRole('textbox', { name: '正文' });
    const undo = screen.getByRole('button', { name: '撤销编辑' });
    const redo = screen.getByRole('button', { name: '重做编辑' });
    // 知识页把按钮放在自己的页脚：编辑器内不再渲染第二组。
    expect(screen.getAllByRole('button', { name: '撤销编辑' })).toHaveLength(1);
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();

    textbox.textContent = '原文改';
    fireEvent.input(textbox);
    // 全量并行跑时编辑器历史状态偶尔晚于默认 1s 断言窗口。
    await waitFor(() => {
      expect(undo).toBeEnabled();
    }, { timeout: 3000 });

    await user.click(undo);
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: '正文' })).toHaveTextContent(
        '原文',
      );
    });
    const redoButton = screen.getByRole('button', { name: '重做编辑' });
    expect(redoButton).toBeEnabled();
    await user.click(redoButton);
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: '正文' })).toHaveTextContent(
        '原文改',
      );
    });

    // 右栏 9 项 + 折叠按钮；文档动作仍集中在命令栏与菜单，不回到正文。
    const rail = screen.getByRole('navigation', { name: '笔记面板' });
    const railItems = Array.from(rail.querySelectorAll('button')).filter(
      (button) => !button.classList.contains('kn-rail-toggle'),
    );
    expect(railItems).toHaveLength(9);
    expect(
      rail.querySelector('.kn-rail-toggle'),
    ).not.toBeNull();
  });

  it('插入 H2/待办/表格/代码/文件卡，卸载重挂后仍在，并同步 HTML 缓存', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-block-persist',
        title: '块持久化',
        body: '',
        updatedAt: '2026-10-25T08:00:00.000Z',
      }),
    ]);
    const blocks = createFakeBlockSource();
    const attachments = createAttachmentHarness();
    const view = renderKnowledge(
      source,
      '/knowledge',
      blocks,
      undefined,
      undefined,
      undefined,
      attachments,
    );

    const firstPlus = await screen.findByRole('button', {
      name: '插入内容',
    });
    await insertFromMenu(user, firstPlus, /标题 2/);
    const heading = await screen.findByRole('textbox', { name: '标题 2' });
    await user.type(heading, '验收标题');

    await insertFromMenu(
      user,
      screen.getByRole('button', { name: '块操作' }),
      /待办事项/,
    );
    expect(
      await screen.findByRole('checkbox', { name: '标记完成' }),
    ).toBeInTheDocument();

    await insertFromMenu(
      user,
      screen.getAllByRole('button', { name: '插入内容' }).at(-1) as HTMLElement,
      /^表格/,
    );
    expect(await screen.findByRole('group', { name: '表格' })).toBeInTheDocument();

    await insertFromMenu(
      user,
      screen.getAllByRole('button', { name: '插入内容' }).at(-1) as HTMLElement,
      /代码块/,
    );
    const code = await screen.findByLabelText('代码内容');
    fireEvent.change(code, { target: { value: 'const answer = 42;' } });

    await insertFromMenu(
      user,
      screen.getAllByRole('button', { name: '插入内容' }).at(-1) as HTMLElement,
      /文件 \/ 图片/,
    );
    fireEvent.change(screen.getByLabelText('选择文件'), {
      target: { files: [new File(['hello'], '验收方案.docx')] },
    });
    expect(
      await screen.findByRole('group', { name: '文件卡：验收方案.docx' }),
    ).toBeInTheDocument();

    await waitFor(
      () => {
        const types = blocks
          .snapshot(false, 'note-block-persist')
          .map((block) => block.type);
        expect(types).toEqual(
          expect.arrayContaining([
            'heading2',
            'todo',
            'table',
            'code',
            'file',
          ]),
        );
      },
      { timeout: 4000 },
    );

    await waitFor(
      () => {
        const body = noteById(source, 'note-block-persist').body;
        expect(body).toContain('<h2>验收标题</h2>');
        expect(body).toContain('<table>');
        expect(body).toContain('验收方案.docx');
      },
      { timeout: 4000 },
    );

    view.unmount();
    renderKnowledge(
      source,
      '/knowledge',
      blocks,
      undefined,
      undefined,
      undefined,
      attachments,
    );

    expect(await screen.findByText('验收标题')).toBeInTheDocument();
    expect(
      await screen.findByRole('checkbox', { name: '标记完成' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('group', { name: '表格' }),
    ).toBeInTheDocument();
    expect(await screen.findByLabelText('代码内容')).toHaveValue(
      'const answer = 42;',
    );
    expect(
      await screen.findByRole('group', { name: '文件卡：验收方案.docx' }),
    ).toBeInTheDocument();
  }, 15000);

  it('选中文字出现浮动划词条，B 写入结构化 runs', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-format',
        title: '划词测试',
        body: '<p>划词测试</p>',
        updatedAt: '2026-10-25T08:00:00.000Z',
      }),
    ]);
    const blocks = createFakeBlockSource();
    renderKnowledge(source, '/knowledge', blocks);

    const textbox = await screen.findByRole('textbox', { name: '正文' });
    expect(screen.queryByRole('toolbar', { name: '文字格式' })).toBeNull();
    selectText(textbox, 0, 2);

    const toolbar = await screen.findByRole('toolbar', {
      name: '文字格式',
    });
    await user.click(within(toolbar).getByRole('button', { name: '粗体' }));
    await waitFor(() => {
      expect(textbox.innerHTML).toContain('<strong>划词</strong>');
    });
    await waitFor(
      () => {
        const paragraph = blocks
          .snapshot(false, 'note-format')
          .find((block) => block.type === 'paragraph');
        expect(paragraph?.payload.runs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              text: '划词',
              marks: expect.objectContaining({ bold: true }),
            }),
          ]),
        );
      },
      { timeout: 4000 },
    );
  });

  it('表格脏数据与文件缺失在页面上有可见失败态', async () => {
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-broken',
        title: '损坏块',
        updatedAt: '2026-10-25T08:00:00.000Z',
      }),
    ]);
    const blocks = createFakeBlockSource([
      makeBlock({
        id: 'broken-table',
        noteId: 'note-broken',
        type: 'table',
        payload: { rows: 'bad' },
      }),
      makeBlock({
        id: 'missing-file',
        noteId: 'note-broken',
        type: 'file',
        orderKey: 2048,
        payload: {
          fileName: '丢失.pdf',
          byteSize: 0,
          mime: 'application/pdf',
          attachmentId: null,
          status: 'missing',
        },
      }),
    ]);
    renderKnowledge(source, '/knowledge', blocks);

    expect(await screen.findByText(/表格数据异常/)).toBeInTheDocument();
    expect(screen.getByText('文件缺失')).toBeInTheDocument();
  });
});

describe('知识页 · 笔记待办（AUD-003）', () => {
  const NOTE_ID = 'note-todos';
  const WORK_LISTS = [
    makeFakeList({ id: 'inbox', name: '收件箱', isInbox: true, sortOrder: 0 }),
    makeFakeList({ id: 'work', name: '工作', sortOrder: 10 }),
  ];

  function todoNote() {
    return createFakeNoteSource([
      makeNote({
        id: NOTE_ID,
        title: '待办笔记',
        body: '<p>正文内容</p>',
        updatedAt: '2026-10-27T08:00:00.000Z',
      }),
    ]);
  }

  it('正文块菜单插入待办后，文末汇总与 note_todos 同步出现', async () => {
    const user = userEvent.setup();
    const source = todoNote();
    const blocks = createFakeBlockSource();
    const noteTodos = createFakeNoteTodoSource();
    const tasks = createFakeTodoTaskSource([], WORK_LISTS);

    renderKnowledge(source, '/knowledge', blocks, undefined, noteTodos, tasks);

    await user.click(
      await screen.findByRole('button', { name: '块操作' }),
    );
    await user.click(
      within(await screen.findByRole('menu', { name: '插入块' })).getByRole(
        'menuitem',
        { name: /待办事项/ },
      ),
    );

    const todoText = await screen.findByRole('textbox', {
      name: '待办内容',
    });
    await user.type(todoText, '新待办');

    expect(await screen.findByText('0/1 已完成')).toBeInTheDocument();
    await waitFor(() => {
      expect(noteTodos.snapshot(false).map((todo) => todo.title)).toEqual([
        '新待办',
      ]);
    });
    expect(tasks.snapshotTasks(false)).toHaveLength(0);
  });

  it('正文内联待办与文末汇总共用 note_todos；勾选不镜像关联任务', async () => {
    const user = userEvent.setup();
    const source = todoNote();
    const blocks = createFakeBlockSource([
      todoBlockFor(NOTE_ID, 'todo-block-1', '写验收清单', {
        todoId: 'todo-1',
      }),
    ]);
    const noteTodos = createFakeNoteTodoSource([
      makeNoteTodo({
        id: 'todo-1',
        noteId: NOTE_ID,
        title: '写验收清单',
        taskId: 'task-a',
      }),
    ]);
    const tasks = createFakeTodoTaskSource(
      [makeFakeTask({ id: 'task-a', title: '整理验收清单', listId: 'work' })],
      WORK_LISTS,
    );

    renderKnowledge(source, '/knowledge', blocks, undefined, noteTodos, tasks);

    expect(await screen.findByText('0/1 已完成')).toBeInTheDocument();
    expect(noteTodos.snapshot(false)).toHaveLength(1);

    // 勾选正文内联待办：汇总立即同源变化。
    await user.click(screen.getByRole('checkbox', { name: '标记完成' }));
    expect(await screen.findByText('1/1 已完成')).toBeInTheDocument();
    const doneTodo = noteTodos.snapshot(false)[0];
    expect(doneTodo.done).toBe(true);
    expect(doneTodo.taskId).toBe('task-a');

    // 只改 note_todos.done，不镜像关联任务状态。
    const linkedTask = tasks
      .snapshotTasks(false)
      .find((task) => task.id === 'task-a');
    expect(linkedTask?.status).toBe('todo');
    expect(linkedTask?.completedAt).toBeNull();

    // 汇总勾选走同一个 todo：取消完成，正文 checkbox 同步。
    await user.click(
      screen.getByRole('checkbox', { name: '标记未完成：写验收清单' }),
    );
    expect(await screen.findByText('0/1 已完成')).toBeInTheDocument();
    expect(noteTodos.snapshot(false)[0].done).toBe(false);
    expect(
      screen.getByRole('checkbox', { name: '标记完成' }),
    ).toHaveAttribute('aria-checked', 'false');
  });

  it('汇总删除待办 → 正文消失；5 秒窗口内撤销恢复正文与关联任务', async () => {
    const user = userEvent.setup();
    const source = todoNote();
    const blocks = createFakeBlockSource([
      todoBlockFor(NOTE_ID, 'todo-block-1', '写验收清单', {
        todoId: 'todo-1',
      }),
    ]);
    const noteTodos = createFakeNoteTodoSource([
      makeNoteTodo({
        id: 'todo-1',
        noteId: NOTE_ID,
        title: '写验收清单',
        taskId: 'task-a',
      }),
    ]);
    const tasks = createFakeTodoTaskSource(
      [makeFakeTask({ id: 'task-a', title: '整理验收清单', listId: 'work' })],
      WORK_LISTS,
    );

    const { container } = renderKnowledge(
      source,
      '/knowledge',
      blocks,
      undefined,
      noteTodos,
      tasks,
    );

    expect(await screen.findByText('0/1 已完成')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: '删除待办：写验收清单' }),
    );

    await waitFor(() => {
      expect(screen.queryByLabelText('本篇待办')).toBeNull();
    });
    expect(container.querySelector('[data-block-type="todo"]')).toBeNull();
    expect(noteTodos.snapshot(false)).toHaveLength(0);
    expect(
      tasks.snapshotTasks(true).find((task) => task.id === 'task-a')?.deletedAt,
    ).toBeNull();

    // 撤销窗口是真实的 5 秒提示，不是静默删除。
    expect(screen.getByText('5 秒内可撤销')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '撤销' }));

    expect(await screen.findByText('0/1 已完成')).toBeInTheDocument();
    expect(container.querySelector('[data-block-type="todo"]')).not.toBeNull();
    const restored = noteTodos.snapshot(false);
    expect(restored).toHaveLength(1);
    expect(restored[0].title).toBe('写验收清单');
    expect(restored[0].taskId).toBe('task-a');
    expect(
      tasks.snapshotTasks(true).find((task) => task.id === 'task-a')?.deletedAt,
    ).toBeNull();
  });

  it('汇总点击标题 → 正文块滚动并短暂高亮', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    const descriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView',
    );
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const source = todoNote();
      const blocks = createFakeBlockSource([
        todoBlockFor(NOTE_ID, 'todo-block-1', '定位我', { todoId: 'todo-1' }),
      ]);
      const noteTodos = createFakeNoteTodoSource([
        makeNoteTodo({ id: 'todo-1', noteId: NOTE_ID, title: '定位我' }),
      ]);
      const { container } = renderKnowledge(
        source,
        '/knowledge',
        blocks,
        undefined,
        noteTodos,
      );

      expect(await screen.findByText('0/1 已完成')).toBeInTheDocument();
      await user.click(
        screen.getByRole('button', { name: '定位待办：定位我' }),
      );

      expect(scrollIntoView).toHaveBeenCalled();
      expect(
        container
          .querySelector('[data-block-type="todo"]')
          ?.classList.contains('zxt-locate-flash'),
      ).toBe(true);
    } finally {
      if (descriptor) {
        Object.defineProperty(
          Element.prototype,
          'scrollIntoView',
          descriptor,
        );
      } else {
        delete (Element.prototype as { scrollIntoView?: unknown })
          .scrollIntoView;
      }
    }
  });

  it('显式关联已有任务；勾选待办不改任务，解除后任务保留', async () => {
    const user = userEvent.setup();
    const source = todoNote();
    const blocks = createFakeBlockSource([
      todoBlockFor(NOTE_ID, 'todo-block-1', '写验收清单', {
        todoId: 'todo-1',
      }),
    ]);
    const noteTodos = createFakeNoteTodoSource([
      makeNoteTodo({ id: 'todo-1', noteId: NOTE_ID, title: '写验收清单' }),
    ]);
    const tasks = createFakeTodoTaskSource(
      [makeFakeTask({ id: 'task-a', title: '整理验收清单', listId: 'work' })],
      WORK_LISTS,
    );

    renderKnowledge(source, '/knowledge', blocks, undefined, noteTodos, tasks);

    expect(await screen.findByText('0/1 已完成')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: '关联任务：写验收清单' }),
    );
    await user.selectOptions(
      await screen.findByLabelText('选择已有任务'),
      'task-a',
    );
    await user.click(screen.getByRole('button', { name: '保存关联' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(noteTodos.snapshot(false)[0].taskId).toBe('task-a');
    const linked = await screen.findByRole('button', {
      name: /已关联任务：整理验收清单/,
    });

    await user.click(screen.getByRole('checkbox', { name: '标记完成' }));
    await screen.findByText('1/1 已完成');
    const linkedTask = tasks
      .snapshotTasks(false)
      .find((task) => task.id === 'task-a');
    expect(linkedTask?.status).toBe('todo');

    await user.click(linked);
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: '解除关联',
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(noteTodos.snapshot(false)[0].taskId).toBeNull();
    expect(
      tasks.snapshotTasks(true).find((task) => task.id === 'task-a')?.deletedAt,
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: '关联任务：写验收清单' }),
    ).toBeInTheDocument();
  });

  it('正文删除待办块后，文末汇总同步移除对应 note_todo', async () => {
    const user = userEvent.setup();
    const source = todoNote();
    const blocks = createFakeBlockSource([
      todoBlockFor(NOTE_ID, 'todo-block-1', '删除我', {
        todoId: 'todo-1',
        orderKey: 1024,
      }),
      todoBlockFor(NOTE_ID, 'todo-block-2', '保留我', {
        todoId: 'todo-2',
        orderKey: 2048,
      }),
    ]);
    const noteTodos = createFakeNoteTodoSource([
      makeNoteTodo({
        id: 'todo-1',
        noteId: NOTE_ID,
        title: '删除我',
        sortOrder: 0,
      }),
      makeNoteTodo({
        id: 'todo-2',
        noteId: NOTE_ID,
        title: '保留我',
        sortOrder: 1,
      }),
    ]);

    const { container } = renderKnowledge(
      source,
      '/knowledge',
      blocks,
      undefined,
      noteTodos,
    );

    expect(await screen.findByText('0/2 已完成')).toBeInTheDocument();
    const controls = screen.getAllByRole('button', { name: '块操作' });
    await user.click(controls[0]);
    await user.click(screen.getByRole('menuitem', { name: '删除块' }));

    await waitFor(
      () => {
        expect(screen.getByText('0/1 已完成')).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(
      screen.queryByRole('button', { name: '定位待办：删除我' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: '定位待办：保留我' }),
    ).toBeInTheDocument();
    expect(noteTodos.snapshot(false).map((todo) => todo.title)).toEqual([
      '保留我',
    ]);
    expect(
      container.querySelectorAll('[data-block-type="todo"]'),
    ).toHaveLength(1);
  });

  it('阅读模式下汇总只读，不能勾选或删除待办', async () => {
    const user = userEvent.setup();
    const source = todoNote();
    const blocks = createFakeBlockSource([
      todoBlockFor(NOTE_ID, 'todo-block-1', '阅读待办', {
        todoId: 'todo-1',
      }),
    ]);
    const noteTodos = createFakeNoteTodoSource([
      makeNoteTodo({ id: 'todo-1', noteId: NOTE_ID, title: '阅读待办' }),
    ]);

    renderKnowledge(source, '/knowledge', blocks, undefined, noteTodos);

    expect(await screen.findByText('0/1 已完成')).toBeInTheDocument();
    fireEvent.keyDown(document, {
      key: 'R',
      shiftKey: true,
      metaKey: true,
    });

    expect(
      await screen.findByRole('button', { name: '进入编辑模式' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('checkbox', { name: '标记完成：阅读待办' }),
    ).toBeDisabled();
    expect(
      await screen.findByRole('button', { name: '删除待办：阅读待办' }),
    ).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '进入编辑模式' }));
    expect(
      await screen.findByRole('button', { name: '删除待办：阅读待办' }),
    ).toBeEnabled();
  });
});

describe('知识页 · 命令栏与右栏入口（ZX-DESIGN-15）', () => {
  // 右栏 9 项（ZX-DESIGN-15 §3.1）：阅读/编辑、样式、链接、大纲、信息、附件、
  // 专注、新建画板、全屏阅读。命令栏保持 5 个文档级命令，≤900 用「工具」抽屉。
  const RAIL_LABELS = [
    '阅读模式',
    '样式',
    '笔记链接',
    '大纲',
    '笔记信息',
    '附件',
    '专注模式',
    '新建画板',
    '全屏阅读',
  ];

  function singleNote() {
    return createFakeNoteSource([
      makeNote({
        id: 'note-rail',
        title: '工具轨笔记',
        body: '<h2>背景</h2><p>正文</p><h3>结论</h3>',
        updatedAt: '2026-10-27T08:00:00.000Z',
      }),
    ]);
  }

  function railBlocks() {
    return createFakeBlockSource([
      makeBlock({
        id: 'head-1',
        noteId: 'note-rail',
        type: 'heading2',
        payload: { runs: [{ text: '背景' }] },
      }),
      makeBlock({
        id: 'body-1',
        noteId: 'note-rail',
        type: 'paragraph',
        orderKey: 2048,
        payload: { runs: [{ text: '正文' }] },
      }),
      makeBlock({
        id: 'head-2',
        noteId: 'note-rail',
        type: 'heading3',
        orderKey: 3072,
        payload: { runs: [{ text: '结论' }] },
      }),
      makeBlock({
        id: 'file-1',
        noteId: 'note-rail',
        type: 'file',
        orderKey: 4096,
        payload: {
          attachmentId: null,
          fileName: '验收方案.docx',
          byteSize: 2048,
          mime:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          status: 'local',
        },
      }),
    ]);
  }

  it('窄窗右栏改为「工具」抽屉，9 项仍可用而不是消失', async () => {
    const user = userEvent.setup();
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('900px'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    try {
      renderKnowledge(singleNote(), '/knowledge', createFakeBlockSource());
      await screen.findByRole('button', { name: '打开笔记：工具轨笔记' });

      // 窄屏不渲染常驻右栏，但入口升级为「工具」抽屉。
      expect(
        screen.queryByRole('navigation', { name: '笔记面板' }),
      ).not.toBeInTheDocument();

      const commandbar = screen.getByRole('toolbar', { name: '文档命令' });
      expect(
        within(commandbar).queryByRole('button', { name: '插入链接' }),
      ).not.toBeInTheDocument();
      const tools = within(commandbar).getByRole('button', {
        name: '工具',
      });
      expect(tools).toHaveAttribute('aria-haspopup', 'dialog');
      expect(tools).toHaveAttribute('aria-expanded', 'false');

      const more = within(commandbar).getByRole('button', {
        name: '更多文档操作',
      });
      await user.click(more);
      expect(
        within(await screen.findByRole('menu', { name: '更多' })).getByRole(
          'menuitem',
          { name: /插入链接/ },
        ),
      ).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByRole('menu', { name: '更多' })).toBeNull();
      });

      await user.click(tools);
      const drawer = await screen.findByRole('dialog', { name: '笔记工具' });
      expect(tools).toHaveAttribute('aria-expanded', 'true');
      expect(
        screen.queryByRole('menu', { name: '面板' }),
      ).not.toBeInTheDocument();
      const rows = Array.from(drawer.querySelectorAll('.kn-drawer-row'));
      expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(
        RAIL_LABELS,
      );

      // 面板项执行后关闭抽屉，面板以窄屏覆盖层出现。
      await user.click(within(drawer).getByRole('button', { name: '大纲' }));
      expect(
        screen.queryByRole('dialog', { name: '笔记工具' }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole('complementary', { name: '笔记大纲' }),
      ).toBeInTheDocument();
      expect(tools).toHaveFocus();

      // Esc 关闭抽屉，焦点归还「工具」按钮。
      await user.click(tools);
      await screen.findByRole('dialog', { name: '笔记工具' });
      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(
          screen.queryByRole('dialog', { name: '笔记工具' }),
        ).not.toBeInTheDocument();
      });
      expect(tools).toHaveFocus();
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: original,
      });
    }
  });

  it('桌面右栏 9 项按契约顺序触发对应状态', async () => {
    const user = userEvent.setup();
    const source = singleNote();
    const blocks = createFakeBlockSource([
      makeBlock({
        id: 'rail-body',
        noteId: 'note-rail',
        type: 'paragraph',
        payload: { runs: [{ text: '右栏正文' }] },
      }),
    ]);
    const boards = createFakeBoardSource();
    const { container } = renderKnowledge(
      source,
      '/knowledge',
      blocks,
      boards.source,
    );

    await screen.findByRole('button', { name: '打开笔记：工具轨笔记' });
    const rail = screen.getByRole('navigation', { name: '笔记面板' });
    const items = Array.from(rail.querySelectorAll('button')).filter(
      (button) => !button.classList.contains('kn-rail-toggle'),
    );
    expect(items.map((button) => button.getAttribute('aria-label'))).toEqual(
      RAIL_LABELS,
    );

    // 1. 阅读/编辑：aria-label、aria-pressed 与只读态同步。
    const reading = within(rail).getByRole('button', { name: '阅读模式' });
    expect(reading).toHaveAttribute('aria-pressed', 'false');
    await user.click(reading);
    expect(
      within(rail).getByRole('button', { name: '编辑模式' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('笔记标题')).toHaveAttribute('readonly');
    await user.click(
      within(rail).getByRole('button', { name: '编辑模式' }),
    );
    expect(screen.getByLabelText('笔记标题')).not.toHaveAttribute('readonly');

    // 2. 样式：复用编辑器 StylePanel，可开可关。
    const style = within(rail).getByRole('button', { name: '样式' });
    await user.click(style);
    expect(
      screen.getByRole('complementary', { name: '样式面板' }),
    ).toBeInTheDocument();
    expect(style).toHaveAttribute('aria-pressed', 'true');
    await user.click(style);
    expect(
      screen.queryByRole('complementary', { name: '样式面板' }),
    ).not.toBeInTheDocument();
    expect(style).toHaveAttribute('aria-pressed', 'false');

    // 3–6. 四个面板互斥替换。
    await user.click(within(rail).getByRole('button', { name: '笔记链接' }));
    expect(
      screen.getByRole('complementary', { name: '笔记链接' }),
    ).toBeInTheDocument();
    await user.click(within(rail).getByRole('button', { name: '大纲' }));
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();
    await user.click(
      within(rail).getByRole('button', { name: '笔记信息' }),
    );
    expect(
      screen.getByRole('complementary', { name: '笔记信息' }),
    ).toBeInTheDocument();
    await user.click(within(rail).getByRole('button', { name: '附件' }));
    expect(
      screen.getByRole('complementary', { name: '附件' }),
    ).toBeInTheDocument();

    // 7. 专注：跨笔记保持的状态机原样接线。
    const focus = within(rail).getByRole('button', { name: '专注模式' });
    await user.click(focus);
    expect(focus).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('.kn-workspace')).toHaveClass('is-focus');
    await user.click(focus);
    expect(focus).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('.kn-workspace')).not.toHaveClass(
      'is-focus',
    );

    // 9. 全屏阅读：沿用现有沉浸状态机与 Esc 退出。
    await user.click(
      within(rail).getByRole('button', { name: '全屏阅读' }),
    );
    expect(container.querySelector('.knowledge-shell')).toHaveClass(
      'is-immersive',
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(container.querySelector('.knowledge-shell')).not.toHaveClass(
        'is-immersive',
      );
    });

    // 8. 新建画板：写真实笔记/画板并导航到画板深链。
    await user.click(
      within(rail).getByRole('button', { name: '新建画板' }),
    );
    expect(
      await screen.findByRole('heading', { name: '画板工作区' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(boards.created).toHaveLength(1);
    });
  });

  it('键盘可完成格式化、插入、面板开关与导出', async () => {
    const user = userEvent.setup();
    const source = singleNote();
    renderKnowledge(
      source,
      '/knowledge',
      createFakeBlockSource([
        makeBlock({
          id: 'kb-1',
          noteId: 'note-rail',
          type: 'paragraph',
          payload: { runs: [{ text: '键盘格式' }] },
        }),
      ]),
    );

    // 格式化：选中文字后 Ctrl+B，走结构化 runs。
    const textbox = await screen.findByRole('textbox', { name: '正文' });

    // Alt+F10 把焦点送到命令栏第一个命令。
    fireEvent.keyDown(window, { key: 'F10', altKey: true });
    expect(
      screen.getByRole('button', { name: /样式菜单/ }),
    ).toHaveFocus();

    selectText(textbox, 0, 2);
    fireEvent.keyDown(textbox, { key: 'b', ctrlKey: true });
    await waitFor(() => {
      expect(textbox.innerHTML).toContain('<strong>键盘</strong>');
    });

    // 面板开关：聚焦右栏按钮后用 Enter 切换。
    const rail = screen.getByRole('navigation', { name: '笔记面板' });
    const outline = within(rail).getByRole('button', { name: '大纲' });
    outline.focus();
    await user.keyboard('{Enter}');
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(
      screen.queryByRole('complementary', { name: '笔记大纲' }),
    ).not.toBeInTheDocument();

    // 插入：⇧⌘I 打开菜单，方向键 + Enter 选择「标题 2」。
    fireEvent.keyDown(window, {
      key: 'I',
      ctrlKey: true,
      shiftKey: true,
    });
    await screen.findByRole('menu', { name: '插入块' });
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => {
      expect(document.querySelector('h2')).not.toBeNull();
    });

    // 导出：⇧⌘E 打开同一个导出面板。
    fireEvent.keyDown(window, {
      key: 'E',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(
      await screen.findByRole('dialog', { name: /导出「工具轨笔记」/ }),
    ).toBeInTheDocument();
  });

  it('右栏 9 项全部可用，命令栏/菜单保留文档级入口；分享/评论已移除', async () => {
    const user = userEvent.setup();
    const source = singleNote();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const write = vi.fn().mockResolvedValue(undefined);
    const picker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({
        write,
        close: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn(),
      }),
    });
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    });

    try {
      renderKnowledge(source, '/knowledge', createFakeBlockSource());

      await screen.findByRole('button', { name: '打开笔记：工具轨笔记' });

      // 顶部命令栏只保留 5 个文档级入口。
      const commandbar = screen.getByRole('toolbar', { name: '文档命令' });
      for (const name of [
        /样式菜单/,
        '插入菜单',
        '插入链接',
        '导出笔记',
        '更多文档操作',
      ]) {
        expect(
          within(commandbar).getByRole('button', { name }),
          `命令栏缺少入口：${String(name)}`,
        ).toBeEnabled();
      }

      // 右栏恢复 9 项（阅读/编辑、样式、链接、大纲、信息、附件、专注、画板、全屏）。
      const rail = screen.getByRole('navigation', { name: '笔记面板' });
      for (const label of RAIL_LABELS) {
        expect(
          within(rail).getByRole('button', { name: label }),
          `右栏缺少入口：${label}`,
        ).toBeEnabled();
      }

      // 低频文档动作收在「更多」，菜单打开后焦点进入首项、Esc 归还触发按钮。
      const more = within(commandbar).getByRole('button', {
        name: '更多文档操作',
      });
      await user.click(more);
      const moreMenu = await screen.findByRole('menu', { name: '更多' });
      for (const label of [/阅读模式/, /专注模式/, /全屏阅读/]) {
        expect(
          within(moreMenu).getByRole('menuitem', { name: label }),
          `更多菜单缺少：${String(label)}`,
        ).toBeInTheDocument();
      }
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByRole('menu', { name: '更多' })).toBeNull();
      });
      expect(more).toHaveFocus();

      // 新建画板收在插入菜单。
      await user.click(
        within(commandbar).getByRole('button', { name: '插入菜单' }),
      );
      const insertMenu = await screen.findByRole('menu', { name: '插入块' });
      expect(
        within(insertMenu).getByRole('menuitem', { name: /画板/ }),
      ).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      await waitFor(() => {
        expect(screen.queryByRole('menu', { name: '插入块' })).toBeNull();
      });

      expect(
        screen.queryByRole('button', { name: '分享' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: '评论' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('complementary', { name: '分享' }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('complementary', { name: '评论' }),
      ).not.toBeInTheDocument();

      await user.click(
        within(rail).getByRole('button', { name: '笔记链接' }),
      );
      const links = screen.getByRole('complementary', { name: '笔记链接' });
      const copy = within(links).getByRole('button', {
        name: '复制笔记内链',
      });
      expect(copy).toBeEnabled();
      await user.click(copy);
      expect(writeText).toHaveBeenCalledWith('zhixing://note/note-rail');
      expect(await screen.findByText('已复制笔记内链')).toBeInTheDocument();

      // 导出菜单直接选 Markdown，进入同一个导出面板。
      await user.click(
        within(commandbar).getByRole('button', { name: '导出笔记' }),
      );
      await user.click(
        within(await screen.findByRole('menu', { name: '导出' })).getByRole(
          'menuitem',
          { name: 'Markdown（.md）' },
        ),
      );
      const exportDialog = await screen.findByRole('dialog', {
        name: /导出「工具轨笔记」/,
      });
      await user.click(
        within(exportDialog).getByRole('button', { name: '继续' }),
      );
      expect(
        await screen.findByRole('dialog', { name: '已导出 Markdown' }),
      ).toBeInTheDocument();
      expect(picker).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedName: '工具轨笔记.md' }),
      );
      expect(write).toHaveBeenCalledTimes(1);
      expect(anchorClick).not.toHaveBeenCalled();
    } finally {
      anchorClick.mockRestore();
      delete (navigator as unknown as { clipboard?: unknown }).clipboard;
      delete (window as Window & { showSaveFilePicker?: unknown })
        .showSaveFilePicker;
    }
  });

  it('右栏 9 项使用统一 SVG 图标；命令栏不堆格式按钮', async () => {
    // 视觉规范 §2.6：工具轨可见文本中不得再出现原始 Unicode 字形。
    const banned =
      /[⌖✋▭▢○◇▤▥▦↗✦╱⌐⌒↶↷⇤↔⇥⇧↕⇩⌫◐✎⌸◌◉≡▧⛶⇄☰ⓘ⌁‹›⠿＋]/u;
    renderKnowledge(singleNote(), '/knowledge', railBlocks());

    await screen.findByRole('button', { name: '打开笔记：工具轨笔记' });
    const rail = screen.getByRole('navigation', { name: '笔记面板' });

    const buttons = Array.from(rail.querySelectorAll('button'));
    const toggle = buttons.filter((button) =>
      button.classList.contains('kn-rail-toggle'),
    );
    const items = buttons.filter(
      (button) => !button.classList.contains('kn-rail-toggle'),
    );
    expect(toggle).toHaveLength(1);
    expect(items).toHaveLength(9);

    for (const button of items) {
      expect(button.getAttribute('aria-label')?.trim()).toBeTruthy();
      expect(button.getAttribute('title')?.trim()).toBeTruthy();

      const svg = button.querySelector('svg');
      expect(
        svg,
        `${button.getAttribute('aria-label')} 缺少 SVG`,
      ).not.toBeNull();
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
      expect(svg).toHaveAttribute('fill', 'none');
      expect(svg).toHaveAttribute('stroke', 'currentColor');
      expect(svg).toHaveAttribute('stroke-width', '1.5');
      expect(svg).toHaveAttribute('width', '16');
      expect(svg).toHaveAttribute('height', '16');
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg?.getAttribute('data-icon')).toMatch(/^(note|common)-/);
    }

    expect(rail.textContent ?? '').not.toMatch(banned);
    expect(rail.querySelectorAll('.kn-rail-title')).toHaveLength(0);
    expect(
      Array.from(rail.querySelectorAll('.kn-rail-caption')).map(
        (node) => node.textContent,
      ),
    ).toEqual([
      '阅读',
      '样式',
      '链接',
      '大纲',
      '信息',
      '附件',
      '专注',
      '画板',
      '全屏',
    ]);

    // 命令栏只有 5 个文档级命令，不再常驻 B/I/U/S 等格式按钮。
    const commandbar = screen.getByRole('toolbar', { name: '文档命令' });
    expect(within(commandbar).getAllByRole('button')).toHaveLength(5);
    for (const name of ['加粗', '斜体', '下划线', '删除线']) {
      expect(
        within(commandbar).queryByRole('button', { name }),
      ).not.toBeInTheDocument();
    }

    // ⇧⌘R 切换阅读后，命令栏出现主按钮「编辑」。
    fireEvent.keyDown(document, {
      key: 'R',
      shiftKey: true,
      metaKey: true,
    });
    expect(
      await screen.findByRole('button', { name: '进入编辑模式' }),
    ).toBeInTheDocument();
  });

  it('阅读模式真实只读，返回编辑后恢复；样式面板由右栏打开', async () => {
    const user = userEvent.setup();
    const source = singleNote();
    const { container } = renderKnowledge(
      source,
      '/knowledge',
      createFakeBlockSource([
        makeBlock({
          id: 'style-body',
          noteId: 'note-rail',
          type: 'paragraph',
          payload: { runs: [{ text: '样式面板' }] },
        }),
      ]),
    );

    const title = await screen.findByLabelText('笔记标题');
    expect(title).not.toHaveAttribute('readonly');

    fireEvent.keyDown(document, {
      key: 'R',
      shiftKey: true,
      metaKey: true,
    });
    expect(
      await screen.findByRole('button', { name: '进入编辑模式' }),
    ).toBeInTheDocument();
    expect(title).toHaveAttribute('readonly');
    expect(
      container.querySelector('.zxe'),
    ).toHaveAttribute('data-read-only', 'true');

    await user.click(
      screen.getByRole('button', { name: '进入编辑模式' }),
    );
    expect(title).not.toHaveAttribute('readonly');
    expect(
      container.querySelector('.zxe'),
    ).toHaveAttribute('data-read-only', 'false');

    // 样式是真实编辑器的 StylePanel；右栏与命令栏「Aa」共用同一 handler。
    const rail = screen.getByRole('navigation', { name: '笔记面板' });
    await user.click(within(rail).getByRole('button', { name: '样式' }));
    const stylePanel = screen.getByRole('complementary', { name: '样式面板' });

    // ZX10-STYLE-01：知识页外部右栏场景贴编辑器右缘，不再落到左上角。
    expect(container.querySelector('.zxe')).toHaveClass('zxe--external-rail');
    const stylePanelLayout = getComputedStyle(stylePanel);
    expect(stylePanelLayout.position).toBe('absolute');
    expect(stylePanelLayout.left).toBe('auto');
    expect(stylePanelLayout.right).toBe('12px');
    expect(stylePanelLayout.zIndex).toBe('var(--z-rail-flyout, 340)');

    await user.click(within(stylePanel).getByRole('button', { name: 'H1' }));
    await waitFor(() => {
      expect(container.querySelector('h1')).not.toBeNull();
    });
    // 切换块样式后仍是同一个面板、同一套右侧锚点。
    expect(getComputedStyle(stylePanel).right).toBe('12px');
    expect(getComputedStyle(stylePanel).left).toBe('auto');
    await user.click(
      within(stylePanel).getByRole('button', { name: '关闭样式面板' }),
    );
    expect(
      screen.queryByRole('complementary', { name: '样式面板' }),
    ).not.toBeInTheDocument();
  });

  it('大纲列出标题并滚动到对应块；附件列出文件卡并可插入文件', async () => {
    const user = userEvent.setup();
    const source = singleNote();
    const blocks = railBlocks();
    const attachments = createAttachmentHarness();
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const { container } = renderKnowledge(
      source,
      '/knowledge',
      blocks,
      undefined,
      undefined,
      undefined,
      attachments,
    );

    await screen.findByRole('button', { name: '打开笔记：工具轨笔记' });
    await user.click(screen.getByRole('button', { name: '大纲' }));
    const outline = screen.getByRole('complementary', { name: '笔记大纲' });
    expect(within(outline).getByText('H2 · 背景')).toBeInTheDocument();
    expect(within(outline).getByText('H3 · 结论')).toBeInTheDocument();
    await user.click(within(outline).getByText('H3 · 结论'));
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled();
    });

    await user.click(screen.getByRole('button', { name: '附件' }));
    const attachment = screen.getByRole('complementary', { name: '附件' });
    expect(attachment).toHaveTextContent('验收方案.docx');
    expect(attachment).toHaveTextContent('2.0 KB');

    await user.click(
      within(attachment).getByRole('button', { name: '＋ 在正文插入文件卡' }),
    );
    fireEvent.change(screen.getByLabelText('选择文件'), {
      target: {
        files: [new File(['pdf'], '补充材料.pdf', { type: 'application/pdf' })],
      },
    });
    await waitFor(() => {
      expect(
        blocks
          .snapshot(false, 'note-rail')
          .some((block) => block.payload.fileName === '补充材料.pdf'),
      ).toBe(true);
    });
    expect(
      (await within(attachment).findAllByText('补充材料.pdf')).length,
    ).toBeGreaterThan(0);
    const attachmentRegion = within(attachment).getByRole('region', {
      name: '笔记附件',
    });
    expect(
      await within(attachmentRegion).findByText('补充材料.pdf'),
    ).toBeInTheDocument();
    const insertedId = blocks
      .snapshot(false, 'note-rail')
      .find((block) => block.payload.fileName === '补充材料.pdf')?.payload
      .attachmentId;
    expect(insertedId).toEqual(expect.stringMatching(/^att_/));
    expect(
      within(attachmentRegion).getByLabelText('附件：补充材料.pdf'),
    ).toHaveAttribute('data-attachment-id', insertedId);
    expect(container.querySelectorAll('.zxe-file-input')).toHaveLength(1);

    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('正文文件列表按真实附件与当前模式显示：local 旧 pending 不再是待同步，无附件不冒充已保存', async () => {
    const user = userEvent.setup();
    const source = singleNote();
    const attachments = createAttachmentHarness();
    const ingested = await attachments.manager.ingest(
      new File(['legacy'], '旧附件.pdf', { type: 'application/pdf' }),
      { noteId: 'note-rail' },
    );
    await attachments.stateStore.put({
      ...defaultState(
        ingested.attachment.metadata.id,
        bytesKey(ingested.attachment.metadata.sha256),
        '2026-10-01T00:00:00.000Z',
      ),
      status: 'pending',
      lastError: null,
    });
    const blocks = createFakeBlockSource([
      makeBlock({
        id: 'file-legacy',
        noteId: 'note-rail',
        type: 'file',
        payload: {
          attachmentId: ingested.attachment.metadata.id,
          fileName: '旧附件.pdf',
          byteSize: 6,
          mime: 'application/pdf',
          status: 'pending',
        },
      }),
      makeBlock({
        id: 'file-no-attachment',
        noteId: 'note-rail',
        type: 'file',
        orderKey: 2048,
        payload: {
          attachmentId: null,
          fileName: '仅剩文件名.pdf',
          byteSize: 128,
          mime: 'application/pdf',
          status: 'pending',
        },
      }),
    ]);
    renderKnowledge(
      source,
      '/knowledge',
      blocks,
      undefined,
      undefined,
      undefined,
      { manager: attachments.manager, uploader: null },
    );

    await screen.findByRole('button', { name: '打开笔记：工具轨笔记' });
    await user.click(screen.getByRole('button', { name: '附件' }));
    const attachment = screen.getByRole('complementary', { name: '附件' });
    const fileList = attachment.querySelector('.kn-attachment-list');
    expect(fileList).not.toBeNull();

    const legacyItem = within(fileList as HTMLElement)
      .getByText('旧附件.pdf')
      .closest('li');
    expect(legacyItem).not.toBeNull();
    await waitFor(() => {
      expect(legacyItem).toHaveTextContent('本机已保存');
    });
    expect(legacyItem).not.toHaveTextContent(/待上传|待同步/);

    const noAttachmentItem = within(fileList as HTMLElement)
      .getByText('仅剩文件名.pdf')
      .closest('li');
    expect(noAttachmentItem).toHaveTextContent('仅文件信息');
    expect(noAttachmentItem).not.toHaveTextContent('本机已保存');
  });

  it('笔记附件入口挂载真实附件服务：上传、哈希展示与重新挂载后仍在', async () => {
    const user = userEvent.setup();
    const source = singleNote();
    const harness = createAttachmentHarness();
    const first = renderKnowledge(
      source,
      '/knowledge',
      railBlocks(),
      undefined,
      undefined,
      undefined,
      harness,
    );

    await screen.findByRole('button', { name: '打开笔记：工具轨笔记' });
    await user.click(screen.getByRole('button', { name: '附件' }));
    const attachment = screen.getByRole('complementary', { name: '附件' });
    const panel = await within(attachment).findByRole('region', {
      name: '笔记附件',
    });

    const file = new File([new Uint8Array([9, 8, 7, 6])], '会议纪要.txt', {
      type: 'text/plain',
    });
    const sha = await sha256Blob(file);
    fireEvent.change(within(panel).getByLabelText('选择附件文件'), {
      target: { files: [file] },
    });
    expect(await within(panel).findByText('会议纪要.txt')).toBeInTheDocument();
    expect(within(panel).getByText(sha)).toBeInTheDocument();

    await user.click(
      within(panel).getByRole('button', { name: '上传附件 会议纪要.txt' }),
    );
    expect(
      await within(panel).findByText('已同步'),
    ).toBeInTheDocument();
    expect(within(panel).getByText(sha)).toBeInTheDocument();

    first.unmount();
    renderKnowledge(
      source,
      '/knowledge',
      railBlocks(),
      undefined,
      undefined,
      undefined,
      harness,
    );
    await screen.findByRole('button', { name: '打开笔记：工具轨笔记' });
    await user.click(screen.getByRole('button', { name: '附件' }));
    const again = await screen.findByRole('region', { name: '笔记附件' });
    expect(await within(again).findByText('会议纪要.txt')).toBeInTheDocument();
    expect(within(again).getByText(sha)).toBeInTheDocument();
  });

  it('附件服务不可用时笔记附件入口给出明确提示', async () => {
    const user = userEvent.setup();
    const source = singleNote();
    renderKnowledge(
      source,
      '/knowledge',
      railBlocks(),
      undefined,
      undefined,
      undefined,
      { manager: null },
    );

    await screen.findByRole('button', { name: '打开笔记：工具轨笔记' });
    await user.click(screen.getByRole('button', { name: '附件' }));
    const attachment = screen.getByRole('complementary', { name: '附件' });
    expect(
      await within(attachment).findByText(/附件服务不可用/),
    ).toBeInTheDocument();
  });

  it('笔记链接面板列出任务、画板与反向链接', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-links',
        title: '链接笔记',
        body:
          '<div class="callout zx-task-backlink" data-task-id="task-9" data-task-title="来源任务"><p>来自任务：来源任务</p></div><h2>背景</h2>',
        updatedAt: '2026-10-27T08:00:00.000Z',
      }),
      makeNote({
        id: 'note-back',
        title: '反向来源',
        body: '<p>参见 zhixing://note/note-links</p>',
        updatedAt: '2026-10-26T08:00:00.000Z',
      }),
    ]);
    const blocks = createFakeBlockSource([
      makeBlock({
        id: 'board-ref',
        noteId: 'note-links',
        type: 'board',
        payload: { boardId: 'board-9', title: '流程画板' },
      }),
    ]);
    renderKnowledge(source, '/knowledge', blocks);

    await screen.findByRole('button', { name: '打开笔记：链接笔记' });
    await user.click(screen.getByRole('button', { name: '笔记链接' }));
    const panel = screen.getByRole('complementary', { name: '笔记链接' });
    expect(panel).toHaveTextContent('来源任务');
    expect(panel).toHaveTextContent('流程画板');
    expect(panel).toHaveTextContent('反向来源');

    await user.click(
      within(panel).getByRole('button', { name: '⌁ 反向来源' }),
    );
    expect(
      await screen.findByLabelText('笔记标题'),
    ).toHaveValue('反向来源');
  });

  it('关系图显示方向/孤立/断链，支持一跳/两跳/全部筛选与点击跳转（ZX-GRAPH-01）', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({
        id: 'graph-a',
        title: '来源笔记',
        body: [
          '<p><a href="zhixing://note/graph-b">目标</a></p>',
          '<p><a href="https://example.com/doc">外部链接不进入图</a></p>',
          '<p>zhixing://note/graph-missing</p>',
        ].join(''),
        updatedAt: '2026-10-27T08:00:00.000Z',
      }),
      makeNote({
        id: 'graph-b',
        title: '二跳来源',
        body: '<p>zhixing://note/graph-c</p>',
        updatedAt: '2026-10-26T08:00:00.000Z',
      }),
      makeNote({
        id: 'graph-c',
        title: '二跳笔记',
        body: '<p>正文</p>',
        updatedAt: '2026-10-25T08:00:00.000Z',
      }),
      makeNote({
        id: 'graph-d',
        title: '孤立笔记',
        body: '<p>没有人链接我，我也不链接别人。</p>',
        updatedAt: '2026-10-24T08:00:00.000Z',
      }),
    ]);
    renderKnowledge(source, '/knowledge?note=graph-a');

    await screen.findByLabelText('笔记标题');
    await user.click(screen.getByRole('button', { name: '笔记链接' }));
    const panel = screen.getByRole('complementary', { name: '笔记链接' });
    expect(panel).toHaveTextContent('跨应用不可跳转');
    await user.click(within(panel).getByRole('tab', { name: '关系图' }));

    const graph = within(panel).getByRole('group', { name: '笔记关系图' });
    expect(
      within(graph).getByRole('button', {
        name: /打开关系图笔记：来源笔记/,
      }),
    ).toBeInTheDocument();
    expect(
      within(graph).getByRole('button', {
        name: /打开关系图笔记：二跳来源/,
      }),
    ).toBeInTheDocument();
    expect(
      within(graph).queryByRole('button', {
        name: /打开关系图笔记：二跳笔记/,
      }),
    ).not.toBeInTheDocument();
    expect(
      within(graph).getByLabelText('断链：graph-missing'),
    ).toBeInTheDocument();
    expect(
      graph.querySelector('[data-direction="graph-a->graph-b"]'),
    ).not.toBeNull();
    expect(panel).toHaveTextContent('2 篇笔记 · 1 条内链 · 1 条断链');

    expect(graph).toHaveAttribute('data-zoom', '1.00');
    await user.click(
      within(panel).getByRole('button', { name: '放大关系图' }),
    );
    expect(graph).toHaveAttribute('data-zoom', '1.25');
    await user.click(
      within(panel).getByRole('button', { name: '重置关系图' }),
    );
    expect(graph).toHaveAttribute('data-zoom', '1.00');

    await user.click(within(panel).getByRole('button', { name: '两跳' }));
    expect(
      within(graph).getByRole('button', {
        name: /打开关系图笔记：二跳笔记/,
      }),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent('3 篇笔记 · 2 条内链');

    await user.click(within(panel).getByRole('button', { name: '全部' }));
    expect(
      within(graph).getByRole('button', {
        name: /打开关系图笔记：孤立笔记（孤立笔记）/,
      }),
    ).toBeInTheDocument();
    expect(panel).toHaveTextContent('4 篇笔记 · 2 条内链');
    expect(panel).toHaveTextContent('1 个孤立');

    await user.click(
      within(graph).getByRole('button', {
        name: /打开关系图笔记：二跳笔记/,
      }),
    );
    expect(await screen.findByLabelText('笔记标题')).toHaveValue('二跳笔记');
  });

  it('关系图没有内链时给出解释，而不是空白画布', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({
        id: 'lonely-note',
        title: '孤立笔记',
        body: '<p>还没建立任何内链。</p>',
      }),
    ]);
    renderKnowledge(source, '/knowledge?note=lonely-note');

    await screen.findByLabelText('笔记标题');
    await user.click(screen.getByRole('button', { name: '笔记链接' }));
    const panel = screen.getByRole('complementary', { name: '笔记链接' });
    await user.click(within(panel).getByRole('tab', { name: '关系图' }));

    expect(panel).toHaveTextContent('1 篇笔记 · 0 条内链');
    expect(panel).toHaveTextContent('1 个孤立');
    expect(panel).toHaveTextContent('当前笔记还没有站内内链');
    expect(panel).toHaveTextContent('外部网页链接不计入关系图');

    await user.click(within(panel).getByRole('button', { name: '全部' }));
    expect(panel).toHaveTextContent('整个知识库还没有笔记间内链');
  });

  it('插入内链后点击打开目标笔记，目标反向链接出现来源', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-a',
        title: '来源笔记',
        body: '<p>去看目标</p>',
        updatedAt: '2026-10-27T08:00:00.000Z',
      }),
      makeNote({
        id: 'note-b',
        title: '目标笔记',
        body: '<p>目标正文</p>',
        updatedAt: '2026-10-26T08:00:00.000Z',
      }),
    ]);
    const blocks = createFakeBlockSource([
      makeBlock({
        id: 'a-1',
        noteId: 'note-a',
        type: 'paragraph',
        payload: { runs: [{ text: '去看目标' }] },
      }),
    ]);
    const { container } = renderKnowledge(
      source,
      '/knowledge?note=note-a',
      blocks,
    );

    const textbox = await screen.findByRole('textbox', { name: '正文' });
    restoreSelectionByOffsets(textbox, 0, 4);
    fireEvent.mouseUp(textbox);
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    const toolbar = await screen.findByRole('toolbar', { name: '文字格式' });
    await user.click(within(toolbar).getByRole('button', { name: '链接' }));

    const dialog = await screen.findByRole('dialog', { name: '插入链接' });
    await user.click(
      within(dialog).getByRole('button', { name: '笔记内链' }),
    );
    await user.type(within(dialog).getByLabelText('搜索笔记'), '目标');
    await user.click(
      await within(dialog).findByRole('option', { name: '目标笔记' }),
    );

    await waitFor(
      () => {
        const saved = noteById(source, 'note-a');
        expect(saved.body).toContain('zhixing://note/note-b');
      },
      { timeout: 3000 },
    );

    const link = await within(container).findByRole('link', {
      name: '去看目标',
    });
    fireEvent.click(link, { metaKey: true });
    expect(await screen.findByLabelText('笔记标题')).toHaveValue('目标笔记');

    await user.click(screen.getByRole('button', { name: '笔记链接' }));
    const panel = screen.getByRole('complementary', { name: '笔记链接' });
    expect(
      await within(panel).findByRole('button', { name: '⌁ 来源笔记' }),
    ).toBeInTheDocument();
  });

  it('链接块内链打开目标笔记，来源标签保留并可返回（ZX-LINK-01）', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-a',
        title: '来源笔记',
        body: '<p>来源正文</p>',
        updatedAt: '2026-10-27T08:00:00.000Z',
      }),
      makeNote({
        id: 'note-b',
        title: '目标笔记',
        body: '<p>目标正文</p>',
        updatedAt: '2026-10-26T08:00:00.000Z',
      }),
    ]);
    const blocks = createFakeBlockSource([
      makeBlock({
        id: 'a-link',
        noteId: 'note-a',
        type: 'link',
        payload: { url: 'zhixing://note/note-b', title: '' },
      }),
    ]);
    const { container } = renderKnowledge(
      source,
      '/knowledge?note=note-a',
      blocks,
    );

    const card = await within(container).findByRole('group', {
      name: '链接块',
    });
    expect(card).toHaveTextContent('目标笔记');
    expect(card).toHaveTextContent('站内笔记');

    await user.click(
      within(card).getByRole('button', { name: /打开笔记/ }),
    );
    expect(await screen.findByLabelText('笔记标题')).toHaveValue('目标笔记');

    // 来源标签没有被替换，用户可原路返回。
    await user.click(
      screen.getByRole('tab', { name: '切换到标签：来源笔记' }),
    );
    expect(await screen.findByLabelText('笔记标题')).toHaveValue('来源笔记');
    expect(
      within(container).getByRole('group', { name: '链接块' }),
    ).toBeInTheDocument();
  });

  it('点击指向已删除笔记的内链会明确提示不存在', async () => {
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-a',
        title: '来源笔记',
        body: '<p>去看已删除</p>',
        updatedAt: '2026-10-27T08:00:00.000Z',
      }),
    ]);
    const blocks = createFakeBlockSource([
      makeBlock({
        id: 'a-1',
        noteId: 'note-a',
        type: 'paragraph',
        payload: {
          runs: [
            {
              text: '去看已删除',
              marks: { link: 'zhixing://note/note-gone' },
            },
          ],
        },
      }),
    ]);
    const { container } = renderKnowledge(
      source,
      '/knowledge?note=note-a',
      blocks,
    );

    const link = await within(container).findByRole('link', {
      name: '去看已删除',
    });
    fireEvent.click(link, { metaKey: true });
    expect(
      await screen.findByText('笔记不存在或已删除'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('笔记标题')).toHaveValue('来源笔记');
  });

  it('指向回收站笔记的内链同样提示不存在，而不是打开只读页', async () => {
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-a',
        title: '来源笔记',
        body: '<p>去看已删除</p>',
        updatedAt: '2026-10-27T08:00:00.000Z',
      }),
      makeNote({
        id: 'note-b',
        title: '已删除笔记',
        status: 'trashed',
        deletedAt: '2026-10-26T08:00:00.000Z',
        updatedAt: '2026-10-26T08:00:00.000Z',
      }),
    ]);
    const blocks = createFakeBlockSource([
      makeBlock({
        id: 'a-1',
        noteId: 'note-a',
        type: 'paragraph',
        payload: {
          runs: [
            {
              text: '去看已删除',
              marks: { link: 'zhixing://note/note-b' },
            },
          ],
        },
      }),
    ]);
    const { container } = renderKnowledge(
      source,
      '/knowledge?note=note-a',
      blocks,
    );

    const link = await within(container).findByRole('link', {
      name: '去看已删除',
    });
    fireEvent.click(link, { metaKey: true });
    expect(
      await screen.findByText('笔记不存在或已删除'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('笔记标题')).toHaveValue('来源笔记');
  });

  it('搜索深链滚动并高亮首个命中块，1.4s 后褪去', async () => {
    const scrollSpy = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollSpy,
    });
    try {
      const source = createFakeNoteSource([
        makeNote({
          id: 'note-search',
          title: '搜索定位',
          body: '<p>开头</p><p>响应式布局要点</p>',
          updatedAt: '2026-10-27T08:00:00.000Z',
        }),
      ]);
      const blocks = createFakeBlockSource([
        makeBlock({
          id: 's-1',
          noteId: 'note-search',
          type: 'paragraph',
          payload: { runs: [{ text: '开头' }] },
        }),
        makeBlock({
          id: 's-2',
          noteId: 'note-search',
          type: 'paragraph',
          orderKey: 2048,
          payload: { runs: [{ text: '响应式布局要点' }] },
        }),
      ]);
      const { container } = renderKnowledge(
        source,
        '/knowledge?note=note-search&find=%E5%93%8D%E5%BA%94%E5%BC%8F',
        blocks,
      );

      await waitFor(() => {
        expect(container.querySelector('[data-block-id="s-2"]')).toHaveClass(
          'is-search-hit',
        );
      });
      expect(container.querySelector('[data-block-id="s-1"]')).not.toHaveClass(
        'is-search-hit',
      );
      expect(scrollSpy).toHaveBeenCalled();

      await waitFor(
        () => {
          expect(
            container.querySelector('[data-block-id="s-2"]'),
          ).not.toHaveClass('is-search-hit');
        },
        { timeout: 2500 },
      );
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown })
        .scrollIntoView;
    }
  });

  it('搜索深链没有命中块时打开顶部并提示未找到', async () => {
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-search',
        title: '搜索定位',
        body: '<p>开头</p>',
        updatedAt: '2026-10-27T08:00:00.000Z',
      }),
    ]);
    const blocks = createFakeBlockSource([
      makeBlock({
        id: 's-1',
        noteId: 'note-search',
        type: 'paragraph',
        payload: { runs: [{ text: '开头' }] },
      }),
    ]);
    const { container } = renderKnowledge(
      source,
      '/knowledge?note=note-search&find=%E4%B8%8D%E5%AD%98%E5%9C%A8',
      blocks,
    );

    expect(
      await screen.findByText('未找到匹配位置'),
    ).toBeInTheDocument();
    expect(container.querySelector('.is-search-hit')).toBeNull();
  });

  it('专注/写作跟随/全屏真实切换；无独立打字机按钮；ESC 依次退出', async () => {
    const user = userEvent.setup();
    const source = singleNote();
    const { container } = renderKnowledge(source, '/knowledge');

    await screen.findByRole('button', { name: '打开笔记：工具轨笔记' });

    // ZX-NOTE-02：独立打字机按钮已删除，并入专注模式的写作跟随。
    expect(screen.queryByRole('button', { name: '打字机模式' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/打字机/);

    await user.click(screen.getByRole('button', { name: '更多文档操作' }));
    await user.click(
      within(await screen.findByRole('menu', { name: '更多' })).getByRole(
        'menuitem',
        { name: /专注模式/ },
      ),
    );
    expect(container.querySelector('.kn-workspace')).toHaveClass('is-focus');
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-focus',
      'true',
    );

    // 专注不是无反馈开关：状态条给出写作跟随与当前表现。
    const bar = screen.getByRole('region', { name: '专注模式状态' });
    expect(bar).toHaveTextContent('专注模式');
    expect(bar).toHaveTextContent('当前段落居中 · Esc 退出');
    const follow = within(bar).getByRole('checkbox', { name: '写作跟随' });
    expect(follow).toBeChecked();
    await user.click(follow);
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-writing-follow',
      'false',
    );
    expect(bar).toHaveTextContent('只保留当前块高亮 · Esc 退出');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(container.querySelector('.zxe')).toHaveAttribute(
        'data-focus',
        'false',
      );
    });
    expect(container.querySelector('.kn-workspace')).not.toHaveClass(
      'is-focus',
    );

    await user.click(screen.getByRole('button', { name: '更多文档操作' }));
    await user.click(
      within(await screen.findByRole('menu', { name: '更多' })).getByRole(
        'menuitem',
        { name: /全屏阅读/ },
      ),
    );
    expect(container.querySelector('.knowledge-shell')).toHaveClass(
      'is-immersive',
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(container.querySelector('.knowledge-shell')).not.toHaveClass(
        'is-immersive',
      );
    });

    // F11 与「更多 → 全屏阅读」同一入口。
    fireEvent.keyDown(window, { key: 'F11' });
    expect(container.querySelector('.knowledge-shell')).toHaveClass(
      'is-immersive',
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(container.querySelector('.knowledge-shell')).not.toHaveClass(
        'is-immersive',
      );
    });
  });

  it('窄屏工具轨可折叠/展开', async () => {
    const user = userEvent.setup();
    const { container } = renderKnowledge(singleNote());

    await screen.findByRole('button', { name: '打开笔记：工具轨笔记' });
    await user.click(screen.getByRole('button', { name: '收起面板栏' }));
    expect(container.querySelector('.kn-rail')).toHaveClass('is-collapsed');
    expect(container.querySelector('.kn-editor')).toHaveClass(
      'is-rail-collapsed',
    );
    expect(
      screen.getByRole('button', { name: '展开面板栏' }),
    ).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByRole('button', { name: '展开面板栏' }));
    expect(container.querySelector('.kn-rail')).not.toHaveClass(
      'is-collapsed',
    );
  });

  it('新建画板创建真实笔记/画板/board 块并打开画板', async () => {
    const user = userEvent.setup();
    const source = singleNote();
    const blocks = createFakeBlockSource();
    const boards = createFakeBoardSource();
    renderKnowledge(source, '/knowledge', blocks, boards.source);

    await screen.findByRole('button', { name: '打开笔记：工具轨笔记' });
    await user.click(screen.getByRole('button', { name: '插入菜单' }));
    await user.click(
      within(await screen.findByRole('menu', { name: '插入块' })).getByRole(
        'menuitem',
        { name: /画板/ },
      ),
    );

    expect(
      await screen.findByRole('heading', { name: '画板工作区' }),
    ).toBeInTheDocument();
    expect(boards.created).toHaveLength(1);
    const board = boards.created[0];
    expect(board.noteId).not.toBeNull();

    const note = source
      .snapshot()
      .find((item) => item.id === board.noteId);
    expect(note?.title).toBe('未命名画板');
    const saved = blocks.snapshot(false, board.noteId as string);
    expect(saved.map((block) => block.type)).toEqual([
      'paragraph',
      'board',
    ]);
    expect(saved[1].payload.boardId).toBe(board.boardId);
  });
});

describe('知识页 · 任务回链兼容', () => {
  it('编辑块正文后保留 notes.body 里的任务回链标记', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-task',
        title: '执行笔记 · 回链',
        body:
          '<div class="callout zx-task-backlink" data-task-id="task-1" data-task-title="来源任务"><p>来自任务：来源任务</p></div><p>正文内容</p>',
        updatedAt: '2026-10-25T08:00:00.000Z',
      }),
    ]);
    const blocks = createFakeBlockSource();
    renderKnowledge(source, '/knowledge', blocks);

    expect(
      await screen.findAllByText('来源任务'),
    ).not.toHaveLength(0);
    const paragraph = await screen.findByRole('textbox', { name: '正文' });
    await user.type(paragraph, '补充');

    await waitFor(
      () => {
        const body = noteById(source, 'note-task').body;
        expect(body).toContain('data-task-id="task-1"');
        expect(body).toContain('正文内容');
        expect(body).toContain('补充');
      },
      { timeout: 4000 },
    );
  });
});

describe('知识页 · 单篇导出面板（ZX-EXPORT-01）', () => {
  /** ZX-TOOLBAR-02：导出收进命令栏菜单，四入口共用同一个面板。 */
  async function openExportFromCommand(
    user: ReturnType<typeof userEvent.setup>,
  ) {
    await user.click(await screen.findByRole('button', { name: '导出笔记' }));
    await user.click(
      within(await screen.findByRole('menu', { name: '导出' })).getByRole(
        'menuitem',
        { name: '导出选项…' },
      ),
    );
  }

  function installPicker(write: ReturnType<typeof vi.fn>) {
    const picker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({
        write,
        close: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn(),
      }),
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    });
    return picker;
  }

  function removePicker() {
    delete (window as Window & { showSaveFilePicker?: unknown })
      .showSaveFilePicker;
  }

  it('标题区入口默认 Word，生成真 .docx 并显示保存结果', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    const write = vi.fn().mockResolvedValue(undefined);
    const picker = installPicker(write);
    try {
      renderKnowledge(source);
      await openExportFromCommand(user);
      const dialog = await screen.findByRole('dialog', {
        name: /导出「产品设计笔记」/,
      });
      expect(
        within(dialog).getByRole('radio', { name: /Word 文档/ }),
      ).toBeChecked();
      expect(
        within(dialog).getByText(/该笔记的全部正文块|个块/),
      ).toBeInTheDocument();
      await user.click(
        within(dialog).getByRole('button', { name: '继续' }),
      );

      const done = await screen.findByRole('dialog', {
        name: '已导出 Word 文档',
      });
      expect(done).toHaveTextContent('产品设计笔记.docx');
      expect(done).toHaveTextContent('已保存到所选位置');
      expect(picker).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedName: '产品设计笔记.docx' }),
      );
      const blob = write.mock.calls[0]![0] as Blob;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      expect(bytes[0]).toBe(0x50);
      expect(bytes[1]).toBe(0x4b);
    } finally {
      removePicker();
    }
  });

  it('PDF 显示不可选中限制；无 Canvas 时给出明确原因且不写文件', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    const write = vi.fn().mockResolvedValue(undefined);
    const picker = installPicker(write);
    try {
      renderKnowledge(source);
      await openExportFromCommand(user);
      const dialog = await screen.findByRole('dialog', {
        name: /导出「产品设计笔记」/,
      });
      await user.click(within(dialog).getByRole('radio', { name: /PDF/ }));
      expect(
        within(dialog).getByText(/文字不可选中、检索或复制/),
      ).toBeInTheDocument();
      await user.click(
        within(dialog).getByRole('button', { name: '继续' }),
      );
      expect(
        await screen.findByText(/Canvas 2D 上下文不可用/),
      ).toBeInTheDocument();
      expect(picker).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      removePicker();
    }
  });

  it('取消保存面板不写文件并明确提示', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    const write = vi.fn().mockResolvedValue(undefined);
    const abort = Object.assign(new Error('取消'), { name: 'AbortError' });
    const picker = vi.fn().mockRejectedValue(abort);
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    });
    try {
      renderKnowledge(source);
      await openExportFromCommand(user);
      const dialog = await screen.findByRole('dialog', {
        name: /导出「产品设计笔记」/,
      });
      await user.click(
        within(dialog).getByRole('button', { name: '继续' }),
      );
      expect(
        await screen.findByText('已取消保存，未写入文件。'),
      ).toBeInTheDocument();
      expect(write).not.toHaveBeenCalled();
      expect(
        screen.getByRole('dialog', { name: /导出「产品设计笔记」/ }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('dialog', { name: /已导出/ }),
      ).not.toBeInTheDocument();
    } finally {
      removePicker();
    }
  });

  it('浏览器没有保存面板时显示可读原因，不退化成 <a download>', async () => {
    const user = userEvent.setup();
    removePicker();
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    try {
      renderKnowledge(createFakeNoteSource(seedNotes()));
      await openExportFromCommand(user);
      const dialog = await screen.findByRole('dialog', {
        name: /导出「产品设计笔记」/,
      });
      await user.click(
        within(dialog).getByRole('button', { name: '继续' }),
      );
      expect(
        await screen.findByText(/没有用户可见的保存面板/),
      ).toBeInTheDocument();
      expect(anchorClick).not.toHaveBeenCalled();
    } finally {
      anchorClick.mockRestore();
    }
  });

  it('⇧⌘E 打开同一个导出面板', async () => {
    renderKnowledge(createFakeNoteSource(seedNotes()));
    await screen.findByRole('button', { name: '导出笔记' });
    fireEvent.keyDown(window, {
      key: 'e',
      shiftKey: true,
      metaKey: true,
    });
    expect(
      await screen.findByRole('dialog', { name: /导出「产品设计笔记」/ }),
    ).toBeInTheDocument();
  });

  it('导入 Markdown 后打开笔记、编辑标题，块与待办仍是结构化数据', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource(seedNotes());
    const blockSource = createFakeBlockSource();
    const noteTodoSource = createFakeNoteTodoSource();
    const imports: ImportNoteInput[] = [];
    source.import = async (input) => {
      imports.push(input);
      const note = await source.create!(input.note);
      await blockSource.saveDocument(
        note.id,
        input.blocks.map((block) => ({
          id: block.id,
          type: block.blockType,
          payload: block.payload as never,
          schemaVersion: block.schemaVersion,
        })),
      );
      for (const todo of input.todos) {
        await noteTodoSource.create({ ...todo, noteId: note.id });
      }
      return note;
    };

    renderKnowledge(
      source,
      '/knowledge',
      blockSource,
      undefined,
      noteTodoSource,
    );
    await screen.findByRole('button', { name: '导出笔记' });
    await user.click(screen.getByRole('button', { name: '导入笔记' }));

    const dialog = await screen.findByRole('dialog', { name: '导入笔记' });
    const file = new File(
      [
        new TextEncoder().encode(
          '# 导入标题\n\n第一段\n\n- [ ] 导入待办\n',
        ),
      ],
      '导入.md',
      { type: 'text/markdown' },
    );
    await user.upload(
      within(dialog).getByLabelText('选择要导入的文件'),
      file,
    );
    expect(
      await within(dialog).findByText('标题：导入标题'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/2 个块/)).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole('button', { name: /开始导入/ }),
    );
    expect(
      await within(dialog).findByText(/全部导入成功：成功 1 篇/),
    ).toBeInTheDocument();
    expect(imports).toHaveLength(1);
    expect(imports[0].blocks.map((block) => block.blockType)).toEqual([
      'paragraph',
      'todo',
    ]);
    expect(imports[0].todos).toHaveLength(1);
    expect(imports[0].blocks[1].payload).toMatchObject({
      checked: false,
      todoId: imports[0].todos[0].id,
    });

    await user.click(within(dialog).getByRole('button', { name: '打开' }));
    const paragraph = await screen.findByRole('textbox', { name: '正文' });
    expect(paragraph).toHaveTextContent('第一段');
    expect(
      screen.getByRole('textbox', { name: '待办内容' }),
    ).toHaveTextContent('导入待办');

    await user.click(paragraph);
    expect(paragraph).toHaveAttribute('contenteditable', 'true');
    paragraph.textContent = '第一段！';
    fireEvent.input(paragraph);
    await waitFor(() =>
      expect(paragraph).toHaveTextContent('第一段！'),
    );

    const imported = source
      .snapshot()
      .find((note) => note.title === '导入标题');
    expect(imported?.folderId).toBeNull();
  });

  it('多选导入逐文件报告：同名跳过、解析失败与成功可以同时存在', async () => {
    const user = userEvent.setup();
    const seeded = seedNotes();
    seeded.push(
      makeNote({
        id: 'note-duplicate',
        title: '重复标题',
        folderId: 'f1',
        body: '<p>已有内容</p>',
      }),
    );
    const source = createFakeNoteSource(seeded);
    const blockSource = createFakeBlockSource();
    const noteTodoSource = createFakeNoteTodoSource();
    const imports: ImportNoteInput[] = [];
    source.import = async (input) => {
      imports.push(input);
      const note = await source.create!(input.note);
      await blockSource.saveDocument(
        note.id,
        input.blocks.map((block) => ({
          id: block.id,
          type: block.blockType,
          payload: block.payload as never,
          schemaVersion: block.schemaVersion,
        })),
      );
      return note;
    };

    renderKnowledge(
      source,
      '/knowledge',
      blockSource,
      undefined,
      noteTodoSource,
    );
    await screen.findByRole('button', { name: '导出笔记' });
    await user.click(screen.getByRole('button', { name: '导入笔记' }));
    const dialog = await screen.findByRole('dialog', { name: '导入笔记' });
    await user.upload(
      within(dialog).getByLabelText('选择要导入的文件'),
      [
        new File(
          [new TextEncoder().encode('# 重复标题\n\n新的正文\n')],
          '重复标题.md',
          { type: 'text/markdown' },
        ),
        new File(
          [new TextEncoder().encode('   \n\n')],
          '空白.md',
          { type: 'text/markdown' },
        ),
        new File(
          [new TextEncoder().encode('# 正常笔记\n\n正常正文\n')],
          '正常.md',
          { type: 'text/markdown' },
        ),
      ],
    );

    expect(await within(dialog).findByText('标题：重复标题')).toBeInTheDocument();
    expect(
      await within(dialog).findByText(/IMPORT_EMPTY：文件为空或只有空白/),
    ).toBeInTheDocument();

    await user.selectOptions(
      within(dialog).getByLabelText('目标目录'),
      'f1',
    );
    await user.click(within(dialog).getByLabelText('跳过同名'));
    expect(
      await within(dialog).findByText('目标目录已有同名笔记，导入时将跳过'),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('button', { name: /开始导入/ }),
    );

    expect(
      await within(dialog).findByText(
        '部分成功：成功 1 篇 / 跳过 1 篇 / 失败 1 篇',
      ),
    ).toBeInTheDocument();
    expect(imports).toHaveLength(1);
    expect(imports[0].note.title).toBe('正常笔记');
    expect(imports[0].note.folderId).toBe('f1');
    const titles = source.snapshot().map((note) => note.title);
    expect(titles).toContain('正常笔记');
    expect(titles.filter((title) => title === '重复标题')).toHaveLength(1);
  });
});

describe('知识页 · 未关联画板兜底入口（ZX5-NAV-01）', () => {
  it('孤儿画板在目录可达，打开仍进入全屏画板深链', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-linked',
        title: '已关联笔记',
        body: '<div class="zx-board-ref" data-board-id="board-linked">画板：已关联画板</div><p>正文</p>',
        updatedAt: '2026-10-26T08:00:00.000Z',
      }),
      makeNote({
        id: 'note-gone',
        title: '已删除笔记',
        status: 'trashed',
        deletedAt: '2026-10-25T00:00:00.000Z',
        body: '<p>将被删除的画板来源</p>',
        updatedAt: '2026-10-25T00:00:00.000Z',
      }),
    ]);
    const boards = createMemoryBoardSource([
      boardDocument('board-linked', 'note-linked', '已关联画板'),
      boardDocument('board-orphan', null, '产品草图'),
      boardDocument('board-detached', 'note-linked', '失去引用的画板'),
      boardDocument('board-gone', 'note-gone', '已删除笔记的画板'),
    ]);
    renderKnowledge(
      source,
      '/knowledge',
      createFakeBlockSource(),
      boards.source,
    );

    const orphanNode = await screen.findByRole('button', {
      name: '未关联画板',
    });
    expect(within(orphanNode).getByText('3')).toBeInTheDocument();

    await user.click(orphanNode);
    expect(
      screen.getByRole('heading', { level: 2, name: '未关联画板' }),
    ).toBeInTheDocument();
    expect(screen.getByText('3 块')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开画板：产品草图' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开画板：失去引用的画板' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开画板：已删除笔记的画板' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '打开画板：已关联画板' }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: '打开画板：产品草图' }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: '画板工作区' }),
    ).toBeInTheDocument();
  });

  it('关联孤儿画板会追加 board 块并写回 note_id', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({
        id: 'note-a',
        title: '目标笔记',
        body: '<p>已有正文</p>',
      }),
    ]);
    const blocks = createFakeBlockSource([
      makeBlock({
        id: 'blk-a',
        noteId: 'note-a',
        type: 'paragraph',
        payload: { runs: [{ text: '已有正文' }] },
      }),
    ]);
    const boards = createMemoryBoardSource([
      boardDocument('board-orphan', null, '产品草图'),
    ]);
    renderKnowledge(source, '/knowledge', blocks, boards.source);

    await user.click(
      await screen.findByRole('button', { name: '未关联画板' }),
    );
    await user.click(
      screen.getByRole('button', { name: '关联到笔记：产品草图' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: '关联画板到笔记',
    });
    expect(within(dialog).getByLabelText('笔记')).toHaveValue('note-a');

    await user.click(within(dialog).getByRole('button', { name: '关联' }));

    await waitFor(() => {
      expect(boards.documents()[0].noteId).toBe('note-a');
    });
    expect(
      blocks
        .snapshot(false, 'note-a')
        .some(
          (block) =>
            block.type === 'board' &&
            block.payload.boardId === 'board-orphan',
        ),
    ).toBe(true);
    expect(noteById(source, 'note-a').body).toContain(
      'data-board-id="board-orphan"',
    );
    expect(
      screen.getByText('已关联到笔记'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: '未关联画板' }),
      ).not.toBeInTheDocument();
    });
  });

  it('删除孤儿画板需要二次确认，并保留笔记数据', async () => {
    const user = userEvent.setup();
    const source = createFakeNoteSource([
      makeNote({ id: 'note-a', title: '目标笔记', body: '<p>已有正文</p>' }),
    ]);
    const boards = createMemoryBoardSource([
      boardDocument('board-orphan', null, '产品草图'),
    ]);
    renderKnowledge(
      source,
      '/knowledge',
      createFakeBlockSource(),
      boards.source,
    );

    await user.click(
      await screen.findByRole('button', { name: '未关联画板' }),
    );
    await user.click(
      screen.getByRole('button', { name: '删除画板：产品草图' }),
    );
    const dialog = await screen.findByRole('dialog', { name: '删除画板' });
    expect(dialog).toHaveTextContent('包含 0 个对象');

    await user.click(within(dialog).getByRole('button', { name: '确认删除' }));

    await waitFor(() => {
      expect(boards.removed).toEqual(['board-orphan']);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: '未关联画板' }),
      ).not.toBeInTheDocument();
    });
    expect(noteById(source, 'note-a').body).toBe('<p>已有正文</p>');
    expect(
      source.snapshot().find((note) => note.id === 'note-a')?.deletedAt,
    ).toBeNull();
  });
});

describe('知识页 · 右栏浮窗贴边与层级（ZX8-RAILPOP-01）', () => {
  function railPopNote() {
    return createFakeNoteSource([
      makeNote({
        id: 'note-railpop',
        title: '右栏浮窗笔记',
        body: '<h2>背景</h2><p>正文</p><h3>结论</h3>',
        updatedAt: '2026-10-29T08:00:00.000Z',
      }),
    ]);
  }

  function rect(left: number, top: number, width: number, height: number) {
    return {
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  }

  it('浮窗使用 fixed 贴右栏，按钮 aria 同步，一次只渲染一个面板', async () => {
    const user = userEvent.setup();
    const { container } = renderKnowledge(railPopNote());
    await screen.findByRole('button', { name: '打开笔记：右栏浮窗笔记' });

    const rail = screen.getByRole('navigation', { name: '笔记面板' });
    const outline = within(rail).getByRole('button', { name: '大纲' });
    const info = within(rail).getByRole('button', { name: '笔记信息' });
    expect(outline).toHaveAttribute('aria-controls', 'kn-rail-flyout');
    expect(outline).toHaveAttribute('aria-expanded', 'false');

    await user.click(outline);
    const panel = screen.getByRole('complementary', { name: '笔记大纲' });
    expect(panel).toHaveClass('kn-rail-flyout');
    expect(panel).toHaveAttribute('data-kn-rail-flyout', 'true');
    expect(panel).toHaveAttribute('id', 'kn-rail-flyout');
    expect(outline).toHaveAttribute('aria-expanded', 'true');

    // CSS 真值：fixed + 右缘按右栏宽度锚定 + 浮窗层级 token。
    const panelStyle = getComputedStyle(panel);
    expect(panelStyle.position).toBe('fixed');
    expect(panelStyle.right).toBe('calc(var(--kn-rail-w) + 1px)');
    expect(panelStyle.width).toBe('var(--kn-flyout-w)');
    expect(panelStyle.zIndex).toBe('var(--z-rail-flyout, 340)');

    const editor = container.querySelector('.kn-editor');
    expect(editor).not.toBeNull();
    const editorStyle = getComputedStyle(editor as HTMLElement);
    expect(editorStyle.getPropertyValue('--kn-rail-w').trim()).toBe('48px');
    expect(editorStyle.getPropertyValue('--kn-flyout-w').trim()).toBe(
      'clamp(264px,24vw,360px)',
    );

    // 面板互斥替换：同一时刻最多一个浮窗。
    await user.click(info);
    expect(
      screen.queryByRole('complementary', { name: '笔记大纲' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('complementary', { name: '笔记信息' }),
    ).toBeInTheDocument();
    expect(
      document.querySelectorAll('[data-kn-rail-flyout]'),
    ).toHaveLength(1);
    expect(outline).toHaveAttribute('aria-expanded', 'false');
    expect(info).toHaveAttribute('aria-expanded', 'true');

    // × 关闭后焦点回到触发按钮。
    await user.click(
      screen.getByRole('button', { name: '关闭笔记信息' }),
    );
    expect(
      screen.queryByRole('complementary', { name: '笔记信息' }),
    ).not.toBeInTheDocument();
    expect(info).toHaveFocus();
  });

  it('Esc 逐层关闭：IME/长按不误触，菜单先于浮窗，关闭后回焦按钮', async () => {
    const user = userEvent.setup();
    renderKnowledge(railPopNote());
    await screen.findByRole('button', { name: '打开笔记：右栏浮窗笔记' });

    const rail = screen.getByRole('navigation', { name: '笔记面板' });
    const outline = within(rail).getByRole('button', { name: '大纲' });
    outline.focus();
    await user.keyboard('{Enter}');
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(window, { key: 'Escape', repeat: true });
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();

    // 输入框内的 Esc 归输入控件/编辑器，不抢关浮窗。
    const titleInput = screen.getByLabelText('笔记标题');
    fireEvent.keyDown(titleInput, { key: 'Escape' });
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();

    // 菜单打开时 Esc 只关菜单，不连带关闭右栏浮窗。
    const commandbar = screen.getByRole('toolbar', { name: '文档命令' });
    await user.click(
      within(commandbar).getByRole('button', { name: '更多文档操作' }),
    );
    const menu = await screen.findByRole('menu', { name: '更多' });
    expect(menu).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: '更多' })).toBeNull();
    });
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();

    // 再按一次 Esc 才关闭浮窗，并把焦点还给触发按钮。
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(
        screen.queryByRole('complementary', { name: '笔记大纲' }),
      ).not.toBeInTheDocument();
    });
    expect(outline).toHaveFocus();
  });

  it('浮窗与点击菜单同开时几何避让；滚动/缩放不关闭浮窗，折叠后仍贴边', async () => {
    const user = userEvent.setup();
    const { container } = renderKnowledge(railPopNote());
    await screen.findByRole('button', { name: '打开笔记：右栏浮窗笔记' });

    const rail = screen.getByRole('navigation', { name: '笔记面板' });
    await user.click(within(rail).getByRole('button', { name: '大纲' }));
    const panel = screen.getByRole('complementary', { name: '笔记大纲' });
    const commandbar = screen.getByRole('toolbar', { name: '文档命令' });
    const more = within(commandbar).getByRole('button', {
      name: '更多文档操作',
    });

    const flyoutRect = rect(800, 92, 260, 508);
    const menuRect = rect(0, 0, 248, 300);
    const triggerRect = rect(400, 40, 80, 30);
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this === panel) return flyoutRect;
        if (this.classList.contains('kn-context-menu')) return menuRect;
        if (this.getAttribute('aria-label') === '更多文档操作') {
          return triggerRect;
        }
        return rect(0, 0, 0, 0);
      });

    try {
      fireEvent.click(more);
      const menu = await screen.findByRole('menu', { name: '更多' });
      const menuLeft = Number.parseFloat(menu.style.left);
      const menuRight = menuLeft + menuRect.width;
      // 菜单 z 更高，但几何上不压浮窗：right <= flyout.left - 8。
      expect(menuLeft).toBe(400);
      expect(menuRight).toBeLessThanOrEqual(flyoutRect.left - 8 + 0.5);
      expect(panel).toBeInTheDocument();
      expect(menu).toBeInTheDocument();
    } finally {
      rectSpy.mockRestore();
    }

    // 正文滚动：菜单关闭（避免脱离锚点），浮窗 fixed 不动。
    fireEvent.scroll(container.querySelector('.kn-paper') as Element);
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: '更多' })).toBeNull();
    });
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();

    // 窗口缩放：只关菜单，浮窗继续显示。
    fireEvent.click(more);
    await screen.findByRole('menu', { name: '更多' });
    fireEvent(window, new Event('resize'));
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: '更多' })).toBeNull();
    });
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();

    // 折叠右栏：锚点宽度降到 32px，浮窗仍贴边、不被卸载。
    await user.click(
      within(rail).getByRole('button', { name: '收起面板栏' }),
    );
    const editor = container.querySelector('.kn-editor') as HTMLElement;
    expect(editor).toHaveClass('is-rail-collapsed');
    expect(
      getComputedStyle(editor).getPropertyValue('--kn-rail-w').trim(),
    ).toBe('32px');
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();
    expect(
      getComputedStyle(
        screen.getByRole('complementary', { name: '笔记大纲' }),
      ).right,
    ).toBe('calc(var(--kn-rail-w) + 1px)');
  });

  it('浮窗左侧放不下菜单时关闭浮窗，保证只留一个浮层', async () => {
    const user = userEvent.setup();
    renderKnowledge(railPopNote());
    await screen.findByRole('button', { name: '打开笔记：右栏浮窗笔记' });

    await user.click(
      within(
        screen.getByRole('navigation', { name: '笔记面板' }),
      ).getByRole('button', { name: '大纲' }),
    );
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();

    const panel = screen.getByRole('complementary', { name: '笔记大纲' });
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this === panel) return rect(160, 92, 260, 508);
        if (this.classList.contains('kn-context-menu')) {
          return rect(0, 0, 248, 300);
        }
        if (this.getAttribute('aria-label') === '更多文档操作') {
          return rect(20, 40, 80, 30);
        }
        return rect(0, 0, 0, 0);
      });

    try {
      fireEvent.click(
        within(
          screen.getByRole('toolbar', { name: '文档命令' }),
        ).getByRole('button', { name: '更多文档操作' }),
      );
      const menu = await screen.findByRole('menu', { name: '更多' });
      await waitFor(() => {
        expect(
          screen.queryByRole('complementary', { name: '笔记大纲' }),
        ).not.toBeInTheDocument();
      });
      expect(menu).toBeInTheDocument();
    } finally {
      rectSpy.mockRestore();
    }
  });

  it('窄屏从抽屉打开 sheet，不同时存在抽屉/右栏/浮窗；Esc 回焦工具按钮', async () => {
    const user = userEvent.setup();
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('900px'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    try {
      renderKnowledge(railPopNote());
      await screen.findByRole('button', { name: '打开笔记：右栏浮窗笔记' });
      expect(
        screen.queryByRole('navigation', { name: '笔记面板' }),
      ).not.toBeInTheDocument();

      const tools = within(
        screen.getByRole('toolbar', { name: '文档命令' }),
      ).getByRole('button', { name: '工具' });
      await user.click(tools);
      const drawer = await screen.findByRole('dialog', { name: '笔记工具' });
      await user.click(within(drawer).getByRole('button', { name: '大纲' }));

      expect(
        screen.queryByRole('dialog', { name: '笔记工具' }),
      ).not.toBeInTheDocument();
      const sheet = screen.getByRole('complementary', {
        name: '笔记大纲',
      });
      expect(sheet).toHaveAttribute('data-kn-rail-flyout', 'true');
      expect(
        document.querySelectorAll('[data-kn-rail-flyout]'),
      ).toHaveLength(1);

      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => {
        expect(
          screen.queryByRole('complementary', { name: '笔记大纲' }),
        ).not.toBeInTheDocument();
      });
      expect(tools).toHaveFocus();

      // 再开抽屉时不会带回旧浮窗。
      await user.click(tools);
      await screen.findByRole('dialog', { name: '笔记工具' });
      expect(
        screen.queryByRole('complementary', { name: '笔记大纲' }),
      ).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: original,
      });
    }
  });
});

describe('知识页 · ESC 展开/还原与冲突处理（ZX8-ESC-01）', () => {
  function escNote() {
    return createFakeNoteSource([
      makeNote({
        id: 'note-esc',
        title: 'ESC 展开笔记',
        body: '<h2>背景</h2><p>正文段落</p><h3>结论</h3>',
        updatedAt: '2026-10-30T08:00:00.000Z',
      }),
    ]);
  }

  function mockMedia(matcher: (query: string) => boolean) {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: matcher(query),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    return () => {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: original,
      });
    };
  }

  async function ready() {
    return screen.findByRole('button', { name: '打开笔记：ESC 展开笔记' });
  }

  it('ESC 展开：收左树/列表、无 scrim/置灰、右栏可用、焦点回原位置并保持滚动', async () => {
    const user = userEvent.setup();
    const { container } = renderKnowledge(escNote());
    await ready();

    const workspace = container.querySelector('.kn-workspace') as HTMLElement;
    const tree = screen.getByRole('navigation', { name: '知识目录' });
    const list = container.querySelector('.kn-list') as HTMLElement;
    const paper = screen.getByRole('article', { name: '笔记内容' });
    const scroller = (await screen.findByLabelText('笔记正文')) as HTMLElement;
    const allNotes = screen.getByRole('button', { name: '全部笔记' });

    expect(workspace).toHaveAttribute('data-expanded', 'false');
    expect(
      screen.queryByRole('button', { name: '还原目录与列表' }),
    ).toBeNull();

    scroller.scrollTop = 300;
    allNotes.focus();
    expect(allNotes).toHaveFocus();

    fireEvent.keyDown(allNotes, { key: 'Escape' });

    await waitFor(() => {
      expect(workspace).toHaveClass('is-expanded');
      expect(workspace).toHaveAttribute('data-expanded', 'true');
    });
    expect(tree).toHaveAttribute('aria-hidden', 'true');
    expect(tree).toHaveAttribute('inert');
    expect(list).toHaveAttribute('aria-hidden', 'true');
    expect(list).toHaveAttribute('inert');
    expect(
      screen.getByRole('button', { name: '还原目录与列表' }),
    ).toBeInTheDocument();

    // 无遮罩、无置灰：纸面仍不透明、无滤镜、可交互。
    expect(document.querySelector('.kn-tools-scrim')).toBeNull();
    const paperStyle = getComputedStyle(paper);
    expect(['', '1']).toContain(paperStyle.opacity);
    expect(['', 'none']).toContain(paperStyle.filter);
    expect(paperStyle.pointerEvents).not.toBe('none');

    // 焦点从隐藏的目录移到正文纸面，正文滚动位置保持。
    await waitFor(() => expect(paper).toHaveFocus());
    expect(scroller.scrollTop).toBe(300);

    // 右栏与命令栏仍可用：展开时仍能打开大纲浮窗。
    const rail = screen.getByRole('navigation', { name: '笔记面板' });
    await user.click(within(rail).getByRole('button', { name: '大纲' }));
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(
        screen.queryByRole('complementary', { name: '笔记大纲' }),
      ).not.toBeInTheDocument();
    });
    expect(workspace).toHaveClass('is-expanded');

    // 再按 ESC 还原；焦点回到展开前的目录行，滚动不重置。
    fireEvent.keyDown(paper, { key: 'Escape' });
    await waitFor(() => {
      expect(workspace).not.toHaveClass('is-expanded');
      expect(workspace).toHaveAttribute('data-expanded', 'false');
    });
    expect(tree).not.toHaveAttribute('aria-hidden');
    expect(tree).not.toHaveAttribute('inert');
    expect(list).not.toHaveAttribute('aria-hidden');
    expect(
      screen.queryByRole('button', { name: '还原目录与列表' }),
    ).toBeNull();
    await waitFor(() => expect(allNotes).toHaveFocus());
    expect(scroller.scrollTop).toBe(300);
  });

  it('输入框内 ESC 不展开，也不关闭右栏浮窗', async () => {
    const { container } = renderKnowledge(escNote());
    await ready();

    const rail = screen.getByRole('navigation', { name: '笔记面板' });
    (within(rail).getByRole('button', { name: '大纲' }) as HTMLButtonElement).focus();
    await userEvent.setup().keyboard('{Enter}');
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();

    const titleInput = screen.getByLabelText('笔记标题');
    titleInput.focus();
    fireEvent.keyDown(titleInput, { key: 'Escape' });

    expect(container.querySelector('.kn-workspace')).not.toHaveClass(
      'is-expanded',
    );
    expect(
      screen.getByRole('complementary', { name: '笔记大纲' }),
    ).toBeInTheDocument();

    // 焦点离开输入框后，下一次 ESC 才关闭浮窗。
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(
        screen.queryByRole('complementary', { name: '笔记大纲' }),
      ).not.toBeInTheDocument();
    });
    expect(container.querySelector('.kn-workspace')).not.toHaveClass(
      'is-expanded',
    );
  });

  it('菜单 / 弹窗 ESC 只关自己，不展开；长按与 IME 不误触', async () => {
    const user = userEvent.setup();
    const { container } = renderKnowledge(escNote());
    await ready();
    const workspace = container.querySelector('.kn-workspace') as HTMLElement;

    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(window, { key: 'Escape', repeat: true });
    expect(workspace).not.toHaveClass('is-expanded');

    await user.click(screen.getByRole('button', { name: '更多文档操作' }));
    await screen.findByRole('menu', { name: '更多' });
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: '更多' })).toBeNull();
    });
    expect(workspace).not.toHaveClass('is-expanded');

    await user.click(screen.getByRole('button', { name: '导出笔记' }));
    await user.click(
      within(await screen.findByRole('menu', { name: '导出' })).getByRole(
        'menuitem',
        { name: '导出选项…' },
      ),
    );
    const dialog = await screen.findByRole('dialog', {
      name: /导出「ESC 展开笔记」/,
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
    expect(workspace).not.toHaveClass('is-expanded');
  });

  it('沉浸阅读与专注 ESC 只退出自身，不进入展开', async () => {
    const user = userEvent.setup();
    const { container } = renderKnowledge(escNote());
    await ready();
    const workspace = container.querySelector('.kn-workspace') as HTMLElement;
    const shell = container.querySelector('.knowledge-shell') as HTMLElement;

    const rail = screen.getByRole('navigation', { name: '笔记面板' });
    await user.click(within(rail).getByRole('button', { name: '全屏阅读' }));
    expect(shell).toHaveClass('is-immersive');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(shell).not.toHaveClass('is-immersive'));
    expect(workspace).not.toHaveClass('is-expanded');

    await user.click(within(rail).getByRole('button', { name: '专注模式' }));
    expect(workspace).toHaveClass('is-focus');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(workspace).not.toHaveClass('is-focus'));
    expect(workspace).not.toHaveClass('is-expanded');
  });

  it('展开→沉浸→Esc 恢复展开；进入专注会清除展开', async () => {
    const user = userEvent.setup();
    const { container } = renderKnowledge(escNote());
    await ready();
    const workspace = container.querySelector('.kn-workspace') as HTMLElement;
    const shell = container.querySelector('.knowledge-shell') as HTMLElement;

    screen.getByRole('button', { name: '全部笔记' }).focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(workspace).toHaveClass('is-expanded'));

    const rail = screen.getByRole('navigation', { name: '笔记面板' });
    await user.click(within(rail).getByRole('button', { name: '全屏阅读' }));
    expect(shell).toHaveClass('is-immersive');
    expect(workspace).not.toHaveClass('is-expanded');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(shell).not.toHaveClass('is-immersive'));
    await waitFor(() => expect(workspace).toHaveClass('is-expanded'));

    await user.click(within(rail).getByRole('button', { name: '专注模式' }));
    expect(workspace).toHaveClass('is-focus');
    expect(workspace).not.toHaveClass('is-expanded');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(workspace).not.toHaveClass('is-focus'));
    expect(workspace).not.toHaveClass('is-expanded');
  });

  it('900 档展开只收列表，内容区占满', async () => {
    const restore = mockMedia((query) => query.includes('900px'));
    try {
      const { container } = renderKnowledge(escNote());
      await ready();
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => {
        expect(container.querySelector('.kn-workspace')).toHaveClass(
          'is-expanded',
        );
      });
      expect(container.querySelector('.kn-list')).toHaveAttribute(
        'aria-hidden',
        'true',
      );
      expect(
        screen.queryByRole('navigation', { name: '笔记面板' }),
      ).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it('390 档展开为 no-op 并给出提示', async () => {
    const restore = mockMedia(
      (query) => query.includes('900px') || query.includes('720px'),
    );
    try {
      const { container } = renderKnowledge(escNote());
      await ready();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(container.querySelector('.kn-workspace')).not.toHaveClass(
        'is-expanded',
      );
      expect(container.querySelector('.kn-list')).not.toHaveAttribute(
        'aria-hidden',
      );
      expect(document.querySelector('.kn-toast')).toHaveTextContent(
        '当前窗口已无可收起列',
      );
    } finally {
      restore();
    }
  });
});
