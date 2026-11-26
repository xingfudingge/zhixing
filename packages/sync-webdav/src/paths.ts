/**
 * URL 与远端路径安全。
 *
 * 规则：
 * - 只允许 https；http 仅限 loopback（本地 OpenList/Alist 验收）。
 * - 地址中不允许内嵌用户名/密码、query、hash。
 * - 数据目录必须是绝对路径，禁止 `..`、反斜杠、控制字符。
 * - 生成的设备/空间/文件名只允许 ASCII 白名单。
 */

import { WebDavError } from './errors.ts';

export const DEFAULT_ROOT = '/zhixing';
export const DEFAULT_SPACE_ID = 'personal';
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

const SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SPACE_PATTERN = /^[a-z0-9_-]{1,64}$/;
const DEVICE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type UrlValidationOptions = {
  allowInsecureLoopback?: boolean;
};

export function normalizeBaseUrl(
  raw: string,
  options: UrlValidationOptions = {},
): string {
  const value = raw.trim();
  if (!value) {
    throw new WebDavError('INVALID_URL', '请填写 WebDAV 地址');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebDavError(
      'INVALID_URL',
      'WebDAV 地址格式不正确，需要包含 http(s)://',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebDavError('INVALID_URL', 'WebDAV 地址只支持 http/https');
  }
  if (url.username || url.password) {
    throw new WebDavError(
      'INVALID_URL',
      '请勿把用户名/密码写进地址，请使用下方独立输入框',
    );
  }
  if (url.search || url.hash) {
    throw new WebDavError('INVALID_URL', 'WebDAV 地址不能包含查询参数或锚点');
  }
  if (
    url.protocol === 'http:' &&
    (options.allowInsecureLoopback === false || !isLoopbackHost(url.hostname))
  ) {
    throw new WebDavError(
      'INSECURE_URL',
      'WebDAV 仅允许 HTTPS；本机 127.0.0.1/localhost 测试除外',
    );
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${pathname}`;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0'
  );
}

/** 规范化用户填写的根目录；空值回落到 `/zhixing`。 */
export function normalizeRoot(raw?: string): string {
  let value = (raw ?? DEFAULT_ROOT).trim();
  if (!value) return DEFAULT_ROOT;
  // 用户常写 `zhixing`；自动补前导斜杠，随后仍做 `..`/白名单校验。
  if (!value.startsWith('/')) value = `/${value}`;
  if (value.includes('\\') || /[\u0000-\u001f]/.test(value)) {
    throw new WebDavError('INVALID_PATH', '根目录包含非法字符');
  }
  const segments = value.split('/').filter(Boolean);
  for (const segment of segments) {
    if (
      segment === '.' ||
      segment === '..' ||
      segment.length > 128 ||
      !SEGMENT_PATTERN.test(segment)
    ) {
      throw new WebDavError('INVALID_PATH', `根目录片段非法：${segment}`);
    }
  }
  return segments.length === 0 ? '' : `/${segments.join('/')}`;
}

export function assertSpaceId(value: string): string {
  if (!SPACE_PATTERN.test(value)) {
    throw new WebDavError(
      'INVALID_CONFIG',
      '空间 ID 只能包含小写字母、数字、下划线和连字符',
    );
  }
  return value;
}

export function assertDeviceId(value: string): string {
  if (!DEVICE_PATTERN.test(value)) {
    throw new WebDavError(
      'INVALID_CONFIG',
      '设备 ID 只能包含 ASCII 字母、数字、下划线和连字符',
    );
  }
  return value;
}

/** 拼接路径片段，结果总是以 `/` 开头、无尾斜杠；`..` 一律拒绝。 */
export function joinPath(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (part.includes('\\') || /[\u0000-\u001f]/.test(part)) {
      throw new WebDavError('INVALID_PATH', '路径包含非法字符');
    }
    for (const segment of part.split('/')) {
      if (!segment || segment === '.') continue;
      if (segment === '..' || segment.length > 256) {
        throw new WebDavError('INVALID_PATH', '路径包含 .. 或过长片段');
      }
      segments.push(segment);
    }
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

export function parentPath(path: string): string {
  const normalized = joinPath(path);
  if (normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

export function baseName(path: string): string {
  const normalized = joinPath(path);
  if (normalized === '/') return '';
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/**
 * 把相对数据路径拼到完整 URL。
 * 只做百分号编码，不改变大小写；所有调用方传入的路径都已过白名单。
 */
export function resolveUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  let basePath = url.pathname;
  try {
    basePath = decodeURIComponent(basePath);
  } catch {
    // 保留原路径；非法百分号会在后续请求中由服务器拒绝。
  }
  basePath = basePath.replace(/\/+$/, '');
  const encoded = joinPath(basePath, path)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  url.pathname = encoded;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** 从 PROPFIND 的 href 中取出解码后的绝对路径。 */
export function hrefToPath(href: string): string {
  const decodedHref = decodeXmlEntities(href.trim());
  let pathname: string;
  try {
    const url = new URL(decodedHref, 'http://webdav.invalid');
    pathname = url.pathname;
  } catch {
    pathname = decodedHref;
  }
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // 保留原样；后续路径校验会拒绝非法字符。
  }
  return pathname.replace(/\/+$/, '') || '/';
}

export function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity.startsWith('#x')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    }
    return '';
  });
}

export function formatSeq(seq: number): string {
  return String(seq).padStart(12, '0');
}

export function parseSeq(raw: string): number | null {
  if (!/^\d{12}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 防止日志/错误把 Authorization 或 URL 查询参数带出去。 */
export function safeUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}
