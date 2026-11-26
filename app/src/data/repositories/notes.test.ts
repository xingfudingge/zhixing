import { describe, expect, it } from 'vitest';

import { createDbClient, type DbInvoker } from '../db/client';
import type { Note, NoteUpdate } from '../db/types';
import {
  buildNoteLinkGraph,
  createNoteRepository,
  exportMarkdownFileName,
  htmlToMarkdown,
  noteToMarkdown,
  normalizeNoteTitle,
  NoteTitleError,
  sortNotes,
  toNoteUpdate,
} from './notes';

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    spaceId: 'personal',
    title: '示例笔记',
    folderId: 'f1',
    tags: ['产品'],
    body: '<p>正文</p>',
    bodyFormat: 'html',
    status: 'active',
    favorite: false,
    pinned: false,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function noteUpdate(overrides: Partial<NoteUpdate> = {}): NoteUpdate {
  return {
    title: '示例笔记',
    folderId: 'f1',
    tags: ['产品'],
    body: '<p>正文</p>',
    bodyFormat: 'html',
    favorite: false,
    pinned: false,
    ...overrides,
  };
}

describe('笔记仓储 · 标题与更新映射', () => {
  it('标题去空格；空标题抛出可读错误', () => {
    expect(normalizeNoteTitle('  新标题  ')).toBe('新标题');
    expect(() => normalizeNoteTitle('   ')).toThrow(NoteTitleError);
    expect(() => normalizeNoteTitle('')).toThrow('笔记标题不能为空');
  });

  it('toNoteUpdate 用局部修改补全完整字段', () => {
    const note = makeNote({ favorite: true, body: '<p>旧正文</p>' });
    const update = toNoteUpdate(note, {
      title: '新标题',
      body: '<p>新正文</p>',
      pinned: true,
    });
    expect(update).toEqual({
      title: '新标题',
      folderId: 'f1',
      tags: ['产品'],
      body: '<p>新正文</p>',
      bodyFormat: 'html',
      favorite: true,
      pinned: true,
    });
  });

  it('列表把置顶笔记排在前面', () => {
    const rows = sortNotes([
      makeNote({
        id: 'a',
        title: 'A',
        updatedAt: '2026-10-22T00:00:00.000Z',
      }),
      makeNote({
        id: 'b',
        title: 'B',
        pinned: true,
        updatedAt: '2026-10-20T00:00:00.000Z',
      }),
    ]);
    expect(rows.map((note) => note.id)).toEqual(['b', 'a']);
  });
});

describe('笔记仓储 · 写入校验', () => {
  it('update 空标题在 IPC 前被拒绝', async () => {
    const calls: string[] = [];
    const invoker = (async (command: string) => {
      calls.push(command);
      return makeNote();
    }) as DbInvoker;
    const repository = createNoteRepository(createDbClient(invoker));

    await expect(
      repository.update('note-1', noteUpdate({ title: '   ' })),
    ).rejects.toThrow('笔记标题不能为空');
    expect(calls).toEqual([]);
  });

  it('patch 发送完整 NoteUpdate 并裁剪标题', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const invoker = (async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push({ command, args });
      return makeNote({
        title: '新标题',
        favorite: true,
        version: 2,
      });
    }) as DbInvoker;
    const repository = createNoteRepository(createDbClient(invoker));

    const updated = await repository.patch(makeNote(), {
      title: '  新标题  ',
      favorite: true,
    });

    expect(updated.title).toBe('新标题');
    expect(calls).toEqual([
      {
        command: 'notes_update',
        args: {
          id: 'note-1',
          input: {
            title: '新标题',
            folderId: 'f1',
            tags: ['产品'],
            body: '<p>正文</p>',
            bodyFormat: 'html',
            favorite: true,
            pinned: false,
          },
        },
      },
    ]);
  });

  it('删除与恢复直接委托 notes_delete / notes_restore', async () => {
    const calls: string[] = [];
    const invoker = (async (
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push(command);
      if (command === 'notes_restore') {
        return makeNote({ id: String(args?.id), status: 'active' });
      }
      return undefined;
    }) as DbInvoker;
    const repository = createNoteRepository(createDbClient(invoker));

    await repository.remove('note-1');
    await repository.restore('note-1');

    expect(calls).toEqual(['notes_delete', 'notes_restore']);
  });
});

describe('Markdown 导出保留结构', () => {
  const body = [
    '<h2>本周计划</h2>',
    '<p>先做<strong>重要</strong>的事。</p>',
    '<ul><li>完成需求文档</li><li>评审原型</li></ul>',
    '<ol><li>第一步</li><li>第二步</li></ol>',
    '<div class="itodo done" data-note-todo="t1"><span class="ittext">已完成待办</span></div>',
    '<div class="itodo" data-note-todo="t2"><span class="ittext">未完成待办</span></div>',
    '<blockquote>引用一段原则</blockquote>',
    '<pre>const answer = 42;</pre>',
    '<table><tr><th>项</th><th>值</th></tr><tr><td>A</td><td>1</td></tr></table>',
    '<p><a href="https://example.com">外部链接</a></p>',
    '<p><a href="zhixing://note/note-b">目标笔记</a></p>',
  ].join('');

  it('标题、标题层级、列表、待办、引用、代码、表格与链接都在', () => {
    const markdown = noteToMarkdown({
      title: '导出结构',
      body,
    });

    expect(markdown.startsWith('# 导出结构\n\n')).toBe(true);
    expect(markdown).toContain('## 本周计划');
    expect(markdown).toContain('**重要**');
    expect(markdown).toContain('- 完成需求文档');
    expect(markdown).toContain('- 评审原型');
    expect(markdown).toContain('1. 第一步');
    expect(markdown).toContain('2. 第二步');
    expect(markdown).toContain('- [x] 已完成待办');
    expect(markdown).toContain('- [ ] 未完成待办');
    expect(markdown).toContain('> 引用一段原则');
    expect(markdown).toContain('```\nconst answer = 42;\n```');
    expect(markdown).toContain('| 项 | 值 |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('[外部链接](https://example.com)');
    expect(markdown).toContain('[目标笔记](zhixing://note/note-b)');
  });

  it('嵌套列表与复选框列表保持缩进/勾选状态', () => {
    const markdown = htmlToMarkdown(
      '<ul><li>父项<ul><li>子项</li></ul></li><li><input type="checkbox" checked> 已勾选</li></ul>',
    );
    expect(markdown).toContain('- 父项');
    expect(markdown).toContain('  - 子项');
    expect(markdown).toContain('- [x] 已勾选');
  });

  it('空正文只导出标题；文件名去掉路径非法字符', () => {
    expect(noteToMarkdown({ title: '空笔记', body: '' })).toBe('# 空笔记\n');
    expect(exportMarkdownFileName('a/b:c*?"<>|')).toBe('a-b-c------.md');
    expect(exportMarkdownFileName('   ')).toBe('未命名笔记.md');
  });
});

describe('笔记内链关系图（ZX-GRAPH-01）', () => {
  const link = (id: string) =>
    `<a href="zhixing://note/${id}">${id}</a>`;

  function graphNotes(): Note[] {
    return [
      makeNote({
        id: 'note-a',
        title: '来源笔记',
        body: [
          `<p>${link('note-b')}</p>`,
          '<p><a href="https://example.com/doc">外部链接</a></p>',
          '<p><a href="https://example.com/?next=zhixing://note/not-a-relation">外链参数</a></p>',
          '<p>zhixing://note/missing-note</p>',
          '<p>zhixing://board/board-1</p>',
        ].join(''),
      }),
      makeNote({
        id: 'note-b',
        title: '目标笔记',
        body: `<p>${link('note-c')}</p>`,
      }),
      makeNote({ id: 'note-c', title: '二跳笔记', body: '<p>正文</p>' }),
      makeNote({ id: 'note-d', title: '孤立笔记', body: '<p>没人链接我</p>' }),
      makeNote({
        id: 'note-trash',
        title: '已删除目标',
        status: 'trashed',
        deletedAt: '2026-10-21T00:00:00.000Z',
      }),
    ];
  }

  it('解析有向边，外部链接排除，孤立/断链显式标注', () => {
    const graph = buildNoteLinkGraph(graphNotes(), {
      rootId: 'note-a',
      depth: 'all',
    });

    expect(graph.noteCount).toBe(4);
    expect(graph.edgeCount).toBe(2);
    expect(graph.brokenCount).toBe(1);
    expect(graph.isolatedCount).toBe(1);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: 'note-a',
          targetId: 'note-b',
          broken: false,
        }),
        expect.objectContaining({
          sourceId: 'note-b',
          targetId: 'note-c',
          broken: false,
        }),
        expect.objectContaining({
          sourceId: 'note-a',
          targetId: 'broken:missing-note',
          broken: true,
        }),
      ]),
    );
    // 外部网页链接与 zhixing://board 都不产生边。
    expect(
      graph.edges.some(
        (edge) =>
          edge.targetId.includes('example.com') ||
          edge.targetId.includes('board-1') ||
          edge.targetId.includes('not-a-relation'),
      ),
    ).toBe(false);
    expect(graph.nodes.find((node) => node.id === 'note-d')).toMatchObject({
      kind: 'note',
      isolated: true,
      depth: null,
    });
    expect(
      graph.nodes.find((node) => node.id === 'broken:missing-note'),
    ).toMatchObject({
      kind: 'broken',
      brokenReason: 'missing',
      title: '断链：missing-note',
    });
  });

  it('一跳/两跳只保留当前笔记邻域，边不跨越可见范围', () => {
    const oneHop = buildNoteLinkGraph(graphNotes(), {
      rootId: 'note-a',
      depth: 1,
    });
    expect(oneHop.noteCount).toBe(2);
    expect(oneHop.nodes.map((node) => node.id).sort()).toEqual([
      'broken:missing-note',
      'note-a',
      'note-b',
    ]);
    expect(oneHop.edgeCount).toBe(1);

    const twoHop = buildNoteLinkGraph(graphNotes(), {
      rootId: 'note-a',
      depth: 2,
    });
    expect(twoHop.noteCount).toBe(3);
    expect(twoHop.edgeCount).toBe(2);
    expect(twoHop.nodes.some((node) => node.id === 'note-c')).toBe(true);
    expect(twoHop.nodes.some((node) => node.id === 'note-d')).toBe(false);
  });

  it('指向回收站笔记的内链标记为断链，恢复后才重新成为有效边', () => {
    const notes = [
      makeNote({
        id: 'source',
        title: '来源',
        body: '<p>zhixing://note/trashed</p>',
      }),
      makeNote({
        id: 'trashed',
        title: '旧笔记',
        status: 'trashed',
        deletedAt: '2026-10-21T00:00:00.000Z',
      }),
    ];
    const broken = buildNoteLinkGraph(notes, {
      rootId: 'source',
      depth: 1,
    });
    expect(broken.brokenCount).toBe(1);
    expect(
      broken.nodes.find((node) => node.id === 'broken:trashed'),
    ).toMatchObject({
      brokenReason: 'trashed',
      title: '断链：旧笔记',
    });

    const restored = buildNoteLinkGraph(
      notes.map((note) =>
        note.id === 'trashed'
          ? { ...note, status: 'active' as const, deletedAt: null }
          : note,
      ),
      { rootId: 'source', depth: 1 },
    );
    expect(restored.brokenCount).toBe(0);
    expect(restored.edgeCount).toBe(1);
  });

  it('100 篇笔记 / 1000 条边在交互预算内构建', () => {
    const notes = Array.from({ length: 100 }, (_, index) =>
      makeNote({
        id: `perf-${index}`,
        title: `性能笔记 ${index}`,
        body: Array.from({ length: 10 }, (_, offset) => {
          const target = `perf-${(index * 10 + offset) % 100}`;
          return target === `perf-${index}`
            ? '<span>自链接已忽略</span>'
            : `<a href="zhixing://note/${target}">${target}</a>`;
        }).join(''),
      }),
    );
    const startedAt = performance.now();
    const graph = buildNoteLinkGraph(notes, {
      rootId: 'perf-0',
      depth: 'all',
    });
    const elapsed = performance.now() - startedAt;

    expect(graph.noteCount).toBe(100);
    expect(graph.edgeCount + graph.brokenCount).toBeGreaterThan(900);
    expect(elapsed).toBeLessThan(1500);
  });
});
