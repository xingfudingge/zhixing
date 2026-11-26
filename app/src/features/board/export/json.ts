/**
 * 画板 JSON 源文件（version=1）的生成与命名。
 *
 * 与 PNG 共用 ZX-EXPORT-06 的保存面板策略：文件名由用户可见的标题 +
 * 本地时间戳组成，保存位置由用户选择；这里只负责生成字节，不触碰
 * Downloads/Documents。
 */

import { BOARD_FILE_SCHEMA, boardDocumentJson } from '../model';
import type { BoardDocument, BoardViewport } from '../types';

export const BOARD_JSON_MIME = 'application/json';

/**
 * 开发者 JSON 文件选择器接受类型。
 *
 * 只允许 `.json`；画板包 `.zxboard` 走包入口，避免两套格式在同一入口
 * 混淆。JSON 仅用于调试/schema 查看，不保证跨版本兼容。
 */
export const BOARD_JSON_ACCEPT = '.json,application/json';

export type BoardJsonFileOptions = {
  viewport?: BoardViewport | null;
  now?: Date;
};

function sanitizeTitle(title: string): string {
  return (
    Array.from(
      (title || '画板')
        .replace(/[\\/:*?"<>|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
      .slice(0, 60)
      .join('') || '画板'
  );
}

function timestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
    now.getDate(),
  )}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * 文件名：`标题-YYYYMMDD-HHmm.json`。与 PNG 使用同一套标题清洗规则，
 * 只把扩展名换成 `.json`。
 */
export function defaultBoardJsonFileName(
  title: string,
  now: Date = new Date(),
): string {
  return `${sanitizeTitle(title)}-${timestamp(now)}.json`;
}

/** 生成可保存/下载的 JSON 文本，包含 schema、元数据与 viewport。 */
export function boardJsonFileText(
  document: BoardDocument,
  options: BoardJsonFileOptions = {},
): string {
  const now = options.now ?? new Date();
  return boardDocumentJson(document, {
    viewport: options.viewport ?? null,
    exportedAt: now.toISOString(),
  });
}

export function boardJsonFileBlob(
  document: BoardDocument,
  options: BoardJsonFileOptions = {},
): Blob {
  return new Blob([boardJsonFileText(document, options)], {
    type: `${BOARD_JSON_MIME};charset=utf-8`,
  });
}

export { BOARD_FILE_SCHEMA };
