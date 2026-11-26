import {
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorBlock } from '../../../data/repositories/blocks';
import type { LinkNoteOption } from '../LinkDialog';
import { NoteBlockEditor } from '../NoteBlockEditor';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
  type FakeBlockSource,
} from './fakeBlockSource';

const openExternalLinkMock = vi.hoisted(() =>
  vi.fn(async (_url: string) => {}),
);
const copyLinkTextMock = vi.hoisted(() =>
  vi.fn(async (_text: string) => true),
);

vi.mock('../linkActions', () => ({
  openExternalLink: openExternalLinkMock,
  copyLinkText: copyLinkTextMock,
}));

const TARGET_ID = 'note-target';
const MISSING_ID = 'note-missing';
const TARGET_TITLE = '任务与笔记的关系是一等数据';
const NOTE_OPTIONS: LinkNoteOption[] = [
  { id: TARGET_ID, title: TARGET_TITLE },
];

function link(id: string, url: string, title = ''): EditorBlock {
  return makeBlock({ id, type: 'link', payload: { url, title } });
}

function renderEditor(
  source: FakeBlockSource,
  options: {
    initialReadOnly?: boolean;
    noteOptions?: readonly LinkNoteOption[];
    onOpenNote?: (noteId: string) => void;
  } = {},
) {
  return render(
    <NoteBlockEditor
      noteId={FAKE_NOTE_ID}
      source={source}
      saveDelayMs={0}
      initialReadOnly={options.initialReadOnly}
      noteOptions={options.noteOptions ?? NOTE_OPTIONS}
      onOpenNote={options.onOpenNote}
    />,
  );
}

function groupOf(container: HTMLElement, blockId: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(
    `[data-block-id="${blockId}"]`,
  );
  if (!row) {
    throw new Error(`缺少块 ${blockId}`);
  }
  const group = row.querySelector<HTMLElement>('[role="group"]');
  if (!group) {
    throw new Error(`块 ${blockId} 没有链接卡`);
  }
  return group;
}

function blockOf(source: FakeBlockSource, id: string) {
  return source.snapshot().find((block) => block.id === id);
}

async function awaitGroups(count = 1) {
  await waitFor(() => {
    expect(screen.queryAllByRole('group', { name: '链接块' })).toHaveLength(
      count,
    );
  });
}

beforeEach(() => {
  openExternalLinkMock.mockReset();
  openExternalLinkMock.mockResolvedValue(undefined);
  copyLinkTextMock.mockReset();
  copyLinkTextMock.mockResolvedValue(true);
});

describe('链接块 · 可点击链接卡片（ZX-LINK-01）', () => {
  it('外链卡显示标题、域名与打开按钮，不抓取 favicon 或网络元数据', async () => {
    const source = createFakeBlockSource([
      link(
        'l1',
        'https://www.feishu.cn/doc/abc',
        '飞书画板 · 单人创作指南',
      ),
    ]);
    const { container } = renderEditor(source, { initialReadOnly: true });

    const group = await screen.findByRole('group', { name: '链接块' });
    expect(group).toHaveAttribute('data-kind', 'external');
    expect(group).toHaveAttribute('data-invalid', 'false');
    expect(group).toHaveTextContent('飞书画板 · 单人创作指南');
    expect(group).toHaveTextContent('www.feishu.cn');
    expect(container.querySelector('img')).toBeNull();

    const open = within(group).getByRole('button', { name: /打开链接/ });
    expect(open).not.toHaveAttribute('href');
    expect(open).not.toHaveAttribute('target');
    expect(container.querySelector('a[target="_blank"]')).toBeNull();
  });

  it('编辑态单击外链标题直接交给系统打开，不弹编辑弹层', async () => {
    const source = createFakeBlockSource([
      link('l1', 'https://www.feishu.cn/doc/abc', '飞书画板指南'),
    ]);
    const user = userEvent.setup();
    const { container } = renderEditor(source, { initialReadOnly: false });

    await awaitGroups();
    const group = groupOf(container, 'l1');
    await user.click(
      within(group).getByRole('button', { name: '飞书画板指南' }),
    );

    expect(openExternalLinkMock).toHaveBeenCalledWith(
      'https://www.feishu.cn/doc/abc',
    );
    expect(
      screen.queryByRole('dialog', { name: '编辑链接' }),
    ).not.toBeInTheDocument();
  });

  it('阅读态单击外链标题同样直接打开', async () => {
    const source = createFakeBlockSource([
      link('l1', 'mailto:hi@example.com', '写邮件'),
    ]);
    const user = userEvent.setup();
    const { container } = renderEditor(source, { initialReadOnly: true });

    await awaitGroups();
    await user.click(
      within(groupOf(container, 'l1')).getByRole('button', {
        name: '写邮件',
      }),
    );
    expect(openExternalLinkMock).toHaveBeenCalledWith('mailto:hi@example.com');
  });

  it('外链打开失败时显示原因并可复制链接，不静默失败', async () => {
    openExternalLinkMock.mockRejectedValueOnce(
      new Error('没有可用的默认浏览器'),
    );
    const source = createFakeBlockSource([
      link('l1', 'https://example.com/broken', '打不开的链接'),
    ]);
    const user = userEvent.setup();
    const { container } = renderEditor(source, { initialReadOnly: false });

    await awaitGroups();
    const group = groupOf(container, 'l1');
    await user.click(
      within(group).getByRole('button', { name: '打不开的链接' }),
    );

    const alert = await within(group).findByRole('alert');
    expect(alert).toHaveTextContent('没有可用的默认浏览器');
    expect(
      screen.queryByRole('dialog', { name: '编辑链接' }),
    ).not.toBeInTheDocument();

    const copy = within(alert).getByRole('button', { name: '复制链接' });
    await user.click(copy);
    expect(copyLinkTextMock).toHaveBeenCalledWith(
      'https://example.com/broken',
    );
    expect(await within(group).findByRole('status')).toHaveTextContent(
      '已复制链接',
    );
  });

  it('标题留空时回退域名；mailto 显示邮箱地址而不是空白', async () => {
    const source = createFakeBlockSource([
      link('l1', 'https://example.com/path'),
      link('l2', 'mailto:hi@example.com', '写邮件'),
    ]);
    const { container } = renderEditor(source, { initialReadOnly: true });

    await awaitGroups(2);
    const external = groupOf(container, 'l1');
    expect(external).toHaveTextContent('example.com');
    expect(external).toHaveAttribute('data-invalid', 'false');

    const mail = groupOf(container, 'l2');
    expect(mail).toHaveTextContent('写邮件');
    expect(mail).toHaveTextContent('hi@example.com');
    expect(mail.querySelector('.zxe-linkblock-meta')).toHaveTextContent(
      'hi@example.com',
    );
  });

  it('危险协议与无法解析的地址显示原始 URL 和原因，不空白也不可点', async () => {
    const source = createFakeBlockSource([
      link('l1', 'javascript:alert(1)', '危险链接'),
      link('l2', 'www.example.com', '缺少协议'),
    ]);
    const { container } = renderEditor(source, { initialReadOnly: true });

    await awaitGroups(2);
    const dangerous = groupOf(container, 'l1');
    expect(dangerous).toHaveAttribute('data-kind', 'invalid');
    expect(dangerous).toHaveAttribute('data-invalid', 'true');
    expect(dangerous).toHaveTextContent('危险链接');
    expect(dangerous).toHaveTextContent('javascript:alert(1)');
    expect(dangerous).toHaveTextContent(
      '仅支持 http / https / mailto 或站内笔记内链',
    );
    expect(within(dangerous).getByRole('alert')).toBeInTheDocument();
    expect(within(dangerous).queryByRole('link')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();

    const bare = groupOf(container, 'l2');
    expect(bare).toHaveTextContent('www.example.com');
    expect(bare).toHaveAttribute('data-invalid', 'true');
  });

  it('内链卡解析目标笔记标题，点击打开笔记而不是浏览器', async () => {
    const source = createFakeBlockSource([
      link('l1', `zhixing://note/${TARGET_ID}`),
    ]);
    const onOpenNote = vi.fn();
    const user = userEvent.setup();
    const { container } = renderEditor(source, {
      initialReadOnly: true,
      onOpenNote,
    });

    await awaitGroups();
    const group = groupOf(container, 'l1');
    expect(group).toHaveAttribute('data-kind', 'note');
    expect(group).toHaveTextContent(TARGET_TITLE);
    expect(group.querySelector('.zxe-linkblock-meta')).toHaveTextContent(
      '站内笔记',
    );
    expect(group.querySelector('a[href^="zhixing"]')).toBeNull();

    await user.click(
      within(group).getByRole('button', { name: /打开笔记/ }),
    );
    expect(onOpenNote).toHaveBeenCalledWith(TARGET_ID);
  });

  it('编辑态单击内链标题直接跳转，不弹编辑弹层', async () => {
    const source = createFakeBlockSource([
      link('l1', `zhixing://note/${TARGET_ID}`, '先读这一篇'),
    ]);
    const onOpenNote = vi.fn();
    const user = userEvent.setup();
    const { container } = renderEditor(source, {
      initialReadOnly: false,
      onOpenNote,
    });

    await awaitGroups();
    const group = groupOf(container, 'l1');
    await user.click(
      within(group).getByRole('button', { name: '先读这一篇' }),
    );

    expect(onOpenNote).toHaveBeenCalledWith(TARGET_ID);
    expect(
      screen.queryByRole('dialog', { name: '编辑链接' }),
    ).not.toBeInTheDocument();
  });

  it('内链设置别名时仍显示目标笔记，便于确认指向', async () => {
    const source = createFakeBlockSource([
      link('l1', `zhixing://note/${TARGET_ID}`, '先读这一篇'),
    ]);
    const { container } = renderEditor(source, { initialReadOnly: true });

    await awaitGroups();
    const group = groupOf(container, 'l1');
    expect(group).toHaveTextContent('先读这一篇');
    expect(group.querySelector('.zxe-linkblock-meta')).toHaveTextContent(
      `站内笔记 · ${TARGET_TITLE}`,
    );
  });

  it('目标笔记不存在时进入失效态，单击标题提示且不导航', async () => {
    const source = createFakeBlockSource([
      link('l1', `zhixing://note/${MISSING_ID}`, '已删除的旧笔记'),
    ]);
    const onOpenNote = vi.fn();
    const user = userEvent.setup();
    const { container } = renderEditor(source, {
      initialReadOnly: true,
      onOpenNote,
    });

    await awaitGroups();
    const group = groupOf(container, 'l1');
    expect(group).toHaveAttribute('data-invalid', 'true');
    expect(group).toHaveTextContent('已删除的旧笔记');
    expect(group).toHaveTextContent('笔记不存在或已删除');
    expect(
      within(group).queryByRole('button', { name: /打开笔记/ }),
    ).toBeNull();

    await user.click(
      within(group).getByRole('button', { name: '已删除的旧笔记' }),
    );
    expect(onOpenNote).not.toHaveBeenCalled();
    const notice = await waitFor(() => {
      const element = group.querySelector<HTMLElement>(
        '.zxe-linkblock-notice',
      );
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(notice).toHaveTextContent('笔记不存在或已删除');
  });

  it('失效链接仍可修复，并可复制原始地址', async () => {
    const source = createFakeBlockSource([
      link('l1', `zhixing://note/${MISSING_ID}`, '已删除的旧笔记'),
    ]);
    const user = userEvent.setup();
    const { container } = renderEditor(source, { initialReadOnly: false });

    await awaitGroups();
    const group = groupOf(container, 'l1');
    const copy = within(group).getByRole('button', { name: '复制链接' });
    await user.click(copy);
    expect(copyLinkTextMock).toHaveBeenCalledWith(
      `zhixing://note/${MISSING_ID}`,
    );

    await user.click(
      within(group).getByRole('button', { name: '修复链接' }),
    );
    const dialog = await screen.findByRole('dialog', { name: '编辑链接' });
    expect(within(dialog).getByLabelText('链接地址')).toHaveValue(
      `zhixing://note/${MISSING_ID}`,
    );
  });

  it('指向当前笔记的内链视为有效，不误报已删除', async () => {
    const source = createFakeBlockSource([
      link('l1', `zhixing://note/${FAKE_NOTE_ID}`),
    ]);
    const onOpenNote = vi.fn();
    const user = userEvent.setup();
    const { container } = renderEditor(source, {
      initialReadOnly: true,
      onOpenNote,
    });

    await awaitGroups();
    const group = groupOf(container, 'l1');
    expect(group).toHaveAttribute('data-invalid', 'false');
    expect(group).toHaveTextContent('当前笔记');
    await user.click(
      within(group).getByRole('button', { name: /打开笔记/ }),
    );
    expect(onOpenNote).toHaveBeenCalledWith(FAKE_NOTE_ID);
  });

  it('显式编辑按钮打开弹层，标题单击不抢占编辑入口', async () => {
    const source = createFakeBlockSource([
      link('l1', `zhixing://note/${TARGET_ID}`, '旧别名'),
    ]);
    const onOpenNote = vi.fn();
    const user = userEvent.setup();
    const { container } = renderEditor(source, {
      initialReadOnly: false,
      onOpenNote,
    });

    await awaitGroups();
    const group = groupOf(container, 'l1');
    await user.click(
      within(group).getByRole('button', { name: '编辑链接' }),
    );
    expect(onOpenNote).not.toHaveBeenCalled();

    const dialog = await screen.findByRole('dialog', { name: '编辑链接' });
    expect(within(dialog).getByLabelText('链接标题')).toHaveValue('旧别名');
    expect(within(dialog).getByLabelText('链接地址')).toHaveValue(
      `zhixing://note/${TARGET_ID}`,
    );
    expect(dialog).toHaveTextContent(`目标笔记：${TARGET_TITLE}`);

    const titleInput = within(dialog).getByLabelText('链接标题');
    const urlInput = within(dialog).getByLabelText('链接地址');
    await user.clear(titleInput);
    await user.type(titleInput, '新别名');
    await user.clear(urlInput);
    await user.type(urlInput, 'https://example.com/new');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(blockOf(source, 'l1')?.payload).toEqual({
        url: 'https://example.com/new',
        title: '新别名',
      });
    });
    await waitFor(() => {
      const updated = groupOf(container, 'l1');
      expect(updated).toHaveAttribute('data-kind', 'external');
      expect(updated).toHaveTextContent('新别名');
      expect(updated).toHaveTextContent('example.com');
    });
  });

  it('编辑弹层拒绝危险协议与不存在的内链，卡片保持原值', async () => {
    const source = createFakeBlockSource([
      link('l1', 'https://example.com/safe', '安全链接'),
    ]);
    const user = userEvent.setup();
    const { container } = renderEditor(source, { initialReadOnly: false });

    await awaitGroups();
    const group = groupOf(container, 'l1');
    await user.click(within(group).getByRole('button', { name: '编辑链接' }));
    let dialog = await screen.findByRole('dialog', { name: '编辑链接' });

    const urlInput = within(dialog).getByLabelText('链接地址');
    await user.clear(urlInput);
    await user.type(urlInput, 'javascript:alert(1)');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '仅支持 http / https / mailto 或站内笔记内链',
    );
    expect(blockOf(source, 'l1')?.payload).toEqual({
      url: 'https://example.com/safe',
      title: '安全链接',
    });
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();

    await user.clear(urlInput);
    await user.type(urlInput, `zhixing://note/${MISSING_ID}`);
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '笔记不存在或已删除',
    );
    expect(blockOf(source, 'l1')?.payload).toEqual({
      url: 'https://example.com/safe',
      title: '安全链接',
    });

    dialog = await screen.findByRole('dialog', { name: '编辑链接' });
    expect(dialog).toBeInTheDocument();
  });

  it('编辑弹层可从笔记列表选择内链，标题留空后跟随目标笔记', async () => {
    const source = createFakeBlockSource([
      link('l1', 'https://example.com/safe', '旧外链'),
    ]);
    const user = userEvent.setup();
    const { container } = renderEditor(source, { initialReadOnly: false });

    await awaitGroups();
    await user.click(
      within(groupOf(container, 'l1')).getByRole('button', {
        name: '编辑链接',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: '编辑链接' });
    await user.clear(within(dialog).getByLabelText('链接标题'));
    await user.click(
      within(dialog).getByRole('button', { name: '笔记内链' }),
    );
    await user.type(within(dialog).getByLabelText('搜索笔记'), '任务');
    await user.click(
      await within(dialog).findByRole('option', { name: TARGET_TITLE }),
    );
    expect(within(dialog).getByLabelText('链接地址')).toHaveValue(
      `zhixing://note/${TARGET_ID}`,
    );
    expect(dialog).toHaveTextContent(`目标笔记：${TARGET_TITLE}`);

    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(blockOf(source, 'l1')?.payload).toEqual({
        url: `zhixing://note/${TARGET_ID}`,
        title: '',
      });
    });
    await waitFor(() => {
      const updated = groupOf(container, 'l1');
      expect(updated).toHaveAttribute('data-kind', 'note');
      expect(updated).toHaveTextContent(TARGET_TITLE);
    });
  });

  it('新建空链接块自动打开编辑；取消后卡片显示空态而不是空白', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const user = userEvent.setup();
    const { container } = renderEditor(source);

    await user.click(
      await screen.findByRole('button', { name: '插入内容' }),
    );
    await user.click(
      within(await screen.findByRole('menu', { name: '插入块' })).getByRole(
        'menuitem',
        { name: /^链接/ },
      ),
    );

    const dialog = await screen.findByRole('dialog', { name: '编辑链接' });
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog', { name: '编辑链接' })).toBeNull();

    const group = await screen.findByRole('group', { name: '链接块' });
    expect(group).toHaveAttribute('data-invalid', 'true');
    expect(group).toHaveTextContent('未填写链接');
    expect(group).toHaveTextContent('请填写链接地址');
    expect(group.textContent?.trim().length).toBeGreaterThan(0);
    expect(container.querySelector('a[href]')).toBeNull();
  });
});
