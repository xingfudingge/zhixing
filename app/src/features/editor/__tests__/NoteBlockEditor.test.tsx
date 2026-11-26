import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { parseBlockDocument } from '../../../data/repositories/blocks';
import {
  AttachmentManager,
  MemoryAttachmentMetadataRepository,
  MemoryAttachmentStateStore,
  MemoryBlobStore,
} from '../../attachments';
import { restoreSelectionByOffsets } from '../inline';
import { blockTableRows } from '../types';
import type { LinkNoteOption } from '../LinkDialog';
import { NoteBlockEditor } from '../NoteBlockEditor';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
  type FakeBlockSource,
} from './fakeBlockSource';

function createEditorAttachmentHarness() {
  const repository = new MemoryAttachmentMetadataRepository();
  const blobStore = new MemoryBlobStore();
  const stateStore = new MemoryAttachmentStateStore();
  let sequence = 0;
  const manager = new AttachmentManager({
    repository,
    blobStore,
    stateStore,
    newId: () => `att_${++sequence}`,
  });
  return { repository, blobStore, stateStore, manager };
}

function renderEditor(
  source: FakeBlockSource,
  options: {
    initialReadOnly?: boolean;
    initialHtml?: string;
    noteOptions?: LinkNoteOption[];
    onOpenNote?: (noteId: string) => void;
    attachmentManager?: AttachmentManager | null;
  } = {},
) {
  return render(
    <NoteBlockEditor
      noteId={FAKE_NOTE_ID}
      source={source}
      saveDelayMs={0}
      {...options}
    />,
  );
}

/**
 * 文档级入口（样式面板）已迁到知识页命令栏；编辑器单测用受控开关驱动，
 * 不把测试按钮带进产品 UI。
 */
function EditorStyleHarness({ source }: { source: FakeBlockSource }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开样式
      </button>
      <NoteBlockEditor
        noteId={FAKE_NOTE_ID}
        source={source}
        saveDelayMs={0}
        stylePanelOpen={open}
        onStylePanelChange={setOpen}
      />
    </>
  );
}

function selectRange(element: HTMLElement, start: number, end: number) {
  restoreSelectionByOffsets(element, start, end);
  fireEvent.mouseUp(element);
  act(() => {
    document.dispatchEvent(new Event('selectionchange'));
  });
}

function blockIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-block-type]'),
  ).map((element) => element.getAttribute('data-block-id') ?? '');
}

describe('块编辑器 · 无固定工具栏与块菜单', () => {
  it('空块显示 ＋，菜单可把空段落变为 H2 和待办', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const user = userEvent.setup();
    const { container } = renderEditor(source);

    const control = await screen.findByRole('button', { name: '插入内容' });
    expect(control).toHaveTextContent('＋');
    expect(screen.queryByRole('toolbar', { name: '文字格式' })).toBeNull();
    expect(container.querySelector('.zxe-formatbar')).toBeNull();

    await user.click(control);
    const menu = await screen.findByRole('menu', { name: '插入块' });
    await user.click(within(menu).getByRole('menuitem', { name: /标题 2/ }));

    await waitFor(() => {
      expect(container.querySelector('h2')).not.toBeNull();
    });
    expect(screen.getByRole('textbox', { name: '标题 2' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '插入内容' }));
    const todoMenu = await screen.findByRole('menu', { name: '插入块' });
    await user.click(
      within(todoMenu).getByRole('menuitem', { name: /待办事项/ }),
    );

    expect(await screen.findByRole('checkbox')).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: '待办内容' }),
    ).toBeInTheDocument();
  });

  it('非空块显示 ⠿，点击打开同类菜单', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '已有内容' }] },
      }),
    ]);
    const user = userEvent.setup();
    renderEditor(source);

    const control = await screen.findByRole('button', { name: '块操作' });
    expect(control).toHaveTextContent('⠿');
    await user.click(control);
    expect(
      await screen.findByRole('menu', { name: '插入块' }),
    ).toBeInTheDocument();
  });

  it('空块输入 / 打开块菜单', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    renderEditor(source);
    const textbox = await screen.findByRole('textbox', { name: '正文' });
    fireEvent.keyDown(textbox, { key: '/' });
    expect(
      await screen.findByRole('menu', { name: '插入块' }),
    ).toBeInTheDocument();
  });
});

const BLOCK_CASES: Array<{
  name: string;
  menu: RegExp;
  verify: (container: HTMLElement) => void;
}> = [
  {
    name: 'H1',
    menu: /标题 1/,
    verify: (container) => expect(container.querySelector('h1')).not.toBeNull(),
  },
  {
    name: 'H2',
    menu: /标题 2/,
    verify: (container) => expect(container.querySelector('h2')).not.toBeNull(),
  },
  {
    name: 'H3',
    menu: /标题 3/,
    verify: (container) => expect(container.querySelector('h3')).not.toBeNull(),
  },
  {
    name: 'H4',
    menu: /标题 4/,
    verify: (container) => expect(container.querySelector('h4')).not.toBeNull(),
  },
  {
    name: 'H5',
    menu: /标题 5/,
    verify: (container) => expect(container.querySelector('h5')).not.toBeNull(),
  },
  {
    name: '待办',
    menu: /待办事项/,
    verify: (container) =>
      expect(within(container).getByRole('checkbox')).toBeInTheDocument(),
  },
  {
    name: '无序列表',
    menu: /无序列表/,
    verify: (container) =>
      expect(
        within(container).getByRole('textbox', { name: '无序列表项' }),
      ).toBeInTheDocument(),
  },
  {
    name: '有序列表',
    menu: /有序列表/,
    verify: (container) =>
      expect(
        within(container).getByRole('textbox', { name: '有序列表项' }),
      ).toBeInTheDocument(),
  },
  {
    name: '引用',
    menu: /^引用$/,
    verify: (container) =>
      expect(
        within(container).getByRole('textbox', { name: '引用内容' }),
      ).toBeInTheDocument(),
  },
  {
    name: '代码块',
    menu: /代码块/,
    verify: (container) =>
      expect(
        within(container).getByLabelText('代码内容'),
      ).toBeInTheDocument(),
  },
  {
    name: '分割线',
    menu: /^分割线$/,
    verify: (container) => expect(container.querySelector('hr')).not.toBeNull(),
  },
  {
    name: '表格',
    menu: /^表格/,
    verify: (container) =>
      expect(
        within(container).getByRole('group', { name: '表格' }),
      ).toBeInTheDocument(),
  },
  {
    name: '画板',
    menu: /画板/,
    verify: (container) =>
      expect(
        within(container).getByRole('group', { name: '画板块' }),
      ).toBeInTheDocument(),
  },
  {
    name: '公式',
    menu: /公式/,
    verify: (container) =>
      expect(
        within(container).getByRole('group', { name: '公式块' }),
      ).toBeInTheDocument(),
  },
  {
    name: '链接',
    menu: /^链接/,
    verify: (container) =>
      expect(
        within(container).getByRole('group', { name: '链接块' }),
      ).toBeInTheDocument(),
  },
];

describe('块编辑器 · 全部声明块类型可插入', () => {
  it.each(BLOCK_CASES)('菜单插入 $name', async ({ menu, verify }) => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const user = userEvent.setup();
    const { container } = renderEditor(source);

    await user.click(
      await screen.findByRole('button', { name: '插入内容' }),
    );
    const blockMenu = await screen.findByRole('menu', { name: '插入块' });
    await user.click(
      within(blockMenu).getByRole('menuitem', { name: menu }),
    );
    await waitFor(() => verify(container));
  });

  it('文件 / 图片只生成文件卡，不渲染图片', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const user = userEvent.setup();
    const attachments = createEditorAttachmentHarness();
    const { container } = renderEditor(source, {
      attachmentManager: attachments.manager,
    });

    await user.click(
      await screen.findByRole('button', { name: '插入内容' }),
    );
    await user.click(
      within(await screen.findByRole('menu', { name: '插入块' })).getByRole(
        'menuitem',
        { name: /文件 \/ 图片/ },
      ),
    );
    fireEvent.change(screen.getByLabelText('选择文件'), {
      target: {
        files: [new File(['x'], '图片.png', { type: 'image/png' })],
      },
    });

    expect(
      await screen.findByRole('group', { name: '文件卡：图片.png' }),
    ).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    const fileBlock = source.snapshot().find((block) => block.type === 'file');
    expect(fileBlock?.payload.attachmentId).toMatch(/^att_/);
    expect(fileBlock?.payload.byteSize).toBe(1);
  });

  it('链接块拒绝 javascript: 协议，安全地址可打开', async () => {
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
    const urlInput = within(dialog).getByLabelText('链接地址');
    fireEvent.change(urlInput, {
      target: { value: 'javascript:alert(1)' },
    });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(
      await within(dialog).findByRole('alert'),
    ).toHaveTextContent('仅支持 http / https / mailto 或站内笔记内链');
    expect(
      container.querySelector('a[href^="javascript"]'),
    ).toBeNull();

    fireEvent.change(urlInput, {
      target: { value: 'https://example.com/path' },
    });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '编辑链接' })).toBeNull();
      const open = within(container).getByRole('button', {
        name: /打开链接/,
      });
      expect(open).toHaveAttribute('title', '用系统浏览器打开');
      expect(open).not.toHaveAttribute('href');
      expect(
        container.querySelector('a[href^="https://example.com/path"]'),
      ).toBeNull();
    });
  });
});

describe('块编辑器 · 划词格式条', () => {
  it('Ctrl/⌘+B 走结构化 runs，不依赖浏览器 execCommand', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '快捷键' }] },
      }),
    ]);
    renderEditor(source);
    const textbox = await screen.findByRole('textbox', { name: '正文' });

    selectRange(textbox, 0, 3);
    fireEvent.keyDown(textbox, { key: 'b', ctrlKey: true });

    await waitFor(() => {
      expect(textbox.innerHTML).toContain('<strong>快捷键</strong>');
    });
    await waitFor(() => {
      const saved = source.snapshot().find((block) => block.id === 'b1');
      expect(saved?.payload.runs).toEqual([
        { text: '快捷键', marks: { bold: true } },
      ]);
    });
  });

  it('选中文字后 B/文字色/清除生效，并写入结构化 runs', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '知行编辑器' }] },
      }),
    ]);
    const user = userEvent.setup();
    renderEditor(source);
    const textbox = await screen.findByRole('textbox', { name: '正文' });

    selectRange(textbox, 0, 2);
    const toolbar = await screen.findByRole('toolbar', { name: '文字格式' });
    await user.click(within(toolbar).getByRole('button', { name: '粗体' }));

    await waitFor(() => {
      expect(textbox.innerHTML).toContain('<strong>知行</strong>');
    });
    await waitFor(() => {
      const saved = source.snapshot().find((block) => block.id === 'b1');
      expect(saved?.payload.runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: '知行',
            marks: expect.objectContaining({ bold: true }),
          }),
        ]),
      );
    });

    selectRange(textbox, 0, 2);
    await user.click(
      within(
        await screen.findByRole('toolbar', { name: '文字格式' }),
      ).getByRole('button', { name: '文字颜色 #c0392b' }),
    );
    await waitFor(() => {
      expect(textbox.innerHTML).toContain('color:#c0392b');
    });
    await waitFor(() => {
      const saved = source.snapshot().find((block) => block.id === 'b1');
      expect(saved?.payload.runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            text: '知行',
            marks: expect.objectContaining({
              bold: true,
              color: '#c0392b',
            }),
          }),
        ]),
      );
    });

    selectRange(textbox, 0, 2);
    await user.click(
      within(
        await screen.findByRole('toolbar', { name: '文字格式' }),
      ).getByRole('button', { name: '清除格式' }),
    );
    await waitFor(() => {
      const saved = source.snapshot().find((block) => block.id === 'b1');
      expect(saved?.payload.runs).toEqual([{ text: '知行编辑器' }]);
    });
    expect(textbox.innerHTML).not.toContain('<strong>');
  });
});

describe('块编辑器 · 表格/代码/文件卡持久化', () => {
  it('插入表格、代码、文件卡，卸载重挂后内容仍在', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const user = userEvent.setup();
    const attachments = createEditorAttachmentHarness();
    const view = renderEditor(source, {
      attachmentManager: attachments.manager,
    });

    const firstControl = await screen.findByRole('button', { name: '插入内容' });
    await user.click(firstControl);
    await user.click(
      within(await screen.findByRole('menu', { name: '插入块' })).getByRole(
        'menuitem',
        { name: /表格/ },
      ),
    );
    const cell = await screen.findByLabelText('第 1 行第 1 列');
    fireEvent.change(cell, { target: { value: '目标' } });

    await user.click(screen.getByRole('button', { name: '插入内容' }));
    await user.click(
      within(await screen.findByRole('menu', { name: '插入块' })).getByRole(
        'menuitem',
        { name: /代码块/ },
      ),
    );
    const code = await screen.findByLabelText('代码内容');
    fireEvent.change(code, {
      target: { value: 'const answer = 42;\nconsole.log(answer);' },
    });

    await user.click(screen.getByRole('button', { name: '插入内容' }));
    await user.click(
      within(await screen.findByRole('menu', { name: '插入块' })).getByRole(
        'menuitem',
        { name: /文件 \/ 图片/ },
      ),
    );
    const fileInput = screen.getByLabelText('选择文件');
    const file = new File(['hello'], '方案.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(
      await screen.findByRole('group', { name: '文件卡：方案.docx' }),
    ).toBeInTheDocument();

    await waitFor(() => {
      const types = source.snapshot().map((block) => block.type);
      expect(types).toContain('table');
      expect(types).toContain('code');
      expect(types).toContain('file');
    });
    const tableBlock = source
      .snapshot()
      .find((block) => block.type === 'table');
    expect(tableBlock && blockTableRows(tableBlock)[0][0]).toBe('目标');
    const codeBlock = source.snapshot().find((block) => block.type === 'code');
    expect(codeBlock?.payload.code).toContain('console.log(answer);');
    const fileBlock = source.snapshot().find((block) => block.type === 'file');
    expect(fileBlock?.payload.fileName).toBe('方案.docx');
    expect(fileBlock?.payload.byteSize).toBe(5);
    expect(fileBlock?.payload.attachmentId).toMatch(/^att_/);
    expect(fileBlock?.payload.status).toBe('local');

    view.unmount();
    renderEditor(source, { attachmentManager: attachments.manager });

    expect(
      await screen.findByLabelText('第 1 行第 1 列'),
    ).toHaveValue('目标');
    expect(await screen.findByLabelText('代码内容')).toHaveValue(
      'const answer = 42;\nconsole.log(answer);',
    );
    expect(
      await screen.findByRole('button', {
        name: '重命名文件 方案.docx：双击或按 F2',
      }),
    ).toHaveTextContent('方案.docx');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('代码块语言与换行/行号设置写入 payload，重挂后恢复', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const user = userEvent.setup();
    const view = renderEditor(source);

    await user.click(
      await screen.findByRole('button', { name: '插入内容' }),
    );
    await user.click(
      within(await screen.findByRole('menu', { name: '插入块' })).getByRole(
        'menuitem',
        { name: /代码块/ },
      ),
    );
    fireEvent.change(await screen.findByLabelText('代码内容'), {
      target: { value: 'const answer: number = 42;' },
    });
    // 代码属性头默认不渲染（ZX6-PROPS-02）；指针进入代码块后才出现。
    fireEvent.mouseEnter(screen.getByRole('group', { name: '代码块' }));

    const language = screen.getByRole('combobox', { name: '代码语言' });
    await user.click(language);
    await user.click(
      within(
        await screen.findByRole('listbox', { name: '常用代码语言' }),
      ).getByRole('option', { name: /TypeScript/ }),
    );
    await user.click(
      screen.getByRole('button', { name: '更多代码块选项' }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', { name: '更多代码块选项' }),
      ).getByRole('menuitem', { name: '自动换行' }),
    );
    await user.click(
      screen.getByRole('button', { name: '更多代码块选项' }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', { name: '更多代码块选项' }),
      ).getByRole('menuitem', { name: '显示行号' }),
    );

    await waitFor(() => {
      const codeBlock = source
        .snapshot()
        .find((block) => block.type === 'code');
      expect(codeBlock?.payload.language).toBe('typescript');
      expect(codeBlock?.payload.wrap).toBe(false);
      expect(codeBlock?.payload.lineNumbers).toBe(false);
    });

    view.unmount();
    renderEditor(source);
    // 重挂后属性头仍默认隐藏，悬停后才恢复语言与设置入口。
    fireEvent.mouseEnter(
      await screen.findByRole('group', { name: '代码块' }),
    );
    expect(
      await screen.findByRole('combobox', { name: '代码语言' }),
    ).toHaveValue('typescript');
    await user.click(
      screen.getByRole('button', { name: '更多代码块选项' }),
    );
    const options = await screen.findByRole('menu', {
      name: '更多代码块选项',
    });
    expect(
      within(options).getByRole('menuitem', { name: '自动换行' }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(
      within(options).getByRole('menuitem', { name: '显示行号' }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('.zxe-code-gutter')).toBeNull();
    expect(await screen.findByLabelText('代码内容')).toHaveValue(
      'const answer: number = 42;',
    );
  });
});

describe('块编辑器 · 站内内链（N-16）', () => {
  const noteOptions: LinkNoteOption[] = [
    { id: 'note-b', title: '目标笔记' },
    { id: 'note-c', title: '另一篇笔记' },
  ];

  it('划词后用「笔记内链」搜索选择，写入 zhixing://note/<id>', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '查看目标笔记' }] },
      }),
    ]);
    const user = userEvent.setup();
    renderEditor(source, { noteOptions });
    const textbox = await screen.findByRole('textbox', { name: '正文' });

    selectRange(textbox, 0, 4);
    const toolbar = await screen.findByRole('toolbar', { name: '文字格式' });
    await user.click(within(toolbar).getByRole('button', { name: '链接' }));

    const dialog = await screen.findByRole('dialog', { name: '插入链接' });
    await user.click(
      within(dialog).getByRole('button', { name: '笔记内链' }),
    );
    const search = within(dialog).getByLabelText('搜索笔记');
    await user.type(search, '目标');
    await user.click(
      await within(dialog).findByRole('option', { name: '目标笔记' }),
    );

    await waitFor(() => {
      const saved = source.snapshot().find((block) => block.id === 'b1');
      const runs = saved?.payload.runs as
        | Array<{ text: string; marks?: { link?: string } }>
        | undefined;
      expect(
        runs?.some((run) => run.marks?.link === 'zhixing://note/note-b'),
      ).toBe(true);
    });
    expect(textbox.innerHTML).toContain('href="zhixing://note/note-b"');
  });

  it('网页链接输入框直接粘贴内链也能识别，非法内链被拒绝', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '去目标' }] },
      }),
    ]);
    const user = userEvent.setup();
    renderEditor(source, { noteOptions });
    const textbox = await screen.findByRole('textbox', { name: '正文' });

    selectRange(textbox, 0, 3);
    await user.click(
      within(
        await screen.findByRole('toolbar', { name: '文字格式' }),
      ).getByRole('button', { name: '链接' }),
    );
    let dialog = await screen.findByRole('dialog', { name: '插入链接' });
    const input = within(dialog).getByLabelText('链接地址');
    await user.clear(input);
    await user.type(input, 'zhixing://note/note-zzz');
    await user.click(within(dialog).getByRole('button', { name: '应用' }));

    await waitFor(() => {
      const saved = source.snapshot().find((block) => block.id === 'b1');
      const runs = saved?.payload.runs as
        | Array<{ marks?: { link?: string } }>
        | undefined;
      expect(
        runs?.some((run) => run.marks?.link === 'zhixing://note/note-zzz'),
      ).toBe(true);
    });

    selectRange(textbox, 0, 3);
    await user.click(
      within(
        await screen.findByRole('toolbar', { name: '文字格式' }),
      ).getByRole('button', { name: '链接' }),
    );
    dialog = await screen.findByRole('dialog', { name: '插入链接' });
    const badInput = within(dialog).getByLabelText('链接地址');
    await user.clear(badInput);
    await user.type(badInput, 'zhixing://note/../secret');
    await user.click(within(dialog).getByRole('button', { name: '应用' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      '内链 id 不合法',
    );
  });

  it('编辑态普通点击不跳转，Ctrl/Cmd+点击打开；阅读态直接打开', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: {
          runs: [
            { text: '去目标', marks: { link: 'zhixing://note/note-b' } },
          ],
        },
      }),
    ]);
    const onOpenNote = vi.fn();
    const view = renderEditor(source, { onOpenNote });
    const link = await screen.findByRole('link', { name: '去目标' });

    fireEvent.click(link);
    expect(onOpenNote).not.toHaveBeenCalled();
    fireEvent.click(link, { metaKey: true });
    expect(onOpenNote).toHaveBeenCalledWith('note-b');

    view.unmount();
    const readOnlyView = renderEditor(source, {
      initialReadOnly: true,
      onOpenNote,
    });
    const readOnlyLink = await screen.findByRole('link', { name: '去目标' });
    fireEvent.click(readOnlyLink);
    expect(onOpenNote).toHaveBeenLastCalledWith('note-b');
    expect(
      readOnlyView.container.querySelector('[contenteditable="false"]'),
    ).not.toBeNull();
  });

  it('粘贴纯文本 zhixing://note/<id> 自动变成链接', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    renderEditor(source);
    const textbox = await screen.findByRole('textbox', { name: '正文' });

    fireEvent.paste(textbox, {
      clipboardData: {
        getData: (type: string) =>
          type === 'text/plain' ? '  zhixing://note/note-b  ' : '',
      },
    });

    await waitFor(() => {
      const saved = source.snapshot().find((block) => block.id === 'b1');
      expect(saved?.payload.runs).toEqual([
        { text: 'zhixing://note/note-b', marks: { link: 'zhixing://note/note-b' } },
      ]);
    });
    expect(textbox.innerHTML).toContain('href="zhixing://note/note-b"');
  });
});

describe('块编辑器 · 粘贴白名单', () => {
  it('带 script 的粘贴 HTML 被清洗，链接协议受控', async () => {
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const { container } = renderEditor(source);
    const textbox = await screen.findByRole('textbox', { name: '正文' });

    fireEvent.paste(textbox, {
      clipboardData: {
        getData: (type: string) =>
          type === 'text/html'
            ? '<p>安全<script>alert(1)</script><strong>加粗</strong><a href="javascript:alert(1)">坏链接</a><a href="https://example.com">好链接</a></p>'
            : '安全加粗坏链接好链接',
      },
    });

    await waitFor(() => {
      expect(textbox.textContent).toContain('安全');
      expect(textbox.textContent).toContain('加粗');
    });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull();

    await waitFor(() => {
      const saved = source.snapshot().find((block) => block.id === 'b1');
      const runs = saved?.payload.runs as
        | Array<{ text: string; marks?: { bold?: boolean; link?: string } }>
        | undefined;
      expect(runs?.some((run) => run.marks?.bold)).toBe(true);
      expect(runs?.some((run) => run.marks?.link === 'https://example.com')).toBe(
        true,
      );
      expect(
        runs?.some((run) => run.marks?.link?.startsWith('javascript:')),
      ).toBe(false);
    });
  });
});

describe('块编辑器 · 阅读/专注（写作跟随）', () => {
  it('阅读模式隐藏块控制与浮条并禁止编辑，返回编辑恢复', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '只读检查' }] },
      }),
    ]);
    const user = userEvent.setup();
    const { container } = renderEditor(source);
    const textbox = await screen.findByRole('textbox', { name: '正文' });

    await user.click(textbox);
    fireEvent.keyDown(document, {
      key: 'R',
      shiftKey: true,
      metaKey: true,
    });
    expect(screen.queryByRole('button', { name: '插入内容' })).toBeNull();
    expect(screen.queryByRole('button', { name: '块操作' })).toBeNull();
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(textbox).toHaveAttribute('contenteditable', 'false');
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-read-only',
      'true',
    );

    fireEvent.keyDown(document, {
      key: 'R',
      shiftKey: true,
      metaKey: true,
    });
    expect(
      await screen.findByRole('button', { name: '块操作' }),
    ).toBeInTheDocument();
    expect(textbox).toHaveAttribute('contenteditable', 'true');
  });

  it('专注模式提供状态条与写作跟随；不再有独立打字机按钮', async () => {
    window.localStorage.removeItem('editor.focus.follow');
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '第一段' }] },
      }),
      makeBlock({
        id: 'b2',
        type: 'paragraph',
        orderKey: 2048,
        payload: { runs: [{ text: '第二段' }] },
      }),
    ]);
    const user = userEvent.setup();
    const { container } = renderEditor(source);
    expect(
      (await screen.findAllByRole('textbox', { name: '正文' })).length,
    ).toBeGreaterThan(0);

    // ZX-NOTE-02：独立开关已删除，按钮文案也不再出现「打字机」。
    expect(screen.queryByRole('button', { name: '打字机' })).toBeNull();
    expect(screen.queryByRole('button', { name: '打字机模式' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/打字机/);

    fireEvent.keyDown(document, {
      key: 'F',
      shiftKey: true,
      metaKey: true,
    });
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-focus',
      'true',
    );

    // 状态条是可见反馈：标题 + 写作跟随 + 居中说明 + 退出。
    const bar = screen.getByRole('region', { name: '专注模式状态' });
    expect(bar).toHaveTextContent('专注模式');
    expect(bar).toHaveTextContent('写作跟随');
    expect(bar).toHaveTextContent('当前段落居中 · Esc 退出');
    const follow = within(bar).getByRole('checkbox', {
      name: '写作跟随',
    });
    expect(follow).toBeChecked();

    // 关闭写作跟随：仍保留当前块高亮，状态说明随之变化。
    await user.click(follow);
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-writing-follow',
      'false',
    );
    expect(bar).toHaveTextContent('只保留当前块高亮 · Esc 退出');
    expect(
      window.localStorage.getItem('editor.focus.follow'),
    ).toBe('false');

    await user.click(within(bar).getByRole('button', { name: '退出' }));
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-focus',
      'false',
    );
  });

  it('⌘⇧F 切换专注；Esc 优先关弹层，再退出专注', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '快捷键' }] },
      }),
    ]);
    const user = userEvent.setup();
    const { container } = render(<EditorStyleHarness source={source} />);
    await screen.findByRole('textbox', { name: '正文' });

    fireEvent.keyDown(document, {
      key: 'F',
      code: 'KeyF',
      shiftKey: true,
      metaKey: true,
    });
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-focus',
      'true',
    );

    // 有弹层时 Esc 先关弹层，不退出专注。
    await user.click(screen.getByRole('button', { name: '打开样式' }));
    expect(screen.getByRole('complementary', { name: '样式面板' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('complementary', { name: '样式面板' })).toBeNull();
    });
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-focus',
      'true',
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('.zxe')).toHaveAttribute(
      'data-focus',
      'false',
    );
  });

  it('写作跟随把当前块滚到视口约 36% 处；输入与撤销不受影响', async () => {
    window.localStorage.removeItem('editor.focus.follow');
    const blocks = Array.from({ length: 12 }, (_, index) =>
      makeBlock({
        id: `p${index + 1}`,
        type: 'paragraph',
        orderKey: (index + 1) * 1024,
        payload: { runs: [{ text: `第 ${index + 1} 段` }] },
      }),
    );
    const source = createFakeBlockSource(blocks);
    const user = userEvent.setup();
    const { container } = renderEditor(source);
    await screen.findAllByRole('textbox', { name: '正文' });

    // jsdom 无布局；注入可观测的滚动几何，验证 36% 目标而非假样式。
    const body = container.querySelector('.zxe-body') as HTMLElement;
    const scrollTo = vi.fn();
    Object.defineProperty(body, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });
    Object.defineProperty(body, 'clientHeight', {
      configurable: true,
      value: 500,
    });
    body.getBoundingClientRect = () =>
      ({
        top: 0,
        left: 0,
        right: 800,
        bottom: 500,
        width: 800,
        height: 500,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    fireEvent.keyDown(document, {
      key: 'F',
      shiftKey: true,
      metaKey: true,
    });
    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('[data-block-id]'),
    );
    for (const row of rows) {
      row.getBoundingClientRect = () =>
        ({
          top: rows.indexOf(row) * 120,
          left: 0,
          right: 800,
          bottom: rows.indexOf(row) * 120 + 60,
          width: 800,
          height: 60,
          x: 0,
          y: rows.indexOf(row) * 120,
          toJSON: () => ({}),
        }) as DOMRect;
    }

    // 进入专注后归位第一个块：top = 0 - 500 * 0.36 → 被 clamp 到 0。
    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalled();
    });
    expect(scrollTo.mock.calls.at(-1)?.[0]).toMatchObject({ top: 0 });

    // 点击更下面的块：top = blockTop - clientHeight * 0.36。
    const lateRow = rows.find((row) => row.dataset.blockId === 'p9');
    await user.click(
      within(lateRow as HTMLElement).getByRole('textbox', { name: '正文' }),
    );
    await waitFor(() => {
      expect(scrollTo.mock.calls.at(-1)?.[0]).toMatchObject({
        top: 8 * 120 - 500 * 0.36,
      });
    });

    // 输入不打断：撤销/重做照常，保存状态照常。
    const textbox = screen.getAllByRole('textbox', { name: '正文' })[0];
    await user.click(textbox);
    await user.keyboard('改');
    expect(
      await screen.findByRole('button', { name: '撤销编辑' }),
    ).toBeEnabled();
  });
});

describe('块编辑器 · 滚动位置（ZX10-EDITOR-01）', () => {
  function paragraphBlocks(count: number) {
    return Array.from({ length: count }, (_, index) =>
      makeBlock({
        id: `p${index + 1}`,
        type: 'paragraph',
        orderKey: (index + 1) * 1024,
        payload: { runs: [{ text: `第 ${index + 1} 段` }] },
      }),
    );
  }

  it('点击正文空白/最后一行下方空白不改变活动块、不抢焦点、不滚动', async () => {
    const source = createFakeBlockSource(paragraphBlocks(8));
    const user = userEvent.setup();
    const { container } = renderEditor(source);
    const textboxes = await screen.findAllByRole('textbox', { name: '正文' });
    const body = container.querySelector('.zxe-body') as HTMLElement;
    const scrollTo = vi.fn();
    Object.defineProperty(body, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });

    await user.click(textboxes[0]);
    const firstRow = textboxes[0].closest<HTMLElement>('[data-block-id]');
    const lastRow = textboxes[textboxes.length - 1].closest<HTMLElement>(
      '[data-block-id]',
    );
    await waitFor(() => expect(firstRow).toHaveClass('is-active'));
    expect(lastRow).not.toHaveClass('is-active');

    // 正文空白（含最后一行下方）不是块：点击不应把光标丢到最后一个块。
    fireEvent.mouseDown(body);
    fireEvent.click(body);

    expect(document.activeElement).toBe(textboxes[0]);
    expect(firstRow).toHaveClass('is-active');
    expect(lastRow).not.toHaveClass('is-active');
    expect(scrollTo).not.toHaveBeenCalled();
    expect(body.scrollTop).toBe(0);
  });

  it('取消全选回到最后一个块时使用 preventScroll，不把正文带到最底部', async () => {
    const source = createFakeBlockSource(paragraphBlocks(8));
    const user = userEvent.setup();
    const { container } = renderEditor(source);
    const textboxes = await screen.findAllByRole('textbox', { name: '正文' });
    const lastTextbox = textboxes[textboxes.length - 1];
    await user.click(textboxes[0]);

    // 程序化聚焦时记录 focus 选项；真实浏览器里没有 preventScroll 会把
    // 滚动容器带到最后一个块（jsdom 不做布局，因此直接断言调用参数）。
    const focusSpy = vi.spyOn(lastTextbox, 'focus');

    fireEvent.keyDown(document, { key: 'a', metaKey: true });
    await waitFor(() => {
      expect(container.querySelector('.zxe')?.getAttribute(
        'data-block-selection',
      )).toBe('true');
    });
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    });
  });

  it('普通模式切换活动块不触发写作跟随滚动', async () => {
    const source = createFakeBlockSource(paragraphBlocks(8));
    const user = userEvent.setup();
    const { container } = renderEditor(source);
    const textboxes = await screen.findAllByRole('textbox', { name: '正文' });
    const body = container.querySelector('.zxe-body') as HTMLElement;
    const scrollTo = vi.fn();
    Object.defineProperty(body, 'scrollTo', {
      configurable: true,
      value: scrollTo,
    });

    await user.click(textboxes[5]);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('保存、撤销、重做和块更新不重置正文滚动位置', async () => {
    const source = createFakeBlockSource(paragraphBlocks(8));
    const user = userEvent.setup();
    const { container } = renderEditor(source);
    const textboxes = await screen.findAllByRole('textbox', { name: '正文' });
    const body = container.querySelector('.zxe-body') as HTMLElement;
    body.scrollTop = 320;

    await user.click(textboxes[0]);
    await user.keyboard('改');
    await waitFor(() => {
      expect(JSON.stringify(source.snapshot()[0]?.payload)).toContain('改');
    });
    expect(body.scrollTop).toBe(320);

    await user.click(
      await screen.findByRole('button', { name: '撤销编辑' }),
    );
    await waitFor(() => expect(body.scrollTop).toBe(320));
    await user.click(
      await screen.findByRole('button', { name: '重做编辑' }),
    );
    await waitFor(() => expect(body.scrollTop).toBe(320));
  });

  it('initialScrollTop 只在就绪后恢复一次，滚动回传当前笔记', async () => {
    const source = createFakeBlockSource(paragraphBlocks(8));
    const onScrollPositionChange = vi.fn();
    const { container } = render(
      <NoteBlockEditor
        noteId={FAKE_NOTE_ID}
        source={source}
        saveDelayMs={0}
        initialScrollTop={280}
        onScrollPositionChange={onScrollPositionChange}
      />,
    );
    await screen.findAllByRole('textbox', { name: '正文' });
    const body = container.querySelector('.zxe-body') as HTMLElement;

    await waitFor(() => expect(body.scrollTop).toBe(280));

    body.scrollTop = 140;
    fireEvent.scroll(body);
    expect(onScrollPositionChange).toHaveBeenCalledWith(FAKE_NOTE_ID, 140);
  });

  it('大纲/搜索的 scrollToBlock 仍能滚到目标块', async () => {
    const source = createFakeBlockSource(paragraphBlocks(6));
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      const view = render(
        <NoteBlockEditor
          noteId={FAKE_NOTE_ID}
          source={source}
          saveDelayMs={0}
          scrollToBlock={null}
        />,
      );
      await screen.findAllByRole('textbox', { name: '正文' });
      view.rerender(
        <NoteBlockEditor
          noteId={FAKE_NOTE_ID}
          source={source}
          saveDelayMs={0}
          scrollToBlock={{ blockId: 'p5', token: 1 }}
        />,
      );
      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledWith(
          expect.objectContaining({ block: 'center' }),
        );
      });
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe('块编辑器 · 样式面板', () => {
  it('H1、居中、颜色、清除与插入入口可用', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        payload: { runs: [{ text: '样式面板' }] },
      }),
    ]);
    const user = userEvent.setup();
    const { container } = render(<EditorStyleHarness source={source} />);

    await screen.findByRole('textbox', { name: '正文' });
    await user.click(screen.getByRole('button', { name: '打开样式' }));
    const panel = screen.getByRole('complementary', { name: '样式面板' });
    await user.click(within(panel).getByRole('button', { name: 'H1' }));
    await waitFor(() => {
      expect(container.querySelector('h1')).not.toBeNull();
    });

    await user.click(within(panel).getByRole('button', { name: '居中' }));
    await waitFor(() => {
      const row = container.querySelector<HTMLElement>(
        '[data-block-type="heading1"]',
      );
      expect(row?.style.textAlign).toBe('center');
    });

    await user.click(
      within(panel).getByRole('button', { name: '文字颜色 #FF403C' }),
    );
    await waitFor(() => {
      const saved = source.snapshot().find((block) => block.id === 'b1');
      expect(saved?.payload.runs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            marks: expect.objectContaining({ color: '#ff403c' }),
          }),
        ]),
      );
    });

    await user.click(
      within(panel).getByRole('button', { name: '清除全部格式' }),
    );
    await waitFor(() => {
      const saved = source.snapshot().find((block) => block.id === 'b1');
      expect(saved?.payload.runs).toEqual([{ text: '样式面板' }]);
    });
  });
});

describe('块编辑器 · 公式/画板/未知块诚实呈现', () => {
  it('公式用 KaTeX 真实渲染且不再出现“未渲染”；画板不画伪预览', async () => {
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
        { name: /公式/ },
      ),
    );
    const formula = await screen.findByRole('group', { name: '公式块' });
    expect(formula.getAttribute('data-state')).toBe('view');
    expect(formula.textContent).not.toContain('未渲染');
    expect(formula.textContent).not.toContain('不显示伪公式');
    expect(formula.getAttribute('data-render-error')).toBe('false');
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('math')).not.toBeNull();
    expect(within(formula).queryByLabelText('LaTeX 源')).toBeNull();

    // 属性条默认隐藏；hover 公式块后显式编辑入口才出现（ZX6-PROPS-01）。
    // 属性条/编辑工具条 portal 到 body（ZX7-TOOLBAR-01），按角色从文档查询。
    fireEvent.mouseEnter(formula);
    const formulaToolbar = await screen.findByRole('toolbar', {
      name: '公式属性',
    });
    await user.click(
      within(formulaToolbar).getByRole('button', { name: '编辑公式' }),
    );
    expect(within(formula).getByLabelText('LaTeX 源')).toHaveValue(
      '\\frac{a}{b}',
    );
    expect(
      within(formula).getByText('渲染成功 · 预览与导出一致'),
    ).toBeInTheDocument();
    await user.click(
      within(
        screen.getByRole('toolbar', { name: '公式工具栏' }),
      ).getByRole('button', { name: '完成' }),
    );
    expect(within(formula).queryByLabelText('LaTeX 源')).toBeNull();

    await user.click(screen.getByRole('button', { name: '插入内容' }));
    await user.click(
      within(await screen.findByRole('menu', { name: '插入块' })).getByRole(
        'menuitem',
        { name: /画板/ },
      ),
    );
    const board = await screen.findByRole('group', { name: '画板块' });
    expect(board.textContent).toContain('不显示伪预览');
    expect(container.querySelector('svg')).toBeNull();
  });

  it('未知块原样保留 payload，不崩溃也不丢数据', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'unknown',
        type: 'mindmap_future',
        payload: { root: '中心主题', nodes: [{ id: 'n1' }] },
      }),
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        orderKey: 2048,
        payload: { runs: [{ text: '正文' }] },
      }),
    ]);
    renderEditor(source);

    expect(
      await screen.findByText('未知块（mindmap_future）'),
    ).toBeInTheDocument();
    expect(screen.getByText(/中心主题/)).toBeInTheDocument();
    expect(
      source.snapshot().find((block) => block.id === 'unknown')?.payload,
    ).toEqual({ root: '中心主题', nodes: [{ id: 'n1' }] });
  });
});

describe('块编辑器 · 顺序与 JSON 回放', () => {
  it('按 orderKey 排序，菜单下移后保存顺序，导出 JSON 可回放', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'b1',
        type: 'paragraph',
        orderKey: 3072,
        payload: { runs: [{ text: '第三' }] },
      }),
      makeBlock({
        id: 'b2',
        type: 'paragraph',
        orderKey: 2048,
        payload: { runs: [{ text: '第二' }] },
      }),
      makeBlock({
        id: 'b3',
        type: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: '第一' }] },
      }),
    ]);
    const user = userEvent.setup();
    const view = renderEditor(source);
    const { container } = view;

    await screen.findAllByRole('textbox', { name: '正文' });
    expect(blockIds(container)).toEqual(['b3', 'b2', 'b1']);

    const controls = screen.getAllByRole('button', { name: '块操作' });
    await user.click(controls[0]);
    const menu = await screen.findByRole('menu', { name: '插入块' });
    await user.click(within(menu).getByRole('menuitem', { name: '↓ 下移' }));

    await waitFor(() => {
      expect(source.snapshot().map((block) => block.id)).toEqual([
        'b2',
        'b3',
        'b1',
      ]);
    });

    const json = await source.exportDocument(FAKE_NOTE_ID);
    const parsed = parseBlockDocument(json);
    expect(parsed.map((block) => block.id)).toEqual(['b2', 'b3', 'b1']);
    expect(parsed.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
    ]);

    view.unmount();
    const replay = createFakeBlockSource();
    await replay.importDocument(FAKE_NOTE_ID, json);
    const replayView = renderEditor(replay);
    await screen.findAllByRole('textbox', { name: '正文' });
    expect(blockIds(replayView.container)).toEqual(['b2', 'b3', 'b1']);
  });
});

describe('块编辑器 · 旧数据兼容', () => {
  it('空块仓储时把旧 HTML 正文投影为块，首次编辑后落库', async () => {
    const source = createFakeBlockSource();
    const user = userEvent.setup();
    renderEditor(source, {
      initialHtml:
        '<h2>背景</h2><p>旧正文里的执行说明。</p><ul><li>访谈</li></ul>',
    });

    const heading = await screen.findByRole('textbox', { name: '标题 2' });
    expect(heading).toHaveTextContent('背景');
    const paragraph = screen.getByRole('textbox', { name: '正文' });
    expect(paragraph).toHaveTextContent('旧正文里的执行说明。');
    expect(
      screen.getByRole('textbox', { name: '无序列表项' }),
    ).toHaveTextContent('访谈');
    // 只读投影不写库，避免打开旧笔记就产生副作用。
    expect(source.snapshot()).toHaveLength(0);

    await user.click(paragraph);
    await user.type(paragraph, '补充');

    await waitFor(() => {
      const types = source.snapshot().map((block) => block.type);
      expect(types).toContain('heading2');
      expect(types).toContain('paragraph');
      expect(types).toContain('bullet_list');
    });
  });

  it('旧版 heading/text payload 归一化后可见，不显示未知块', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'legacy-h',
        type: 'heading',
        orderKey: 1024,
        payload: { level: 2, text: '旧版标题' },
      }),
      makeBlock({
        id: 'legacy-p',
        type: 'paragraph',
        orderKey: 2048,
        payload: { text: '旧版正文' },
      }),
    ]);
    const { container } = renderEditor(source);

    expect(await screen.findByText('旧版标题')).toBeInTheDocument();
    expect(screen.getByText('旧版正文')).toBeInTheDocument();
    expect(container.querySelector('h2')).not.toBeNull();
    expect(screen.queryByRole('group', { name: '未知块' })).toBeNull();
  });

  it('表格数据异常与文件缺失显示可见失败态', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'bad-table',
        type: 'table',
        orderKey: 1024,
        payload: { rows: 'not-a-table' },
      }),
      makeBlock({
        id: 'missing-file',
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
    renderEditor(source);

    expect(await screen.findByText(/表格数据异常/)).toBeInTheDocument();
    expect(screen.getByText('文件缺失')).toBeInTheDocument();
    const alerts = screen.getAllByRole('alert').map((node) => node.textContent);
    expect(alerts.some((text) => text?.includes('表格数据异常'))).toBe(true);
    expect(alerts.some((text) => text?.includes('文件缺失'))).toBe(true);
  });
});

describe('块编辑器 · 正文文件真实附件（ZX-NOTE-01）', () => {
  async function insertFiles(
    user: ReturnType<typeof userEvent.setup>,
    files: File[],
  ) {
    await user.click(
      await screen.findByRole('button', { name: '插入内容' }),
    );
    await user.click(
      within(await screen.findByRole('menu', { name: '插入块' })).getByRole(
        'menuitem',
        { name: /文件 \/ 图片/ },
      ),
    );
    fireEvent.change(screen.getByLabelText('选择文件'), {
      target: { files },
    });
  }

  it('多文件写入同一附件库，重开笔记仍能打开 PDF 与预览图片', async () => {
    const attachments = createEditorAttachmentHarness();
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const user = userEvent.setup();
    const first = renderEditor(source, {
      attachmentManager: attachments.manager,
    });

    await insertFiles(user, [
      new File(['pdf'], '验收.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array([137, 80, 78, 71])], '截图.png', {
        type: 'image/png',
      }),
      new File(['hello'], '备注.txt', { type: 'text/plain' }),
    ]);

    expect(
      await screen.findByRole('group', { name: '文件卡：验收.pdf' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: '文件卡：截图.png' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: '文件卡：备注.txt' }),
    ).toBeInTheDocument();

    const fileBlocks = source.snapshot().filter((block) => block.type === 'file');
    expect(fileBlocks).toHaveLength(3);
    fileBlocks.forEach((block) => {
      expect(block.payload.attachmentId).toMatch(/^att_/);
      expect(block.payload.status).toBe('local');
    });
    const stored = await attachments.manager.list(FAKE_NOTE_ID);
    expect(stored.map((item) => item.metadata.fileName).sort()).toEqual(
      ['备注.txt', '截图.png', '验收.pdf'].sort(),
    );

    first.unmount();

    const createObjectURL = vi.fn(() => 'blob:file-card');
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    // 浏览器预览：PDF 走新标签预览，不再用 <a download> 冒充“打开”。
    const openWindow = vi
      .spyOn(window, 'open')
      .mockImplementation(() => ({}) as Window);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURL,
    });

    try {
      renderEditor(source, { attachmentManager: attachments.manager });

      await user.click(
        await screen.findByRole('button', { name: '打开文件 验收.pdf' }),
      );
      await waitFor(() => {
        expect(createObjectURL).toHaveBeenCalled();
        expect(openWindow).toHaveBeenCalledWith('blob:file-card', '_blank');
      });
      expect(anchorClick).not.toHaveBeenCalled();

      await user.click(
        screen.getByRole('button', { name: '打开文件 截图.png' }),
      );
      expect(
        await screen.findByRole('dialog', { name: '图片预览：截图.png' }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '关闭图片预览' }));
      expect(
        screen.queryByRole('dialog', { name: '图片预览：截图.png' }),
      ).toBeNull();
    } finally {
      anchorClick.mockRestore();
      openWindow.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreate,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevoke,
      });
    }
  });

  it('从文件卡“另存为”走真实保存面板，写入的是本机 Blob 内容', async () => {
    const attachments = createEditorAttachmentHarness();
    const ingested = await attachments.manager.ingest(
      new File(['save-me'], '另存说明.txt', { type: 'text/plain' }),
      { noteId: FAKE_NOTE_ID },
    );
    const source = createFakeBlockSource([
      makeBlock({
        id: 'file-save',
        type: 'file',
        payload: {
          attachmentId: ingested.attachment.metadata.id,
          fileName: '另存说明.txt',
          byteSize: ingested.attachment.metadata.byteSize,
          mime: 'text/plain',
          status: 'local',
        },
      }),
    ]);
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const showSaveFilePicker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue({
        write,
        close,
        abort: vi.fn(),
      }),
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: showSaveFilePicker,
    });
    const user = userEvent.setup();

    try {
      renderEditor(source, { attachmentManager: attachments.manager });
      await user.click(
        await screen.findByRole('button', {
          name: '更多文件操作 另存说明.txt',
        }),
      );
      await user.click(
        within(
          await screen.findByRole('menu', {
            name: '更多文件操作 另存说明.txt',
          }),
        ).getByRole('menuitem', { name: '另存为…' }),
      );

      await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      expect(showSaveFilePicker).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedName: '另存说明.txt' }),
      );
      const blob = write.mock.calls[0]![0] as Blob;
      expect(await blob.text()).toBe('save-me');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as Window & { showSaveFilePicker?: unknown })
        .showSaveFilePicker;
    }
  });

  it('入库失败显示原因，不生成假文件卡', async () => {
    const attachments = createEditorAttachmentHarness();
    vi.spyOn(attachments.manager, 'ingest').mockRejectedValue(
      'SQLite 错误：本机磁盘空间不足',
    );
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
    ]);
    const user = userEvent.setup();
    renderEditor(source, { attachmentManager: attachments.manager });

    await insertFiles(user, [
      new File(['big'], '大文件.pdf', { type: 'application/pdf' }),
    ]);

    expect(
      await screen.findByRole('alert', {}, { timeout: 2000 }),
    ).toHaveTextContent('本机磁盘空间不足');
    expect(source.snapshot().some((block) => block.type === 'file')).toBe(false);
    expect(screen.queryByRole('group', { name: /文件卡/ })).toBeNull();
  });

  it('附件记录缺失时明确提示并支持重新选择原文件', async () => {
    const attachments = createEditorAttachmentHarness();
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
      makeBlock({
        id: 'lost-file',
        type: 'file',
        orderKey: 2048,
        payload: {
          attachmentId: 'att_missing',
          fileName: '丢失.pdf',
          byteSize: 1024,
          mime: 'application/pdf',
          status: 'local',
        },
      }),
    ]);
    renderEditor(source, { attachmentManager: attachments.manager });

    expect(await screen.findByText('文件缺失')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '打开文件 丢失.pdf' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', {
        name: '更多文件操作 丢失.pdf',
      }),
    );
    fireEvent.click(
      within(
        await screen.findByRole('menu', {
          name: '更多文件操作 丢失.pdf',
        }),
      ).getByRole('menuitem', { name: '重新选择文件…' }),
    );

    fireEvent.change(screen.getByLabelText('选择文件'), {
      target: {
        files: [
          new File(['restored'], '丢失.pdf', { type: 'application/pdf' }),
        ],
      },
    });

    await waitFor(() => {
      const block = source
        .snapshot()
        .find((item) => item.id === 'lost-file');
      expect(block?.payload.attachmentId).not.toBe('att_missing');
    });
    expect(
      await screen.findByRole('button', { name: '打开文件 丢失.pdf' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('文件缺失')).toBeNull();
  });

  it('文件行双击重命名同步块 payload 与附件元数据', async () => {
    const attachments = createEditorAttachmentHarness();
    const ingested = await attachments.manager.ingest(
      new File(['rename-me'], '旧名.txt', { type: 'text/plain' }),
      { noteId: FAKE_NOTE_ID, blockId: 'file-rename' },
    );
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
      makeBlock({
        id: 'file-rename',
        type: 'file',
        orderKey: 2048,
        payload: {
          attachmentId: ingested.attachment.metadata.id,
          fileName: '旧名.txt',
          byteSize: 9,
          mime: 'text/plain',
          status: 'pending',
        },
      }),
    ]);
    const user = userEvent.setup();
    renderEditor(source, { attachmentManager: attachments.manager });

    expect(
      await screen.findByRole('button', { name: '打开文件 旧名.txt' }),
    ).toBeInTheDocument();
    await user.dblClick(
      screen.getByRole('button', {
        name: '重命名文件 旧名.txt：双击或按 F2',
      }),
    );
    const input = screen.getByLabelText('文件名');
    await user.clear(input);
    await user.type(input, '新名.txt{Enter}');

    await waitFor(() => {
      expect(
        source.snapshot().find((block) => block.id === 'file-rename')
          ?.payload.fileName,
      ).toBe('新名.txt');
    });
    await waitFor(async () => {
      expect(
        (await attachments.manager.get(ingested.attachment.metadata.id))
          .metadata.fileName,
      ).toBe('新名.txt');
    });
    expect(
      screen.getByRole('button', {
        name: '重命名文件 新名.txt：双击或按 F2',
      }),
    ).toBeInTheDocument();
  });

  it('删除文件卡只移除正文引用，不删除仍可用的附件记录', async () => {
    const attachments = createEditorAttachmentHarness();
    const ingested = await attachments.manager.ingest(
      new File(['delete-me'], '待删.txt', { type: 'text/plain' }),
      { noteId: FAKE_NOTE_ID, blockId: 'file-1' },
    );
    const attachmentId = ingested.attachment.metadata.id;
    const source = createFakeBlockSource([
      makeBlock({ id: 'b1', type: 'paragraph', payload: { runs: [] } }),
      makeBlock({
        id: 'file-1',
        type: 'file',
        orderKey: 2048,
        payload: {
          attachmentId,
          fileName: '待删.txt',
          byteSize: 9,
          mime: 'text/plain',
          status: 'pending',
        },
      }),
    ]);
    const user = userEvent.setup();
    renderEditor(source, { attachmentManager: attachments.manager });

    await user.click(
      await screen.findByRole('button', {
        name: '更多文件操作 待删.txt',
      }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', { name: '更多文件操作 待删.txt' }),
      ).getByRole('menuitem', { name: '删除文件卡' }),
    );

    await waitFor(() => {
      expect(
        source.snapshot().some((block) => block.id === 'file-1'),
      ).toBe(false);
    });
    expect((await attachments.manager.get(attachmentId)).metadata.fileName).toBe(
      '待删.txt',
    );
    expect(await attachments.manager.hasLocalBlob(attachmentId)).toBe(true);
  });
});

describe('块编辑器 · 连续文档流（ZX-NOTE-08）', () => {
  it('文本块行容器透明、无 56px 内缩，gutter 是默认隐藏的覆盖层', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'h2',
        type: 'heading2',
        payload: { runs: [{ text: '连续排版' }] },
      }),
      makeBlock({
        id: 'p1',
        type: 'paragraph',
        orderKey: 2048,
        payload: { runs: [{ text: '段落正文' }] },
      }),
      makeBlock({
        id: 'ul',
        type: 'bullet_list',
        orderKey: 3072,
        payload: { runs: [{ text: '列表项' }] },
      }),
      makeBlock({
        id: 'todo1',
        type: 'todo',
        orderKey: 4096,
        payload: { runs: [{ text: '待办事项' }], checked: false },
      }),
    ]);
    const { container } = renderEditor(source);
    await screen.findByRole('textbox', { name: '标题 2' });

    const rows = Array.from(
      container.querySelectorAll<HTMLElement>('.zxe-row'),
    );
    expect(rows).toHaveLength(4);

    for (const row of rows) {
      const style = window.getComputedStyle(row);
      expect(style.borderTopWidth).toBe('0px');
      expect(style.borderRightWidth).toBe('0px');
      expect(style.borderBottomWidth).toBe('0px');
      expect(style.borderLeftWidth).toBe('0px');
      expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(style.borderRadius).toBe('0px');
      expect(style.paddingLeft).toBe('0px');
      expect(row.style.paddingLeft).toBe('');

      const content = row.querySelector<HTMLElement>('.zxe-row-content');
      expect(content).not.toBeNull();
      // 默认 indent=0；jsdom 不解析 var()/calc()，真实几何由浏览器验收覆盖。
      expect(content?.getAttribute('style')).toBeNull();
      expect(
        window.getComputedStyle(content as HTMLElement).paddingLeft,
      ).toMatch(/^(0px|calc\(var\(--zxe-indent, 0\) \* 20px\))$/);

      const gutter = row.querySelector<HTMLElement>('.zxe-block-gutter');
      expect(gutter).not.toBeNull();
      const gutterStyle = window.getComputedStyle(gutter as HTMLElement);
      expect(gutterStyle.position).toBe('absolute');
      expect(gutterStyle.width).toBe('44px');
      expect(gutterStyle.opacity).toBe('0');
      // 行前选择入口常驻 DOM（ZX10-BLOCKSEL-01），每行只有一套控件：
      // 选择 + 拖拽/菜单，不重复渲染，也不占正文宽度。
      expect(
        gutter?.querySelectorAll('.zxe-block-select'),
      ).toHaveLength(1);
      expect(
        gutter?.querySelectorAll('.zxe-block-control'),
      ).toHaveLength(1);
      // 默认 pointer-events:none 在 @media (hover:hover) 内；jsdom 不实现
      // hover 媒体查询，真实浏览器断言见 tests/e2e/zx-note-08-visual.mjs。
      // gutter 是 content 的兄弟覆盖层，不在内容列里占宽。
      expect(content?.parentElement).toBe(row);
      expect(gutter?.nextElementSibling).toBe(content);
    }

    // 低频入口只在 hover / focus-within / 已选中时随 gutter 浮出。
    expect(
      editorCssRuleMatching('.zxe-row:hover .zxe-block-gutter').style.opacity,
    ).toBe('1');
    expect(
      editorCssRuleMatching('.zxe-row:focus-within .zxe-block-gutter').style
        .opacity,
    ).toBe('1');
    expect(
      editorCssRuleMatching('.zxe-row.is-block-selected .zxe-block-gutter')
        .style.opacity,
    ).toBe('1');
  });
});

/**
 * ZX6-BLOCK-01：行容器与对象容器分开。
 *
 * 约束：
 * - 行容器（.zxe-row）与文本块永远不是卡片；
 * - 公式/代码/表格/画板/链接/文件的外壳默认 border:0、透明底、无阴影；
 * - 表格网格、代码内容面、引用左侧竖线这些语义边界必须保留；
 * - hover 只有左侧竖线，块选择才是唯一允许的整行淡色 + inset 描边。
 *
 * jsdom 不实现 :hover / var() 的最终计算值，所以状态类通过 CSSOM 断言；
 * 真实浏览器几何由 tests/e2e/zx-note-08-visual.mjs 复验。
 */
function editorCssRule(selector: string): CSSStyleRule {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText === selector) {
        return rule;
      }
    }
  }
  throw new Error(`没有找到编辑器 CSS 规则：${selector}`);
}

/** 组合选择器（`a, b`）用包含匹配，避免测试绑死逗号后的空格格式。 */
function editorCssRuleMatching(fragment: string): CSSStyleRule {
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText.includes(fragment)) {
        return rule;
      }
    }
  }
  throw new Error(`没有找到包含「${fragment}」的编辑器 CSS 规则`);
}

function computedBorderWidths(element: Element): string[] {
  const style = window.getComputedStyle(element);
  return [
    style.borderTopWidth,
    style.borderRightWidth,
    style.borderBottomWidth,
    style.borderLeftWidth,
  ];
}

describe('内容块去边框 · ZX6-BLOCK-01', () => {
  it('对象块外壳无边框、无阴影，语义边界保留', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'p1',
        type: 'paragraph',
        orderKey: 1024,
        payload: { runs: [{ text: '正文段落' }] },
      }),
      makeBlock({
        id: 'todo1',
        type: 'todo',
        orderKey: 2048,
        payload: { runs: [{ text: '待办' }], checked: false },
      }),
      makeBlock({
        id: 'quote1',
        type: 'quote',
        orderKey: 3072,
        payload: { runs: [{ text: '引用正文' }], source: '某本书' },
      }),
      makeBlock({
        id: 'code1',
        type: 'code',
        orderKey: 4096,
        payload: { code: 'const a = 1;', language: 'typescript' },
      }),
      makeBlock({
        id: 'table1',
        type: 'table',
        orderKey: 5120,
        payload: {
          rows: [
            ['表头 A', '表头 B'],
            ['单元格 A', '单元格 B'],
          ],
        },
      }),
      makeBlock({
        id: 'formula1',
        type: 'formula',
        orderKey: 6144,
        payload: {
          latex: 'a^2+b^2=c^2',
          display: 'block',
          renderer: 'katex',
        },
      }),
      makeBlock({
        id: 'file1',
        type: 'file',
        orderKey: 7168,
        payload: {
          attachmentId: null,
          fileName: '验收附件.txt',
          byteSize: 12,
          mime: 'text/plain',
          status: 'local',
        },
      }),
      // 图片块在 v1 复用文件行（mime=image/*）；外壳同样不能是卡片。
      makeBlock({
        id: 'image1',
        type: 'file',
        orderKey: 7680,
        payload: {
          attachmentId: null,
          fileName: '验收图片.png',
          byteSize: 24,
          mime: 'image/png',
          status: 'local',
        },
      }),
      makeBlock({
        id: 'link1',
        type: 'link',
        orderKey: 8192,
        payload: { url: 'https://example.com/', title: '示例链接' },
      }),
      makeBlock({
        id: 'board1',
        type: 'board',
        orderKey: 9216,
        payload: { boardId: null, title: '验收画板' },
      }),
      // 画板是原子块；编辑器会在文末补一个可继续输入的段落。
      makeBlock({
        id: 'p2',
        type: 'paragraph',
        orderKey: 10240,
        payload: { runs: [] },
      }),
    ]);

    const { container } = renderEditor(source);
    await waitFor(() => {
      expect(container.querySelectorAll('.zxe-row')).toHaveLength(11);
    });
    await screen.findByRole('group', { name: '公式块' });
    await screen.findByRole('group', { name: '画板块' });

    const shells: Array<{
      name: string;
      selector: string;
      radius: string[];
    }> = [
      { name: '公式', selector: '.zxe-formula', radius: ['0px'] },
      { name: '代码', selector: '.zxe-code', radius: ['0px'] },
      { name: '表格', selector: '.zxe-table-wrap', radius: ['0px'] },
      { name: '链接', selector: '.zxe-linkblock', radius: ['0px'] },
      { name: '画板', selector: '.zxe-board', radius: ['0px'] },
      {
        name: '画板嵌入',
        selector: '.zxe-board .bw-embed',
        radius: ['0px'],
      },
      {
        name: '文件',
        selector: '[data-block-id="file1"] .zxe-filecard',
        radius: ['6px', 'var(--radius-6)'],
      },
      {
        name: '图片',
        selector: '[data-block-id="image1"] .zxe-filecard',
        radius: ['6px', 'var(--radius-6)'],
      },
    ];

    for (const shell of shells) {
      const element = container.querySelector<HTMLElement>(shell.selector);
      expect(element, `${shell.name}外壳应渲染`).not.toBeNull();
      expect(computedBorderWidths(element as HTMLElement)).toEqual([
        '0px',
        '0px',
        '0px',
        '0px',
      ]);
      const style = window.getComputedStyle(element as HTMLElement);
      // jsdom 对未设置的 box-shadow 返回空串而不是 none。
      expect(['', 'none'], `${shell.name}不应有阴影`).toContain(
        style.boxShadow,
      );
      expect(shell.radius, `${shell.name}外壳圆角`).toContain(
        style.borderRadius,
      );
    }

    // 文本/待办行容器（不是对象外壳）同样不是卡片。
    for (const row of Array.from(
      container.querySelectorAll<HTMLElement>(
        '.zxe-row[data-block-type="paragraph"], .zxe-row[data-block-type="todo"]',
      ),
    )) {
      expect(computedBorderWidths(row)).toEqual([
        '0px',
        '0px',
        '0px',
        '0px',
      ]);
      expect(window.getComputedStyle(row).boxShadow).not.toContain('inset');
    }

    // 引用线是语义边界，保留；外层仍无边框/阴影。
    const quote = container.querySelector<HTMLElement>('.zxe-quote');
    expect(quote).not.toBeNull();
    expect(window.getComputedStyle(quote as HTMLElement).boxShadow).not.toContain(
      'inset',
    );
    const quoteRule = editorCssRule('.zxe-quote');
    expect(quoteRule.style.cssText).toContain(
      'border-left: 3px solid var(--blue)',
    );
    expect(quoteRule.style.cssText).not.toContain('border:');
    expect(quoteRule.style.cssText).not.toContain('box-shadow');

    // 表格单元格网格线必须保留（内容结构，不是卡片壳）。
    const gridRule = editorCssRuleMatching('.zxe-table th');
    expect(gridRule.style.borderRight).toContain('1px');
    expect(gridRule.style.borderBottom).toContain('1px');

    // 代码阅读面保留 --surface-2 底，但外壳已透明。
    expect(editorCssRule('.zxe-code-body').style.background).toBe(
      'var(--surface-2)',
    );
    expect(editorCssRule('.zxe-code').style.border).toBe('0px');
    expect(editorCssRule('.zxe-code').style.background).toBe('transparent');
  });

  it('hover 只出左侧竖线，块选择才铺淡底 + inset 描边', () => {
    const row = editorCssRule('.zxe-row');
    expect(row.style.border).toBe('0px');
    expect(row.style.background).toBe('transparent');

    const rowLine = editorCssRule('.zxe-row::before');
    expect(rowLine.style.cssText).toContain('width: 2px');
    expect(rowLine.style.cssText).toContain('background: var(--accent)');
    expect(rowLine.style.cssText).toContain('opacity: 0');

    const hoverLine = editorCssRule('.zxe-row:hover::before');
    expect(hoverLine.style.cssText).toContain('opacity: 0.35');

    const selected = editorCssRuleMatching('.zxe-row.is-block-selected');
    expect(selected.style.cssText).toContain('inset 0 0 0 1px');
    expect(selected.style.cssText).toContain('color-mix');
    expect(selected.style.cssText).toContain('9%');

    // 不允许再出现「深色主题 hover 铺整行背景」这类回到卡片的分支。
    const darkRowRules: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (
          rule instanceof CSSStyleRule &&
          rule.selectorText.includes('.zxe-row') &&
          rule.selectorText.includes('data-theme')
        ) {
          darkRowRules.push(rule.selectorText);
        }
      }
    }
    expect(darkRowRules).toEqual([]);
  });
});
