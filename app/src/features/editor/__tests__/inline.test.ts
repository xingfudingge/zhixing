import { afterEach, describe, expect, it } from 'vitest';

import {
  clearMarksInRange,
  inlineRunsFromHtml,
  inlineRunsFromNode,
  insertRunsAt,
  rangeHasMark,
  replaceRangeWithRuns,
  restoreSelectionByOffsets,
  runsToHtml,
  runsToPlainText,
  selectionOffsetsIn,
  sliceRuns,
  splitRunsAt,
  toggleMarksInRange,
} from '../inline';
import type { InlineRun } from '../types';

const root = document.createElement('div');

afterEach(() => {
  root.remove();
  root.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

function select(rootNode: HTMLElement, start: number, end: number) {
  const text = rootNode.firstChild;
  if (!text) {
    throw new Error('缺少文本节点');
  }
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, end);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('行内 runs', () => {
  it('HTML 转义并序列化粗体/颜色/链接，拒绝 javascript 链接', () => {
    const html = runsToHtml([
      {
        text: '<script>alert(1)</script>',
        marks: {
          bold: true,
          color: '#c0392b',
          background: '#fff1a8',
          link: 'javascript:alert(1)',
        },
      },
      { text: '安全', marks: { link: 'https://example.com' } },
    ]);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<strong>');
    expect(html).toContain('color:#c0392b');
    expect(html).toContain('background-color:#fff1a8');
    expect(html).toContain('href="https://example.com"');
  });

  it('从 DOM 读取 marks 并合并相邻 runs', () => {
    const node = document.createElement('div');
    node.innerHTML =
      '<strong>知行</strong><em>编辑</em><span style="color:#2f7e63">器</span><s>旧</s><code>code</code>';
    const runs = inlineRunsFromNode(node);
    expect(runsToPlainText(runs)).toBe('知行编辑器旧code');
    expect(runs.map((run) => run.text)).toEqual(['知行', '编辑', '器', '旧', 'code']);
    expect(runs[0].marks?.bold).toBe(true);
    expect(runs[1].marks?.italic).toBe(true);
    expect(runs[2].marks?.color).toBe('#2f7e63');
    expect(runs[3].marks?.strike).toBe(true);
    expect(runs[4].marks?.code).toBe(true);
  });

  it('空块里的 <br> 不会变成持久化换行', () => {
    const node = document.createElement('div');
    node.innerHTML = '<br>';
    expect(inlineRunsFromNode(node)).toEqual([]);
  });

  it('inlineRunsFromHtml 保留安全链接并丢弃脚本链接', () => {
    const runs = inlineRunsFromHtml(
      '<a href="https://example.com">好</a><a href="javascript:alert(1)">坏</a>',
    );
    expect(runs[0].marks?.link).toBe('https://example.com');
    expect(runs[1].marks?.link).toBeUndefined();
  });
});

describe('行内格式区间', () => {
  const runs: InlineRun[] = [{ text: '知行编辑器' }];

  it('B 第一次加粗、第二次取消，并支持范围切片', () => {
    const bold = toggleMarksInRange(runs, 0, 2, { bold: true });
    expect(runsToHtml(bold)).toBe('<strong>知行</strong>编辑器');
    expect(rangeHasMark(bold, 0, 2, 'bold')).toBe(true);
    expect(rangeHasMark(bold, 1, 4, 'bold')).toBe(false);
    const plain = toggleMarksInRange(bold, 0, 2, { bold: true });
    expect(runsToHtml(plain)).toBe('知行编辑器');
    expect(sliceRuns(bold, 1, 4)).toEqual([
      { text: '行', marks: { bold: true } },
      { text: '编辑' },
    ]);
  });

  it('文字色/底色设置与清除', () => {
    const colored = toggleMarksInRange(runs, 1, 3, {
      color: '#c0392b',
      background: '#fff1a8',
    });
    expect(runsToHtml(colored)).toContain('color:#c0392b');
    expect(runsToHtml(colored)).toContain('background-color:#fff1a8');
    const cleared = clearMarksInRange(colored, 0, 7);
    expect(runsToHtml(cleared)).toBe('知行编辑器');
  });

  it('拆分与插入 runs 保持 marks', () => {
    const bold = toggleMarksInRange(runs, 0, 2, { bold: true });
    const [before, after] = splitRunsAt(bold, 3);
    expect(runsToPlainText(before)).toBe('知行编');
    expect(runsToPlainText(after)).toBe('辑器');
    const inserted = insertRunsAt(bold, 3, [
      { text: 'X', marks: { italic: true } },
    ]);
    expect(runsToHtml(inserted)).toContain('<em>X</em>');
    const replaced = replaceRangeWithRuns(bold, 0, 2, [{ text: '替换' }]);
    expect(runsToPlainText(replaced)).toBe('替换编辑器');
  });
});

describe('选区偏移', () => {
  it('DOM 选区与 runs 文本偏移可双向恢复', () => {
    root.textContent = '知行笔记编辑器';
    document.body.appendChild(root);

    select(root, 2, 4);
    expect(selectionOffsetsIn(root)).toEqual({ start: 2, end: 4 });

    restoreSelectionByOffsets(root, 1, 5);
    expect(selectionOffsetsIn(root)).toEqual({ start: 1, end: 5 });
  });
});
