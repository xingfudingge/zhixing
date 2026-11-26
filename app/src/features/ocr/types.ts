/**
 * 图片 OCR 领域类型。
 *
 * 硬约束：
 * - 默认关闭；没有可用引擎时显示“不可用/未配置”，不返回任何占位文字。
 * - 识别结果只能来自引擎真实返回值；本模块不生成、不猜测、不补全文本。
 * - 远程适配器只在用户显式允许发送图片后才可运行；默认只接受本机引擎。
 */

export type OcrEngineKind = 'system-local' | 'custom-adapter' | 'none';

/**
 * 识别范围：
 * - new-images：只处理还没有识别记录的新图片；已有作业直接返回原结果；
 * - all-images：允许重新识别已有图片（显式重跑，覆盖上一次文本）；
 * - folder：只处理所选知识库目录内笔记下的图片；未选目录时入队被拒绝。
 */
export type OcrScope = 'new-images' | 'all-images' | 'folder';

export type OcrSettings = {
  /** 默认 false；关闭后不再排新任务。 */
  enabled: boolean;
  engine: OcrEngineKind;
  scope: OcrScope;
  /** scope=folder 时选定的知识库目录 ID；null 表示尚未选择。 */
  scopeFolderId: string | null;
  languages: string[];
  /** local = 识别文本只在本机；sync = 用户明确允许识别文本进入同步管线。 */
  textStorage: 'local' | 'sync';
  custom: {
    endpoint: string;
    /** 远程端点默认拒绝发送图片，必须显式勾选。 */
    allowRemoteImages: boolean;
    timeoutMs: number;
  };
};

export const DEFAULT_OCR_SETTINGS: OcrSettings = {
  enabled: false,
  engine: 'system-local',
  scope: 'new-images',
  scopeFolderId: null,
  languages: ['zh-Hans', 'en'],
  textStorage: 'local',
  custom: {
    endpoint: '',
    allowRemoteImages: false,
    timeoutMs: 15_000,
  },
};

/** 入队时用于校验识别范围的图片上下文；由附件/笔记元数据提供。 */
export type OcrImageContext = {
  attachmentId: string;
  /** 附件所属笔记的知识库目录；null 表示未分类。 */
  folderId: string | null;
  fileName?: string | null;
  createdAt?: string | null;
};

/** 按识别范围批量排队时的候选图片。 */
export type OcrImageCandidate = OcrImageContext;

export type OcrScopeEnqueueResult = {
  /** 新加入队列（pending）或重跑（all-images）的作业数。 */
  queued: number;
  /** 已被范围规则跳过、且不是错误的图片数（例如仅新图片里的旧图）。 */
  skipped: number;
  /** 读取原图/入队失败的数量；原因逐条保留。 */
  failed: number;
  reasons: string[];
};

export type OcrCapability = {
  engineId: string;
  engineName: string;
  kind: OcrEngineKind;
  available: boolean;
  local: boolean;
  languages: string[];
  reason: string | null;
  version: string | null;
};

export type OcrBlock = {
  text: string;
  confidence: number | null;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
};

export type OcrResult = {
  engineId: string;
  engineName: string;
  text: string;
  language: string | null;
  confidence: number | null;
  blocks: OcrBlock[];
  durationMs: number;
  finishedAt: string;
};

export type OcrJobStatus =
  | 'pending'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled';

/**
 * 识别文本的同步状态。只描述“文本是否真正进入同步管线”，
 * 不使用 `synced` 以免在没观察到服务端确认时伪造成功。
 */
export type OcrTextSyncState = 'local' | 'pending' | 'queued' | 'failed';

export type OcrJob = {
  id: string;
  attachmentId: string;
  status: OcrJobStatus;
  engineId: string;
  dedupeKey: string;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  text: string | null;
  language: string | null;
  error: string | null;
  /** 用户是否允许识别文本参与同步；未开启时只在本机保存。 */
  textStorage: 'local' | 'sync';
  /** sync 时：识别文本是否已进入同步 outbox，或入队失败原因。 */
  textSyncState: OcrTextSyncState;
  textSyncError: string | null;
  sourceSha256: string;
};

export type OcrEnqueueInput = {
  attachmentId: string;
  image: Blob;
  engineId: string;
  force?: boolean;
};

export class OcrDisabledError extends Error {
  constructor() {
    super('图片 OCR 默认关闭；请先在设置中开启并选择可用引擎');
    this.name = 'OcrDisabledError';
  }
}

export class OcrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrUnavailableError';
  }
}

export class OcrRemoteConsentError extends Error {
  constructor(endpoint: string) {
    super(
      `自定义引擎 ${redactEndpoint(endpoint)} 不在本机；发送图片前必须显式勾选“允许远程处理图片”`,
    );
    this.name = 'OcrRemoteConsentError';
  }
}

export class OcrEncryptionBoundaryError extends Error {
  constructor(
    message = '笔记内容加密已开启；OCR 文本会绕过 SQLite 密文边界，已拒绝识别。请先在设置中关闭加密或删除笔记附件。',
  ) {
    super(message);
    this.name = 'OcrEncryptionBoundaryError';
  }
}

/** 图片不满足当前识别范围；消息直接说明是哪条范围规则拒绝的。 */
export class OcrScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrScopeError';
  }
}

export class OcrProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrProtocolError';
  }
}

export function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const auth = url.username || url.password ? '***@' : '';
    const query = url.search ? '?…' : '';
    return `${url.protocol}//${auth}${url.host}${url.pathname}${query}`;
  } catch {
    return '(无效地址)';
  }
}

export function isLocalEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.local')
  );
}

export function jobStatusLabel(status: OcrJobStatus): string {
  switch (status) {
    case 'pending':
      return '待处理';
    case 'processing':
      return '识别中';
    case 'succeeded':
      return '已完成';
    case 'failed':
      return '失败';
    case 'canceled':
      return '已取消';
  }
}

export function scopeLabel(scope: OcrScope): string {
  switch (scope) {
    case 'new-images':
      return '仅新图片';
    case 'all-images':
      return '全部图片';
    case 'folder':
      return '指定目录';
  }
}

/** 指定目录范围是否已配置；其它范围始终就绪。 */
export function isScopeConfigured(settings: OcrSettings): boolean {
  return settings.scope !== 'folder' || Boolean(settings.scopeFolderId);
}

export function textSyncStateLabel(state: OcrTextSyncState): string {
  switch (state) {
    case 'local':
      return '仅本机';
    case 'pending':
      return '等待识别文本';
    case 'queued':
      return '已进入同步队列';
    case 'failed':
      return '同步入队失败';
  }
}
