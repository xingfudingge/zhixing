/**
 * WebDAV 错误模型。
 *
 * 所有错误都带稳定的 `code`，UI 与测试依赖 code 而不是英文/中文文案；
 * `retryable` 只表示“同一请求重试可能成功”，不表示服务器支持条件写。
 */

export type WebDavErrorCode =
  | 'INVALID_URL'
  | 'INSECURE_URL'
  | 'INVALID_PATH'
  | 'INVALID_CONFIG'
  | 'INVALID_DATA'
  | 'AUTH_FAILED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'CONFLICT'
  | 'REMOTE_CONFLICT'
  | 'PRECONDITION_FAILED'
  | 'LOCKED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'SERVER_ERROR'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'PROPFIND_UNSUPPORTED'
  | 'CHUNK_INCOMPLETE'
  | 'CHUNK_CORRUPT'
  | 'COMPRESSION_UNSUPPORTED'
  | 'WEBDAV_UNSUPPORTED_ON_WEB'
  | 'UNSUPPORTED_PLATFORM'
  | 'MODE_SWITCH_BLOCKED'
  | 'PENDING_UPLOADS'
  | 'NOT_SYNCED';

export class WebDavError extends Error {
  readonly code: WebDavErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly detail: string | null;

  constructor(
    code: WebDavErrorCode,
    message: string,
    options: {
      status?: number | null;
      retryable?: boolean;
      retryAfterMs?: number | null;
      detail?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'WebDavError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.detail = options.detail ?? null;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isWebDavError(value: unknown): value is WebDavError {
  return value instanceof WebDavError;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(300_000, Math.round(seconds * 1000));
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.min(300_000, date - Date.now()));
  }
  return null;
}

export function errorFromStatus(
  status: number,
  path: string,
  options: {
    action?: string;
    retryAfter?: string | null;
    detail?: string | null;
  } = {},
): WebDavError {
  const action = options.action ?? '访问';
  const suffix = path ? `（${path}）` : '';
  const retryAfterMs = parseRetryAfter(options.retryAfter ?? null);
  const detail = options.detail ? truncateDetail(options.detail) : null;

  if (status === 401) {
    return new WebDavError(
      'AUTH_FAILED',
      `WebDAV 认证失败${suffix}，请检查用户名与应用密码`,
      { status, detail },
    );
  }
  if (status === 403) {
    return new WebDavError(
      'FORBIDDEN',
      `没有权限${action}该 WebDAV 路径${suffix}`,
      { status, detail },
    );
  }
  if (status === 404) {
    return new WebDavError('NOT_FOUND', `WebDAV 路径不存在${suffix}`, {
      status,
      detail,
    });
  }
  if (status === 405) {
    return new WebDavError(
      'METHOD_NOT_ALLOWED',
      `服务器不允许${action}该路径${suffix}`,
      { status, detail },
    );
  }
  if (status === 409) {
    return new WebDavError(
      'CONFLICT',
      `目录状态冲突${suffix}，可能是父目录不存在`,
      { status, detail },
    );
  }
  if (status === 412) {
    return new WebDavError(
      'PRECONDITION_FAILED',
      `服务器返回条件写失败${suffix}；知行不依赖 If-Match，请检查是否存在代理改写`,
      { status, detail },
    );
  }
  if (status === 423) {
    return new WebDavError(
      'LOCKED',
      `远端文件被服务器锁定${suffix}；知行不使用 LOCK，请等待其他客户端释放`,
      { status, detail },
    );
  }
  if (status === 429) {
    return new WebDavError(
      'RATE_LIMITED',
      `WebDAV 服务器限流${suffix}，将稍后重试`,
      { status, retryable: true, retryAfterMs, detail },
    );
  }
  if (status === 507) {
    return new WebDavError(
      'QUOTA_EXCEEDED',
      `WebDAV 服务器空间不足${suffix}`,
      { status, detail },
    );
  }
  if (status >= 500) {
    return new WebDavError(
      'SERVER_ERROR',
      `WebDAV 服务器暂时不可用（HTTP ${status}）${suffix}`,
      { status, retryable: true, retryAfterMs, detail },
    );
  }
  return new WebDavError(
    'SERVER_ERROR',
    `WebDAV 请求失败（HTTP ${status}）${suffix}`,
    { status, retryable: isRetryableStatus(status), retryAfterMs, detail },
  );
}

function truncateDetail(value: string): string {
  // 错误页可能是整页 HTML；只留少量文本，且绝不包含请求头（可能含 Basic 凭据）。
  const text = value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

export type UserFacingError = {
  code: WebDavErrorCode | 'UNKNOWN';
  title: string;
  message: string;
  hint: string | null;
  retryable: boolean;
};

/**
 * 把底层错误翻译成设置页可展示的文案。
 * 日志里只打印 code/status，不打印 URL 里的凭据或 Authorization 头。
 */
export function toUserFacingError(error: unknown): UserFacingError {
  if (!isWebDavError(error)) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : '未知错误，请稍后重试';
    return {
      code: 'UNKNOWN',
      title: '连接失败',
      message,
      hint: null,
      retryable: false,
    };
  }

  const base = {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };

  switch (error.code) {
    case 'INVALID_URL':
      return {
        ...base,
        title: '地址格式不正确',
        hint: '示例：https://dav.example.com/dav 或 http://127.0.0.1:5244/dav',
      };
    case 'INVALID_PATH':
      return {
        ...base,
        title: '路径不合法',
        hint: '根目录不能包含 ..、反斜杠或控制字符。',
      };
    case 'INVALID_CONFIG':
      return {
        ...base,
        title: '配置不合法',
        hint: '空间 ID 使用小写字母/数字/下划线；设备 ID 使用 ASCII。',
      };
    case 'INVALID_DATA':
      return {
        ...base,
        title: '远端数据损坏',
        hint: '该文件不会被覆盖；请保留现场并在另一台设备上确认。',
      };
    case 'METHOD_NOT_ALLOWED':
      return {
        ...base,
        title: '服务器不允许该操作',
        hint: '检查账号是否有创建/上传/删除权限。',
      };
    case 'PRECONDITION_FAILED':
      return {
        ...base,
        title: '服务器拒绝写入',
        hint: '知行不使用 If-Match；请检查代理或网盘客户端是否强制条件写。',
      };
    case 'LOCKED':
      return {
        ...base,
        title: '远端文件被锁定',
        hint: '知行不使用 LOCK；请等待其他客户端释放或换一个目录。',
      };
    case 'INSECURE_URL':
      return {
        ...base,
        title: '必须使用 HTTPS',
        hint: '只有本机 127.0.0.1 / localhost 可用 HTTP 做验收。',
      };
    case 'AUTH_FAILED':
      return {
        ...base,
        title: '认证失败',
        hint: 'OpenList/Alist 请填写用户名和应用密码，不要填写网页登录密码。',
      };
    case 'FORBIDDEN':
      return {
        ...base,
        title: '没有权限',
        hint: '检查该账号是否对目录有读写/删除权限。',
      };
    case 'NOT_FOUND':
      return {
        ...base,
        title: '地址或目录不存在',
        hint: '确认 WebDAV 地址包含正确的前缀（如 /dav），根目录将由知行自动创建。',
      };
    case 'PROPFIND_UNSUPPORTED':
      return {
        ...base,
        title: '服务器不支持目录列举',
        hint: '知行需要 PROPFIND；请确认连接的是 WebDAV 地址，而不是网页地址。',
      };
    case 'NETWORK':
      return {
        ...base,
        title: '网络不可达',
        hint: '检查地址、代理和网络；恢复后可重试，已上传的不可变文件不会重复写入。',
      };
    case 'TIMEOUT':
      return {
        ...base,
        title: '连接超时',
        hint: '检查服务器负载/网络；大文件会分片重试。',
      };
    case 'RATE_LIMITED':
      return {
        ...base,
        title: '服务器限流',
        hint: '稍后自动重试；不要重复手动点击。',
      };
    case 'QUOTA_EXCEEDED':
      return {
        ...base,
        title: '空间不足',
        hint: '清理网盘空间后重试。',
      };
    case 'REMOTE_CONFLICT':
      return {
        ...base,
        title: '远端已有不同内容',
        hint: '知行不会覆盖远端未知文件；请换一个目录或先手动确认。',
      };
    case 'CHUNK_INCOMPLETE':
      return {
        ...base,
        title: '分片不完整',
        hint: '保留已上传分片，断网恢复后会续传缺失部分。',
      };
    case 'CHUNK_CORRUPT':
      return {
        ...base,
        title: '分片校验失败',
        hint: '远端分片与清单不一致；删除该附件的分片目录后会重新上传。',
      };
    case 'WEBDAV_UNSUPPORTED_ON_WEB':
      return {
        ...base,
        title: 'Web 端不支持 WebDAV',
        hint: '浏览器受 CORS/认证限制；Web 端只连接知行后台。',
      };
    case 'MODE_SWITCH_BLOCKED':
    case 'PENDING_UPLOADS':
    case 'NOT_SYNCED':
      return {
        ...base,
        title: '暂不能切换同步模式',
        hint: '先完成同步，或在确认框中明确接受本地未上传修改。',
      };
    default:
      return {
        ...base,
        title: 'WebDAV 操作失败',
        hint: error.status ? `服务器返回 HTTP ${error.status}` : null,
      };
  }
}
