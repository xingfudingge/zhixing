/**
 * 文件下载适配（P2-04）。
 *
 * 浏览器/Tauri WebView 用 Blob URL + <a download> 触发保存；返回 false
 * 时由 UI 显示“当前环境无法自动下载”，而不是假装成功。测试可注入内存
 * 下载器，完整跑通导出 → 导入。
 */

import type { FileDownloader } from './types';

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** 桌面壳写应用数据目录；浏览器没有 Tauri IPC 时返回 null，继续走 Blob 下载。 */
async function saveInTauri(fileName: string, blob: Blob): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    return await invoke<string>('save_export_file', { fileName, bytes });
  } catch {
    return null;
  }
}

export const browserDownloader: FileDownloader = async ({ fileName, blob }) => {
  const desktopPath = await saveInTauri(fileName, blob);
  if (desktopPath) {
    return true;
  }

  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return false;
  }
  try {
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
    return true;
  } catch {
    return false;
  }
};

export function createMemoryDownloader(): {
  downloader: FileDownloader;
  files: Array<{ fileName: string; blob: Blob }>;
  last(): { fileName: string; blob: Blob } | undefined;
} {
  const files: Array<{ fileName: string; blob: Blob }> = [];
  return {
    downloader: async ({ fileName, blob }) => {
      files.push({ fileName, blob });
      return true;
    },
    files,
    last: () => files[files.length - 1],
  };
}
