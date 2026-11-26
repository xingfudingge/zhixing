import { describe, expect, it } from 'vitest';

import {
  pastedBlocksFromHtml,
  sanitizePastedHtml,
  sanitizedHtmlToRuns,
} from '../paste';
import type { InlineRun } from '../types';

describe('粘贴白名单清洗', () => {
  it('移除 script/iframe/事件属性/javascript 链接与危险 CSS', () => {
    const html = `
      <p onclick="alert(1)" class="x">
        hello
        <script>alert('xss')</script>
        <iframe src="https://evil.example"></iframe>
        <strong>世界</strong>
        <a href="javascript:alert(1)" onclick="alert(2)">坏链接</a>
        <a href="https://example.com" onclick="alert(3)">好链接</a>
        <span style="color:#c0392b;background:url(javascript:x)" data-x="1">红</span>
      </p>`;
    const sanitized = sanitizePastedHtml(html);
    expect(sanitized).not.toMatch(/script/i);
    expect(sanitized).not.toMatch(/iframe/i);
    expect(sanitized).not.toMatch(/onclick/i);
    expect(sanitized).not.toMatch(/javascript:/i);
    expect(sanitized).not.toMatch(/url\(/i);
    expect(sanitized).not.toContain('class=');
    expect(sanitized).not.toContain('data-x');
    expect(sanitized).toContain('<strong>世界</strong>');
    expect(sanitized).toContain('href="https://example.com"');
    expect(sanitized).toMatch(
      /color:\s*(#c0392b|rgb\(192,\s*57,\s*43\))/,
    );
  });

  it('粘贴 HTML 转成 runs 时保留粗体和安全链接', () => {
    const blocks = pastedBlocksFromHtml(
      '<p>安全<script>alert(1)</script><strong>加粗</strong><a href="https://example.com">好</a><a href="javascript:alert(1)">坏</a></p>',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
    const runs = blocks[0].payload.runs as InlineRun[];
    expect(runs.map((run) => run.text).join('')).toBe('安全加粗好坏');
    expect(runs.some((run) => run.marks?.bold)).toBe(true);
    expect(runs.some((run) => run.marks?.link === 'https://example.com')).toBe(
      true,
    );
    expect(
      runs.some((run) => run.marks?.link?.startsWith('javascript:')),
    ).toBe(false);
  });

  it('标题、列表、表格、代码与分割线保留结构', () => {
    const blocks = pastedBlocksFromHtml(`
      <h2>粘贴标题</h2>
      <ul><li>一</li><li>二<ul><li>嵌套</li></ul></li></ul>
      <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
      <pre><code>const a = 1;</code></pre>
      <hr>
    `);
    expect(blocks.map((block) => block.type)).toEqual([
      'heading2',
      'bullet_list',
      'bullet_list',
      'bullet_list',
      'table',
      'code',
      'divider',
    ]);
    expect(blocks[1].payload.indent).toBe(0);
    expect(blocks[3].payload.indent).toBe(1);
    expect(blocks[4].payload.rows).toEqual([
      ['A', 'B'],
      ['1', '2'],
    ]);
    expect(blocks[5].payload.code).toBe('const a = 1;');
  });

  it('图片不会带 src/onerror 进入 DOM，只保留 alt 文本', () => {
    const sanitized = sanitizePastedHtml(
      '<p>图<img src="https://evil.example/x.png" onerror="alert(1)" alt="截图"></p>',
    );
    expect(sanitized).not.toContain('<img');
    expect(sanitized).not.toContain('onerror');
    expect(sanitized).toContain('[图片：截图]');
    const runs = sanitizedHtmlToRuns(sanitized);
    expect(runs.map((run) => run.text).join('')).toContain('[图片：截图]');
  });

  it('未知标签去标签留文字', () => {
    const sanitized = sanitizePastedHtml('<custom>保留文字</custom>');
    expect(sanitized).toBe('保留文字');
  });
});
