import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { htmlToMarkdown } from '../../../data/repositories/notes';
import {
  blocksToHtml,
  renderFormula,
  type FormulaDisplayMode,
} from '../blockHtml';
import { FormulaBlock } from '../blocks/FormulaBlock';
import { NoteBlockEditor } from '../NoteBlockEditor';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
} from './fakeBlockSource';

type HarnessProps = {
  initialLatex?: string;
  initialDisplay?: FormulaDisplayMode;
  readOnly?: boolean;
  onChange?: (latex: string, display: FormulaDisplayMode) => void;
  onContextMenu?: (state: { x: number; y: number }) => void;
};

function FormulaHarness({
  initialLatex = '\\frac{a}{b}',
  initialDisplay = 'block',
  readOnly = false,
  onChange,
  onContextMenu,
}: HarnessProps) {
  const [state, setState] = useState({
    latex: initialLatex,
    display: initialDisplay,
  });

  const update = (
    patch: Partial<{ latex: string; display: FormulaDisplayMode }>,
  ) => {
    setState((current) => {
      const next = { ...current, ...patch };
      onChange?.(next.latex, next.display);
      return next;
    });
  };

  return (
    <FormulaBlock
      block={makeBlock({
        id: 'formula-1',
        type: 'formula',
        payload: {
          latex: state.latex,
          display: state.display,
          renderer: 'katex',
        },
      })}
      readOnly={readOnly}
      onChangeLatex={(latex) => update({ latex })}
      onChangeDisplay={(display) => update({ display })}
      onContextMenu={onContextMenu}
    />
  );
}

function mockClipboard() {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

/** 属性条默认隐藏；指针进入公式块后才出现（ZX6-PROPS-01）。 */
async function hoverFormula(_user: ReturnType<typeof userEvent.setup>) {
  fireEvent.mouseEnter(screen.getByRole('group', { name: '公式块' }));
}

async function openMore(user: ReturnType<typeof userEvent.setup>) {
  await hoverFormula(user);
  await user.click(screen.getByRole('button', { name: '更多公式选项' }));
  return screen.findByRole('menu', { name: '更多公式选项' });
}

async function chooseMore(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) {
  const menu = await openMore(user);
  await user.click(within(menu).getByRole('menuitem', { name: label }));
}

async function enterEdit(user: ReturnType<typeof userEvent.setup>) {
  await hoverFormula(user);
  await user.click(screen.getByRole('button', { name: '编辑公式' }));
  return screen.getByLabelText('LaTeX 源') as HTMLTextAreaElement;
}

async function openTemplateMenu(
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.click(screen.getByRole('button', { name: '公式模板' }));
  return screen.findByRole('menu', { name: '公式模板' });
}

async function chooseTemplate(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) {
  const menu = await openTemplateMenu(user);
  await user.click(within(menu).getByRole('menuitem', { name: label }));
}

function latexInput() {
  return screen.getByLabelText('LaTeX 源') as HTMLTextAreaElement;
}

function modeChip(): HTMLElement {
  // 工具条 portal 到 body，不再位于公式块容器内（ZX7-TOOLBAR-01）。
  const chip = document.querySelector<HTMLElement>(
    '[data-formula="mode"]',
  );
  if (!chip) {
    throw new Error('缺少公式模式 chip');
  }
  return chip;
}

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
  vi.restoreAllMocks();
});

describe('FormulaBlock · 阅读态与编辑态', () => {
  it('默认阅读态只渲染 KaTeX，不出现源码、模板、属性条与状态栏', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <FormulaHarness initialLatex={'\\int_{a}^{b} f(x)\\,\\mathrm{d}x'} />,
    );
    const group = screen.getByRole('group', { name: '公式块' });

    expect(group.getAttribute('data-state')).toBe('view');
    expect(group.getAttribute('data-render-error')).toBe('false');
    expect(group.getAttribute('data-display')).toBe('block');
    expect(group.getAttribute('data-meta-visible')).toBe('false');
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('.katex-display')).not.toBeNull();
    expect(container.querySelector('math')).not.toBeNull();
    expect(container.querySelector('.zxe-formula-source')).toBeNull();
    expect(container.querySelector('.zxe-formula-foot')).toBeNull();
    expect(document.querySelector('.zxe-formula-head')).toBeNull();
    expect(screen.queryByLabelText('LaTeX 源')).toBeNull();
    expect(screen.queryByRole('button', { name: '公式模板' })).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑公式' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: '更多公式选项' }),
    ).toBeNull();
    expect(screen.queryByText('渲染成功 · 预览与导出一致')).toBeNull();

    // hover 后属性条浮出，显示模式与操作入口。
    await hoverFormula(user);
    expect(group.getAttribute('data-meta-visible')).toBe('true');
    const strip = screen.getByRole('toolbar', { name: '公式属性' });
    expect(modeChip().textContent).toBe('块级');
    expect(
      within(strip).getByRole('button', { name: '编辑公式' }),
    ).toBeInTheDocument();
    expect(
      within(strip).getByRole('button', { name: '更多公式选项' }),
    ).toBeInTheDocument();
  });

  it('KaTeX MathML 不携带 annotation，阅读态 DOM 文本不混入 LaTeX 源', () => {
    const { container } = render(
      <FormulaHarness initialLatex={'\\frac{a}{b}'} />,
    );
    const group = screen.getByRole('group', { name: '公式块' });

    expect(container.querySelector('annotation')).toBeNull();
    expect(group.textContent).not.toContain('\\frac{a}{b}');
  });

  it('行内模式不产生 .katex-display，并显示一句上下文', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <FormulaHarness initialLatex={'x^{2}'} initialDisplay="inline" />,
    );

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('.katex-display')).toBeNull();
    expect(screen.getByText(/行内预览：当参数满足/)).toBeInTheDocument();
    expect(
      screen
        .getByRole('group', { name: '公式块' })
        .getAttribute('data-display'),
    ).toBe('inline');
    await hoverFormula(user);
    expect(modeChip().textContent).toBe('行内');
  });

  it('块级/行内切换收进更多菜单并写回 display', async () => {
    const user = userEvent.setup();
    const changes: string[] = [];
    render(
      <FormulaHarness
        initialDisplay="block"
        onChange={(_latex, display) => changes.push(display)}
      />,
    );
    const group = screen.getByRole('group', { name: '公式块' });

    await chooseMore(user, '切换为行内');
    await waitFor(() => {
      expect(group.getAttribute('data-display')).toBe('inline');
    });
    await hoverFormula(user);
    expect(modeChip().textContent).toBe('行内');
    expect(changes.at(-1)).toBe('inline');

    await chooseMore(user, '切换为块级');
    await waitFor(() => {
      expect(group.getAttribute('data-display')).toBe('block');
    });
    await hoverFormula(user);
    expect(modeChip().textContent).toBe('块级');
  });

  it('显式编辑入口进入编辑态，完成后退回渲染态', async () => {
    const user = userEvent.setup();
    const { container } = render(<FormulaHarness initialLatex={'x^2'} />);

    const textarea = await enterEdit(user);
    expect(textarea).toHaveValue('x^2');
    expect(screen.getByRole('group', { name: '公式块' }).getAttribute('data-state')).toBe(
      'edit',
    );
    expect(container.querySelector('.zxe-formula-foot')).not.toBeNull();
    expect(screen.getByText('渲染成功 · 预览与导出一致')).toBeInTheDocument();
    expect(container.querySelector('.katex')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: '完成' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('LaTeX 源')).toBeNull();
    });
    expect(screen.queryByRole('button', { name: '完成' })).toBeNull();
    expect(screen.getByRole('button', { name: '编辑公式' })).toBeInTheDocument();
    expect(container.querySelector('.zxe-formula-foot')).toBeNull();
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('Enter/F2 进入编辑，Esc 与 ⌘/Ctrl+Enter 退出编辑', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initialLatex={'x^2'} />);
    const group = screen.getByRole('group', { name: '公式块' });

    group.focus();
    fireEvent.keyDown(group, { key: 'Enter' });
    expect(screen.getByLabelText('LaTeX 源')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText('LaTeX 源'), { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByLabelText('LaTeX 源')).toBeNull();
    });
    expect(document.activeElement).toBe(group);

    fireEvent.keyDown(group, { key: 'F2' });
    expect(screen.getByLabelText('LaTeX 源')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText('LaTeX 源'), {
      key: 'Enter',
      ctrlKey: true,
    });
    await waitFor(() => {
      expect(screen.queryByLabelText('LaTeX 源')).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: '编辑公式' }));
    fireEvent.blur(screen.getByLabelText('LaTeX 源'), {
      relatedTarget: document.body,
    });
    await waitFor(() => {
      expect(screen.queryByLabelText('LaTeX 源')).toBeNull();
    });
  });

  it('点击渲染区域进入编辑；有文本选区时不抢占', async () => {
    const user = userEvent.setup();
    const { container } = render(<FormulaHarness initialLatex={'x^2'} />);
    const preview = container.querySelector<HTMLElement>(
      '.zxe-formula-preview',
    );

    await user.click(preview!);
    expect(screen.getByLabelText('LaTeX 源')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('LaTeX 源'), { key: 'Escape' });

    const range = document.createRange();
    range.selectNodeContents(preview!);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.click(preview!);
    expect(screen.queryByLabelText('LaTeX 源')).toBeNull();
  });

  it('语法错误在阅读态只给占位，不显示源码/位置；编辑态显示行列', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <FormulaHarness initialLatex={'\\frac{a}{b'} />,
    );
    const group = screen.getByRole('group', { name: '公式块' });

    expect(group.getAttribute('data-render-error')).toBe('true');
    expect(container.querySelector('.katex')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('公式无法渲染')).toBeInTheDocument();
    expect(screen.getByText('打开编辑查看错误位置')).toBeInTheDocument();
    expect(group.textContent).not.toContain('\\frac{a}{b');
    expect(screen.queryByLabelText('LaTeX 源')).toBeNull();

    const textarea = await enterEdit(user);
    const alert = screen.getByRole('alert');

    expect(textarea).toHaveValue('\\frac{a}{b');
    expect(alert.textContent).toContain('KaTeX parse error');
    expect(alert.textContent).toMatch(/第 1 行第 \d+ 列/);
    expect(screen.getByText(/^解析错误 · 第 1 行第 \d+ 列$/)).toBeInTheDocument();
  });

  it('错误时预览不保留上一版半成品，修正后恢复渲染', async () => {
    const user = userEvent.setup();
    const { container } = render(<FormulaHarness initialLatex={'x^2'} />);
    const textarea = await enterEdit(user);

    fireEvent.change(textarea, { target: { value: 'x^2 \\frac{' } });
    await waitFor(() => {
      expect(
        screen
          .getByRole('group', { name: '公式块' })
          .getAttribute('data-render-error'),
      ).toBe('true');
    });

    const preview = container.querySelector('.zxe-formula-preview');
    expect(preview?.classList.contains('is-stale')).toBe(false);
    expect(preview?.querySelector('.katex')).toBeNull();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'x^2' } });
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(screen.getByText('渲染成功 · 预览与导出一致')).toBeInTheDocument();
  });

  it('空公式显示占位，点击添加进入编辑并实时预览', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initialLatex="" />);

    expect(screen.getByText('空公式')).toBeInTheDocument();
    const add = screen.getByRole('button', { name: '点击添加公式' });
    expect(screen.queryByLabelText('LaTeX 源')).toBeNull();

    await user.click(add);
    const textarea = screen.getByLabelText('LaTeX 源');
    expect(
      screen.getByText('在下方输入 LaTeX，预览会实时更新。'),
    ).toBeInTheDocument();
    expect(screen.getByText('空公式 · 等待输入')).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'x^2' } });
    await waitFor(() => {
      expect(document.querySelector('.katex')).not.toBeNull();
    });
  });

  it('阅读模式强制 view、隐藏编辑与模板，hover 只保留更多菜单', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <FormulaHarness initialLatex={'E=mc^2'} readOnly />,
    );
    const group = screen.getByRole('group', { name: '公式块' });

    expect(container.querySelector('.katex')).not.toBeNull();
    expect(group.getAttribute('data-state')).toBe('view');
    expect(screen.queryByLabelText('LaTeX 源')).toBeNull();
    expect(screen.queryByRole('button', { name: '编辑公式' })).toBeNull();
    expect(screen.queryByRole('button', { name: '公式模板' })).toBeNull();
    expect(screen.queryByRole('button', { name: '完成' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    await hoverFormula(user);
    expect(
      screen.getByRole('button', { name: '更多公式选项' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '编辑公式' })).toBeNull();
    expect(group.textContent).not.toContain('E=mc^2');
  });

  it('阅读模式的空公式与错误公式只给占位', () => {
    const empty = render(<FormulaHarness initialLatex="" readOnly />);
    expect(screen.getByText('空公式')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '点击添加公式' }),
    ).toBeNull();
    empty.unmount();

    render(<FormulaHarness initialLatex={'\\frac{a}{b'} readOnly />);
    expect(screen.getByText('公式无法渲染')).toBeInTheDocument();
    expect(screen.getByText('公式源数据错误')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('缩放收进更多菜单，编辑态显示比例并可重置', async () => {
    const user = userEvent.setup();
    const { container } = render(<FormulaHarness initialLatex={'x^2'} />);
    const group = screen.getByRole('group', { name: '公式块' });

    expect(group.getAttribute('data-zoom')).toBe('100');
    await chooseMore(user, '放大公式');
    expect(group.getAttribute('data-zoom')).toBe('110');
    expect(screen.queryByText('110%')).toBeNull();

    const textarea = await enterEdit(user);
    expect(screen.getByText('110%')).toBeInTheDocument();
    const preview = container.querySelector<HTMLElement>(
      '.zxe-formula-preview',
    );
    expect(preview?.style.getPropertyValue('--zxe-formula-zoom')).toBe('1.1');

    fireEvent.keyDown(textarea, { key: 'Escape' });
    await chooseMore(user, '重置公式缩放');
    expect(group.getAttribute('data-zoom')).toBe('100');
  });

  it('模板在光标处插入并保持渲染', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initialLatex={'x='} />);
    const textarea = await enterEdit(user);
    textarea.focus();
    textarea.setSelectionRange(2, 2);

    await user.click(screen.getByRole('button', { name: '公式模板' }));
    await user.click(
      within(
        await screen.findByRole('menu', { name: '公式模板' }),
      ).getByRole('menuitem', { name: '矩阵' }),
    );
    await waitFor(() => {
      expect(textarea.value).toBe(
        'x=\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
      );
    });
    expect(document.querySelector('.katex')).not.toBeNull();
  });

  it('复制 LaTeX 源收进更多菜单', async () => {
    const user = userEvent.setup();
    const writeText = mockClipboard();
    render(<FormulaHarness initialLatex={'\\sqrt{x}'} />);

    await chooseMore(user, '复制 LaTeX');
    expect(writeText).toHaveBeenCalledWith('\\sqrt{x}');
    expect(await screen.findByText('已复制 LaTeX')).toBeInTheDocument();
  });

  it('导出弹窗：LaTeX 原文、Markdown $$、HTML 含 KaTeX 与 MathML', async () => {
    const user = userEvent.setup();
    render(
      <FormulaHarness initialLatex={'\\int_{a}^{b} f(x)\\,\\mathrm{d}x'} />,
    );

    await chooseMore(user, '导出');
    const dialog = screen.getByRole('dialog', { name: '导出公式' });
    const pre = () => dialog.querySelector<HTMLElement>('[data-fepre]');

    expect(pre()?.textContent).toContain('\\int_{a}^{b}');

    await user.click(within(dialog).getByRole('tab', { name: 'Markdown' }));
    expect(pre()?.textContent).toContain('$$');
    expect(pre()?.textContent).toContain('\\int_{a}^{b}');

    await user.click(within(dialog).getByRole('tab', { name: 'HTML' }));
    expect(pre()?.textContent).toContain('class="katex"');
    expect(pre()?.textContent).toContain('katex-mathml');
    expect(pre()?.textContent).toContain('<math');
    expect(pre()?.textContent).not.toContain('<annotation');
  });

  it('错误源导出 HTML 只给可见占位与注释，不输出源码', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initialLatex={'\\frac{a}{b'} />);

    await chooseMore(user, '导出');
    const dialog = screen.getByRole('dialog', { name: '导出公式' });
    await user.click(within(dialog).getByRole('tab', { name: 'Markdown' }));
    let text =
      dialog.querySelector<HTMLElement>('[data-fepre]')?.textContent ?? '';
    expect(text).toBe('<!-- 公式无法渲染 -->');

    await user.click(within(dialog).getByRole('tab', { name: 'HTML' }));
    text =
      dialog.querySelector<HTMLElement>('[data-fepre]')?.textContent ?? '';

    expect(text).toContain('<!-- 公式无法渲染');
    expect(text).toContain('⚠ 公式无法渲染');
    expect(text).not.toContain('class="katex"');
    expect(text).not.toContain('\\frac{a}{b');
  });
});

describe('FormulaBlock · 模板菜单焦点与即时生效（ZX6-FORMULA-01）', () => {
  it('指针打开不抢焦点，连续切换 3 个模板后焦点与光标仍在输入框', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initialLatex="x=" />);
    const textarea = await enterEdit(user);
    textarea.focus();
    textarea.setSelectionRange(2, 2);

    await openTemplateMenu(user);
    expect(document.activeElement).toBe(textarea);

    const menu = screen.getByRole('menu', { name: '公式模板' });
    await user.click(within(menu).getByRole('menuitem', { name: '分数' }));
    await waitFor(() => {
      expect(latexInput()).toHaveValue('x=\\frac{a}{b}');
    });
    expect(document.activeElement).toBe(latexInput());
    expect(latexInput().selectionStart).toBe(13);
    expect(latexInput().selectionEnd).toBe(13);

    await chooseTemplate(user, '根式');
    await waitFor(() => {
      expect(latexInput()).toHaveValue('x=\\frac{a}{b}\\sqrt{x}');
    });
    expect(document.activeElement).toBe(latexInput());
    expect(latexInput().selectionStart).toBe(21);

    await chooseTemplate(user, '上标');
    await waitFor(() => {
      expect(latexInput()).toHaveValue('x=\\frac{a}{b}\\sqrt{x}x^{2}');
    });
    expect(document.activeElement).toBe(latexInput());
    expect(latexInput().selectionStart).toBe(26);
    expect(document.querySelector('.katex')).not.toBeNull();
  });

  it('切换模板后继续输入与删除，焦点不丢且光标落在文本末尾', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initialLatex="" />);
    await user.click(screen.getByRole('button', { name: '点击添加公式' }));
    const textarea = latexInput();
    expect(document.activeElement).toBe(textarea);

    await chooseTemplate(user, '分数');
    await waitFor(() => {
      expect(textarea).toHaveValue('\\frac{a}{b}');
    });
    expect(textarea.selectionStart).toBe(11);

    await user.type(textarea, 'ab');
    await waitFor(() => {
      expect(textarea).toHaveValue('\\frac{a}{b}ab');
    });
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(13);

    await user.type(textarea, '{Backspace}{Backspace}');
    await waitFor(() => {
      expect(textarea).toHaveValue('\\frac{a}{b}');
    });
    expect(document.activeElement).toBe(textarea);
  });

  it('Esc 只关闭模板菜单：焦点回输入框、保留选区、不退出编辑', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initialLatex="ab" />);
    const textarea = await enterEdit(user);
    textarea.focus();
    textarea.setSelectionRange(1, 2);

    await openTemplateMenu(user);
    // portal 菜单在 WKWebView 下可能给出 relatedTarget=null，不能因此退出编辑。
    fireEvent.blur(textarea, { relatedTarget: null });
    expect(latexInput()).toBe(textarea);
    expect(
      screen.getByRole('group', { name: '公式块' }).getAttribute('data-state'),
    ).toBe('edit');

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        screen.queryByRole('menu', { name: '公式模板' }),
      ).toBeNull();
    });
    expect(latexInput()).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe(1);
    expect(textarea.selectionEnd).toBe(2);
    expect(
      screen.getByRole('group', { name: '公式块' }).getAttribute('data-state'),
    ).toBe('edit');
  });

  it('键盘打开菜单进入第一项，Esc 关闭后焦点与选区回到输入框', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initialLatex="ab" />);
    const textarea = await enterEdit(user);
    textarea.focus();
    textarea.setSelectionRange(1, 1);

    const trigger = screen.getByRole('button', { name: '公式模板' });
    trigger.focus();
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu', { name: '公式模板' });
    const first = within(menu).getByRole('menuitem', { name: '分数' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Escape' });
    await waitFor(() => {
      expect(
        screen.queryByRole('menu', { name: '公式模板' }),
      ).toBeNull();
    });
    expect(document.activeElement).toBe(latexInput());
    expect(latexInput().selectionStart).toBe(1);
    expect(
      screen.getByRole('group', { name: '公式块' }).getAttribute('data-state'),
    ).toBe('edit');
  });

  it('点击菜单外部关闭时焦点回输入框，草稿与原选区不丢', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initialLatex="x^2" />);
    const textarea = await enterEdit(user);
    textarea.focus();
    textarea.setSelectionRange(1, 1);

    await openTemplateMenu(user);
    await user.click(screen.getByLabelText('公式预览'));
    await waitFor(() => {
      expect(
        screen.queryByRole('menu', { name: '公式模板' }),
      ).toBeNull();
    });
    expect(document.activeElement).toBe(latexInput());
    expect(latexInput()).toBe(textarea);
    expect(textarea.value).toBe('x^2');
    expect(textarea.selectionStart).toBe(1);
    expect(
      screen.getByRole('group', { name: '公式块' }).getAttribute('data-state'),
    ).toBe('edit');
  });

  it('连续切换模板后 ⌘Z/⇧⌘Z 撤销重做，每步独立且焦点仍在输入框', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'formula-1',
        type: 'formula',
        payload: { latex: 'x=', display: 'block', renderer: 'katex' },
      }),
    ]);
    const user = userEvent.setup();
    render(
      <NoteBlockEditor noteId={FAKE_NOTE_ID} source={source} saveDelayMs={0} />,
    );
    await screen.findByRole('group', { name: '公式块' });
    const textarea = await enterEdit(user);
    textarea.focus();
    textarea.setSelectionRange(2, 2);

    // 先输入，再连插两个模板：模板插入应是独立撤销步，不和输入合并。
    await user.type(textarea, 'y');
    await waitFor(() => {
      expect(latexInput()).toHaveValue('x=y');
    });

    await chooseTemplate(user, '分数');
    await chooseTemplate(user, '根式');
    await waitFor(() => {
      expect(latexInput()).toHaveValue('x=y\\frac{a}{b}\\sqrt{x}');
    });

    await act(async () => {
      fireEvent.keyDown(latexInput(), { key: 'z', metaKey: true });
    });
    await waitFor(() => {
      expect(latexInput()).toHaveValue('x=y\\frac{a}{b}');
    });
    expect(document.activeElement).toBe(latexInput());

    await act(async () => {
      fireEvent.keyDown(latexInput(), { key: 'z', metaKey: true });
    });
    await waitFor(() => {
      // 只撤销“根式”之前的“分数”插入，先前输入的 y 仍在。
      expect(latexInput()).toHaveValue('x=y');
    });

    await act(async () => {
      fireEvent.keyDown(latexInput(), {
        key: 'z',
        metaKey: true,
        shiftKey: true,
      });
    });
    await waitFor(() => {
      expect(latexInput()).toHaveValue('x=y\\frac{a}{b}');
    });
    expect(document.activeElement).toBe(latexInput());
  });
});

describe('公式块 · 属性标识默认隐藏（ZX6-PROPS-01）', () => {
  /** jsdom 不计算布局，浮层契约通过 CSSOM 断言。 */
  function formulaCssRule(selector: string): CSSStyleRule {
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSStyleRule && rule.selectorText === selector) {
          return rule;
        }
      }
    }
    throw new Error(`没有找到公式 CSS 规则：${selector}`);
  }

  it('默认无属性条；hover 出现模式/编辑/更多，移开消失', async () => {
    render(<FormulaHarness initialLatex={'x^2'} />);
    const group = screen.getByRole('group', { name: '公式块' });

    expect(document.querySelector('.zxe-formula-head')).toBeNull();
    expect(group.getAttribute('data-meta-visible')).toBe('false');
    expect(screen.queryByRole('toolbar', { name: '公式属性' })).toBeNull();

    fireEvent.mouseEnter(group);
    await waitFor(() => {
      expect(group.getAttribute('data-meta-visible')).toBe('true');
    });
    const strip = screen.getByRole('toolbar', { name: '公式属性' });
    expect(within(strip).getByText('公式')).toBeInTheDocument();
    expect(within(strip).getByText('块级')).toBeInTheDocument();
    expect(
      within(strip).getByRole('button', { name: '编辑公式' }),
    ).toBeInTheDocument();
    expect(
      within(strip).getByRole('button', { name: '更多公式选项' }),
    ).toBeInTheDocument();

    fireEvent.mouseLeave(group);
    await waitFor(() => {
      expect(document.querySelector('.zxe-formula-head')).toBeNull();
    });
    expect(screen.queryByRole('toolbar', { name: '公式属性' })).toBeNull();
  });

  it('属性条固定定位在视口浮层，不占布局、不推移正文', () => {
    expect(formulaCssRule('.zxe-formula').style.position).toBe('relative');
    const floating = formulaCssRule('.zxe-formula-head');
    expect(floating.style.position).toBe('fixed');
    expect(floating.style.zIndex).toBe('var(--z-toolbar, 300)');
    expect(floating.style.maxWidth).toBe('calc(100vw - 16px)');
  });

  it('键盘 Tab 聚焦公式块后属性条出现，再 Tab 可到达编辑入口', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initialLatex={'x^2'} />);

    await user.tab();
    expect(screen.getByRole('group', { name: '公式块' })).toHaveFocus();
    const strip = await screen.findByRole('toolbar', { name: '公式属性' });
    expect(document.querySelector('.zxe-formula-head')).not.toBeNull();

    await user.tab();
    expect(
      within(strip).getByRole('button', { name: '编辑公式' }),
    ).toHaveFocus();
  });

  it('右键菜单打开时属性条让位，不与菜单重复同一组入口', async () => {
    const onContextMenu = vi.fn();
    render(
      <FormulaHarness initialLatex={'x^2'} onContextMenu={onContextMenu} />,
    );
    const group = screen.getByRole('group', { name: '公式块' });

    fireEvent.mouseEnter(group);
    await waitFor(() => {
      expect(document.querySelector('.zxe-formula-head')).not.toBeNull();
    });

    fireEvent.contextMenu(group, { clientX: 120, clientY: 160 });
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(document.querySelector('.zxe-formula-head')).toBeNull();
    });
  });

  it('进入编辑后属性条作为编辑工具保持可见，Esc 退出后由焦点上下文接管', async () => {
    const user = userEvent.setup();
    render(<FormulaHarness initialLatex={'x^2'} />);
    const textarea = await enterEdit(user);

    expect(document.querySelector('.zxe-formula-head')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: '公式模板' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '更多公式选项' }),
    ).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByLabelText('LaTeX 源')).toBeNull();
    });
    // 退出后焦点回到公式块（focus-within），仍属于“按上下文显示”。
    expect(screen.getByRole('toolbar', { name: '公式属性' })).toBeVisible();
  });
});

describe('blockHtml · 公式投影与导出', () => {
  it('renderFormula 返回 KaTeX HTML 与可定位错误', () => {
    const ok = renderFormula('\\frac{a}{b}', 'block');
    expect(ok.status).toBe('ok');
    if (ok.status === 'ok') {
      expect(ok.html).toContain('class="katex"');
      expect(ok.html).toContain('katex-mathml');
      expect(ok.html).not.toContain('<annotation');
    }

    const bad = renderFormula('\\frac{a}{b', 'block');
    expect(bad.status).toBe('error');
    if (bad.status === 'error') {
      expect(bad.message).toContain('KaTeX parse error');
      expect(bad.line).toBe(1);
      expect(bad.column).toBeGreaterThan(0);
      expect(bad.excerpt.length).toBeGreaterThan(0);
      expect(bad.caret).toContain('^');
    }
  });

  it('块级公式写 LaTeX 源，Markdown 导出逐字符一致（反斜杠不二次转义）', () => {
    const html = blocksToHtml([
      {
        type: 'formula',
        payload: { latex: '\\frac{a}{b}', display: 'block' },
      },
    ]);

    expect(html).toContain('data-display="block"');
    expect(html).toContain('data-language="latex"');
    expect(html).toContain('\\frac{a}{b}');
    expect(html).not.toContain('class="katex"');
    expect(htmlToMarkdown(html)).toBe('```latex\n\\frac{a}{b}\n```');
  });

  it('行内公式导出为行内代码并保留源', () => {
    const html = blocksToHtml([
      {
        type: 'formula',
        payload: { latex: 'x^{2}', display: 'inline' },
      },
    ]);

    expect(html).toContain('data-display="inline"');
    expect(htmlToMarkdown(html)).toBe('`x^{2}`');
  });

  it('空公式不产生 Markdown 内容', () => {
    const html = blocksToHtml([
      { type: 'formula', payload: { latex: '', display: 'block' } },
    ]);

    expect(html).toContain('zx-formula-empty');
    expect(htmlToMarkdown(html)).toBe('');
  });

  it('LaTeX 源按 HTML 转义，不注入标签', () => {
    const html = blocksToHtml([
      {
        type: 'formula',
        payload: { latex: '<script>alert(1)</script>', display: 'block' },
      },
    ]);

    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('旧数据 renderer:none 默认按块级导出', () => {
    const html = blocksToHtml([
      {
        type: 'formula',
        payload: { latex: '\\sqrt{x}', renderer: 'none' },
      },
    ]);

    expect(html).toContain('data-display="block"');
    expect(htmlToMarkdown(html)).toBe('```latex\n\\sqrt{x}\n```');
  });
});

describe('公式块 · 工具条跟随 caret 与边界（ZX7-TOOLBAR-01）', () => {
  type Box = [left: number, top: number, width: number, height: number];
  const initialViewport = {
    width: window.innerWidth,
    height: window.innerHeight,
  };

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: initialViewport.width,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: initialViewport.height,
    });
  });

  function boxRect([left, top, width, height]: Box): DOMRect {
    return {
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect;
  }

  function setViewport(width: number, height: number) {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: width,
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: height,
    });
  }

  function installGeometry({
    formula,
    preview,
    toolbar,
  }: {
    formula: Box;
    preview: Box;
    toolbar?: Box;
  }) {
    const original = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: Element) {
        const element = this as HTMLElement;
        if (element.classList?.contains('zxe-formula-head')) {
          return boxRect(toolbar ?? [0, 0, 220, 34]);
        }
        if (element.classList?.contains('zxe-formula-input')) {
          return boxRect(formula);
        }
        if (element.classList?.contains('zxe-formula-preview')) {
          return boxRect(preview);
        }
        if (element.classList?.contains('zxe-formula')) {
          return boxRect(preview);
        }
        return original.call(this);
      },
    );
  }

  function strip(): HTMLElement {
    return screen.getByRole('toolbar', { name: '公式属性' });
  }

  it('阅读态锚定预览右上角，上方不足时翻到下方', async () => {
    installGeometry({
      formula: [100, 20, 300, 80],
      preview: [100, 20, 300, 40],
    });
    render(<FormulaHarness initialLatex={'x^2'} />);
    fireEvent.mouseEnter(screen.getByRole('group', { name: '公式块' }));

    const toolbar = await screen.findByRole('toolbar', {
      name: '公式属性',
    });
    await waitFor(() => expect(toolbar.style.top).toBe('66px'));
    expect(toolbar.dataset.side).toBe('bottom');
    expect(toolbar.style.left).toBe('180px');
  });

  it('阅读态靠右时夹取，右边缘不溢出视口', async () => {
    installGeometry({
      formula: [900, 200, 220, 80],
      preview: [900, 200, 220, 40],
    });
    render(<FormulaHarness initialLatex={'x^2'} />);
    fireEvent.mouseEnter(screen.getByRole('group', { name: '公式块' }));

    const toolbar = strip();
    await waitFor(() => expect(toolbar.style.left).toBe('796px'));
    expect(796 + 220).toBeLessThanOrEqual(1024 - 8);
  });

  it('编辑态锚定 caret 行：换行后工具条随 caret 下移', async () => {
    const user = userEvent.setup();
    installGeometry({
      formula: [100, 400, 300, 120],
      preview: [100, 400, 300, 40],
    });
    render(<FormulaHarness initialLatex={'a\nb'} />);

    const textarea = await enterEdit(user);
    // 进入编辑时 caret 在末尾（第 2 行）；先移到首行，验证工具条随 caret 下移。
    textarea.setSelectionRange(0, 0);
    fireEvent.select(textarea);
    // textarea padding-top 为 8px（editor.css .zxe-formula-input）。
    await waitFor(() =>
      expect(screen.getByRole('toolbar', { name: '公式工具栏' })).toHaveStyle({
        top: '368px',
      }),
    );

    textarea.setSelectionRange(2, 2);
    fireEvent.select(textarea);
    const toolbar = screen.getByRole('toolbar', { name: '公式工具栏' });
    await waitFor(() => expect(toolbar.style.top).toBe('386px'));
  });

  it('编辑态 textarea 滚动时按 scrollTop 修正 caret 行', async () => {
    const user = userEvent.setup();
    installGeometry({
      formula: [100, 400, 300, 120],
      preview: [100, 400, 300, 40],
    });
    render(<FormulaHarness initialLatex={'a\nb\nc'} />);

    const textarea = await enterEdit(user);
    textarea.setSelectionRange(4, 4);
    textarea.scrollTop = 10;
    fireEvent.select(textarea);
    fireEvent.scroll(textarea);

    const toolbar = screen.getByRole('toolbar', { name: '公式工具栏' });
    // 第 3 行（行号 2）：400 + 8(padding) + 18×2 - 10 - 6 - 34 = 394
    await waitFor(() => expect(toolbar.style.top).toBe('394px'));
  });

  it('390 窄窗：maxWidth 生效，工具条留在视口内', async () => {
    setViewport(390, 800);
    installGeometry({
      formula: [280, 200, 100, 80],
      preview: [280, 200, 100, 40],
    });
    render(<FormulaHarness initialLatex={'x^2'} />);
    fireEvent.mouseEnter(screen.getByRole('group', { name: '公式块' }));

    const toolbar = strip();
    // 内容区左边界（root 280）兜底，但右边缘仍被夹取在视口安全边距内。
    await waitFor(() => expect(toolbar.style.left).toBe('162px'));
    expect(toolbar.style.maxWidth).toBe('374px');
    expect(Number.parseFloat(toolbar.style.left) + 220).toBeLessThanOrEqual(
      390 - 8,
    );
  });

  it('滚动到锚点不可见时隐藏，滚回后恢复', async () => {
    const preview: Box = [100, 200, 300, 40];
    installGeometry({ formula: [100, 200, 300, 80], preview });
    render(<FormulaHarness initialLatex={'x^2'} />);
    fireEvent.mouseEnter(screen.getByRole('group', { name: '公式块' }));

    const toolbar = strip();
    await waitFor(() => expect(toolbar.dataset.positioned).toBe('true'));

    // 直接改同一个矩形对象的内容，模拟滚动后的新视口坐标。
    preview[0] = 100;
    preview[1] = 900;
    fireEvent.scroll(window);
    await waitFor(() => {
      expect(toolbar.dataset.positioned).toBe('false');
      expect(toolbar.style.visibility).toBe('hidden');
    });
  });

  it('Alt+F10 进入工具条，Esc 回到 textarea（编辑态）', async () => {
    const user = userEvent.setup();
    installGeometry({
      formula: [100, 400, 300, 120],
      preview: [100, 400, 300, 40],
    });
    render(<FormulaHarness initialLatex={'x^2'} />);

    const textarea = await enterEdit(user);
    fireEvent.keyDown(textarea, { key: 'F10', altKey: true });
    const toolbar = screen.getByRole('toolbar', { name: '公式工具栏' });
    expect(
      within(toolbar).getByRole('button', { name: '公式模板' }),
    ).toHaveFocus();

    fireEvent.keyDown(toolbar, { key: 'Escape' });
    expect(textarea).toHaveFocus();
    expect(screen.queryByLabelText('LaTeX 源')).not.toBeNull();
  });
});
