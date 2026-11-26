/**
 * 极简 WebDAV PROPFIND 解析器。
 *
 * 不使用 DOMParser：Tauri/Node 测试都可用，且不会因命名空间前缀不同
 * （D:/d:/lp1: 等）而失败。只读取知行需要的字段。
 */

import { hrefToPath } from './paths.ts';
import type { DavEntry } from './types.ts';

const MULTISTATUS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getlastmodified/>
    <d:displayname/>
  </d:prop>
</d:propfind>`;

export function propfindBody(): string {
  return MULTISTATUS_BODY;
}

function tag(block: string, name: string): string | null {
  const match = new RegExp(
    `<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`,
    'i',
  ).exec(block);
  return match ? match[1] : null;
}

function responseStatus(block: string): number | null {
  const direct = /<(?:(?:[\w.-]+):)?status\b[^>]*>\s*HTTP\/[\d.]+\s+(\d{3})/i.exec(
    block,
  );
  if (direct) return Number(direct[1]);
  return null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function parseMultiStatus(xml: string): DavEntry[] {
  const entries: DavEntry[] = [];
  const responsePattern = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;
  let response: RegExpExecArray | null;
  while ((response = responsePattern.exec(xml)) !== null) {
    const block = response[1];
    const hrefRaw = tag(block, 'href');
    if (!hrefRaw) continue;
    const path = hrefToPath(decodeEntities(hrefRaw));
    if (!path.startsWith('/')) continue;
    const name = path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1);
    const isDirectory = /<(?:[\w.-]+:)?collection\b/i.test(block);
    const lengthRaw = tag(block, 'getcontentlength');
    const length = lengthRaw ? Number(lengthRaw.trim()) : Number.NaN;
    const modified = tag(block, 'getlastmodified');
    entries.push({
      path,
      name,
      isDirectory,
      size: Number.isFinite(length) && length >= 0 ? length : null,
      lastModified: modified ? decodeEntities(modified.trim()) : null,
      status: responseStatus(block) ?? 207,
    });
  }
  return entries;
}
