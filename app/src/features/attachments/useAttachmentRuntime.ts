/**
 * React 侧附件运行时装载。
 *
 * 页面只在没有注入 manager 时启用；测试或嵌入场景可以直接传 manager，
 * 避免被迫依赖 Tauri。初始化失败会保留可读原因，由 AttachmentSection
 * 以 role="alert" 展示，并允许用户重试。
 */

import { useCallback, useEffect, useState } from 'react';

import {
  createDesktopAttachmentRuntime,
  type AttachmentRuntimeOptions,
} from './runtime';
import type { AttachmentManager } from './manager';
import type { AttachmentUploader } from './uploader';
import type { SyncMode } from '../sync/types';

export type AttachmentRuntimeState = {
  status: 'loading' | 'ready' | 'unavailable';
  manager: AttachmentManager | null;
  uploader: AttachmentUploader | null;
  syncMode: SyncMode;
  reason: string | null;
};

export type UseAttachmentRuntimeOptions = AttachmentRuntimeOptions & {
  /** 传 false 时不初始化（调用方已注入 manager 或暂不需要附件）。 */
  enabled?: boolean;
};

const LOADING: AttachmentRuntimeState = {
  status: 'loading',
  manager: null,
  uploader: null,
  syncMode: 'local',
  reason: null,
};

function messageOf(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  return '附件服务初始化失败';
}

export function useAttachmentRuntime(
  options: UseAttachmentRuntimeOptions = {},
): AttachmentRuntimeState & { reload: () => void } {
  const { enabled = true, dbName } = options;
  const [state, setState] = useState<AttachmentRuntimeState>(LOADING);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    setState(LOADING);
    createDesktopAttachmentRuntime(dbName ? { dbName } : {})
      .then((runtime) => {
        if (cancelled) {
          return;
        }
        setState({
          status: runtime.manager ? 'ready' : 'unavailable',
          manager: runtime.manager,
          uploader: runtime.uploader,
          syncMode: runtime.syncMode,
          reason: runtime.reason,
        });
      })
      .catch((reason: unknown) => {
        if (cancelled) {
          return;
        }
        setState({
          status: 'unavailable',
          manager: null,
          uploader: null,
          syncMode: 'local',
          reason: `附件服务初始化失败：${messageOf(reason)}`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [dbName, enabled, nonce]);

  const reload = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  return { ...state, reload };
}
