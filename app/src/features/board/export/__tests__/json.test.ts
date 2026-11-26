import { describe, expect, it } from 'vitest';

import { sampleDocument } from '../../__tests__/fakeBoardSource';
import {
  boardJsonFileBlob,
  boardJsonFileText,
  defaultBoardJsonFileName,
} from '../json';
import { parseBoardDocumentFile } from '../../model';

const withNodes = sampleDocument;

describe('画板 JSON 源文件', () => {
  it('文件名使用标题 + 本地时间戳，并清洗系统非法字符', () => {
    const now = new Date(2026, 9, 29, 13, 30);
    expect(defaultBoardJsonFileName('方案/一:测试', now)).toBe(
      '方案 一 测试-20261029-1330.json',
    );
    expect(defaultBoardJsonFileName('   ', now)).toBe(
      '画板-20261029-1330.json',
    );
  });

  it('Blob 内容可被 parseBoardDocumentFile 完整读回（对象/连线/位置/样式/viewport）', async () => {
    const document = withNodes();
    const viewport = { x: 42, y: 24, zoom: 0.8 };
    const now = new Date('2026-10-29T05:30:00.000Z');
    const blob = boardJsonFileBlob(document, { viewport, now });
    expect(blob.type).toContain('application/json');

    const parsed = parseBoardDocumentFile(await blob.text());
    expect(parsed.document.title).toBe(document.title);
    expect(parsed.document.nodes).toEqual(document.nodes);
    expect(parsed.document.edges).toEqual(document.edges);
    expect(parsed.viewport).toEqual(viewport);
    expect(parsed.metadata.exportedAt).toBe(now.toISOString());
  });

  it('文本导出保持 2 空格缩进，便于人工检查/版本控制', () => {
    const text = boardJsonFileText(withNodes(), {
      now: new Date('2026-10-29T05:30:00.000Z'),
    });
    expect(text.split('\n')[1]).toMatch(/^ {2}"version": 1/);
  });
});
