import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { htmlToMarkdown } from '../../../data/repositories/notes';
import { blocksToHtml } from '../blockHtml';
import { CodeBlock } from '../blocks/CodeBlock';
import {
  CODE_LANGUAGES,
  canonicalCodeLanguage,
  codeFenceLanguage,
  codeHighlightLanguage,
  codeLanguageLabel,
  codeIndentUnit,
  sanitizeCodeLanguage,
} from '../types';
import { makeBlock } from './fakeBlockSource';

type HarnessState = {
  code: string;
  language: string;
  wrap?: boolean;
  lineNumbers?: boolean;
};

function CodeHarness({
  initial,
  readOnly = false,
  onChangeOptions,
}: {
  initial: HarnessState;
  readOnly?: boolean;
  onChangeOptions?: (patch: Record<string, boolean>) => void;
}) {
  const [state, setState] = useState(initial);
  return (
    <CodeBlock
      block={makeBlock({
        id: 'code-1',
        type: 'code',
        payload: state,
      })}
      readOnly={readOnly}
      onChange={(code) => setState((current) => ({ ...current, code }))}
      onChangeLanguage={(language) =>
        setState((current) => ({ ...current, language }))
      }
      onChangeOptions={(patch) => {
        setState((current) => ({ ...current, ...patch }));
        onChangeOptions?.(patch);
      }}
    />
  );
}

/**
 * 属性头默认不渲染；指针进入代码块后才出现（ZX6-PROPS-02）。
 * 与公式/表格的 PROPS-01 测试保持同一套交互前提。
 */
function hoverCodeBlock() {
  fireEvent.mouseEnter(screen.getByRole('group', { name: '代码块' }));
}

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(writeText) },
  });
  return navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
}

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: undefined,
  });
  vi.restoreAllMocks();
});

describe('代码块 · 语言目录与归一化', () => {
  it('目录覆盖 13 种常用语言并含 25 项预设', () => {
    expect(CODE_LANGUAGES.length).toBe(25);
    const ids = CODE_LANGUAGES.map((option) => option.id);
    for (const id of [
      'javascript',
      'typescript',
      'json',
      'html',
      'css',
      'python',
      'bash',
      'sql',
      'go',
      'rust',
      'java',
      'markdown',
      'plaintext',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('别名归一化、清洗非法字符与超长语言，未知语言保留', () => {
    expect(canonicalCodeLanguage('ts')).toBe('typescript');
    expect(canonicalCodeLanguage('c++')).toBe('cpp');
    expect(canonicalCodeLanguage('C#')).toBe('csharp');
    expect(canonicalCodeLanguage('sh')).toBe('bash');
    expect(canonicalCodeLanguage('zx-dsl')).toBe('zx-dsl');
    expect(sanitizeCodeLanguage('  ZX DSL`\n ')).toBe('zxdsl');
    expect(sanitizeCodeLanguage('a'.repeat(40))).toHaveLength(24);
    expect(codeLanguageLabel('ts')).toBe('TypeScript');
    expect(codeLanguageLabel('zx-dsl')).toBe('zx-dsl');
    expect(codeHighlightLanguage('html')).toBe('xml');
    expect(codeHighlightLanguage('zxd')).toBeNull();
    expect(codeFenceLanguage('ts')).toBe('typescript');
    expect(codeFenceLanguage('plaintext')).toBe('');
    expect(codeFenceLanguage('zx-dsl')).toBe('zx-dsl');
    expect(codeIndentUnit('py')).toBe('    ');
    expect(codeIndentUnit('ts')).toBe('  ');
  });

  it('下拉列出 25 项，选择 TypeScript 后语言生效', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CodeHarness initial={{ code: 'const a = 1;', language: '' }} />,
    );
    hoverCodeBlock();

    const input = screen.getByRole('combobox', { name: '代码语言' });
    await user.click(input);
    const menu = screen.getByRole('listbox', { name: '常用代码语言' });
    expect(within(menu).getAllByRole('option')).toHaveLength(25);

    await user.click(within(menu).getByRole('option', { name: /TypeScript/ }));
    expect(input).toHaveValue('typescript');
    // 编辑态只保留语言选择器；重复的徽标已收掉，语言写在块容器上。
    expect(container.querySelector('.zxe-code')).toHaveAttribute(
      'data-language',
      'typescript',
    );
    expect(screen.queryByTitle('已识别：TypeScript')).toBeNull();
    expect(
      screen.queryByRole('listbox', { name: '常用代码语言' }),
    ).not.toBeInTheDocument();
  });

  it('手输未知语言不报错，代码仍保留且按纯文本呈现', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CodeHarness initial={{ code: 'const a = 1;', language: '' }} />,
    );
    hoverCodeBlock();

    const input = screen.getByRole('combobox', { name: '代码语言' });
    await user.click(input);
    await user.type(input, 'zx-dsl');

    expect(input).toHaveValue('zx-dsl');
    expect(container.querySelector('.zxe-code')).toHaveAttribute(
      'data-language',
      'zx-dsl',
    );
    expect(screen.getByLabelText('代码内容')).toHaveValue('const a = 1;');
  });

  it('手输别名失焦后归一化，纯文本清空语言', async () => {
    const user = userEvent.setup();
    render(<CodeHarness initial={{ code: '', language: '' }} />);
    hoverCodeBlock();

    const input = screen.getByRole('combobox', { name: '代码语言' });
    await user.type(input, 'ts');
    fireEvent.blur(input);
    await waitFor(() => expect(input).toHaveValue('typescript'));

    await user.click(input);
    await user.click(
      within(
        screen.getByRole('listbox', { name: '常用代码语言' }),
      ).getByRole('option', { name: /纯文本/ }),
    );
    expect(input).toHaveValue('');
  });
});

describe('代码块 · 高亮与只读', () => {
  it('只读态输出离线高亮 token，代码文本完整', () => {
    const code = `type Note = { id: string };\nconst title: string = "知行";\nconsole.log(title);`;
    const { container } = render(
      <CodeHarness
        initial={{ code, language: 'typescript' }}
        readOnly
      />,
    );

    const pre = container.querySelector('.zxe-code-pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toBe(code);
    expect(container.querySelector('textarea')).toBeNull();
    const tokens = container.querySelectorAll(
      '.hljs-keyword, .hljs-string, .hljs-title, .hljs-number, .hljs-built_in',
    );
    expect(tokens.length).toBeGreaterThanOrEqual(3);
  });

  it('未知语言只读时按纯文本显示，不产生 token、不抛错', () => {
    const code = 'plain text <tag> & value';
    const { container } = render(
      <CodeHarness initial={{ code, language: 'zx-dsl' }} readOnly />,
    );
    const pre = container.querySelector('.zxe-code-pre');
    expect(pre?.textContent).toBe(code);
    expect(container.querySelectorAll('.hljs-keyword').length).toBe(0);
    expect(pre?.querySelector('.hljs')).not.toBeNull();
  });

  it('只读态开启换行时仍按逻辑行显示行号', () => {
    const code = 'first\nsecond\nthird';
    const { container } = render(
      <CodeHarness
        initial={{
          code,
          language: 'typescript',
          wrap: true,
          lineNumbers: true,
        }}
        readOnly
      />,
    );
    expect(container.querySelector('textarea')).toBeNull();
    expect(
      Array.from(
        container.querySelectorAll('.zxe-code-gutter-inner span'),
        (span) => span.textContent,
      ),
    ).toEqual(['1', '2', '3']);
    expect(container.querySelector('.zxe-code-pre')?.textContent).toBe(code);
  });
});

describe('代码块 · 编辑输入与缩进', () => {
  it('Tab 按语言插入缩进，Shift+Tab 反缩进', async () => {
    render(
      <CodeHarness initial={{ code: 'const a = 1;', language: 'typescript' }} />,
    );
    const textarea = screen.getByLabelText(
      '代码内容',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(12, 12);
    fireEvent.keyDown(textarea, { key: 'Tab' });
    await waitFor(() => expect(textarea).toHaveValue('const a = 1;  '));
  });

  it('Shift+Tab 去掉行首一个缩进单位', async () => {
    render(
      <CodeHarness
        initial={{ code: '  const a = 1;', language: 'typescript' }}
      />,
    );
    const textarea = screen.getByLabelText(
      '代码内容',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(14, 14);
    fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(textarea).toHaveValue('const a = 1;'));
  });

  it('Python Tab 使用 4 空格', async () => {
    render(
      <CodeHarness
        initial={{ code: 'print(1)', language: 'python' }}
      />,
    );
    const textarea = screen.getByLabelText(
      '代码内容',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(8, 8);
    fireEvent.keyDown(textarea, { key: 'Tab' });
    await waitFor(() => expect(textarea).toHaveValue('print(1)    '));
  });

  it('Python 冒号换行自动缩进 4 空格', async () => {
    render(
      <CodeHarness
        initial={{ code: 'def main():', language: 'python' }}
      />,
    );
    const textarea = screen.getByLabelText(
      '代码内容',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(11, 11);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() =>
      expect(textarea).toHaveValue('def main():\n    '),
    );
  });

  it('括号后 Enter 自动缩进 2 空格；Shift+Enter 硬换行不缩进', async () => {
    render(
      <CodeHarness
        initial={{ code: 'if (ready) {', language: 'typescript' }}
      />,
    );
    const textarea = screen.getByLabelText(
      '代码内容',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(12, 12);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    await waitFor(() =>
      expect(textarea).toHaveValue('if (ready) {\n  '),
    );

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    await waitFor(() =>
      expect(textarea).toHaveValue('if (ready) {\n  \n'),
    );
  });

  it('块级更多菜单支持方向键、Esc 关闭并归还焦点', async () => {
    const user = userEvent.setup();
    render(
      <CodeHarness
        initial={{ code: 'one', language: 'plaintext', wrap: true }}
      />,
    );
    hoverCodeBlock();

    const trigger = screen.getByRole('button', {
      name: '更多代码块选项',
    });
    await user.click(trigger);
    const menu = await screen.findByRole('menu', {
      name: '更多代码块选项',
    });
    const items = within(menu).getAllByRole('menuitem');
    await waitFor(() => expect(items[0]).toHaveFocus());
    await user.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: '更多代码块选项' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('换行与行号完全解耦，并通过回调持久化', async () => {
    const user = userEvent.setup();
    const onChangeOptions = vi.fn();
    const { container } = render(
      <CodeHarness
        initial={{
          code: 'one\ntwo\nthree',
          language: 'plaintext',
          wrap: true,
          lineNumbers: true,
        }}
        onChangeOptions={onChangeOptions}
      />,
    );
    hoverCodeBlock();

    // 开启换行时行号仍在，且编号按逻辑行而不是视觉折行。
    expect(container.querySelector('.zxe-code-gutter')).not.toBeNull();
    expect(
      Array.from(
        container.querySelectorAll('.zxe-code-gutter-inner span'),
        (span) => span.textContent,
      ),
    ).toEqual(['1', '2', '3']);

    await user.click(
      screen.getByRole('button', { name: '更多代码块选项' }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', { name: '更多代码块选项' }),
      ).getByRole('menuitem', { name: '自动换行' }),
    );
    expect(onChangeOptions).toHaveBeenCalledWith({ wrap: false });
    // 关闭换行不改变行号设置。
    expect(container.querySelector('.zxe-code-gutter')).not.toBeNull();
    expect(
      container.querySelectorAll('.zxe-code-gutter-inner span'),
    ).toHaveLength(3);

    await user.click(
      screen.getByRole('button', { name: '更多代码块选项' }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', { name: '更多代码块选项' }),
      ).getByRole('menuitem', { name: '显示行号' }),
    );
    expect(onChangeOptions).toHaveBeenCalledWith({ lineNumbers: false });
    expect(container.querySelector('.zxe-code-gutter')).toBeNull();

    // 不换行时重新打开行号仍然生效（两个开关互不强制）。
    await user.click(
      screen.getByRole('button', { name: '更多代码块选项' }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', { name: '更多代码块选项' }),
      ).getByRole('menuitem', { name: '显示行号' }),
    );
    expect(onChangeOptions).toHaveBeenCalledWith({ lineNumbers: true });
    expect(container.querySelector('.zxe-code-gutter')).not.toBeNull();
  });

  it('行号默认开启；关闭后换行仍独立保持', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CodeHarness
        initial={{
          code: 'one\ntwo',
          language: 'plaintext',
          wrap: false,
        }}
      />,
    );
    hoverCodeBlock();

    // payload 没有 lineNumbers 时按默认值显示（兼容旧数据）。
    expect(
      container.querySelectorAll('.zxe-code-gutter-inner span'),
    ).toHaveLength(2);

    await user.click(
      screen.getByRole('button', { name: '更多代码块选项' }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', { name: '更多代码块选项' }),
      ).getByRole('menuitem', { name: '显示行号' }),
    );
    expect(container.querySelector('.zxe-code-gutter')).toBeNull();
    expect(
      container.querySelector('.zxe-code'),
    ).not.toHaveClass('is-wrap');
  });

  it('超长行、中文/emoji 与未知语言在换行+行号下不重复编号', () => {
    const longLine = '字'.repeat(120) + '😀'.repeat(20);
    const code = `中文😀\n${longLine}\n\tconst tabbed = true;`;
    const { container } = render(
      <CodeHarness
        initial={{
          code,
          language: 'zx-dsl',
          wrap: true,
          lineNumbers: true,
        }}
      />,
    );

    expect(screen.getByLabelText('代码内容')).toHaveValue(code);
    // 一条逻辑行只露一个编号，长行折出的视觉续行不重复编号。
    expect(
      Array.from(
        container.querySelectorAll('.zxe-code-gutter-inner span'),
        (span) => span.textContent,
      ),
    ).toEqual(['1', '2', '3']);
    expect(container.querySelectorAll('.hljs-keyword').length).toBe(0);
  });

  it('切换换行/行号不丢光标、选区与滚动位置', async () => {
    const user = userEvent.setup();
    render(
      <CodeHarness
        initial={{
          code: 'alpha\nbeta\ngamma',
          language: 'plaintext',
          wrap: true,
          lineNumbers: true,
        }}
      />,
    );
    hoverCodeBlock();
    const textarea = screen.getByLabelText(
      '代码内容',
    ) as HTMLTextAreaElement;
    textarea.focus();
    textarea.setSelectionRange(2, 9);
    textarea.scrollTop = 24;
    textarea.scrollLeft = 3;

    await user.click(
      screen.getByRole('button', { name: '更多代码块选项' }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', { name: '更多代码块选项' }),
      ).getByRole('menuitem', { name: '自动换行' }),
    );
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(9);
    expect(textarea.scrollTop).toBe(24);
    expect(textarea.scrollLeft).toBe(3);

    await user.click(
      screen.getByRole('button', { name: '更多代码块选项' }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', { name: '更多代码块选项' }),
      ).getByRole('menuitem', { name: '显示行号' }),
    );
    expect(textarea.selectionStart).toBe(2);
    expect(textarea.selectionEnd).toBe(9);
    expect(textarea.scrollTop).toBe(24);
  });

  it('滚动 textarea 时同步高亮层与 gutter 位移', () => {
    const { container } = render(
      <CodeHarness
        initial={{
          code: 'one\ntwo\nthree',
          language: 'plaintext',
          wrap: true,
          lineNumbers: true,
        }}
      />,
    );
    const textarea = screen.getByLabelText(
      '代码内容',
    ) as HTMLTextAreaElement;
    textarea.scrollTop = 60;
    textarea.scrollLeft = 4;
    fireEvent.scroll(textarea);

    const highlight = container.querySelector(
      '.zxe-code-highlight',
    ) as HTMLElement;
    expect(highlight.scrollTop).toBe(60);
    expect(highlight.scrollLeft).toBe(4);
    const gutterInner = container.querySelector(
      '.zxe-code-gutter-inner',
    ) as HTMLElement;
    expect(gutterInner.style.transform).toBe('translateY(-60px)');
  });

  it('IME 组合输入期间显示原文，结束后恢复高亮且不报错', async () => {
    const { container } = render(
      <CodeHarness
        initial={{
          code: '',
          language: 'plaintext',
          wrap: true,
          lineNumbers: true,
        }}
      />,
    );
    const textarea = screen.getByLabelText(
      '代码内容',
    ) as HTMLTextAreaElement;

    fireEvent.compositionStart(textarea);
    expect(container.querySelector('.zxe-code')).toHaveClass('is-composing');
    fireEvent.change(textarea, { target: { value: '知行' } });
    await waitFor(() => expect(textarea).toHaveValue('知行'));
    fireEvent.compositionEnd(textarea, { data: '知行' });

    await waitFor(() =>
      expect(container.querySelector('.zxe-code')).not.toHaveClass(
        'is-composing',
      ),
    );
    expect(textarea).toHaveValue('知行');
  });
});

describe('代码块 · gutter 镜像测量', () => {
  it('按逻辑行第一视觉行定位编号，折行续行不重复', async () => {
    const originalOffsetTop = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'offsetTop',
    );
    const originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientWidth',
    );
    // jsdom 不做排版，这里模拟：第 2 行折成两行，后续行整体下移。
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get() {
        if (this.classList?.contains('zxe-code-mirror-line')) {
          const index = Number(this.getAttribute('data-line')) - 1;
          return [0, 21.25, 63.75][index] ?? 0;
        }
        return originalOffsetTop?.get?.call(this) ?? 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        if (this.tagName === 'TEXTAREA') {
          return 400;
        }
        return originalClientWidth?.get?.call(this) ?? 0;
      },
    });

    try {
      const { container } = render(
        <CodeHarness
          initial={{
            code: 'one\nthis logical line wraps into two visual rows\nthree',
            language: 'plaintext',
            wrap: true,
            lineNumbers: true,
          }}
        />,
      );

      const spans = Array.from(
        container.querySelectorAll('.zxe-code-gutter-inner span'),
        (span) => span as HTMLElement,
      );
      await waitFor(() => {
        expect(spans.map((span) => span.style.top)).toEqual([
          '12px',
          '33.25px',
          '75.75px',
        ]);
      });
      expect(
        (container.querySelector('.zxe-code-mirror') as HTMLElement).style
          .width,
      ).toBe('372px');
      expect(spans.map((span) => span.textContent)).toEqual([
        '1',
        '2',
        '3',
      ]);
    } finally {
      if (originalOffsetTop) {
        Object.defineProperty(
          HTMLElement.prototype,
          'offsetTop',
          originalOffsetTop,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop');
      }
      if (originalClientWidth) {
        Object.defineProperty(
          HTMLElement.prototype,
          'clientWidth',
          originalClientWidth,
        );
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
      }
    }
  });
});

describe('代码块 · 复制、反馈与示例', () => {
  it('复制原始代码并显示已复制反馈', async () => {
    const user = userEvent.setup();
    const writeText = mockClipboard(async () => undefined);
    const code = 'const answer = 42;\nconsole.log(answer);';
    render(
      <CodeHarness initial={{ code, language: 'javascript' }} />,
    );
    hoverCodeBlock();

    await user.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith(code);
    expect(await screen.findByText('已复制代码')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '已复制' }),
    ).toBeInTheDocument();
  });

  it('Clipboard API 不可用时退回 execCommand 并给出反馈', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    render(
      <CodeHarness
        initial={{ code: 'echo 知行', language: 'bash' }}
      />,
    );
    hoverCodeBlock();

    await user.click(screen.getByRole('button', { name: '复制' }));
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(await screen.findByText('已复制代码')).toBeInTheDocument();
  });

  it('复制失败时给出可操作提示并选中代码', async () => {
    const user = userEvent.setup();
    mockClipboard(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    render(
      <CodeHarness initial={{ code: 'let x = 1;', language: 'javascript' }} />,
    );
    hoverCodeBlock();

    await user.click(screen.getByRole('button', { name: '复制' }));
    expect(
      await screen.findByText('复制失败，请手动选择代码'),
    ).toBeInTheDocument();
    const textarea = screen.getByLabelText(
      '代码内容',
    ) as HTMLTextAreaElement;
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe('let x = 1;'.length);
  });

  it('空代码块显示提示，插入示例按语言填充', async () => {
    const user = userEvent.setup();
    render(
      <CodeHarness initial={{ code: '', language: 'typescript' }} />,
    );
    hoverCodeBlock();

    expect(
      screen.getByText(
        '空代码块：输入即高亮；未识别语言按纯文本保存，不报错。',
      ),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: '更多代码块选项' }),
    );
    await user.click(
      within(
        await screen.findByRole('menu', { name: '更多代码块选项' }),
      ).getByRole('menuitem', { name: '插入示例' }),
    );
    expect(
      (screen.getByLabelText('代码内容') as HTMLTextAreaElement).value,
    ).toContain('type Note');
  });
});

describe('代码块 · 属性头默认隐藏（ZX6-PROPS-02）', () => {
  it('默认不渲染属性头；hover 出现语言/复制/更多，移开消失', () => {
    render(
      <CodeHarness initial={{ code: 'const a = 1;', language: 'ts' }} />,
    );
    const group = screen.getByRole('group', { name: '代码块' });

    expect(group).toHaveAttribute('data-head-visible', 'false');
    expect(document.querySelector('.zxe-code-head')).toBeNull();
    expect(screen.queryByRole('combobox', { name: '代码语言' })).toBeNull();
    expect(screen.queryByRole('button', { name: '复制' })).toBeNull();

    fireEvent.mouseEnter(group);
    expect(group).toHaveAttribute('data-head-visible', 'true');
    const head = document.querySelector('.zxe-code-head');
    expect(head).not.toBeNull();
    expect(head).toHaveClass('is-floating');
    expect(
      within(head as HTMLElement).getByRole('combobox', { name: '代码语言' }),
    ).toBeInTheDocument();
    expect(
      within(head as HTMLElement).getByRole('button', { name: '复制' }),
    ).toBeInTheDocument();
    expect(
      within(head as HTMLElement).getByRole('button', {
        name: '更多代码块选项',
      }),
    ).toBeInTheDocument();

    fireEvent.mouseLeave(group);
    expect(document.querySelector('.zxe-code-head')).toBeNull();
  });

  it('键盘 Tab 聚焦代码块后属性头出现，再 Tab 到达语言选择', async () => {
    const user = userEvent.setup();
    render(<CodeHarness initial={{ code: 'const a = 1;', language: 'ts' }} />);

    await user.tab();
    expect(screen.getByRole('group', { name: '代码块' })).toHaveFocus();
    expect(document.querySelector('.zxe-code-head')).not.toBeNull();

    await user.tab();
    expect(
      screen.getByRole('combobox', { name: '代码语言' }),
    ).toHaveFocus();
  });

  it('编辑输入时属性头浮出但不删除复制/换行/行号能力', async () => {
    const user = userEvent.setup();
    render(
      <CodeHarness initial={{ code: 'const a = 1;', language: 'ts' }} />,
    );
    const textarea = screen.getByLabelText(
      '代码内容',
    ) as HTMLTextAreaElement;
    await user.click(textarea);
    expect(textarea).toHaveFocus();

    const head = document.querySelector('.zxe-code-head') as HTMLElement;
    expect(head).not.toBeNull();
    expect(head).toHaveClass('is-floating');
    expect(
      within(head).getByRole('button', { name: '复制' }),
    ).toBeInTheDocument();
    expect(
      within(head).getByRole('button', { name: '更多代码块选项' }),
    ).toBeInTheDocument();
    // 属性头出现不改变代码编辑器的剩余能力。
    expect(screen.getByLabelText('代码内容')).toBe(textarea);
    expect(
      screen.getByText(/不换行|自动换行/),
    ).toBeInTheDocument();
  });

  it('只读态默认不渲染属性头；聚焦代码后可到达复制', async () => {
    const user = userEvent.setup();
    render(
      <CodeHarness
        initial={{ code: 'const a = 1;', language: 'ts' }}
        readOnly
      />,
    );
    expect(document.querySelector('.zxe-code-head')).toBeNull();

    await user.tab();
    expect(document.querySelector('.zxe-code-head')).not.toBeNull();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '复制' })).toHaveFocus();
  });
});

describe('代码块 · HTML 缓存与 Markdown 围栏', () => {
  it('已知语言写入 data-language / language-*，Markdown 围栏一致', () => {
    const html = blocksToHtml([
      {
        type: 'code',
        payload: { code: 'const answer = 42;', language: 'ts' },
      },
    ]);
    expect(html).toContain('class="zxe-code-fence"');
    expect(html).toContain('data-language="typescript"');
    expect(html).toContain('class="language-typescript"');
    expect(html).toContain('const answer = 42;');
    expect(htmlToMarkdown(html)).toBe(
      '```typescript\nconst answer = 42;\n```',
    );
  });

  it('未知语言保留清洗后的围栏，纯文本不写围栏语言', () => {
    const unknown = blocksToHtml([
      {
        type: 'code',
        payload: { code: 'a < b', language: 'ZX-DSL`\n' },
      },
    ]);
    expect(unknown).toContain('data-language="zx-dsl"');
    expect(htmlToMarkdown(unknown)).toBe('```zx-dsl\na < b\n```');

    const plain = blocksToHtml([
      { type: 'code', payload: { code: 'plain', language: 'plaintext' } },
    ]);
    expect(plain).toBe('<pre class="zxe-code-fence"><code>plain</code></pre>');
    expect(htmlToMarkdown(plain)).toBe('```\nplain\n```');
  });
});
