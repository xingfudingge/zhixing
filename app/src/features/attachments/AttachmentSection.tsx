/**
 * 页面级附件入口：负责装载运行时、展示不可用原因，再挂载 AttachmentPanel。
 *
 * 页面/测试可以直接注入 manager（和 uploader）绕过 Tauri；未注入时由
 * `useAttachmentRuntime` 装配 SQLite + IndexedDB。任何“不可用”都有可见文案，
 * 不会把入口渲染成点了没反应的按钮。
 */

import { useAttachmentRuntime } from './useAttachmentRuntime';
import {
  AttachmentPanel,
  type AttachmentPanelProps,
} from './AttachmentPanel';
import type { AttachmentManager } from './manager';
import type { AttachmentUploader } from './uploader';
import type { AttachmentSyncMode } from './types';

export type AttachmentSectionProps = Omit<
  AttachmentPanelProps,
  'manager' | 'uploader'
> & {
  /** 传 undefined 时自动装配桌面运行时；传 null 表示明确不可用。 */
  manager?: AttachmentManager | null;
  uploader?: AttachmentUploader | null;
  /** manager 不可用时的原因；优先于运行时原因。 */
  unavailableReason?: string | null;
  /** 上层运行时仍在初始化：显示准备中，而不是误报不可用。 */
  loading?: boolean;
};

export function AttachmentSection({
  manager,
  uploader,
  unavailableReason,
  loading = false,
  ...panelProps
}: AttachmentSectionProps) {
  const injected = manager !== undefined;
  const runtime = useAttachmentRuntime({ enabled: !injected });
  const activeManager = injected ? manager : runtime.manager;
  const activeUploader = injected ? uploader ?? null : runtime.uploader;
  // 注入 manager/uploader 的测试场景没有运行时模式：有 uploader 视为 backend。
  const activeSyncMode: AttachmentSyncMode =
    panelProps.syncMode ??
    (injected
      ? activeUploader
        ? 'backend'
        : 'local'
      : runtime.syncMode);
  const reason =
    unavailableReason !== undefined ? unavailableReason : runtime.reason;

  if (loading || (!injected && runtime.status === 'loading')) {
    return (
      <p className="zx-attach-state" role="status">
        正在准备附件服务…
      </p>
    );
  }

  if (!activeManager) {
    return (
      <div className="zx-attach-state is-error" role="alert">
        附件服务不可用：{reason ?? '当前环境没有可用的附件存储'}。
        {!injected ? (
          <button
            type="button"
            className="zx-attach-button"
            onClick={runtime.reload}
          >
            重试
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <AttachmentPanel
      {...panelProps}
      manager={activeManager}
      uploader={activeUploader ?? undefined}
      syncMode={activeSyncMode}
      uploadDisabledReason={reason}
    />
  );
}
