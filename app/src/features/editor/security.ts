/**
 * 编辑器安全边界：所有进入 DOM 的文本、链接、颜色都必须经过这里。
 *
 * 规则与 PRD/任务卡一致：
 * - 外部链接只允许 http / https / mailto，禁止 javascript:、data: 与协议相对地址；
 * - 站内笔记链接只允许 `zhixing://note/<合法 id>`（N-16），其余 zhixing: 地址拒绝；
 * - 文字色/底色只允许 CSS 颜色字面量，不允许 url()/expression()/var() 等表达式；
 * - 所有文本先 HTML 转义，再拼装 DOM。
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

const LINK_PROTOCOLS = /^(https?|mailto):/i;
const COLOR_LITERAL =
  /^(#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([0-9.,%\s/]+\)|[a-z]{3,20})$/i;

const LINK_UNSUPPORTED =
  '仅支持 http / https / mailto 或站内笔记内链';

export const INTERNAL_NOTE_PREFIX = 'zhixing://note/';

/**
 * 笔记 id 由 Rust 仓储生成（十六进制串），种子数据使用 `seed-note-*`。
 * 只接受字母数字开头、随后 0-127 个字母数字/下划线/短横线，避免路径穿越、
 * 查询串和多段路径混进内链。
 */
const NOTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** 从 `zhixing://note/<id>` 取出合法 id；不是内链或 id 非法时返回 null。 */
export function internalNoteIdFromUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const url = value.trim();
  if (!url.startsWith(INTERNAL_NOTE_PREFIX)) {
    return null;
  }
  if (/[\u0000-\u001f\u007f\s]/.test(url)) {
    return null;
  }
  const id = url.slice(INTERNAL_NOTE_PREFIX.length);
  return NOTE_ID_PATTERN.test(id) ? id : null;
}

/** 生成规范内链；id 非法时返回 null，绝不拼接半成品 URL。 */
export function internalNoteUrl(noteId: unknown): string | null {
  if (typeof noteId !== 'string') {
    return null;
  }
  const id = noteId.trim();
  return NOTE_ID_PATTERN.test(id) ? `${INTERNAL_NOTE_PREFIX}${id}` : null;
}

const INTERNAL_NOTE_LINK_IN_TEXT =
  /zhixing:\/\/note\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?![A-Za-z0-9_?/#-])/g;

/**
 * 从正文 HTML / Markdown / 纯文本中提取有效内链 id（去重、保序）。
 * 反向链接与关系图都用它扫描，避免 `includes` 把非法片段当成关系。
 */
export function internalNoteIdsInText(value: unknown): string[] {
  if (typeof value !== 'string' || !value) {
    return [];
  }
  const ids: string[] = [];
  for (const match of value.matchAll(INTERNAL_NOTE_LINK_IN_TEXT)) {
    const index = match.index ?? 0;
    const previous = index > 0 ? value[index - 1] : '';
    if (previous && /[A-Za-z0-9+.-]/.test(previous)) {
      continue;
    }
    // 外部 URL 的查询串/正文里可能夹着 zhixing://note/...，那只是外链参数，
    // 不能当成站内关系图的一条边。
    const prefix = value.slice(Math.max(0, index - 2048), index);
    if (/(?:https?:\/\/|mailto:)[^\s"'<>]*$/i.test(prefix)) {
      continue;
    }
    const id = internalNoteIdFromUrl(match[0]);
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

export type ParsedLink =
  | { kind: 'note'; id: string; url: string }
  | { kind: 'external'; url: string; host: string }
  | { kind: 'invalid'; raw: string; reason: string };

/**
 * 统一解析用户输入的链接。链接卡、链接弹层、引用块与关系图都走这里，
 * 避免各自维护一套协议/内链规则。
 *
 * 错误文案与 `知识编辑基础规范` §6.3 一致；调用方负责在上层补充
 * 「目标笔记是否存在」这类需要笔记列表才能判断的校验。
 */
export function parseLinkInput(value: unknown): ParsedLink {
  const source = typeof value === 'string' ? value : '';
  const url = source.trim();
  if (!url) {
    return { kind: 'invalid', raw: url, reason: '请填写链接地址' };
  }
  if (url.length > 2048) {
    return {
      kind: 'invalid',
      raw: url,
      reason: '链接过长（最多 2048 字符）',
    };
  }
  // 控制字符会把 URL 拆成两段，直接拒绝。
  if (/[\u0000-\u001f\u007f]/.test(url)) {
    return { kind: 'invalid', raw: url, reason: '链接包含控制字符' };
  }

  if (/^zhixing:/i.test(url)) {
    if (!url.startsWith(INTERNAL_NOTE_PREFIX)) {
      return {
        kind: 'invalid',
        raw: url,
        reason: '站内链接只支持 zhixing://note/<id>',
      };
    }
    const id = internalNoteIdFromUrl(url);
    if (!id) {
      return { kind: 'invalid', raw: url, reason: '内链 id 不合法' };
    }
    return { kind: 'note', id, url: `${INTERNAL_NOTE_PREFIX}${id}` };
  }

  if (!LINK_PROTOCOLS.test(url)) {
    return { kind: 'invalid', raw: url, reason: LINK_UNSUPPORTED };
  }

  try {
    const parsed = new URL(url);
    if (!/^(https?:|mailto:)$/i.test(parsed.protocol)) {
      return { kind: 'invalid', raw: url, reason: LINK_UNSUPPORTED };
    }
    if (parsed.protocol === 'mailto:' && !parsed.pathname.trim()) {
      return { kind: 'invalid', raw: url, reason: '链接格式不正确' };
    }
    const host =
      parsed.protocol === 'mailto:'
        ? parsed.pathname
        : parsed.host || parsed.pathname || url;
    return { kind: 'external', url, host };
  } catch {
    return { kind: 'invalid', raw: url, reason: '链接格式不正确' };
  }
}

/** 仅接受带明确安全协议的绝对链接或站内笔记内链。返回 null 表示拒绝。 */
export function sanitizeLinkUrl(value: unknown): string | null {
  const parsed = parseLinkInput(value);
  return parsed.kind === 'invalid' ? null : parsed.url;
}

export function isSafeLinkUrl(value: unknown): value is string {
  return sanitizeLinkUrl(value) !== null;
}

/** 只接受简单颜色字面量，杜绝 CSS 注入。 */
export function isSafeColor(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const color = value.trim();
  if (!color || color.length > 64) {
    return false;
  }
  if (/[;{}<>\u0000-\u001f]/i.test(color)) {
    return false;
  }
  if (/url\s*\(|expression\s*\(|javascript:|@import|var\s*\(/i.test(color)) {
    return false;
  }
  return COLOR_LITERAL.test(color);
}

export function sanitizeColor(value: unknown): string | undefined {
  return isSafeColor(value) ? value.trim() : undefined;
}

function componentToHex(value: string): string {
  const parsed = Number.parseFloat(value);
  const clamped = Math.max(0, Math.min(255, Math.round(parsed)));
  return clamped.toString(16).padStart(2, '0');
}

/**
 * 统一颜色表示，避免 DOM 把 `#c0392b` 读成 `rgb(192, 57, 43)` 后与模型
 * 中的 hex 值反复不等、导致重绘丢光标。透明/继承色不写入 marks。
 */
export function canonicalColor(value: unknown): string | undefined {
  const color = sanitizeColor(value);
  if (!color) {
    return undefined;
  }
  const lower = color.toLowerCase();
  if (
    lower === 'transparent' ||
    lower === 'currentcolor' ||
    lower === 'inherit' ||
    lower === 'initial' ||
    lower === 'unset' ||
    lower === 'none'
  ) {
    return undefined;
  }
  const shortHex = /^#([0-9a-f]{3})$/.exec(lower);
  if (shortHex) {
    return `#${shortHex[1]
      .split('')
      .map((char) => char + char)
      .join('')}`;
  }
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(lower)) {
    return lower;
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(lower);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).filter(Boolean);
    if (parts.length === 3 || parts.length === 4) {
      const alpha = parts.length === 4 ? Number.parseFloat(parts[3]) : 1;
      if (!Number.isFinite(alpha) || alpha <= 0) {
        return undefined;
      }
      const hex = `#${componentToHex(parts[0])}${componentToHex(
        parts[1],
      )}${componentToHex(parts[2])}`;
      return alpha >= 1 ? hex : `${hex}${componentToHex(String(alpha * 255))}`;
    }
  }
  return lower;
}
