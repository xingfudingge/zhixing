import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { blockQuoteMeta, checkQuoteMeta } from '../types';
import { blocksToHtml } from '../blockHtml';
import { convertBlockType } from '../model';
import type { LinkNoteOption } from '../LinkDialog';
import { NoteBlockEditor } from '../NoteBlockEditor';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
  type FakeBlockSource,
} from './fakeBlockSource';

const TARGET_ID = 'note-target';
const OTHER_ID = 'note-other';
const MISSING_ID = 'note-missing';

const NOTE_OPTIONS: LinkNoteOption[] = [
  { id: TARGET_ID, title: '任务与笔记的关系是一等数据' },
  { id: OTHER_ID, title: '周复盘：从记录到判断' },
];

function paragraph(id: string, text: string) {
  return makeBlock({
    id,
    type: 'paragraph',
    payload: { runs: [{ text }] },
  });
}

function quote(
  id: string,
  text: string,
  meta: {
    source?: string;
    noteId?: string;
    sourceUrl?: string;
  } = {},
) {
  return makeBlock({
    id,
    type: 'quote',
    payload: {
      runs: text ? [{ text }] : [],
      ...meta,
    },
  });
}

function renderEditor(
  source: FakeBlockSource,
  options: {
    initialReadOnly?: boolean;
    noteOptions?: readonly LinkNoteOption[];
    onOpenNote?: (noteId: string) => void;
    saveDelayMs?: number;
  } = {},
) {
  return render(
    <NoteBlockEditor
      noteId={FAKE_NOTE_ID}
      source={source}
      saveDelayMs={options.saveDelayMs ?? 0}
      noteOptions={options.noteOptions ?? NOTE_OPTIONS}
      onOpenNote={options.onOpenNote}
      initialReadOnly={options.initialReadOnly}
    />,
  );
}

function blockOf(source: FakeBlockSource, id: string) {
  return source.snapshot().find((block) => block.id === id);
}

async function openSourceDialog(
  user: ReturnType<typeof userEvent.setup>,
) {
  const trigger = await screen.findByRole('button', {
    name: /编辑引用出处|添加出处/,
  });
  await user.click(trigger);
  return screen.findByRole('dialog', { name: '编辑引用出处' });
}

describe('引用块 · 出处与来源（ZX-NOTE-04）', () => {
  it('显示出处、关联笔记与来源链接，noteId 与内链同一笔记时不重复', async () => {
    const source = createFakeBlockSource([
      paragraph('b1', '前一段'),
      quote('q1', '关系是一等数据。', {
        source: '《任务与知识融合设计》评审记录',
        noteId: TARGET_ID,
        sourceUrl: `zhixing://note/${TARGET_ID}`,
      }),
      paragraph('b3', '后一段'),
    ]);
    const onOpenNote = vi.fn();
    const user = userEvent.setup();
    const { container } = renderEditor(source, { onOpenNote });

    expect(
      await screen.findByText('— 《任务与知识融合设计》评审记录'),
    ).toBeInTheDocument();
    const noteChip = screen.getByRole('button', {
      name: '打开关联笔记：任务与笔记的关系是一等数据',
    });
    expect(noteChip).toHaveTextContent('⌁ 任务与笔记的关系是一等数据');
    // 同一篇笔记的 noteId 优先，站内来源 chip 不重复出现。
    expect(screen.queryByText('⌁ 站内来源')).toBeNull();
    expect(
      container.querySelector('.zxe-quote')?.getAttribute('data-has-meta'),
    ).toBe('true');

    await user.click(noteChip);
    expect(onOpenNote).toHaveBeenCalledWith(TARGET_ID);
    // 引用不改变相邻块。
    expect(blockOf(source, 'b1')?.payload).toEqual({
      runs: [{ text: '前一段' }],
    });
    expect(blockOf(source, 'b3')?.payload).toEqual({
      runs: [{ text: '后一段' }],
    });
  });

  it('外链来源渲染为可点击链接，非法历史 URL 明确提示且不可点', async () => {
    const source = createFakeBlockSource([
      quote('q1', '外部来源', {
        sourceUrl: 'https://example.com/article',
      }),
      quote('q2', '脏数据', { sourceUrl: 'javascript:alert(1)' }),
    ]);
    renderEditor(source);

    const link = await screen.findByRole('link', { name: '打开来源链接' });
    expect(link).toHaveAttribute('href', 'https://example.com/article');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer noopener');

    expect(screen.getByRole('alert')).toHaveTextContent('来源链接无效');
    expect(
      screen.queryByRole('link', { name: '打开来源链接' }),
    ).not.toBeNull();
    // 非法 URL 不应生成第二个可点击链接。
    expect(screen.getAllByRole('link', { name: '打开来源链接' })).toHaveLength(
      1,
    );
  });

  it('站内来源独立于 noteId：有效时可打开，失效时禁用', async () => {
    const source = createFakeBlockSource([
      quote('q1', '站内来源', {
        sourceUrl: `zhixing://note/${OTHER_ID}`,
      }),
      quote('q2', '失效来源', {
        sourceUrl: `zhixing://note/${MISSING_ID}`,
      }),
    ]);
    const onOpenNote = vi.fn();
    const user = userEvent.setup();
    renderEditor(source, { onOpenNote });

    const sourceChip = await screen.findByRole('button', {
      name: '打开站内来源：周复盘：从记录到判断',
    });
    expect(sourceChip).toHaveTextContent('⌁ 站内来源');
    await user.click(sourceChip);
    expect(onOpenNote).toHaveBeenCalledWith(OTHER_ID);

    expect(screen.getByText('站内来源已失效')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('空引用在编辑态显示「＋ 添加出处」，阅读态不出现来源行', async () => {
    const source = createFakeBlockSource([quote('q1', '')]);
    const { unmount } = renderEditor(source);

    expect(
      await screen.findByRole('button', { name: '＋ 添加出处' }),
    ).toBeInTheDocument();
    unmount();

    const readOnlySource = createFakeBlockSource([quote('q1', '')]);
    renderEditor(readOnlySource, { initialReadOnly: true });
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: '引用内容' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: '＋ 添加出处' })).toBeNull();
    expect(
      screen.queryByRole('group', { name: '引用出处' }),
    ).toBeNull();
  });

  it('点击出处行打开弹层；保存只更新来源字段且保留正文与其他块', async () => {
    const source = createFakeBlockSource([
      paragraph('b1', '不动的前段'),
      quote('q1', '引用正文保持不变。', {
        source: '旧出处',
        noteId: TARGET_ID,
      }),
      paragraph('b3', '不动的后段'),
    ]);
    const user = userEvent.setup();
    renderEditor(source, { onOpenNote: vi.fn() });

    const dialog = await openSourceDialog(user);
    expect(within(dialog).getByLabelText('出处')).toHaveValue('旧出处');
    expect(within(dialog).getByLabelText('关联笔记')).toHaveValue(TARGET_ID);
    expect(within(dialog).getByLabelText('来源链接')).toHaveValue('');

    fireEvent.change(within(dialog).getByLabelText('出处'), {
      target: { value: '  《卡片笔记写作法》第 6 章  ' },
    });
    fireEvent.change(within(dialog).getByLabelText('来源链接'), {
      target: { value: 'https://example.com/book' },
    });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(
      screen.getByText('— 《卡片笔记写作法》第 6 章'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: '打开关联笔记：任务与笔记的关系是一等数据',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: '打开来源链接' }),
    ).toHaveAttribute('href', 'https://example.com/book');

    const saved = blockOf(source, 'q1');
    expect(saved?.payload).toMatchObject({
      runs: [{ text: '引用正文保持不变。' }],
      source: '《卡片笔记写作法》第 6 章',
      noteId: TARGET_ID,
      sourceUrl: 'https://example.com/book',
    });
    expect(blockOf(source, 'b1')?.payload).toEqual({
      runs: [{ text: '不动的前段' }],
    });
    expect(blockOf(source, 'b3')?.payload).toEqual({
      runs: [{ text: '不动的后段' }],
    });
  });

  it('javascript: / 超长 / 非法内链就地报错，弹层不关闭也不写值', async () => {
    const source = createFakeBlockSource([
      quote('q1', '校验正文', { source: '原出处', noteId: TARGET_ID }),
    ]);
    const user = userEvent.setup();
    renderEditor(source);

    let dialog = await openSourceDialog(user);
    fireEvent.change(within(dialog).getByLabelText('来源链接'), {
      target: { value: 'javascript:alert(1)' },
    });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(
      within(dialog).getByRole('alert'),
    ).toHaveTextContent('仅支持 http / https / mailto 或站内笔记内链');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(blockOf(source, 'q1')?.payload.sourceUrl).toBeUndefined();

    fireEvent.change(within(dialog).getByLabelText('来源链接'), {
      target: { value: 'zhixing://note/../secret' },
    });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      '内链 id 不合法',
    );

    fireEvent.change(within(dialog).getByLabelText('来源链接'), {
      target: { value: `https://example.com/${'x'.repeat(2048)}` },
    });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('链接过长');

    fireEvent.change(within(dialog).getByLabelText('来源链接'), {
      target: { value: '' },
    });
    fireEvent.change(within(dialog).getByLabelText('出处'), {
      target: { value: '啊'.repeat(121) },
    });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      '出处最多 120 字（当前 121 字）',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(blockOf(source, 'q1')?.payload.source).toBe('原出处');
  });

  it('关联笔记已删除：chip 禁用，弹层保存会清除关联但保留正文和出处', async () => {
    const source = createFakeBlockSource([
      quote('q1', '正文还在', {
        source: '保留的出处',
        noteId: MISSING_ID,
      }),
    ]);
    const user = userEvent.setup();
    renderEditor(source);

    expect(await screen.findByText('关联笔记已删除')).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    const dialog = await openSourceDialog(user);
    expect(
      within(dialog).getByText(/关联笔记已删除；保存后会清除该关联/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('option', {
      name: '关联笔记已删除（保存将清除）',
    })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.queryByText('关联笔记已删除')).toBeNull();
    expect(screen.getByText('— 保留的出处')).toBeInTheDocument();
    expect(blockOf(source, 'q1')?.payload).toMatchObject({
      runs: [{ text: '正文还在' }],
      source: '保留的出处',
      noteId: '',
    });
  });

  it('清除会清空三个来源字段，但不动引用正文', async () => {
    const source = createFakeBlockSource([
      quote('q1', '正文不能删', {
        source: '出处',
        noteId: TARGET_ID,
        sourceUrl: 'https://example.com',
      }),
    ]);
    const user = userEvent.setup();
    renderEditor(source);

    const dialog = await openSourceDialog(user);
    await user.click(within(dialog).getByRole('button', { name: '清除' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    expect(
      screen.getByRole('button', { name: '＋ 添加出处' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '引用内容' })).toHaveTextContent(
      '正文不能删',
    );
    expect(blockOf(source, 'q1')?.payload).toMatchObject({
      runs: [{ text: '正文不能删' }],
      source: '',
      noteId: '',
      sourceUrl: '',
    });
  });

  it('块菜单提供「编辑引用出处」，阅读态不提供任何编辑入口', async () => {
    const source = createFakeBlockSource([
      quote('q1', '菜单位置', { source: '出处' }),
    ]);
    const user = userEvent.setup();
    const { unmount } = renderEditor(source);

    await user.click(
      await screen.findByRole('button', { name: '块操作' }),
    );
    const menuItem = await screen.findByRole('menuitem', {
      name: '❝ 编辑引用出处',
    });
    await user.click(menuItem);
    expect(
      await screen.findByRole('dialog', { name: '编辑引用出处' }),
    ).toBeInTheDocument();
    unmount();

    const readOnlySource = createFakeBlockSource([
      quote('q1', '只读', { source: '出处' }),
    ]);
    renderEditor(readOnlySource, { initialReadOnly: true });
    await waitFor(() => {
      expect(screen.getByText('— 出处')).toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: '编辑引用出处' }),
    ).toBeNull();
  });

  it('带出处的空引用不会被 Backspace 降级丢失来源', async () => {
    const source = createFakeBlockSource([
      quote('q1', '', { source: '有出处的空引用', noteId: TARGET_ID }),
    ]);
    renderEditor(source);

    const textbox = await screen.findByRole('textbox', {
      name: '引用内容',
    });
    textbox.focus();
    fireEvent.keyDown(textbox, { key: 'Backspace' });

    await waitFor(() => {
      expect(
        document.querySelector('[data-block-id="q1"]'),
      ).toHaveAttribute('data-block-type', 'quote');
    });
    expect(blockOf(source, 'q1')?.payload).toMatchObject({
      source: '有出处的空引用',
      noteId: TARGET_ID,
    });
  });
});

describe('引用块 · 数据契约与转换', () => {
  it('blockQuoteMeta 防御式读取脏 payload，不截断出处', () => {
    const dirty = makeBlock({
      id: 'q-dirty',
      type: 'quote',
      payload: {
        runs: [{ text: '正文' }],
        source: `  ${'长'.repeat(130)}  `,
        noteId: 42,
        sourceUrl: 99,
      },
    });
    expect(blockQuoteMeta(dirty)).toEqual({
      source: '长'.repeat(130),
      noteId: '',
      sourceUrl: '',
    });
  });

  it('checkQuoteMeta 覆盖超长、非法 id、危险协议与删除目标', () => {
    expect(
      checkQuoteMeta({
        source: 'a'.repeat(121),
        noteId: '',
        sourceUrl: '',
      }).error,
    ).toContain('最多 120 字');

    expect(
      checkQuoteMeta({
        source: '',
        noteId: '../secret',
        sourceUrl: '',
      }).error,
    ).toBe('关联笔记 id 不合法');

    expect(
      checkQuoteMeta({
        source: '',
        noteId: '',
        sourceUrl: 'data:text/html,<script>alert(1)</script>',
      }).error,
    ).toBe('仅支持 http / https / mailto 或站内笔记内链');

    expect(
      checkQuoteMeta(
        { source: '', noteId: 'gone', sourceUrl: '' },
        [{ id: 'kept' }],
      ),
    ).toMatchObject({
      error: null,
      noteMissing: true,
      meta: { noteId: '' },
    });
  });

  it('引用 ↔ 文本转换保留正文、丢弃引用来源元数据', () => {
    const source = makeBlock({
      id: 'q1',
      type: 'quote',
      payload: {
        runs: [{ text: '要保留的正文' }],
        source: '出处',
        noteId: TARGET_ID,
        sourceUrl: 'https://example.com',
      },
    });
    const paragraphBlock = convertBlockType(source, 'paragraph');
    expect(paragraphBlock.type).toBe('paragraph');
    expect(paragraphBlock.payload).toEqual({
      runs: [{ text: '要保留的正文' }],
    });

    const backToQuote = convertBlockType(paragraphBlock, 'quote');
    expect(backToQuote.payload).toEqual({
      runs: [{ text: '要保留的正文' }],
    });
  });

  it('导出投影保留引用正文与相邻块，不把来源拼成可执行 HTML', () => {
    const html = blocksToHtml([
      paragraph('b1', '前段'),
      {
        type: 'quote',
        payload: {
          runs: [{ text: '引用正文' }],
          source: '<img src=x onerror=alert(1)>',
          sourceUrl: 'javascript:alert(1)',
        },
      },
      paragraph('b3', '后段'),
    ]);
    expect(html).toContain('<blockquote>引用正文</blockquote>');
    expect(html).toContain('<p>前段</p>');
    expect(html).toContain('<p>后段</p>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
  });
});
