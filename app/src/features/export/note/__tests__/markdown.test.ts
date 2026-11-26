import { describe, expect, it } from 'vitest';

import { noteFixture, blocksFixture, docxOptions, fixtureDocument, resolveAsset } from './fixtures';
import { buildNoteExportDocument } from '../document';
import { renderNoteMarkdown } from '../markdown';

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('单篇笔记 Markdown 导出', () => {
  it('标题、元信息、目录与全部块映射都在', async () => {
    const doc = await fixtureDocument({
      ...docxOptions(),
      format: 'md',
    });
    const result = renderNoteMarkdown(doc);
    const text = decode(result.bytes);

    expect(text.startsWith('# 导出结构\n')).toBe(true);
    expect(text).toContain('> 创建：2026-10-20 08:00 · 更新：2026-10-28 09:12');
    expect(text).toContain('目录：产品设计');
    expect(text).toContain('标签：#知识管理、#导出');
    expect(text).toMatch(/约 \d+ 字/);
    expect(text).toContain('## 目录');
    expect(text).toContain('- 概述');
    expect(text).toContain('# 概述');
    expect(text).toContain('**重点**');
    expect(text).toContain('[外链](https://example.com/doc)');
    expect(text).toContain('[关联笔记](zhixing://note/note-b)');
    expect(text).toContain('- [x] 完成导出');
    expect(text).toContain('- 无序项');
    expect(text).toContain('1. 第一步');
    expect(text).toContain('2. 第二步');
    expect(text).toContain('> 引用一段原则');
    expect(text).toContain('> — 设计规范 · 关联笔记《目标笔记》 · https://example.com/spec');
    expect(text).toContain('```typescript');
    expect(text).toContain('const save = await saveFile({ name });');
    expect(text).toContain('| 模块 | 模块 |');
    expect(text).toContain('| 附件 | 打开 / 另存为 |');
    expect(text).toContain('| 附件 | 哈希校验 |');
    expect(text).toContain('![架构图](data:image/png;base64,');
    expect(text).toContain('📎 需求说明.pdf（1.2 MB） · 文件缺失');
    expect(text).toContain('🖼 画板：发布流程（在知心中打开）');
    expect(text).toContain('$$\nE = mc^2\n$$');
    expect(text).toContain('[示例站点](https://example.com/)');
    expect(text).toContain('\n---\n');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('﻿');

    const warningText = result.warnings.join('\n');
    expect(warningText).toContain('Markdown 不支持文字颜色/底色，1 处颜色未保留');
    expect(warningText).toContain('Markdown 不支持表格列宽');
    expect(warningText).toContain('站内内链在导出文件外不可跳转');
    expect(warningText).toContain('画板「发布流程」以文字占位导出');
  });

  it('关闭元信息后三种格式都不输出创建/更新/目录/标签', async () => {
    const doc = await fixtureDocument({
      ...docxOptions(),
      format: 'md',
      includeMetadata: false,
    });
    const text = decode(renderNoteMarkdown(doc).bytes);
    expect(text).not.toContain('创建：');
    expect(text).not.toContain('标签：');
    expect(text).not.toContain('目录：');
    expect(text.startsWith('# 导出结构\n')).toBe(true);
  });

  it('空笔记输出标题与空态；回收站标记只读快照', async () => {
    const doc = await buildNoteExportDocument({
      note: noteFixture({
        title: '空笔记',
        body: '',
        status: 'trashed',
        deletedAt: '2026-10-28T00:00:00.000Z',
      }),
      blocks: [],
      options: { ...docxOptions(), format: 'md' },
      folderName: '未分类',
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const text = decode(renderNoteMarkdown(doc).bytes);
    expect(text).toContain('# 空笔记');
    expect(text).toContain('（空笔记）');
    expect(text).toContain('状态：回收站 · 只读快照');
  });

  it('图片超过 2 MB 时转占位符并报告，不静默丢图', async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    const doc = await buildNoteExportDocument({
      note: noteFixture(),
      blocks: blocksFixture().filter((block) => block.type === 'image'),
      options: { ...docxOptions(), format: 'md' },
      folderName: '产品设计',
      resolveAttachment: async (_id, fallback) => ({
        blob: new Blob([big.slice().buffer], { type: 'image/png' }),
        bytes: big,
        sha256: 'b'.repeat(64),
        status: 'available',
        error: null,
        fileName: fallback.fileName,
        mime: 'image/png',
        byteSize: big.byteLength,
      }),
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    const result = renderNoteMarkdown(doc);
    const text = decode(result.bytes);
    expect(text).toContain('![架构图](图片未内嵌：超过大小上限)');
    expect(result.warnings.join('\n')).toContain('超过 2 MB');
  });

  it('缺失图片输出占位说明，附件缺失不阻断导出', async () => {
    const doc = await buildNoteExportDocument({
      note: noteFixture(),
      blocks: blocksFixture().filter((block) =>
        ['image', 'file'].includes(block.type),
      ),
      options: { ...docxOptions(), format: 'md' },
      folderName: '产品设计',
      resolveAttachment: resolveAsset,
      now: new Date('2026-10-28T09:12:00+08:00'),
    });
    // resolveAsset 对 att-file 返回 missing；图片本身可用。
    const text = decode(renderNoteMarkdown(doc).bytes);
    expect(text).toContain('📎 需求说明.pdf（1.2 MB） · 文件缺失');
    expect(doc.warnings.join('\n')).toContain('文件「需求说明.pdf」缺失，仅导出文件信息');
  });
});
