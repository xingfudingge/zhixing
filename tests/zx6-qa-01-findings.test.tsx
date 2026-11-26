/**
 * ZX6-QA-01 独立验收 · 已知不符合设计/用户验收标准的行为
 *
 * 这里的用例按卡面、PRD、原型与 ZX6-DESIGN-01/02 的**预期**写断言，
 * 当前产品代码会让它们失败。失败即证据；不要把它们改成“现状断言”。
 *
 * 对应报告：outputs/验收报告-ZX6-2026-10-30.md
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  fireEvent,
  render,
  screen,
  waitFor,
} from '../app/node_modules/@testing-library/react/dist/index.js';
import userEvent from '../app/node_modules/@testing-library/user-event/dist/esm/index.js';
import { useState } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createMemoryDownloader } from '../app/src/features/export/download';
import { DataBackupPanel } from '../app/src/features/export/DataBackupPanel';
import {
  makeDataset,
  makeMemorySource,
  makePayload,
} from '../app/src/features/export/__tests__/testFixtures';
import { createMemoryRestoreTarget } from '../app/src/features/import/__tests__/memoryTarget';
import { BoardWorkspace } from '../app/src/features/board/BoardWorkspace';
import { createEmptyDocument } from '../app/src/features/board/model';
import { BoardExportDialog } from '../app/src/features/board/components/BoardExportDialog';
import { planBoardExport } from '../app/src/features/board/export/image';
import {
  createFakeBoardSource,
  sampleDocument,
} from '../app/src/features/board/__tests__/fakeBoardSource';
import { CountdownDialog } from '../app/src/features/countdowns/CountdownDialog';
import { NoteBlockEditor } from '../app/src/features/editor/NoteBlockEditor';
import { TableBlock } from '../app/src/features/editor/blocks/TableBlock';
import {
  restoreSelectionByOffsets,
} from '../app/src/features/editor/inline';
import {
  FAKE_NOTE_ID,
  createFakeBlockSource,
  makeBlock,
} from '../app/src/features/editor/__tests__/fakeBlockSource';
import { DatePicker } from '../app/src/ui/date/DatePicker';

const ROOT = path.resolve(__dirname, '..');

beforeAll(() => {
  // jsdom 没有 Canvas；画板工作区测试只验证 DOM/入口，不验证绘制。
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterAll(() => {
  vi.restoreAllMocks();
});

type User = ReturnType<typeof userEvent.setup>;

function DateHarness({
  initial = '2026-11-03',
  min,
  max,
  onChange,
}: {
  initial?: string | null;
  min?: string;
  max?: string;
  onChange?: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label htmlFor="qa-date">日期</label>
      <DatePicker
        id="qa-date"
        value={value}
        today="2026-10-30"
        min={min}
        max={max}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
      <output data-testid="committed">{value ?? 'null'}</output>
    </>
  );
}

function TableQaHarness({ rows }: { rows: string[][] }) {
  const [current, setCurrent] = useState(rows);
  return (
    <TableBlock
      block={makeBlock({
        id: 'table-qa',
        type: 'table',
        payload: { rows: current } as unknown as never,
      })}
      readOnly={false}
      onChange={(next) => setCurrent(next as unknown as string[][])}
    />
  );
}

function dateInput() {
  return screen.getByLabelText('日期') as HTMLInputElement;
}

async function openDatePanel(user: User) {
  await user.click(screen.getByRole('button', { name: /打开日期选择/ }));
  return screen.findByRole('dialog', { name: '选择日期' });
}

describe('缺陷 1 · 输入 → 面板没有实时联动（ZX6-DESIGN-01 §9.4/§9.6-1）', () => {
  it('面板打开时输入 2026/12/25，未按 Enter 面板就应移动到 2026 年 12 月', async () => {
    const user = userEvent.setup();
    render(<DateHarness />);
    const panel = await openDatePanel(user);

    const input = dateInput();
    await user.click(input);
    await user.clear(input);
    await user.type(input, '2026/12/25');

    // 设计：输入合法日期时 preview/focused/viewMonth 立即跟随，不提交。
    expect(panel.getAttribute('data-view-month')).toBe('2026-12');
    expect(
      panel.querySelector('.dp-day.is-selected')?.getAttribute('data-date'),
    ).toBe('2026-12-25');
    expect(screen.getByTestId('committed')).toHaveTextContent('2026-11-03');
  });
});

describe('缺陷 2 · 面板 → 输入没有实时联动（ZX6-DESIGN-01 §9.4/§9.6-2）', () => {
  it('点 2026-12-25 后输入框应立即显示该日期；只确定才提交', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateHarness onChange={onChange} />);
    const panel = await openDatePanel(user);

    // 面板从 2026-11 打开，42 格里没有 2026-12-25；先翻到 12 月再点，
    // 断言本身不变：点日格 → 输入框实时回写，提交仍要「确定」。
    await user.click(screen.getByRole('button', { name: '下个月' }));
    expect(panel.getAttribute('data-view-month')).toBe('2026-12');

    await user.click(
      panel.querySelector<HTMLElement>('[data-date="2026-12-25"]')!,
    );

    // 设计：点日期格 preview/input 实时回写，committed 不变，页脚显示“待确定”。
    expect(dateInput()).toHaveValue('2026-12-25');
    expect(screen.getByTestId('committed')).toHaveTextContent('2026-11-03');
    expect(onChange).not.toHaveBeenCalled();
    expect(panel.textContent).toMatch(/待确定/);
  });
});

describe('缺陷 3 · min 越界的“今天”没有禁用（ZX6-DESIGN-01 §9.6-5）', () => {
  it('min=2026-10-31、today=2026-10-30：今天禁用，明天可用', async () => {
    const user = userEvent.setup();
    render(
      <DateHarness min="2026-10-31" max="2026-12-31" />,
    );
    const panel = await openDatePanel(user);

    expect(
      screen.getByRole('button', { name: '今天' }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: '明天' }),
    ).toBeEnabled();
  });
});

describe('缺陷 3b · 无选区时对齐按钮未禁用（ZX6-DESIGN-01 §5.5-4）', () => {
  it('只有鼠标悬停、没有单元格选区时，“左对齐”应禁用', () => {
    const { container } = render(<TableQaHarness rows={[['A', 'B']]} />);
    const wrap = container.querySelector<HTMLElement>('.zxe-table-wrap')!;
    fireEvent.mouseEnter(wrap);
    const alignLeft = screen.getByRole('button', { name: '左对齐' });
    expect(alignLeft).toBeDisabled();
  });
});

describe('缺陷 4 · 倒数日弹窗农历信息重复（ZX6-DESIGN-01 §9.6-9）', () => {
  it('切到农历后，农历提示只应出现一条', async () => {
    const user = userEvent.setup();
    render(
      <CountdownDialog
        open
        initialDate="2026-10-28"
        onClose={vi.fn()}
        onSubmit={async () => undefined}
      />,
    );

    await user.selectOptions(screen.getByLabelText('历法'), 'lunar');
    const fieldHelper = document.querySelectorAll('.date-field-help');
    const preview = document.querySelector(
      '[data-testid="countdown-lunar-preview"]',
    );
    expect(fieldHelper.length + (preview ? 1 : 0)).toBe(1);
  });
});

describe('缺陷 5 · 原子块前的 Backspace 删除而非选中（ZX6-DESIGN-01 §8.3/§8.6-2）', () => {
  it('公式后非空段落按 Backspace：块数不变，公式被选中并提示“原子块”', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'f1',
        type: 'formula',
        payload: { latex: 'x^2', display: 'block', renderer: 'none' },
        orderKey: 1024,
      }),
      makeBlock({
        id: 'p2',
        type: 'paragraph',
        payload: { runs: [{ text: '正文' }] },
        orderKey: 2048,
      }),
    ]);
    const { container } = render(
      <NoteBlockEditor
        noteId={FAKE_NOTE_ID}
        source={source}
        saveDelayMs={0}
      />,
    );
    await screen.findByLabelText('笔记正文');

    const p2 = container
      .querySelector<HTMLElement>('[data-block-id="p2"]')
      ?.querySelector<HTMLElement>('[data-inline-editor="true"]');
    expect(p2).not.toBeNull();
    p2!.focus();
    restoreSelectionByOffsets(p2!, 0, 0);
    fireEvent.keyDown(p2!, { key: 'Backspace' });

    // 设计/原型：不删除公式，选中它并提示；当前实现会删除公式。
    await waitFor(() => {
      expect(
        container.querySelector('[data-block-id="f1"]'),
      ).not.toBeNull();
    });
    expect(
      container.querySelectorAll('[data-block-id]'),
    ).toHaveLength(2);
    expect(screen.getByText(/原子块/)).toBeInTheDocument();
  });
});

describe('缺陷 6 · 代码属性头仍常驻（ZX6-DESIGN-01 §7.4/§7.6-1）', () => {
  it('默认打开笔记时 .zxe-code-head 不应出现在 DOM（或应 visibility:hidden）', async () => {
    const source = createFakeBlockSource([
      makeBlock({
        id: 'code1',
        type: 'code',
        payload: { code: 'const a = 1;', language: 'ts' },
        orderKey: 1024,
      }),
    ]);
    const { container } = render(
      <NoteBlockEditor
        noteId={FAKE_NOTE_ID}
        source={source}
        saveDelayMs={0}
      />,
    );
    await screen.findByLabelText('笔记正文');
    expect(container.querySelector('.zxe-code-head')).toBeNull();
  });
});

describe('缺陷 7 · 画板仍暴露一级 JSON 入口（ZX6-DESIGN-02 §3.1/§8.1）', () => {
  function renderWorkspace(initial = sampleDocument()) {
    const fake = createFakeBoardSource(initial);
    render(
      <BoardWorkspace
        boardId={initial.boardId}
        noteId={initial.noteId}
        source={fake.source}
        saveDelayMs={0}
      />,
    );
    return fake;
  }

  it('工具栏不存在独立「JSON」按钮；空画板不出现「恢复 JSON」', async () => {
    renderWorkspace();
    await screen.findByDisplayValue('测试画板');
    expect(screen.queryByRole('button', { name: 'JSON' })).toBeNull();
    expect(screen.queryByRole('button', { name: '恢复 JSON' })).toBeNull();
  });

  it('空画板入口文案应为「导入画板包…」', async () => {
    const empty = createEmptyDocument({
      boardId: 'board-empty-qa',
      noteId: 'note-1',
      title: '空白画板',
    });
    renderWorkspace(empty);
    await screen.findByText('空白画板');
    expect(
      screen.queryByRole('button', { name: '恢复 JSON' }),
    ).toBeNull();
    expect(
      screen.getByRole('button', { name: /导入画板包/ }),
    ).toBeInTheDocument();
  });
});

describe('缺陷 8 · 设置“数据与备份”仍把可回导与单向导出混在一起（ZX6-DESIGN-02 §9.1）', () => {
  it('应有“备份与恢复 / 单向导出”分组，且不出现裸「JSON」按钮', async () => {
    const downloads = createMemoryDownloader();
    render(
      <DataBackupPanel
        source={makeMemorySource(makePayload())}
        target={createMemoryRestoreTarget(makeDataset())}
        downloader={downloads.downloader}
      />,
    );

    expect.soft(screen.queryByText('备份与恢复')).not.toBeNull();
    expect.soft(screen.queryByText('单向导出')).not.toBeNull();
    expect.soft(screen.queryByRole('button', { name: 'JSON' })).toBeNull();
  });
});

describe('缺陷 9 · PNG 导出忙碌时取消/关闭仍可点（ZX6-DESIGN-02 §8.7/§5.4）', () => {
  it('保存进行中：取消与关闭 X 都应禁用', async () => {
    const user = userEvent.setup();
    const document = sampleDocument();
    const never = new Promise<never>(() => undefined);
    const savePng = vi.fn(() => never);
    const renderPng = vi.fn(async () => ({
      blob: new Blob([new Uint8Array([137, 80, 78, 71])], {
        type: 'image/png',
      }),
      plan: planBoardExport(document),
    }));
    render(
      <BoardExportDialog
        open
        document={document}
        noteId="note-1"
        onClose={vi.fn()}
        renderPng={renderPng}
        savePng={savePng}
        now={() => new Date(2026, 9, 30, 10, 0)}
      />,
    );

    await user.click(screen.getByRole('button', { name: '保存 PNG' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '正在导出…' })).toBeDisabled();
    });

    expect.soft(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    expect.soft(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
  });
});

describe('缺陷 10 · 知识页导出/导入弹窗未迁移共享 Modal（ZX6-DESIGN-02 §5.1/§5.2/§5.5）', () => {
  it('KnowledgePage/NoteImportDialog 仍使用 .kn-modal-backdrop 与滚动区 footer', () => {
    const knowledgePage = fs.readFileSync(
      path.join(ROOT, 'app/src/features/knowledge/KnowledgePage.tsx'),
      'utf8',
    );
    const importDialog = fs.readFileSync(
      path.join(ROOT, 'app/src/features/import/NoteImportDialog.tsx'),
      'utf8',
    );
    const knowledgeCss = fs.readFileSync(
      path.join(ROOT, 'app/src/features/knowledge/knowledge.css'),
      'utf8',
    );

    // 设计 ZX6-DIALOG-01：所有模态必须走 app/src/app/a11y/Modal。
    expect.soft(knowledgePage).not.toContain('kn-modal-backdrop');
    expect.soft(importDialog).not.toContain('kn-modal-backdrop');
    // .kn-modal { overflow:auto } 会把 footer 一起滚走；z-index 300 < 弹窗 1200。
    expect.soft(knowledgeCss).not.toMatch(/\.kn-modal\s*\{[^}]*overflow:\s*auto/s);
  });
});
