/**
 * 同步模式切换保护。
 *
 * 产品决策：每台设备只能有一种 transport；Web 端只连后台。
 * 切换必须经过预检，不能在同步进行中并行切换；有未上传修改时必须明确确认。
 */

import { WebDavError } from './errors.ts';
import type { Platform } from './types.ts';

export type SyncMode = 'local' | 'webdav' | 'backend';

export type ModeSwitchContext = {
  platform: Platform;
  from: SyncMode;
  to: SyncMode;
  /** outbox 中待上传的 op 数。 */
  pendingUploads: number;
  /** 已拉取但尚未应用的远端 op 数（可选）。 */
  pendingDownloads?: number;
  /** backend/local 是否已经追平。 */
  localSynced?: boolean;
  /** 后台是否已完成设备配对且令牌有效。 */
  backendReady?: boolean;
  /** 后台 cursor 是否已追平（backend ↔ webdav 切换）。 */
  backendCursorDrained?: boolean;
  /** 当前是否正在同步/导入。 */
  activeOperation?: boolean;
  /** 用户已阅读确认框。 */
  confirmed?: boolean;
};

export type ModeSwitchDecision = {
  allowed: boolean;
  requiresConfirmation: boolean;
  code:
    | 'OK'
    | 'NOOP'
    | 'WEBDAV_WEB_UNSUPPORTED'
    | 'WEB_ONLY_BACKEND'
    | 'SYNC_IN_PROGRESS'
    | 'PENDING_UPLOADS'
    | 'PENDING_UPLOADS_LOCAL'
    | 'BACKEND_NOT_READY'
    | 'BACKEND_CURSOR_NOT_DRAINED'
    | 'NOT_SYNCED';
  message: string;
  steps: string[];
};

const MODE_LABEL: Record<SyncMode, string> = {
  local: '仅本机',
  webdav: 'WebDAV',
  backend: '后台直连',
};

export function evaluateModeSwitch(
  context: ModeSwitchContext,
): ModeSwitchDecision {
  const {
    platform,
    from,
    to,
    pendingUploads,
    pendingDownloads = 0,
    activeOperation = false,
    confirmed = false,
  } = context;

  if (activeOperation) {
    return blocked(
      'SYNC_IN_PROGRESS',
      '同步/切换正在进行中，请等待当前任务结束后再切换',
      false,
    );
  }

  if (to === 'webdav' && platform === 'web') {
    return blocked(
      'WEBDAV_WEB_UNSUPPORTED',
      'Web 端只连接知行后台，不提供 WebDAV 入口；请在桌面/移动客户端使用 WebDAV',
      false,
    );
  }

  if (platform === 'web' && to !== 'backend') {
    return blocked(
      'WEB_ONLY_BACKEND',
      'Web 端只能使用后台直连同步',
      false,
    );
  }

  if (from === to) {
    return {
      allowed: true,
      requiresConfirmation: false,
      code: 'NOOP',
      message: `当前已经是${MODE_LABEL[to]}模式`,
      steps: [],
    };
  }

  if (to === 'webdav' && pendingUploads > 0 && !confirmed) {
    return {
      allowed: false,
      requiresConfirmation: true,
      code: 'PENDING_UPLOADS',
      message: `还有 ${pendingUploads} 条本地修改未上传。切换后请立即完成首次同步，否则这些修改只留在本机。`,
      steps: webdavSteps(),
    };
  }

  if (from === 'webdav' && to === 'local' && pendingUploads > 0 && !confirmed) {
    return {
      allowed: false,
      requiresConfirmation: true,
      code: 'PENDING_UPLOADS_LOCAL',
      message: `还有 ${pendingUploads} 条修改未上传到 WebDAV。切换到仅本机后，这些修改不会再自动上传。`,
      steps: ['停止 WebDAV 定时同步', '保留本机 SQLite 数据', '不删除远端文件'],
    };
  }

  if (to === 'backend' && context.backendReady !== true) {
    return blocked(
      'BACKEND_NOT_READY',
      '请先在后台完成设备配对并确认令牌有效，再切换到后台直连',
      false,
    );
  }

  if (
    (from === 'backend' && to === 'webdav') ||
    (from === 'webdav' && to === 'backend')
  ) {
    if (context.backendCursorDrained !== true) {
      return blocked(
        'BACKEND_CURSOR_NOT_DRAINED',
        from === 'backend'
          ? '后台同步尚未追平，不能导出到 WebDAV'
          : '本地尚未同步到最新，不能切换到后台直连',
        false,
      );
    }
  }

  if (from === 'backend' && to === 'local' && context.localSynced !== true) {
    return blocked(
      'NOT_SYNCED',
      '后台游标尚未追平，请先完成同步再切换到仅本机',
      false,
    );
  }

  if (pendingDownloads > 0) {
    return blocked(
      'NOT_SYNCED',
      `还有 ${pendingDownloads} 条远端修改未应用，请先完成同步`,
      false,
    );
  }

  return {
    allowed: true,
    requiresConfirmation: false,
    code: 'OK',
    message:
      to === 'webdav'
        ? '预检通过：将先探测 WebDAV，再上传本地快照与待同步修改'
        : to === 'local'
          ? '预检通过：切换后停止联网同步，本地数据保留'
          : '预检通过：将导入/追平后台数据后切换',
    steps:
      to === 'webdav'
        ? webdavSteps()
        : to === 'local'
          ? ['停止当前 transport 定时器', '保留本机数据', '下次启动按新模式运行']
          : ['确认后台配对与令牌', '导入/追平 op 与快照', '切换并保留回滚点'],
  };
}

function webdavSteps(): string[] {
  return [
    'PROPFIND / MKCOL / PUT / GET / DELETE 连接探测',
    '上传本地快照与 outbox 中的 op',
    '写入设备同步模式（webdav）',
    'WebDAV 失败时保持原模式，不清空本地数据',
  ];
}

function blocked(
  code: ModeSwitchDecision['code'],
  message: string,
  requiresConfirmation: boolean,
): ModeSwitchDecision {
  return {
    allowed: false,
    requiresConfirmation,
    code,
    message,
    steps: [],
  };
}

export class ModeSwitchBlockedError extends WebDavError {
  readonly decision: ModeSwitchDecision;

  constructor(decision: ModeSwitchDecision) {
    super('MODE_SWITCH_BLOCKED', decision.message);
    this.name = 'ModeSwitchBlockedError';
    this.decision = decision;
  }
}

export function assertModeSwitch(context: ModeSwitchContext): ModeSwitchDecision {
  const decision = evaluateModeSwitch(context);
  if (!decision.allowed) {
    throw new ModeSwitchBlockedError(decision);
  }
  return decision;
}

export function isWebDavPlatformSupported(platform: Platform): boolean {
  return platform !== 'web';
}

export function assertWebDavPlatform(platform: Platform): void {
  if (!isWebDavPlatformSupported(platform)) {
    throw new WebDavError(
      'WEBDAV_UNSUPPORTED_ON_WEB',
      'Web 端只连接知行后台，不提供 WebDAV 入口',
    );
  }
}
