import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BoardRail, type BoardRailProps } from '../components/BoardRail';
import type { BoardRouting, BoardTool } from '../types';

/** 视觉规范 §2.6 禁止的原始字形（仅检查可见文本，快捷键提示不算）。 */
const BANNED_GLYPHS =
  /[⌖✋▭▢○◇▤▥▦↗✦╱⌐⌒↶↷⇤↔⇥⇧↕⇩⌫◐✎⌸◌◉≡▧⛶⇄☰ⓘ⌁‹›⠿＋]/u;

function setup(overrides: Partial<BoardRailProps> = {}) {
  const props: BoardRailProps = {
    tool: 'select' as BoardTool,
    onToolChange: vi.fn(),
    onInsert: vi.fn(),
    onMoreShapes: vi.fn(),
    onStarter: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    canUndo: true,
    canRedo: false,
    selectionCount: 0,
    edgeSelectionCount: 0,
    edgeRouting: null as BoardRouting | null,
    onEdgeRouting: vi.fn(),
    onAlign: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  const view = render(<BoardRail {...props} />);
  const rail = screen.getByRole('navigation', { name: '画板工具' });
  return { ...props, ...view, rail };
}

describe('画板工具轨 · 图标与说明（ZX-ICON-01）', () => {
  it('按「选择/形状/连线/编辑/对齐」分组，组标题常显', () => {
    const { rail } = setup();
    const titles = Array.from(rail.querySelectorAll('.bw-rail-title')).map(
      (node) => node.textContent,
    );
    expect(titles).toEqual(['选择', '形状', '连线', '编辑', '对齐']);
    expect(
      Array.from(rail.querySelectorAll('[role="group"]')).map((group) =>
        group.getAttribute('aria-label'),
      ),
    ).toEqual(expect.arrayContaining(['选择', '形状', '连线', '编辑', '对齐']));
  });

  it('每个按钮都有 SVG 图标、aria-label 与 title，且不出现原始字形', () => {
    const { rail } = setup();
    const buttons = Array.from(rail.querySelectorAll('button'));
    expect(buttons.length).toBeGreaterThan(0);

    for (const button of buttons) {
      expect(button.getAttribute('aria-label')?.trim()).toBeTruthy();
      expect(button.getAttribute('title')?.trim()).toBeTruthy();

      const svg = button.querySelector('svg');
      expect(svg, `${button.getAttribute('aria-label')} 缺少 SVG`).not.toBeNull();
      expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
      expect(svg).toHaveAttribute('fill', 'none');
      expect(svg).toHaveAttribute('stroke', 'currentColor');
      expect(svg).toHaveAttribute('stroke-width', '1.5');
      expect(svg).toHaveAttribute('stroke-linecap', 'round');
      expect(svg).toHaveAttribute('width', '18');
      expect(svg).toHaveAttribute('height', '18');
      // 图标本身装饰性，避免和按钮的 aria-label 重复朗读。
      expect(svg).toHaveAttribute('aria-hidden', 'true');
      expect(svg?.getAttribute('data-icon')).toMatch(
        /^(board|note|common)-/,
      );
    }

    expect(rail.textContent ?? '').not.toMatch(BANNED_GLYPHS);
  });

  it('高频动作有常显短标签，低频动作保留 aria-label/title', () => {
    const { rail } = setup();
    const captions = Array.from(rail.querySelectorAll('.bw-tool-caption')).map(
      (node) => node.textContent,
    );
    expect(captions).toEqual([
      '选择',
      '抓手',
      '矩形',
      '圆角',
      '椭圆',
      '文本',
      '便签',
      '容器',
      '更多',
      '连线',
      '起步',
      '撤销',
      '重做',
      '删除',
    ]);

    // 对象语义已中性化：工具轨不再有判定/流程步骤/开始结束。
    for (const legacy of ['插入判定', '插入流程步骤', '插入开始/结束']) {
      expect(screen.queryByRole('button', { name: legacy })).toBeNull();
    }
    expect(screen.getByRole('button', { name: '插入容器' })).toBeInTheDocument();

    // 线型与对齐用分组标题承载说明，单个按钮仍保留完整名称。
    expect(screen.getByRole('button', { name: '线型折线' })).toHaveAttribute(
      'title',
      '折线（选中连线可用）',
    );
    expect(screen.getByRole('button', { name: '左对齐' })).toHaveAttribute(
      'title',
      '左对齐',
    );
  });

  it('选中态、禁用态与危险态可被辅助技术感知', () => {
    const first = setup({ tool: 'connect' });
    expect(first.rail.querySelector('.bw-tool.is-active')).toHaveAttribute(
      'aria-label',
      '连线',
    );
    expect(screen.getByRole('button', { name: '连线' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    first.unmount();

    setup({ selectionCount: 0, edgeSelectionCount: 0 });
    expect(screen.getByRole('button', { name: '左对齐' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除选中' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '线型折线' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重做' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '撤销' })).toBeEnabled();
    expect(
      screen.getByRole('button', { name: '删除选中' }),
    ).toHaveClass('is-danger');
  });

  it('多选时可对齐，选中连线时线型按钮可用并回显当前线型', () => {
    setup({ selectionCount: 3, edgeSelectionCount: 1, edgeRouting: 'elbow' });
    expect(screen.getByRole('button', { name: '左对齐' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '水平居中' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '底对齐' })).toBeEnabled();

    const elbow = screen.getByRole('button', { name: '线型折线' });
    expect(elbow).toBeEnabled();
    expect(elbow).toHaveAttribute('aria-pressed', 'true');
  });
});
