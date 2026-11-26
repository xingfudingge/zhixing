import { describe, expect, it } from 'vitest';

import type { Note } from '../../../data/db/types';
import { createNoteExport } from '../../export/note';
import { blockTableModel } from '../../editor/types';
import { runsToPlainText } from '../../editor/inline';
import {
  createNoteImportBundle,
  decodeNoteImportBytes,
  noteImportBundleToEditorBlocks,
  noteImportFormatOf,
  parseNoteImportFile,
  NoteImportError,
  NOTE_IMPORT_MAX_FILE_BYTES,
} from '../noteImport';

function markdown(bytes: Uint8Array | string) {
  return parseNoteImportFile({
    fileName: '项目.md',
    bytes:
      typeof bytes === 'string'
        ? new TextEncoder().encode(bytes)
        : bytes,
  });
}

function blockText(block: { payload: Record<string, unknown> }): string {
  return runsToPlainText(
    Array.isArray(block.payload.runs)
      ? (block.payload.runs as never)
      : [],
  );
}

function errorCode(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof NoteImportError ? error.code : null;
  }
}

describe('笔记导入 · Markdown 解析', () => {
  const sample = `# 项目 A

第一段
第二行

## 背景

- 一级
  - 二级
- [x] 完成
1. 第一步
2) 第二步

> 引用第一行
> 引用第二行

\`\`\`ts
const a = 1;
\`\`\`

| 名称 | 状态 |
| :--- | ---: |
| 甲 | 完成 |

---

![架构图](https://example.com/a.png)
[坏链](javascript:alert(1))
`;

  it('标题取一级标题，正文映射为结构化块且不含 HTML 字符串', () => {
    const parsed = markdown(sample);
    expect(parsed.title).toBe('项目 A');
    expect(parsed.format).toBe('markdown');
    expect(parsed.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'heading2',
      'bullet_list',
      'bullet_list',
      'todo',
      'ordered_list',
      'ordered_list',
      'quote',
      'code',
      'table',
      'divider',
      'paragraph',
    ]);
    expect(parsed.todos).toHaveLength(1);
    expect(parsed.todos[0]).toMatchObject({ title: '完成', done: true });
    expect(parsed.blocks[0].payload.runs).toEqual([
      { text: '第一段\n第二行' },
    ]);
    expect(parsed.blocks[2].payload.indent).toBe(0);
    expect(parsed.blocks[3].payload.indent).toBe(1);
    expect(parsed.blocks[8].payload).toMatchObject({
      code: 'const a = 1;',
      language: 'typescript',
    });
    expect(parsed.blocks[7].payload.runs).toEqual([
      { text: '引用第一行\n引用第二行' },
    ]);
    expect(JSON.stringify(parsed.blocks)).not.toContain('"html"');
    expect(parsed.warnings.join('\n')).toContain('图片未导入');
    expect(parsed.warnings.join('\n')).toContain('链接协议不安全');
  });

  it('GFM 表格保留表头与列对齐，并在超过上限时警告', () => {
    const parsed = markdown(sample);
    const table = parsed.blocks.find((block) => block.type === 'table');
    expect(table).toBeTruthy();
    const model = blockTableModel(table!);
    expect(model.model.header).toBe(true);
    expect(model.model.rows[0][0].text).toBe('名称');
    expect(model.model.rows[0][0].align).toBe('left');
    expect(model.model.rows[0][1].align).toBe('right');
    expect(model.model.rows[1][0].text).toBe('甲');

    const wide = [
      '| a | b |',
      '| --- | --- |',
      ...Array.from({ length: 41 }, (_, index) => `| ${index} | x |`),
    ].join('\n');
    const capped = markdown(`# 大表\n\n${wide}`);
    expect(capped.warnings.join('\n')).toContain('表格超过 40 行');
  });

  it('未闭合代码围栏按文件末尾处理并警告', () => {
    const parsed = markdown('# 标题\n\n```js\nconst a = 1;\n');
    expect(parsed.blocks.find((block) => block.type === 'code')?.payload).toMatchObject({
      code: 'const a = 1;',
      language: 'javascript',
    });
    expect(parsed.warnings.join('\n')).toContain('未闭合的代码围栏');
  });

  it('一级标题是唯一内容时保留为正文块，避免空笔记', () => {
    const parsed = markdown('# 只有标题\n');
    expect(parsed.title).toBe('项目');
    expect(parsed.blocks.map((block) => block.type)).toEqual(['heading1']);
    expect(blockText(parsed.blocks[0])).toBe('只有标题');
  });
});

describe('笔记导入 · HTML 清洗与块映射', () => {
  const html = `<!doctype html>
<html>
  <head>
    <title>安全标题</title>
    <style>body { color: red }</style>
    <script>window.__pwned = true</script>
  </head>
  <body>
    <h1>安全标题</h1>
    <p onclick="alert(1)">段落 <strong>加粗</strong>
      <a href="javascript:alert(1)">坏链</a>
      <a href="https://ok.example/doc">好链</a>
    </p>
    <img src="https://evil.example/x.png" onerror="alert(1)">
    <iframe src="https://evil.example"></iframe>
    <h6>六级标题</h6>
    <ul><li>甲</li><li>乙<ul><li>乙一</li></ul></li></ul>
    <pre><code class="language-js">const x = 1;</code></pre>
    <table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
  </body>
</html>`;

  it('不是把 HTML 字符串塞进正文，脚本/事件/外部资源都不执行也不保留', () => {
    const parsed = parseNoteImportFile({
      fileName: '页面.html',
      bytes: new TextEncoder().encode(html),
    });
    expect(parsed.title).toBe('安全标题');
    expect(parsed.blocks[0].type).toBe('paragraph');
    const plain = parsed.blocks
      .map((block) => String(block.payload.runs ? JSON.stringify(block.payload.runs) : ''))
      .join('\n');
    expect(plain).toContain('段落');
    expect(plain).toContain('加粗');
    expect(plain).toContain('好链');
    expect(plain).toContain('[图片]');
    expect(plain).not.toContain('javascript:');
    expect(JSON.stringify(parsed.blocks)).not.toContain('onclick');
    expect(JSON.stringify(parsed.blocks)).not.toContain('window.__pwned');
    expect(JSON.stringify(parsed.blocks)).not.toContain('evil.example');
    expect(JSON.stringify(parsed.blocks)).not.toContain('<p');
    expect(parsed.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
      'heading5',
      'bullet_list',
      'bullet_list',
      'bullet_list',
      'code',
      'table',
    ]);
    expect(parsed.blocks[3].payload.indent).toBe(0);
    expect(parsed.blocks[4].payload.indent).toBe(0);
    expect(parsed.blocks[5].payload.indent).toBe(1);
    expect(parsed.blocks[6].payload).toMatchObject({
      code: 'const x = 1;',
      language: 'javascript',
    });
    const table = parsed.blocks[7];
    expect(blockTableModel(table).model.header).toBe(true);
    expect(blockTableModel(table).model.rows[1][0].text).toBe('1');
  });

  it('只有脚本/样式的 HTML 返回 IMPORT_NO_CONTENT', () => {
    expect(
      errorCode(() =>
        parseNoteImportFile({
          fileName: '空白.html',
          bytes: new TextEncoder().encode(
            '<html><head><script>alert(1)</script><style>x{}</style></head><body></body></html>',
          ),
        }),
      ),
    ).toBe('IMPORT_NO_CONTENT');
  });

  it('损坏/非 HTML 文本不会被当成可执行 HTML', () => {
    const parsed = parseNoteImportFile({
      fileName: '片段.htm',
      bytes: new TextEncoder().encode('<p>未闭合 <b>加粗'),
    });
    expect(parsed.blocks[0].type).toBe('paragraph');
    expect(JSON.stringify(parsed.blocks)).not.toContain('未闭合 <b>');
  });
});

describe('笔记导入 · 纯文本与标题', () => {
  it('首行像标题时用作标题并从正文去重', () => {
    const parsed = parseNoteImportFile({
      fileName: '周报.txt',
      bytes: new TextEncoder().encode(
        '项目周报\n\n本周完成三件事。\n- 这不是 Markdown 列表\n*也不是斜体*\n',
      ),
    });
    expect(parsed.title).toBe('项目周报');
    expect(parsed.format).toBe('text');
    expect(parsed.blocks).toHaveLength(1);
    expect(blockText(parsed.blocks[0])).toBe(
      '本周完成三件事。\n- 这不是 Markdown 列表\n*也不是斜体*',
    );
    expect(parsed.blocks[0].payload.runs).toEqual([
      {
        text: '本周完成三件事。\n- 这不是 Markdown 列表\n*也不是斜体*',
      },
    ]);
  });

  it('首行带句号时不当作标题，按文件名命名', () => {
    const parsed = parseNoteImportFile({
      fileName: '随手记.txt',
      bytes: new TextEncoder().encode('今天完成了评审。\n\n明天继续。'),
    });
    expect(parsed.title).toBe('随手记');
    expect(parsed.blocks).toHaveLength(2);
  });
});

describe('笔记导入 · 编码、大小与空文件', () => {
  it('UTF-8 BOM 与 GB18030 都能识别', () => {
    const bom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('# BOM 标题\n\n正文'),
    ]);
    expect(markdown(bom).title).toBe('BOM 标题');
    expect(decodeNoteImportBytes(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]))).toBe(
      '中文',
    );
    const parsed = parseNoteImportFile({
      fileName: '历史.txt',
      bytes: new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0x0a, 0xd5, 0xfd, 0xce, 0xc4]),
    });
    expect(parsed.blocks).toHaveLength(1);
    expect(blockText(parsed.blocks[0])).toBe('正文');
  });

  it('空文件、超限文件与不支持的扩展名分别报错', () => {
    expect(errorCode(() => markdown('   \n\n'))).toBe('IMPORT_EMPTY');
    expect(
      errorCode(() =>
        parseNoteImportFile({
          fileName: '大文件.md',
          bytes: new Uint8Array(NOTE_IMPORT_MAX_FILE_BYTES + 1),
        }),
      ),
    ).toBe('IMPORT_TOO_LARGE');
    expect(
      errorCode(() =>
        parseNoteImportFile({
          fileName: '文档.docx',
          bytes: new TextEncoder().encode('x'),
        }),
      ),
    ).toBe('IMPORT_UNSUPPORTED_FORMAT');
    expect(noteImportFormatOf('a.markdown')).toBe('markdown');
    expect(noteImportFormatOf('a.docx')).toBeNull();
  });

  it('错误对象带错误码，便于逐文件报告', () => {
    try {
      markdown(' \n');
      throw new Error('should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(NoteImportError);
      expect((error as NoteImportError).code).toBe('IMPORT_EMPTY');
      expect((error as NoteImportError).fileName).toBe('项目.md');
    }
  });
});

describe('笔记导入 · 原子输入与导出回归', () => {
  it('块/待办 ID 互相绑定，notes.body 是块投影而非原始 HTML', () => {
    const parsed = markdown(
      '# 发布计划\n\n正文\n\n- [ ] 准备素材\n- [x] 发布\n\n| 阶段 | 负责人 |\n| --- | --- |\n| 设计 | 小王 |\n',
    );
    const bundle = createNoteImportBundle(parsed, {
      folderId: 'f1',
      idFactory: (() => {
        let index = 0;
        return (prefix: string) => `${prefix}-${++index}`;
      })(),
    });
    expect(bundle.note.title).toBe('发布计划');
    expect(bundle.note.folderId).toBe('f1');
    expect(bundle.note.bodyFormat).toBe('html');
    expect(bundle.note.body).toContain('<p>正文</p>');
    expect(bundle.note.body).toContain('<table>');
    expect(bundle.note.body).not.toContain('<h1>发布计划</h1>');
    expect(bundle.blocks.map((block) => block.blockType)).toEqual([
      'paragraph',
      'todo',
      'todo',
      'table',
    ]);
    expect(bundle.todos).toHaveLength(2);
    const todoBlocks = bundle.blocks.filter(
      (block) => block.blockType === 'todo',
    );
    expect(todoBlocks[0].payload).toMatchObject({
      checked: false,
      todoId: bundle.todos[0].id,
    });
    expect(todoBlocks[1].payload).toMatchObject({
      checked: true,
      todoId: bundle.todos[1].id,
    });

    // 导入后直接走单篇导出：标题/列表/待办/表格都能回放。
    const note: Note = {
      id: 'note-import',
      spaceId: 'personal',
      title: bundle.note.title,
      folderId: bundle.note.folderId ?? null,
      tags: [],
      body: bundle.note.body ?? '',
      bodyFormat: 'html',
      status: 'active',
      favorite: false,
      pinned: false,
      createdAt: '2026-10-29T00:00:00.000Z',
      updatedAt: '2026-10-29T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    };
    return createNoteExport({
      note,
      blocks: noteImportBundleToEditorBlocks(bundle, note.id),
      folderName: '产品设计',
      options: {
        format: 'md',
        includeMetadata: false,
        includeImages: false,
        pdfPaper: 'A4',
      },
    }).then((report) => {
      const text = new TextDecoder().decode(report.bytes);
      expect(text.startsWith('# 发布计划\n')).toBe(true);
      expect(text).toContain('正文');
      expect(text).toContain('- [ ] 准备素材');
      expect(text).toContain('- [x] 发布');
      expect(text).toContain('| 阶段 | 负责人 |');
      expect(text).toContain('| 设计 | 小王 |');
    });
  });
});
