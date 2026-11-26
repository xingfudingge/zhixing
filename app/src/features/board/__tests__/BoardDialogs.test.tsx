import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { JsonDialog, type JsonDialogProps } from '../components/BoardDialogs';
import {
  BOARD_PACKAGE_MAX_BYTES,
  buildBoardPackage,
} from '../export/package';
import { BOARD_JSON_MAX_BYTES, boardDocumentJson } from '../model';
import type { BoardDocument, BoardViewport } from '../types';
import { sampleDocument } from './fakeBoardSource';

const VIEWPORT: BoardViewport = { x: -40, y: -30, zoom: 0.9 };

const MINIMAL_JSON = JSON.stringify({
  version: 1,
  boardId: 'foreign',
  noteId: null,
  title: '外部画板',
  background: 'dot',
  nodes: [
    {
      id: 'only',
      type: 'sticky',
      x: 10,
      y: 20,
      width: 160,
      height: 110,
      text: '导入便签',
      payload: {},
    },
  ],
  edges: [],
});

/** 旧版 JSON：没有 schema/metadata/viewport，仍应被开发者入口接受。 */
const LEGACY_JSON = JSON.stringify({
  version: 1,
  boardId: 'legacy',
  noteId: null,
  title: '旧画板',
  background: 'grid',
  nodes: [],
  edges: [],
});

function renderDialog(overrides: Partial<JsonDialogProps> = {}) {
  const document =
    (overrides.document as BoardDocument | undefined) ?? sampleDocument();
  const onApply = overrides.onApply ?? vi.fn();
  const onApplyDocument = overrides.onApplyDocument ?? vi.fn();
  const onClose = overrides.onClose ?? vi.fn();
  const onStatus = overrides.onStatus ?? vi.fn();
  const result = render(
    <JsonDialog
      open
      document={document}
      viewport={VIEWPORT}
      onApply={onApply}
      onApplyDocument={onApplyDocument}
      onClose={onClose}
      onStatus={onStatus}
      {...overrides}
    />,
  );
  return { ...result, document, onApply, onApplyDocument, onClose, onStatus };
}

function openDeveloperTab(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('tab', { name: /开发者 · JSON/ }));
}

function fakeOversizeFile(name: string, size: number): File {
  const file = new File([new Uint8Array([1])], name);
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('画板导入 / 导出弹窗 · 入口分层', () => {
  it('默认进入画板包 tab；开发者 JSON 需主动切换并带「调试」徽标', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    const packageTab = within(dialog).getByRole('tab', {
      name: /画板包 .zxboard/,
    });
    const jsonTab = within(dialog).getByRole('tab', {
      name: /开发者 · JSON/,
    });
    expect(packageTab).toHaveAttribute('aria-selected', 'true');
    expect(jsonTab).toHaveAttribute('aria-selected', 'false');
    expect(within(jsonTab).getByText('调试')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: '导出画板包…' }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole('button', { name: '导入画板包…' }),
    ).toBeEnabled();
    // 默认 tab 下不出现裸的「从文件导入」；文件选择只由当前 tab 的导入按钮触发。
    expect(
      within(dialog).queryByRole('button', { name: /^从文件导入/ }),
    ).not.toBeInTheDocument();
  });

  it('两个入口的 accept 不混用：包只收 .zxboard，JSON 只收 .json', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    const packageInput = within(dialog).getByLabelText('选择画板包文件');
    expect(packageInput).toHaveAttribute(
      'accept',
      '.zxboard,application/zip',
    );
    expect(packageInput.getAttribute('accept')).not.toContain('.json');

    openDeveloperTab(dialog);
    const jsonInput = within(dialog).getByLabelText('选择画板 JSON 文件');
    expect(jsonInput).toHaveAttribute('accept', '.json,application/json');
    expect(jsonInput.getAttribute('accept')).not.toContain('.zxboard');
  });

  it('不保留旧文案与重复入口', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    expect(within(dialog).queryByText('导入画板包 / JSON…')).toBeNull();
    expect(within(dialog).queryByText('从文件导入')).toBeNull();
    expect(within(dialog).queryByText('恢复 JSON')).toBeNull();
  });
});

describe('画板导入 / 导出弹窗 · 开发者 JSON', () => {
  it('初始为空，应用禁用；当前画板 JSON 只读展示，不预填编辑区', () => {
    renderDialog({ defaultTab: 'json' });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    const textarea = within(dialog).getByLabelText('画板 JSON');
    expect(textarea).toHaveValue('');
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
    expect(
      within(dialog).getByText(/请先选择画板包，或在「开发者 · JSON」/),
    ).toBeInTheDocument();

    const current = within(dialog).getByLabelText(
      '当前画板 JSON',
    ) as HTMLTextAreaElement;
    expect(current).toHaveAttribute('readonly');
    expect(current.value).toContain('"title": "测试画板"');
    expect(current.value).toContain('"version": 1');
  });

  it('粘贴与当前画板相同的 JSON 时提示并禁用应用', async () => {
    const { document } = renderDialog({ defaultTab: 'json' });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    const currentJson = boardDocumentJson(document, {
      viewport: VIEWPORT,
      exportedAt: '2026-10-30T00:00:00.000Z',
    });
    fireEvent.change(within(dialog).getByLabelText('画板 JSON'), {
      target: { value: currentJson },
    });
    expect(
      within(dialog).getByText(/与当前画板内容相同，无需导入/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
  });

  it('粘贴有效 JSON 后二次确认并应用，失败不写入', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderDialog({ defaultTab: 'json', onApply, onClose });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    fireEvent.change(within(dialog).getByLabelText('画板 JSON'), {
      target: { value: MINIMAL_JSON },
    });
    const apply = within(dialog).getByRole('button', { name: '应用导入' });
    expect(apply).toBeEnabled();
    await user.click(apply);
    expect(onApply).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole('button', { name: '确认替换' }),
    );
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith(MINIMAL_JSON, 'replace');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('坏 JSON 明确报错，应用禁用且零写入', () => {
    const onApply = vi.fn();
    renderDialog({ defaultTab: 'json', onApply });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    fireEvent.change(within(dialog).getByLabelText('画板 JSON'), {
      target: { value: '{bad' },
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/合法 JSON/);
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('version=2 明确拒绝且不写入', () => {
    const onApply = vi.fn();
    renderDialog({ defaultTab: 'json', onApply });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    fireEvent.change(within(dialog).getByLabelText('画板 JSON'), {
      target: { value: JSON.stringify({ version: 2, nodes: [], edges: [] }) },
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      /仅支持 version=1/,
    );
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('旧版 JSON（无 schema/metadata）仍可预览并应用', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn().mockResolvedValue(undefined);
    renderDialog({ defaultTab: 'json', onApply });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    fireEvent.change(within(dialog).getByLabelText('画板 JSON'), {
      target: { value: LEGACY_JSON },
    });
    expect(within(dialog).getByText('旧画板')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '应用导入' }));
    await user.click(
      within(dialog).getByRole('button', { name: '确认替换' }),
    );
    await waitFor(() => expect(onApply).toHaveBeenCalledWith(LEGACY_JSON, 'replace'));
  });

  it('超过 10 MiB 的 JSON 在读取前拒绝', () => {
    renderDialog({ defaultTab: 'json' });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    fireEvent.change(within(dialog).getByLabelText('选择画板 JSON 文件'), {
      target: {
        files: [fakeOversizeFile('big.json', BOARD_JSON_MAX_BYTES + 1)],
      },
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      /10 MiB 上限/,
    );
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
  });

  it('把画板包选进开发者入口时提示切回画板包 tab', async () => {
    const report = await buildBoardPackage({
      document: sampleDocument(),
      viewport: VIEWPORT,
      includeThumbnail: false,
    });
    const file = new File([report.bytes.slice().buffer], '测试画板.zxboard', {
      type: 'application/zip',
    });
    renderDialog({ defaultTab: 'json' });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    fireEvent.change(within(dialog).getByLabelText('选择画板 JSON 文件'), {
      target: { files: [file] },
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /切换到「画板包 .zxboard」/,
    );
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
  });
});

describe('画板导入 / 导出弹窗 · 画板包', () => {
  it('包预览显示类型/版本/文件树，新建后交给页面落库', async () => {
    const user = userEvent.setup();
    const report = await buildBoardPackage({
      document: sampleDocument(),
      viewport: VIEWPORT,
      includeThumbnail: false,
    });
    const file = new File([report.bytes.slice().buffer], '测试画板.zxboard', {
      type: 'application/zip',
    });
    const onApplyDocument = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderDialog({ onApplyDocument, onClose });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });

    fireEvent.change(within(dialog).getByLabelText('选择画板包文件'), {
      target: { files: [file] },
    });
    await within(dialog).findByText(/包类型 board-package/);
    expect(within(dialog).getByText(/formatVersion 1/)).toBeInTheDocument();
    expect(within(dialog).getByText(/schemaVersion 2/)).toBeInTheDocument();
    expect(within(dialog).getByText(/3 个对象 · 2 条连线/)).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole('radio', { name: /导入为新画板/ }),
    );
    await user.click(within(dialog).getByRole('button', { name: '应用导入' }));
    await user.click(
      within(dialog).getByRole('button', { name: '确认导入新画板' }),
    );
    await waitFor(() => expect(onApplyDocument).toHaveBeenCalledTimes(1));
    const [document, viewport, mode] = onApplyDocument.mock.calls[0]!;
    expect(document.nodes).toHaveLength(3);
    expect(viewport).toEqual(VIEWPORT);
    expect(mode).toBe('create');
    expect(onClose).toHaveBeenCalled();
  });

  it('非 ZIP 文件给出明确错误，应用禁用且零写入', async () => {
    const onApplyDocument = vi.fn();
    renderDialog({ onApplyDocument });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    const file = new File(['{"version":1}'], 'not-a-package.zxboard', {
      type: 'application/octet-stream',
    });
    fireEvent.change(within(dialog).getByLabelText('选择画板包文件'), {
      target: { files: [file] },
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /不是知行画板包/,
    );
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
    expect(onApplyDocument).not.toHaveBeenCalled();
  });

  it('超过 64 MiB 的画板包在读取前拒绝', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    fireEvent.change(within(dialog).getByLabelText('选择画板包文件'), {
      target: {
        files: [fakeOversizeFile('big.zxboard', BOARD_PACKAGE_MAX_BYTES + 1)],
      },
    });
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      /64 MiB 上限/,
    );
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
  });

  it('取消系统保存面板时留在弹窗并显示行内状态', async () => {
    const user = userEvent.setup();
    const savePackage = vi.fn().mockResolvedValue({ status: 'canceled' });
    const saveJson = vi.fn().mockResolvedValue({ status: 'canceled' });
    renderDialog({ savePackage, saveJson });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    await user.click(
      within(dialog).getByRole('button', { name: '导出画板包…' }),
    );
    expect(
      await within(dialog).findByText('已取消导出画板包，未写入文件。'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '导入 / 导出画板' })).toBeVisible();

    openDeveloperTab(dialog);
    await user.click(
      within(dialog).getByRole('button', { name: '导出 JSON…' }),
    );
    expect(
      await within(dialog).findByText('已取消导出，未写入文件。'),
    ).toBeInTheDocument();
  });
});

describe('画板导入 / 导出弹窗 · 只读', () => {
  it('阅读模式下导入与应用禁用，导出仍可用', () => {
    renderDialog({ readOnly: true });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    expect(
      within(dialog).getByRole('button', { name: '导出画板包…' }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole('button', { name: '导入画板包…' }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
    expect(
      within(dialog).getByText(/阅读模式下不能导入；导出仍可用/),
    ).toBeInTheDocument();

    openDeveloperTab(dialog);
    expect(within(dialog).getByLabelText('画板 JSON')).toHaveAttribute(
      'readonly',
    );
    expect(
      within(dialog).getByRole('button', { name: '从文件导入 .json…' }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole('button', { name: '导出 JSON…' }),
    ).toBeEnabled();
  });

  it('只读时不再提供「替换当前画板」', () => {
    renderDialog({ readOnly: true, defaultTab: 'json' });
    const dialog = screen.getByRole('dialog', { name: '导入 / 导出画板' });
    fireEvent.change(within(dialog).getByLabelText('画板 JSON'), {
      target: { value: MINIMAL_JSON },
    });
    expect(
      within(dialog).queryByRole('radio', { name: /替换当前画板/ }),
    ).not.toBeInTheDocument();
  });
});
