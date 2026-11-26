/**
 * 导出位置的唯一策略入口。
 *
 * - 默认目录只写设备设置（SQLite `settings` + localStorage 镜像），不写进
 *   附件/笔记/画板等业务元数据；
 * - `null` 表示每次保存都弹出用户可见的保存面板，不预设 Downloads/Documents；
 * - 有默认目录时只把它作为保存面板的起始位置，用户仍可改选；
 * - 目录是否存在、是否可写由 Rust 在落盘前校验，失败返回可恢复提示。
 *
 * 这里直接读 localStorage 镜像而不是设置仓储，避免
 * `settings -> notes -> fileActions -> location -> settings` 的循环依赖；
 * 设置页保存时会同步写镜像，桌面启动时也会从 SQLite 校准。
 */

import { invoke } from '@tauri-apps/api/core';

import { isTauriRuntime } from '../../data/db/client';
import { SETTINGS_STORAGE_KEY } from '../../data/settingsStorage';

export class ExportDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportDirectoryError';
  }
}

function normalizeDirectory(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : null;
}

function commandErrorMessage(reason: unknown, fallback: string): string {
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  if (reason && typeof reason === 'object') {
    const value = reason as { message?: unknown };
    if (typeof value.message === 'string' && value.message.trim()) {
      return value.message;
    }
  }
  return fallback;
}

/** 从设备偏好的 localStorage 镜像读取默认导出目录。 */
export function readDefaultExportDirectory(
  storage: Pick<Storage, 'getItem'> | null | undefined = typeof window ===
  'undefined'
    ? null
    : window.localStorage,
): string | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const exportLocation = (parsed as { export?: unknown }).export;
    if (!exportLocation || typeof exportLocation !== 'object') {
      return null;
    }
    return normalizeDirectory(
      (exportLocation as Record<string, unknown>).directory,
    );
  } catch {
    return null;
  }
}

/**
 * 打开系统文件夹选择器。
 *
 * 取消返回 `null`，不改变现有设置；浏览器预览没有可持久化的目录句柄，
 * 明确报错而不是伪造一个下次无法使用的路径。
 */
export async function pickExportDirectory(): Promise<string | null> {
  if (!isTauriRuntime()) {
    throw new ExportDirectoryError(
      '浏览器预览无法固定默认导出目录。请使用桌面版在「设置 → 数据与备份」中选择；浏览器保存时仍会每次弹出保存面板。',
    );
  }
  try {
    const picked = await invoke<string | null>('pick_export_directory');
    return normalizeDirectory(picked);
  } catch (reason) {
    throw new ExportDirectoryError(
      commandErrorMessage(reason, '无法打开目录选择器，请重试'),
    );
  }
}
