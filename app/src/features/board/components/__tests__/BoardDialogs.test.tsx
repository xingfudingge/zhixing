import { useState, type ComponentProps } from 'react';

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { StarterDialog, JsonDialog } from '../BoardDialogs';
import { buildBoardPackage } from '../../export/package';
import {
  BOARD_STARTERS,
  STARTER_GROUPS,
  starterPreview,
} from '../../model';
import type { StarterPreview } from '../../model';
import { sampleDocument } from '../../__tests__/fakeBoardSource';
import type { SaveResult } from '../../../attachments/fileActions';

function countLabel(preview: StarterPreview): string {
  const objects = `${preview.nodes.length} 个对象`;
  return preview.edges.length > 0
    ? `${objects} · ${preview.edges.length} 条连线`
    : objects;
}

function renderDialog(hasContent = false) {
  const onInsert = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <StarterDialog
      open
      onClose={onClose}
      onInsert={onInsert}
      hasContent={hasContent}
    />,
  );
  return { ...view, onInsert, onClose };
}

describe('画板模板弹层', () => {
  it('按 3 组展示全部模板，每张卡都有预览、说明与对象/连线数', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');

    expect(
      within(dialog).getByRole('heading', { name: '起步结构' }),
    ).toBeInTheDocument();
    for (const group of STARTER_GROUPS) {
      expect(
        within(dialog).getByRole('group', { name: group.title }),
      ).toBeInTheDocument();
    }
    expect(dialog.querySelectorAll('.bw-starter-group')).toHaveLength(
      STARTER_GROUPS.length,
    );

    const cards = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>('.bw-starter-card'),
    );
    expect(cards).toHaveLength(BOARD_STARTERS.length);

    for (const template of BOARD_STARTERS) {
      const card = within(dialog).getByRole('button', {
        name: new RegExp(template.title),
      });
      // 预览来自模型真实几何，不是装饰占位图。
      expect(card.querySelector('.bw-starter-preview svg')).not.toBeNull();
      expect(
        card.querySelectorAll('.bw-starter-preview svg *').length,
      ).toBeGreaterThan(0);
      expect(within(card).getByText(template.description)).toBeInTheDocument();
      const preview = starterPreview(template.kind);
      expect(within(card).getByText(countLabel(preview))).toBeInTheDocument();
    }
  });

  it('规范要求的 8 个模板名称全部可检索到', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    for (const title of [
      '时间线',
      '组织架构',
      '系统架构',
      '思维导图',
      '金字塔',
      '增长飞轮',
      '泳道 · 横向',
      '泳道 · 纵向',
    ]) {
      expect(
        within(dialog).getByRole('button', { name: new RegExp(title) }),
      ).toBeInTheDocument();
    }
  });

  it('键盘可达：首卡自动聚焦，Tab/方向键/Home 移动，Esc 关闭', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    const first = screen.getByRole('button', { name: /流程图/ });
    await waitFor(() => expect(first).toHaveFocus());

    await user.tab();
    expect(screen.getByRole('button', { name: /时间线/ })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(
      screen.getByRole('button', { name: /泳道 · 纵向/ }),
    ).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('button', { name: /时间线/ })).toHaveFocus();

    await user.keyboard('{Home}');
    expect(first).toHaveFocus();

    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: /增长飞轮/ })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('每个模板卡片点击后都回调对应的普通对象插入类型', async () => {
    const user = userEvent.setup();
    for (const template of BOARD_STARTERS) {
      const { unmount, onInsert } = renderDialog();
      const dialog = screen.getByRole('dialog');
      const card = within(dialog).getByRole('button', {
        name: new RegExp(template.title),
      });
      await user.click(card);
      expect(onInsert).toHaveBeenCalledTimes(1);
      expect(onInsert).toHaveBeenCalledWith(template.kind);
      unmount();
    }
  });

  it('空画板与已有内容都可打开，只是说明文字不同', () => {
    const { rerender } = render(
      <StarterDialog open onClose={vi.fn()} onInsert={vi.fn()} hasContent={false} />,
    );
    expect(screen.getByText(/不是模式或固定模板/)).toBeInTheDocument();

    rerender(
      <StarterDialog open onClose={vi.fn()} onInsert={vi.fn()} hasContent />,
    );
    expect(screen.getByText(/放在现有内容下方/)).toBeInTheDocument();
    expect(screen.getByText(/一次插入记为一步撤销/)).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /时间线/ }).length,
    ).toBeGreaterThan(0);
  });

  it('重渲染（新的 onClose）不抢回焦点，也不重置模板列表滚动位置', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    const view = render(
      <StarterDialog
        open
        onClose={() => {}}
        onInsert={onInsert}
        hasContent={false}
      />,
    );
    const dialog = screen.getByRole('dialog');
    const scroller = dialog.querySelector<HTMLElement>('.bw-modal-body');
    expect(scroller).not.toBeNull();
    scroller!.scrollTop = 420;
    fireEvent.scroll(scroller!);

    const mind = screen.getByRole('button', { name: /思维导图/ });
    await user.click(mind);
    expect(onInsert).toHaveBeenCalledWith('mind');
    expect(mind).toHaveFocus();

    // 父组件任何状态变化都会带来新的 onClose；此时不应重新聚焦首卡。
    view.rerender(
      <StarterDialog
        open
        onClose={() => {}}
        onInsert={onInsert}
        hasContent
      />,
    );
    await waitFor(() => expect(mind).toHaveFocus());
    expect(scroller!.scrollTop).toBe(420);
  });

  it('关闭后重新打开恢复上次的模板列表滚动位置', () => {
    const onInsert = vi.fn();
    const { rerender } = render(
      <StarterDialog open onClose={() => {}} onInsert={onInsert} hasContent={false} />,
    );
    const dialog = screen.getByRole('dialog');
    const scroller = dialog.querySelector<HTMLElement>('.bw-modal-body');
    expect(scroller).not.toBeNull();
    scroller!.scrollTop = 360;
    fireEvent.scroll(scroller!);

    rerender(
      <StarterDialog
        open={false}
        onClose={() => {}}
        onInsert={onInsert}
        hasContent={false}
      />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(
      <StarterDialog open onClose={() => {}} onInsert={onInsert} hasContent={false} />,
    );
    expect(
      screen
        .getByRole('dialog')
        .querySelector<HTMLElement>('.bw-modal-body')!.scrollTop,
    ).toBe(360);
  });

  it('窄屏单列时上下键按一列移动，并把目标滚入可视区', async () => {
    const originalMatchMedia = window.matchMedia;
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query === '(max-width: 860px)',
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    try {
      const user = userEvent.setup();
      renderDialog();
      const timeline = screen.getByRole('button', { name: /时间线/ });
      timeline.focus();

      await user.keyboard('{ArrowDown}');
      const lane = screen.getByRole('button', { name: /泳道 · 横向/ });
      expect(lane).toHaveFocus();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });

      await user.keyboard('{ArrowUp}');
      expect(timeline).toHaveFocus();
    } finally {
      if (originalMatchMedia) {
        Object.defineProperty(window, 'matchMedia', {
          configurable: true,
          value: originalMatchMedia,
        });
      } else {
        Reflect.deleteProperty(window, 'matchMedia');
      }
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
          configurable: true,
          writable: true,
          value: originalScrollIntoView,
        });
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    }
  });

  it('底部模板（思维导图/增长飞轮）点击可插入并正常关闭', async () => {
    function Harness({ onInsert }: { onInsert: (kind: string) => void }) {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            再打开
          </button>
          <StarterDialog
            open={open}
            onClose={() => setOpen(false)}
            onInsert={(kind) => {
              onInsert(kind);
              setOpen(false);
            }}
            hasContent={false}
          />
        </>
      );
    }

    const user = userEvent.setup();
    for (const [title, kind] of [
      ['思维导图', 'mind'],
      ['增长飞轮', 'flywheel'],
    ] as const) {
      const onInsert = vi.fn();
      const { unmount } = render(<Harness onInsert={onInsert} />);
      const dialog = screen.getByRole('dialog');
      dialog.scrollTop = 520;
      fireEvent.scroll(dialog);

      const card = within(dialog).getByRole('button', {
        name: new RegExp(title),
      });
      await user.click(card);

      expect(onInsert).toHaveBeenCalledWith(kind);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('画板 JSON 弹层', () => {
  const viewport = { x: 10, y: 20, zoom: 1.5 };

  function renderJsonDialog(
    overrides: Partial<ComponentProps<typeof JsonDialog>> = {},
  ) {
    const onApply = vi.fn();
    const onClose = vi.fn();
    const onStatus = vi.fn();
    const saveJson = vi.fn(
      async (_blob: Blob, _fileName: string): Promise<SaveResult> => ({
        status: 'canceled',
      }),
    );
    const view = render(
      <JsonDialog
        open
        document={sampleDocument()}
        viewport={viewport}
        defaultTab="json"
        onApply={onApply}
        onClose={onClose}
        onStatus={onStatus}
        saveJson={saveJson}
        now={() => new Date(2026, 9, 29, 13, 30)}
        {...overrides}
      />,
    );
    return { ...view, onApply, onClose, onStatus, saveJson };
  }

  /** 与当前画板不同、但结构有效的导入内容。 */
  function importedJson(): string {
    return JSON.stringify({
      ...sampleDocument(),
      boardId: 'imported-board',
      title: '导入画板',
    });
  }

  function pasteJson(value: string) {
    fireEvent.change(screen.getByRole('textbox', { name: '画板 JSON' }), {
      target: { value },
    });
  }

  it('导出 JSON 走保存面板，文件名带时间戳且内容含 viewport', async () => {
    const user = userEvent.setup();
    const { saveJson, onStatus } = renderJsonDialog();
    saveJson.mockResolvedValue({
      status: 'saved',
      path: '/Users/me/Exports/测试画板-20261029-1330.json',
      target: 'desktop',
    });

    await user.click(screen.getByRole('button', { name: '导出 JSON…' }));

    await waitFor(() => expect(saveJson).toHaveBeenCalledTimes(1));
    const [blob, fileName] = saveJson.mock.calls[0];
    expect(fileName).toBe('测试画板-20261029-1330.json');
    expect(blob.type).toContain('application/json');
    expect(onStatus).toHaveBeenCalledWith(
      '已导出画板 JSON：测试画板-20261029-1330.json',
    );
  });

  it('保存面板取消时不提示已导出，也不关闭弹层', async () => {
    const user = userEvent.setup();
    const { saveJson, onStatus, onClose } = renderJsonDialog();
    saveJson.mockResolvedValue({ status: 'canceled' });

    await user.click(screen.getByRole('button', { name: '导出 JSON…' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      '已取消导出，未写入文件。',
    );
    expect(onStatus).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('未知版本给明确错误，应用按钮禁用且不调用 onApply', async () => {
    const user = userEvent.setup();
    const { onApply } = renderJsonDialog();
    const textarea = screen.getByRole('textbox', { name: '画板 JSON' });
    fireEvent.change(textarea, {
      target: { value: JSON.stringify({ version: 2, nodes: [], edges: [] }) },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/仅支持 version=1/);
    expect(
      screen.getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '应用导入' }));
    expect(onApply).not.toHaveBeenCalled();
  });

  it('引用缺失给明确错误，不进入二次确认', () => {
    renderJsonDialog();
    const document = sampleDocument();
    const json = {
      ...document,
      edges: [
        {
          ...document.edges[0],
          toNodeId: 'missing-node',
        },
      ],
    };
    fireEvent.change(screen.getByRole('textbox', { name: '画板 JSON' }), {
      target: { value: JSON.stringify(json) },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/不存在的对象/);
    expect(
      screen.queryByRole('group', { name: '确认导入' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
  });

  it('二次确认可取消：不调用 onApply，弹层保留，画板不变', async () => {
    const user = userEvent.setup();
    const { onApply, onClose } = renderJsonDialog();
    pasteJson(importedJson());

    await user.click(screen.getByRole('button', { name: '应用导入' }));
    expect(
      screen.getByRole('group', { name: '确认导入' }),
    ).toHaveTextContent(/将替换当前画布内容/);
    await user.click(screen.getByRole('button', { name: '返回修改' }));

    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('group', { name: '确认导入' }),
    ).not.toBeInTheDocument();
  });

  it('选择“导入为新画板”后确认，把 create 模式交给调用方', async () => {
    const user = userEvent.setup();
    const { onApply, onClose } = renderJsonDialog();
    pasteJson(importedJson());

    await user.click(screen.getByRole('radio', { name: /导入为新画板/ }));
    await user.click(screen.getByRole('button', { name: '应用导入' }));
    expect(
      screen.getByRole('group', { name: '确认导入' }),
    ).toHaveTextContent(/当前画板内容保持不变/);
    await user.click(
      screen.getByRole('button', { name: '确认导入新画板' }),
    );

    await waitFor(() =>
      expect(onApply).toHaveBeenCalledWith(expect.any(String), 'create'),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('阅读模式禁用导入但允许导出', () => {
    renderJsonDialog({ readOnly: true });

    expect(screen.getByRole('textbox', { name: '画板 JSON' })).toHaveAttribute('readonly');
    expect(
      screen.getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: '导出 JSON…' }),
    ).toBeEnabled();
  });
});

describe('画板弹窗外壳 · 层级、焦点与底部操作栏', () => {
  const viewport = { x: 10, y: 20, zoom: 1.5 };

  const cancelSave = async (): Promise<SaveResult> => ({ status: 'canceled' });

  function renderJson(
    overrides: Partial<ComponentProps<typeof JsonDialog>> = {},
  ) {
    const onApply = vi.fn();
    const onApplyDocument = vi.fn();
    const onClose = vi.fn();
    const onStatus = vi.fn();
    const saveJson = vi.fn(cancelSave);
    const savePackage = vi.fn(cancelSave);
    const view = render(
      <JsonDialog
        open
        document={sampleDocument()}
        viewport={viewport}
        onApply={onApply}
        onApplyDocument={onApplyDocument}
        onClose={onClose}
        onStatus={onStatus}
        saveJson={saveJson}
        savePackage={savePackage}
        now={() => new Date(2026, 9, 29, 13, 30)}
        {...overrides}
      />,
    );
    return {
      ...view,
      onApply,
      onApplyDocument,
      onClose,
      onStatus,
      saveJson,
      savePackage,
    };
  }

  it('portal 到 body，header/body/footer 分离，footer 按钮不在滚动区', () => {
    const view = render(
      <StarterDialog
        open
        onClose={vi.fn()}
        onInsert={vi.fn()}
        hasContent={false}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(view.container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);

    const shell = dialog.parentElement;
    const backdrop = shell?.parentElement;
    expect(backdrop).toHaveClass('bw-modal-backdrop');
    expect(shell).toHaveClass('bw-modal-shell');

    const body = dialog.querySelector('.bw-modal-body');
    const footer = dialog.querySelector('.bw-modal-foot');
    const cancel = screen.getByRole('button', { name: '取消' });
    expect(body).toContainElement(
      screen.getByRole('button', { name: /时间线/ }),
    );
    expect(body).not.toContainElement(cancel);
    expect(footer).toContainElement(cancel);
  });

  it('打开时聚焦首个可操作项（不是关闭 X），Tab/Shift+Tab 在弹窗内循环', async () => {
    const user = userEvent.setup();
    renderJson();

    const dialog = screen.getByRole('dialog');
    const packageTab = within(dialog).getByRole('tab', {
      name: /画板包 .zxboard/,
    });
    const jsonTab = within(dialog).getByRole('tab', {
      name: /开发者 · JSON/,
    });
    const close = within(dialog).getByRole('button', { name: '关闭' });
    await waitFor(() => expect(packageTab).toHaveFocus());
    expect(close).not.toHaveFocus();

    await user.tab();
    expect(jsonTab).toHaveFocus();

    await user.tab({ shift: true });
    expect(packageTab).toHaveFocus();
  });

  it('焦点逃逸到背景时拉回弹窗', async () => {
    renderJson();
    const dialog = screen.getByRole('dialog');
    const packageTab = within(dialog).getByRole('tab', {
      name: /画板包 .zxboard/,
    });
    await waitFor(() => expect(packageTab).toHaveFocus());

    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = '背景按钮';
    document.body.append(outside);
    outside.focus();

    await waitFor(() =>
      expect(dialog.contains(document.activeElement)).toBe(true),
    );
    outside.remove();
  });

  it('Escape 关闭弹窗，并把焦点还给触发按钮', async () => {
    const user = userEvent.setup();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            打开导入
          </button>
          <JsonDialog
            open={open}
            document={sampleDocument()}
            viewport={viewport}
            onApply={vi.fn()}
            onApplyDocument={vi.fn()}
            onClose={() => setOpen(false)}
            onStatus={vi.fn()}
            saveJson={cancelSave}
            savePackage={cancelSave}
            now={() => new Date(2026, 9, 29, 13, 30)}
          />
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '打开导入' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(
        within(dialog).getByRole('tab', { name: /画板包 .zxboard/ }),
      ).toHaveFocus(),
    );

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it('点击遮罩关闭；点击弹窗内部不关闭', () => {
    const onClose = vi.fn();
    render(
      <StarterDialog
        open
        onClose={onClose}
        onInsert={vi.fn()}
        hasContent={false}
      />,
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.pointerDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    const backdrop = dialog.parentElement!.parentElement!;
    fireEvent.pointerDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('画板包导出中锁定关闭/取消/Escape/遮罩，并阻止重复提交', async () => {
    const user = userEvent.setup();
    let resolveSave!: (result: SaveResult) => void;
    const savePackage = vi.fn(
      () =>
        new Promise<SaveResult>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onClose = vi.fn();
    renderJson({ onClose, savePackage });

    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: '导出画板包…' }),
    );
    await waitFor(() => expect(savePackage).toHaveBeenCalledTimes(1));
    expect(dialog).toHaveAttribute('aria-busy', 'true');

    const busyButton = within(dialog).getByRole('button', {
      name: '正在导出…',
    });
    expect(busyButton).toBeDisabled();
    expect(
      within(dialog).getByRole('button', { name: '关闭' }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole('button', { name: '取消' }),
    ).toBeDisabled();

    // 重复提交被同步 busy ref 挡住。
    fireEvent.click(busyButton);
    expect(savePackage).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    fireEvent.pointerDown(dialog.parentElement!.parentElement!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await act(async () => {
      resolveSave({
        status: 'saved',
        path: '/Users/me/Exports/测试画板.zxboard',
        target: 'desktop',
      });
    });

    expect(
      await within(dialog).findByText(/已导出画板包：测试画板\.zxboard/),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      within(dialog).getByRole('button', { name: '关闭' }),
    ).toBeEnabled();
  });

  it('保存面板取消：行内提示、弹窗保留，关闭按钮随后可用', async () => {
    const user = userEvent.setup();
    const savePackage = vi.fn(cancelSave);
    const onClose = vi.fn();
    renderJson({ onClose, savePackage });

    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: '导出画板包…' }),
    );
    expect(
      await within(dialog).findByText('已取消导出画板包，未写入文件。'),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('导出失败在弹窗内显示 role=alert，并解除忙碌', async () => {
    const user = userEvent.setup();
    const savePackage = vi.fn(async (): Promise<SaveResult> => {
      throw new Error('磁盘已满');
    });
    renderJson({ savePackage });

    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: '导出画板包…' }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '磁盘已满',
    );
    expect(
      within(dialog).getByRole('button', { name: '关闭' }),
    ).toBeEnabled();
  });

  it('有效画板包进入预览，应用后按替换模式交给调用方并关闭', async () => {
    const user = userEvent.setup();
    const report = await buildBoardPackage({
      document: sampleDocument(),
      viewport,
      includeThumbnail: false,
    });
    const file = new File([report.bytes.slice().buffer], '测试画板.zxboard', {
      type: 'application/zip',
    });
    const { onApplyDocument, onClose } = renderJson();

    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByLabelText('选择画板包文件');
    fireEvent.change(input, { target: { files: [file] } });

    expect(
      await within(dialog).findByText(/包类型 board-package/),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('button', { name: '应用导入' }),
    );
    await user.click(
      within(dialog).getByRole('button', { name: '确认替换' }),
    );

    await waitFor(() =>
      expect(onApplyDocument).toHaveBeenCalledWith(
        expect.objectContaining({ title: '测试画板' }),
        expect.anything(),
        'replace',
      ),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('坏画板包在弹窗内报错，应用导入保持禁用', async () => {
    const { onApplyDocument } = renderJson();
    const file = new File([new Uint8Array([1, 2, 3, 4])], '坏包.zxboard', {
      type: 'application/zip',
    });

    const dialog = screen.getByRole('dialog');
    fireEvent.change(
      within(dialog).getByLabelText('选择画板包文件'),
      { target: { files: [file] } },
    );

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /ZIP|画板包/,
    );
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
    expect(onApplyDocument).not.toHaveBeenCalled();
  });
});
