/**
 * 画板 PNG / JSON 保存：统一走用户可见的保存面板，不默认 Downloads。
 *
 * 桌面壳调用 `save_board_export_file`（原生保存面板 + 对应格式过滤器；
 * 默认目录来自设备设置，未设置时传 null，由系统记住上次位置；取消返回
 * null），浏览器预览复用附件模块的 File System Access 保存面板，同样不会
 * 擅自写进 Downloads。
 */

import { invoke } from '@tauri-apps/api/core';

import { isTauriRuntime } from '../../../data/db/client';
import {
  saveBlobWithDialog,
  type SaveResult,
} from '../../attachments/fileActions';
import { readDefaultExportDirectory } from '../../export/location';

async function saveBoardFileWithDialog(
  blob: Blob,
  fileName: string,
  kind: 'png' | 'json',
): Promise<SaveResult> {
  if (!isTauriRuntime()) {
    return saveBlobWithDialog(blob, fileName);
  }

  const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
  const path = await invoke<string | null>('save_board_export_file', {
    fileName,
    bytes,
    directory: readDefaultExportDirectory(),
    // 旧版 PNG 调用不带 kind，Rust 端默认按 PNG 处理。
    ...(kind === 'json' ? { kind } : {}),
  });
  return path
    ? { status: 'saved', path, target: 'desktop' }
    : { status: 'canceled' };
}

export async function saveBoardPngWithDialog(
  blob: Blob,
  fileName: string,
): Promise<SaveResult> {
  return saveBoardFileWithDialog(blob, fileName, 'png');
}

export async function saveBoardJsonWithDialog(
  blob: Blob,
  fileName: string,
): Promise<SaveResult> {
  return saveBoardFileWithDialog(blob, fileName, 'json');
}
