import { describe, expect, it } from 'vitest';

import {
  internalNoteIdFromUrl,
  internalNoteIdsInText,
  internalNoteUrl,
  isSafeLinkUrl,
  parseLinkInput,
  sanitizeLinkUrl,
} from '../security';

describe('编辑器链接安全边界', () => {
  it('接受规范的站内笔记内链并取出 id', () => {
    expect(sanitizeLinkUrl('zhixing://note/note-b')).toBe(
      'zhixing://note/note-b',
    );
    expect(internalNoteIdFromUrl('zhixing://note/seed-note-welcome')).toBe(
      'seed-note-welcome',
    );
    expect(internalNoteUrl('note-b')).toBe('zhixing://note/note-b');
    expect(isSafeLinkUrl('zhixing://note/0123456789abcdef')).toBe(true);
  });

  it('拒绝非 note 的 zhixing 地址、路径穿越与非法 id', () => {
    for (const value of [
      'zhixing://board/board-1',
      'zhixing://note/',
      'zhixing://note/../secret',
      'zhixing://note/a/b',
      'zhixing://note/a?x=1',
      'zhixing://note/a b',
      'zhixing://note/-bad',
    ]) {
      expect(sanitizeLinkUrl(value)).toBeNull();
      expect(internalNoteIdFromUrl(value)).toBeNull();
    }
    expect(internalNoteUrl('../secret')).toBeNull();
  });

  it('仍然拒绝 javascript:/data:，并保留 http/https/mailto', () => {
    expect(sanitizeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeLinkUrl('data:text/html,<script>x</script>')).toBeNull();
    expect(sanitizeLinkUrl('//example.com')).toBeNull();
    expect(sanitizeLinkUrl('https://example.com/a')).toBe(
      'https://example.com/a',
    );
    expect(sanitizeLinkUrl('mailto:hi@example.com')).toBe(
      'mailto:hi@example.com',
    );
  });
});

describe('链接解析：链接卡 / 引用块 / 关系图共用', () => {
  it('把 URL 解析为内链、外链或带原因的错误', () => {
    expect(parseLinkInput('zhixing://note/note-b')).toEqual({
      kind: 'note',
      id: 'note-b',
      url: 'zhixing://note/note-b',
    });
    expect(parseLinkInput('  https://www.feishu.cn/doc  ')).toEqual({
      kind: 'external',
      url: 'https://www.feishu.cn/doc',
      host: 'www.feishu.cn',
    });
    expect(parseLinkInput('mailto:hi@example.com')).toEqual({
      kind: 'external',
      url: 'mailto:hi@example.com',
      host: 'hi@example.com',
    });
    expect(parseLinkInput('')).toEqual({
      kind: 'invalid',
      raw: '',
      reason: '请填写链接地址',
    });
  });

  it('内链错误有明确原因，且只接受单段合法 id', () => {
    expect(parseLinkInput('zhixing://board/board-1')).toEqual({
      kind: 'invalid',
      raw: 'zhixing://board/board-1',
      reason: '站内链接只支持 zhixing://note/<id>',
    });
    expect(parseLinkInput('zhixing://note/')).toEqual({
      kind: 'invalid',
      raw: 'zhixing://note/',
      reason: '内链 id 不合法',
    });
    for (const value of [
      'zhixing://note/../secret',
      'zhixing://note/a/b',
      'zhixing://note/a?x=1',
      'zhixing://note/a#frag',
      'zhixing://note/a b',
      'zhixing://note/-bad',
      `zhixing://note/${'a'.repeat(129)}`,
    ]) {
      expect(parseLinkInput(value).kind).toBe('invalid');
      expect(sanitizeLinkUrl(value)).toBeNull();
    }
  });

  it('拒绝危险协议、协议相对地址、控制字符与超长链接', () => {
    for (const value of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>x</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'about:blank',
      'blob:https://example.com/id',
      'ftp://example.com/file',
      '//example.com/path',
      'example.com',
    ]) {
      const parsed = parseLinkInput(value);
      expect(parsed.kind).toBe('invalid');
      if (parsed.kind === 'invalid') {
        expect(parsed.reason).toBe('仅支持 http / https / mailto 或站内笔记内链');
      }
      expect(sanitizeLinkUrl(value)).toBeNull();
    }

    expect(parseLinkInput(`https://example.com/${'a'.repeat(2048)}`)).toEqual({
      kind: 'invalid',
      raw: `https://example.com/${'a'.repeat(2048)}`,
      reason: '链接过长（最多 2048 字符）',
    });
    expect(parseLinkInput('https://example.com/\u0000x')).toEqual({
      kind: 'invalid',
      raw: 'https://example.com/\u0000x',
      reason: '链接包含控制字符',
    });
  });

  it('无法解析的 http 地址返回格式错误，而不是静默通过', () => {
    for (const value of [
      'https://',
      'http://',
      'https://exa mple.com',
      'mailto:',
    ]) {
      const parsed = parseLinkInput(value);
      expect(parsed.kind).toBe('invalid');
      if (parsed.kind === 'invalid') {
        expect(parsed.reason).toBe('链接格式不正确');
      }
      expect(sanitizeLinkUrl(value)).toBeNull();
    }
  });

  it('从正文提取有效内链：去重、保序，跳过非法与嵌在别的协议里的片段', () => {
    const text = [
      '<p><a href="zhixing://note/note-b">B</a></p>',
      '<p>zhixing://note/note-a 和 zhixing://note/note-b</p>',
      '<p>zhixing://note/../secret</p>',
      '<p>zhixing://board/board-1</p>',
      '<p>xzhixing://note/note-c</p>',
      '<p>zhixing://note/a/b</p>',
      '<p>zhixing://note/a?x=1</p>',
      '<p>zhixing://note/a#frag</p>',
      `<p>zhixing://note/${'a'.repeat(129)}</p>`,
    ].join('');
    expect(internalNoteIdsInText(text)).toEqual(['note-b', 'note-a']);
    expect(internalNoteIdsInText('')).toEqual([]);
    expect(internalNoteIdsInText(null)).toEqual([]);
  });

  it('外链查询串里的 zhixing://note 片段不会变成站内关系', () => {
    expect(
      internalNoteIdsInText(
        '<a href="https://example.com/?next=zhixing://note/note-x">外链</a>' +
          '<p>mailto:?body=zhixing://note/note-y</p>' +
          '<p>真正的内链 zhixing://note/note-z</p>',
      ),
    ).toEqual(['note-z']);
  });
});
