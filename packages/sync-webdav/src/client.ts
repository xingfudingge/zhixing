/**
 * 低层 WebDAV 客户端。
 *
 * 只使用 PROPFIND / GET / PUT / MKCOL / DELETE，不发送 If-Match、
 * If-None-Match、LOCK、UNLOCK、MOVE、COPY，也不读取或比较 ETag。
 * 目录状态由文件名推导，写入只使用不可变文件名；若目标已存在则比对内容，
 * 内容不同立即报 `REMOTE_CONFLICT`，绝不覆盖远端未知文件。
 */

import {
  compareHlc,
  stableStringify,
  validateOpEnvelope,
  type EntityState,
  type SyncOp,
} from '../../shared/src/index.ts';
import { errorFromStatus, WebDavError } from './errors.ts';
import {
  encodeGzipJson,
  decodeGzipJson,
} from './gzip.ts';
import {
  createSpaceLayout,
  deriveDeviceIds,
  deriveDeviceOps,
  deriveSnapshotRefs,
  type SpaceLayout,
} from './layout.ts';
import {
  assertDeviceId,
  assertSpaceId,
  baseName,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_ROOT,
  DEFAULT_SPACE_ID,
  formatSeq,
  joinPath,
  normalizeBaseUrl,
  normalizeRoot,
  parentPath,
  resolveUrl,
  safeUrlForLog,
} from './paths.ts';
import { withRetry } from './retry.ts';
import { bytesEqual, sha256Hex } from './sha256.ts';
import type {
  AppendOpsResult,
  AssetRef,
  ChunkManifest,
  ConnectionCheck,
  ConnectionTestResult,
  DavEntry,
  DeviceOps,
  ReadOpsResult,
  RemoteOpFile,
  RemoteState,
  RetryOptions,
  SnapshotData,
  SnapshotReadResult,
  SnapshotRef,
  WebDavClientOptions,
} from './types.ts';
import { propfindBody, parseMultiStatus } from './xml.ts';
import { basicAuthHeader } from './base64.ts';

const PROPFIND_DEPTH = 'Depth';
const MAX_DETAIL = 240;

export function createRandomId(prefix = 'id'): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj?.randomUUID) {
    return `${prefix}-${cryptoObj.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

function normalizePath(value: string): string {
  return joinPath(value);
}

function sameEntryPath(a: string, b: string): boolean {
  const left = normalizePath(a).toLowerCase();
  const right = normalizePath(b).toLowerCase();
  return left === right;
}

export class WebDavClient {
  readonly baseUrl: string;
  readonly root: string;
  readonly spaceId: string;
  readonly deviceId: string;
  readonly layout: SpaceLayout;

  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly chunkSize: number;
  private readonly fetchImpl: ((input: string, init?: RequestInit) => Promise<Response>) | null;
  private readonly retryOptions: RetryOptions;
  private readonly now: () => number;
  private readonly ensured = new Set<string>();

  constructor(options: WebDavClientOptions) {
    if (options.platform === 'web') {
      throw new WebDavError(
        'WEBDAV_UNSUPPORTED_ON_WEB',
        'Web 端只连接知行后台，不提供 WebDAV 同步',
      );
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl, {
      allowInsecureLoopback: options.allowInsecureLoopback ?? true,
    });
    this.root = normalizeRoot(options.root ?? DEFAULT_ROOT);
    this.spaceId = assertSpaceId(options.spaceId ?? DEFAULT_SPACE_ID);
    this.deviceId = assertDeviceId(options.deviceId);
    this.layout = createSpaceLayout(this.root, this.spaceId);
    this.username = options.username ?? '';
    this.password = options.password ?? '';
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
    this.chunkSize = Math.max(
      256,
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
    );
    this.fetchImpl = options.fetchImpl ?? null;
    this.retryOptions = options.retry ?? {};
    this.now = options.now ?? (() => Date.now());
  }

  private toClientPath(path: string): string {
    let basePath = '';
    try {
      basePath = decodeURIComponent(new URL(this.baseUrl).pathname);
    } catch {
      basePath = '';
    }
    basePath = basePath.replace(/\/+$/, '');
    let relative = path;
    if (
      basePath &&
      (relative === basePath || relative.startsWith(`${basePath}/`))
    ) {
      relative = relative.slice(basePath.length) || '/';
    }
    return normalizePath(relative);
  }

  /** 供日志/状态展示，不含查询参数和凭据。 */
  describe(): { baseUrl: string; root: string; spaceId: string; deviceId: string } {
    return {
      baseUrl: safeUrlForLog(this.baseUrl),
      root: this.root,
      spaceId: this.spaceId,
      deviceId: this.deviceId,
    };
  }

  private authHeader(): string | null {
    if (!this.username && !this.password) return null;
    return basicAuthHeader(this.username, this.password);
  }

  /**
   * 发一个请求。绝不写入条件写/锁相关头。
   * 网络错误转成可重试的 WebDavError；超时使用 AbortController。
   */
  private async request(
    method: string,
    path: string,
    init: {
      body?: BodyInit | null;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const url = resolveUrl(this.baseUrl, path);
    const controller =
      typeof AbortController === 'undefined' ? null : new AbortController();
    const timer =
      controller !== null
        ? setTimeout(() => controller.abort(), this.timeoutMs)
        : null;
    const headers: Record<string, string> = {
      Accept: 'application/xml, text/plain, application/octet-stream;q=0.9, */*;q=0.8',
      ...(init.headers ?? {}),
    };
    const auth = this.authHeader();
    if (auth) headers.Authorization = auth;

    try {
      const fetchImpl =
        this.fetchImpl ??
        ((input, requestInit) => fetch(input, requestInit));
      return await fetchImpl(url, {
        method,
        headers,
        body: init.body ?? null,
        signal: controller?.signal,
        credentials: 'omit',
        redirect: 'follow',
        cache: 'no-store',
      });
    } catch (error) {
      const aborted =
        controller?.signal.aborted === true ||
        (error instanceof Error && error.name === 'AbortError');
      throw new WebDavError(
        aborted ? 'TIMEOUT' : 'NETWORK',
        aborted
          ? `WebDAV 请求超时（${Math.round(this.timeoutMs / 1000)}s）`
          : `无法连接 WebDAV 服务器（${safeUrlForLog(url)}）`,
        {
          retryable: true,
          detail: error instanceof Error ? error.message.slice(0, MAX_DETAIL) : null,
          cause: error,
        },
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  private async readErrorDetail(response: Response): Promise<string | null> {
    try {
      const text = await response.text();
      return text ? text.slice(0, 4_000) : null;
    } catch {
      return null;
    }
  }

  private async send(
    method: string,
    path: string,
    options: {
      body?: BodyInit | null;
      headers?: Record<string, string>;
      okStatuses: number[];
      missingStatuses?: number[];
      action: string;
    },
  ): Promise<Response> {
    return withRetry(
      method,
      path,
      async () => {
        const response = await this.request(method, path, {
          body: options.body,
          headers: options.headers,
        });
        if (
          options.okStatuses.includes(response.status) ||
          (options.missingStatuses ?? []).includes(response.status)
        ) {
          return response;
        }
        const detail = await this.readErrorDetail(response);
        throw errorFromStatus(response.status, path, {
          action: options.action,
          retryAfter: response.headers.get('retry-after'),
          detail,
        });
      },
      this.retryOptions,
    );
  }

  /** PROPFIND，返回目录/文件条目。 */
  async propfind(path: string, depth: 0 | 1): Promise<DavEntry[]> {
    const target = normalizePath(path);
    const response = await this.send('PROPFIND', target, {
      body: propfindBody(),
      headers: {
        [PROPFIND_DEPTH]: String(depth),
        'Content-Type': 'application/xml; charset=utf-8',
      },
      okStatuses: [200, 207],
      action: '列举',
    });
    const text = await response.text();
    if (!text.trim()) {
      throw new WebDavError(
        'PROPFIND_UNSUPPORTED',
        '服务器返回空 PROPFIND 响应，可能不是 WebDAV 地址',
        { status: response.status },
      );
    }
    const entries = parseMultiStatus(text).map((entry) => ({
      ...entry,
      // 服务器 href 带 WebDAV 挂载前缀（如 /dav）；client 内部路径相对 baseUrl。
      path: this.toClientPath(entry.path),
    }));
    if (entries.length === 0) {
      throw new WebDavError(
        'PROPFIND_UNSUPPORTED',
        'PROPFIND 没有返回任何条目，服务器可能不支持深度列举',
        { status: response.status },
      );
    }
    return entries;
  }

  /** 返回单个条目；不存在抛 NOT_FOUND。 */
  async stat(path: string): Promise<DavEntry> {
    const target = normalizePath(path);
    const entries = await this.propfind(target, 0);
    const entry =
      entries.find((item) => sameEntryPath(item.path, target)) ?? entries[0];
    if (!entry) {
      throw new WebDavError('NOT_FOUND', `WebDAV 路径不存在（${target}）`);
    }
    return entry;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (error) {
      if (error instanceof WebDavError && error.code === 'NOT_FOUND') {
        return false;
      }
      throw error;
    }
  }

  /** 深度 1 列举；不存在返回空数组。 */
  async list(path: string, options: { missingOk?: boolean } = {}): Promise<DavEntry[]> {
    const target = normalizePath(path);
    let entries: DavEntry[];
    try {
      entries = await this.propfind(target, 1);
    } catch (error) {
      if (
        error instanceof WebDavError &&
        error.code === 'NOT_FOUND' &&
        (options.missingOk ?? true)
      ) {
        return [];
      }
      throw error;
    }
    return entries.filter((entry) => !sameEntryPath(entry.path, target));
  }

  /** 创建目录；已存在（405）视为成功。 */
  async mkcol(path: string): Promise<{ created: boolean }> {
    const target = normalizePath(path);
    if (target === '/') return { created: false };
    const response = await this.send('MKCOL', target, {
      okStatuses: [200, 201, 204],
      action: '创建目录',
    });
    return { created: response.status === 201 };
  }

  /**
   * 逐级 MKCOL。部分 WebDAV 不返回父目录，不能依赖深度 2；
   * 这里按已知路径逐段创建，已存在的 405 视为成功。
   */
  async ensureCollection(path: string): Promise<void> {
    const target = normalizePath(path);
    if (target === '/') return;
    if (this.ensured.has(target)) return;
    const segments = target.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current = `${current}/${segment}`;
      try {
        await this.send('MKCOL', current, {
          // 405 = 已存在。部分服务器返回 200/204 也可接受。
          okStatuses: [200, 201, 204, 405],
          action: '创建目录',
        });
      } catch (error) {
        // 已存在但服务器以 409/403 返回时，再 PROPFIND 确认一次，避免误报。
        if (
          error instanceof WebDavError &&
          (error.code === 'CONFLICT' || error.code === 'FORBIDDEN')
        ) {
          try {
            const entry = await this.stat(current);
            if (entry.isDirectory) continue;
          } catch {
            throw error;
          }
        }
        throw error;
      }
    }
    this.ensured.add(target);
  }

  /** 读取字节；404 抛 NOT_FOUND。 */
  async getBytes(path: string): Promise<Uint8Array> {
    const target = normalizePath(path);
    const response = await this.send('GET', target, {
      okStatuses: [200],
      action: '下载',
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  async getText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.getBytes(path));
  }

  /** 常用别名：`GET`。 */
  async get(path: string): Promise<Uint8Array> {
    return this.getBytes(path);
  }

  /**
   * 写入不可变文件。
   *
   * - 目标已存在且内容一致：跳过（幂等重试）；
   * - 目标已存在但内容不同：REMOTE_CONFLICT，不覆盖；
   * - 网络/5xx：重试整个“检查→写入”，因此响应丢失后不会产生重复内容。
   */
  async putImmutable(path: string, data: Uint8Array): Promise<{
    path: string;
    created: boolean;
    existed: boolean;
    size: number;
    sha256: string;
  }> {
    const target = normalizePath(path);
    const digest = sha256Hex(data);
    return withRetry(
      'PUT',
      target,
      async () => {
        let existing: Uint8Array | null = null;
        try {
          existing = await this.getBytes(target);
        } catch (error) {
          if (!(error instanceof WebDavError) || error.code !== 'NOT_FOUND') {
            throw error;
          }
        }
        if (existing) {
          if (bytesEqual(existing, data)) {
            return {
              path: target,
              created: false,
              existed: true,
              size: data.length,
              sha256: digest,
            };
          }
          throw new WebDavError(
            'REMOTE_CONFLICT',
            `远端已存在不同内容的文件（${target}），已停止写入以避免覆盖`,
            { detail: `local=${digest}, remote=${sha256Hex(existing)}` },
          );
        }

        await this.ensureCollection(parentPath(target));
        const response = await this.request('PUT', target, {
          body: data as BodyInit,
          headers: {
            'Content-Type': 'application/octet-stream',
          },
        });
        if ([200, 201, 204].includes(response.status)) {
          return {
            path: target,
            created: response.status === 201,
            existed: false,
            size: data.length,
            sha256: digest,
          };
        }
        const detail = await this.readErrorDetail(response);
        throw errorFromStatus(response.status, target, {
          action: '上传',
          retryAfter: response.headers.get('retry-after'),
          detail,
        });
      },
      this.retryOptions,
    );
  }

  /** 常用别名：默认不覆盖已存在文件。 */
  async put(path: string, data: Uint8Array): Promise<{
    path: string;
    created: boolean;
    existed: boolean;
    size: number;
    sha256: string;
  }> {
    return this.putImmutable(path, data);
  }

  async deletePath(
    path: string,
    options: { missingOk?: boolean } = {},
  ): Promise<boolean> {
    const target = normalizePath(path);
    if (target === '/') {
      throw new WebDavError('INVALID_PATH', '拒绝删除 WebDAV 根目录');
    }
    const missing = options.missingOk ?? true;
    const response = await this.send('DELETE', target, {
      okStatuses: [200, 201, 204, 207],
      missingStatuses: missing ? [404] : [],
      action: '删除',
    });
    this.ensured.delete(target);
    return response.status !== 404;
  }

  /** 常用别名：`DELETE`。 */
  async delete(path: string): Promise<boolean> {
    return this.deletePath(path);
  }

  // -------------------------------------------------------------------------
  // ops：单向追加，文件名即顺序
  // -------------------------------------------------------------------------

  async listDeviceDirectories(knownDeviceIds: string[] = []): Promise<string[]> {
    let entries: DavEntry[] = [];
    try {
      entries = await this.list(this.layout.opsPath);
    } catch (error) {
      // 部分弱能力服务器禁止深度 1；退化为对已知设备目录逐个 PROPFIND。
      if (
        !(error instanceof WebDavError) ||
        !['FORBIDDEN', 'METHOD_NOT_ALLOWED', 'PROPFIND_UNSUPPORTED'].includes(
          error.code,
        )
      ) {
        throw error;
      }
    }
    const ids = deriveDeviceIds(entries);
    for (const known of knownDeviceIds) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(known) || ids.includes(known)) continue;
      try {
        const entry = await this.stat(this.layout.devicePath(known));
        if (entry.isDirectory) ids.push(known);
      } catch {
        // 已知设备目录不存在时忽略；这是深度 1 不可用时的退化探测。
      }
    }
    return ids.sort();
  }

  async listDeviceOps(
    deviceId: string,
    knownOps: { seq: number; opId: string; name: string; path: string }[] = [],
  ): Promise<DeviceOps> {
    const entries = await this.list(this.layout.devicePath(deviceId));
    const derived = deriveDeviceOps(deviceId, entries);
    const seen = new Set(derived.files.map((file) => file.opId));
    for (const known of knownOps) {
      if (!seen.has(known.opId)) {
        derived.files.push(known);
        derived.maxSeq = Math.max(derived.maxSeq, known.seq);
      }
    }
    derived.files.sort((a, b) => a.seq - b.seq);
    return derived;
  }

  async readRemoteState(knownDeviceIds: string[] = []): Promise<RemoteState> {
    const deviceIds = await this.listDeviceDirectories(knownDeviceIds);
    const devices: DeviceOps[] = [];
    for (const deviceId of deviceIds) {
      devices.push(await this.listDeviceOps(deviceId));
    }
    const snapshots = deriveSnapshotRefs(await this.list(this.layout.snapshotsPath));
    return {
      spaceId: this.spaceId,
      devices,
      snapshots,
      maxSeqByDevice: Object.fromEntries(
        devices.map((device) => [device.deviceId, device.maxSeq]),
      ),
    };
  }

  /** 追加 op 文件；同一 op_id 已存在则跳过，不覆盖。 */
  async appendOps(ops: SyncOp[]): Promise<AppendOpsResult> {
    if (ops.length === 0) {
      return { results: [], maxSeq: 0 };
    }
    for (const op of ops) {
      validateOpEnvelope(op);
      if (op.space_id !== this.spaceId) {
        throw new WebDavError(
          'INVALID_DATA',
          `op 的 space_id（${op.space_id}）与当前空间（${this.spaceId}）不一致`,
        );
      }
    }

    await this.ensureCollection(this.layout.devicePath(this.deviceId));
    const existing = await this.listDeviceOps(this.deviceId);
    const byOpId = new Map<string, RemoteOpFile>();
    for (const file of existing.files) byOpId.set(file.opId, file);

    const unique = dedupeOps(ops).sort(compareOps);
    const results: AppendOpsResult['results'] = [];
    let maxSeq = existing.maxSeq;

    for (const op of unique) {
      const existingFile = byOpId.get(op.op_id);
      if (existingFile) {
        const content = await this.getText(existingFile.path);
        let remoteOps: SyncOp[];
        try {
          remoteOps = parseNdjsonOps(content);
        } catch (error) {
          throw new WebDavError(
            'INVALID_DATA',
            `远端 op 文件损坏（${existingFile.name}），未覆盖`,
            { detail: error instanceof Error ? error.message : null },
          );
        }
        const same = remoteOps.some(
          (remote) => stableStringify(remote) === stableStringify(op),
        );
        if (!same) {
          throw new WebDavError(
            'REMOTE_CONFLICT',
            `远端已有同 op_id 但内容不同的文件（${existingFile.name}），未覆盖`,
          );
        }
        results.push({
          opId: op.op_id,
          path: existingFile.path,
          seq: existingFile.seq,
          created: false,
          skipped: true,
        });
        continue;
      }

      const seq = maxSeq + 1;
      const path = this.layout.opPath(this.deviceId, seq, op.op_id);
      const content = new TextEncoder().encode(`${JSON.stringify(op)}\n`);
      const put = await this.putImmutable(path, content);
      maxSeq = Math.max(maxSeq, seq);
      byOpId.set(op.op_id, {
        seq,
        opId: op.op_id,
        name: baseName(path),
        path,
      });
      results.push({
        opId: op.op_id,
        path,
        seq,
        created: put.created,
        skipped: !put.created,
      });
    }

    return { results, maxSeq };
  }

  async readOps(deviceId: string, afterSeq = 0): Promise<ReadOpsResult> {
    const deviceOps = await this.listDeviceOps(deviceId);
    const warnings: ReadOpsResult['warnings'] = [];
    const seen = new Set<string>();
    const collected: ReadOpsResult['ops'] = [];
    let maxSeq = Math.max(0, afterSeq);

    for (const file of deviceOps.files) {
      if (file.seq <= afterSeq) continue;
      let content: string;
      try {
        content = await this.getText(file.path);
      } catch (error) {
        warnings.push({
          file: file.name,
          message: error instanceof Error ? error.message : '读取失败',
        });
        continue;
      }
      let parsed: SyncOp[];
      try {
        parsed = parseNdjsonOps(content);
      } catch (error) {
        warnings.push({
          file: file.name,
          message: error instanceof Error ? error.message : '解析失败',
        });
        maxSeq = Math.max(maxSeq, file.seq);
        continue;
      }
      for (const op of parsed) {
        try {
          validateOpEnvelope(op);
        } catch (error) {
          warnings.push({
            file: file.name,
            message: error instanceof Error ? error.message : 'op 校验失败',
          });
          continue;
        }
        if (op.space_id !== this.spaceId) continue;
        if (seen.has(op.op_id)) continue;
        seen.add(op.op_id);
        collected.push({ op, seq: file.seq, path: file.path });
      }
      maxSeq = Math.max(maxSeq, file.seq);
    }

    return { deviceId, ops: collected, maxSeq, warnings };
  }

  // -------------------------------------------------------------------------
  // 快照
  // -------------------------------------------------------------------------

  async listSnapshots(): Promise<SnapshotRef[]> {
    return deriveSnapshotRefs(await this.list(this.layout.snapshotsPath));
  }

  /**
   * 选择 coveredSeq 最大且 `.sha256` 校验通过的快照。
   * 损坏的候选会被跳过，继续尝试更早的快照；不会回退到无校验数据。
   */
  async readBestSnapshot(maxCandidates = 3): Promise<SnapshotReadResult | null> {
    const refs = await this.listSnapshots();
    const skipped: { name: string; reason: string }[] = [];

    for (const ref of refs.slice(0, Math.max(1, maxCandidates))) {
      try {
        const bytes = await this.getBytes(ref.path);
        const expected = (await this.getText(ref.sha256Path))
          .trim()
          .split(/\s+/)[0]
          ?.toLowerCase();
        if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
          throw new Error('sha256 文件格式不正确');
        }
        const actual = sha256Hex(bytes);
        if (actual !== expected) {
          throw new Error(`sha256 不匹配（期望 ${expected.slice(0, 12)}，实际 ${actual.slice(0, 12)}）`);
        }
        const raw = await decodeGzipJson<unknown>(bytes);
        const snapshot = validateSnapshotData(raw, this.spaceId);
        return { snapshot, ref, skipped };
      } catch (error) {
        skipped.push({
          name: ref.name,
          reason: error instanceof Error ? error.message : '校验失败',
        });
      }
    }
    return null;
  }

  /** 写快照 + sha256；文件名含 uuid，天然不冲突，不需要锁。 */
  async writeSnapshot(input: {
    entities: EntityState[];
    cursors: Record<string, number>;
    coveredSeq: number;
    deviceId?: string;
  }): Promise<{ ref: SnapshotRef; sha256: string; size: number }> {
    await this.ensureCollection(this.layout.snapshotsPath);
    const deviceId = assertDeviceId(input.deviceId ?? this.deviceId);
    const coveredSeq = Math.max(0, Math.floor(input.coveredSeq));
    const uuid = createRandomId('snap');
    const name = `${formatSeq(coveredSeq)}-${deviceId}-${uuid.replace(/[^A-Za-z0-9_-]/g, '')}.json.gz`;
    const snapshot: SnapshotData = {
      version: 1,
      spaceId: this.spaceId,
      deviceId,
      coveredSeq,
      createdAt: new Date(this.now()).toISOString(),
      cursors: sanitizeCursors(input.cursors),
      entities: input.entities,
    };
    const bytes = encodeGzipJson(snapshot);
    const digest = sha256Hex(bytes);
    const path = this.layout.snapshotPath(name);
    await this.putImmutable(path, bytes);
    await this.putImmutable(`${path}.sha256`, new TextEncoder().encode(`${digest}\n`));
    return {
      ref: {
        name,
        path,
        sha256Path: `${path}.sha256`,
        coveredSeq,
        deviceId,
      },
      sha256: digest,
      size: bytes.length,
    };
  }

  // -------------------------------------------------------------------------
  // 附件：内容寻址 + 4MB 分片 + complete.json
  // -------------------------------------------------------------------------

  async putAsset(
    bytes: Uint8Array,
    options: { chunkSize?: number } = {},
  ): Promise<AssetRef> {
    const digest = sha256Hex(bytes);
    const chunkSize = Math.max(256, options.chunkSize ?? this.chunkSize);
    if (bytes.length <= chunkSize) {
      const path = this.layout.assetPath(digest);
      const put = await this.putImmutable(path, bytes);
      return {
        sha256: digest,
        size: bytes.length,
        path,
        chunked: false,
        created: put.created,
      };
    }
    return this.putChunkedAsset(bytes, digest, chunkSize);
  }

  private async putChunkedAsset(
    bytes: Uint8Array,
    digest: string,
    chunkSize: number,
  ): Promise<AssetRef> {
    const chunks = Math.ceil(bytes.length / chunkSize);
    const manifestPath = this.layout.assetManifestPath(digest);
    const existingManifest = await this.tryReadJson<ChunkManifest>(manifestPath);
    if (existingManifest) {
      validateExistingManifest(existingManifest, digest, bytes.length);
      let created = false;
      for (let index = 0; index < existingManifest.chunks; index += 1) {
        const partPath = this.layout.assetPartPath(digest, index);
        const part = await this.tryGetBytes(partPath);
        const expected = bytes.subarray(
          index * existingManifest.chunkSize,
          (index + 1) * existingManifest.chunkSize,
        );
        if (!part) {
          const put = await this.putImmutable(partPath, expected);
          created = created || put.created;
        } else if (!bytesEqual(part, expected)) {
          throw new WebDavError(
            'REMOTE_CONFLICT',
            `远端分片 ${index} 已存在但内容不同，未覆盖`,
          );
        }
      }
      return {
        sha256: digest,
        size: bytes.length,
        path: manifestPath,
        chunked: true,
        created,
      };
    }

    let created = false;
    for (let index = 0; index < chunks; index += 1) {
      const partPath = this.layout.assetPartPath(digest, index);
      const chunk = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
      const put = await this.putImmutable(partPath, chunk);
      created = created || put.created;
    }
    const manifest: ChunkManifest = {
      version: 1,
      sha256: digest,
      size: bytes.length,
      chunks,
      chunkSize,
      createdAt: new Date(this.now()).toISOString(),
    };
    const put = await this.putImmutable(
      manifestPath,
      new TextEncoder().encode(`${JSON.stringify(manifest)}\n`),
    );
    created = created || put.created;
    return {
      sha256: digest,
      size: bytes.length,
      path: manifestPath,
      chunked: true,
      created,
    };
  }

  /** 读取附件；分片必须全部存在且整体哈希匹配。 */
  async getAsset(sha256: string): Promise<Uint8Array> {
    const directPath = this.layout.assetPath(sha256);
    const direct = await this.tryGetBytes(directPath);
    if (direct) {
      if (sha256Hex(direct) !== sha256) {
        throw new WebDavError('CHUNK_CORRUPT', '附件内容与文件名 sha256 不一致');
      }
      return direct;
    }

    const manifestPath = this.layout.assetManifestPath(sha256);
    const manifest = await this.tryReadJson<ChunkManifest>(manifestPath);
    if (!manifest) {
      throw new WebDavError('NOT_FOUND', `附件不存在（${sha256.slice(0, 12)}…）`);
    }
    validateExistingManifest(manifest, sha256, manifest.size);
    const missing: number[] = [];
    const pieces: Uint8Array[] = [];
    for (let index = 0; index < manifest.chunks; index += 1) {
      const partPath = this.layout.assetPartPath(sha256, index);
      const part = await this.tryGetBytes(partPath);
      if (!part) {
        missing.push(index);
        continue;
      }
      pieces.push(part);
    }
    if (missing.length > 0) {
      throw new WebDavError(
        'CHUNK_INCOMPLETE',
        `附件分片不完整（缺失 ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}）`,
      );
    }
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    if (total !== manifest.size) {
      throw new WebDavError(
        'CHUNK_CORRUPT',
        `附件分片总大小 ${total} 与清单 ${manifest.size} 不一致`,
      );
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) {
      combined.set(piece, offset);
      offset += piece.length;
    }
    if (sha256Hex(combined) !== sha256) {
      throw new WebDavError('CHUNK_CORRUPT', '附件分片合并后哈希不匹配');
    }
    return combined;
  }

  async deleteAsset(sha256: string): Promise<void> {
    await this.deletePath(this.layout.assetPath(sha256));
    await this.deletePath(this.layout.assetManifestPath(sha256), {
      missingOk: true,
    });
    await this.deletePath(joinPath(this.layout.partsPath, sha256), {
      missingOk: true,
    });
  }

  private async tryGetBytes(path: string): Promise<Uint8Array | null> {
    try {
      return await this.getBytes(path);
    } catch (error) {
      if (error instanceof WebDavError && error.code === 'NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  private async tryReadJson<T>(path: string): Promise<T | null> {
    const bytes = await this.tryGetBytes(path);
    if (!bytes) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch (error) {
      throw new WebDavError('INVALID_DATA', `远端 JSON 损坏（${path}）`, {
        cause: error,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 连接测试
  // -------------------------------------------------------------------------

  /**
   * 保存前探测：PROPFIND 根 → MKCOL 递归 → 深度 1 → PUT/GET/DELETE →
   * 分片写入/读取。任何一步失败都返回可展示的 check 与错误文案。
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const checks: ConnectionCheck[] = [];
    const probeId = createRandomId('probe');
    const probePath = joinPath(this.layout.spacePath, '.probes', `${probeId}.txt`);
    const probeBytes = new TextEncoder().encode(
      `zhixing webdav probe ${probeId}\n`,
    );
    let firstError: unknown = null;

    const run = async (
      id: ConnectionCheck['id'],
      label: string,
      fn: () => Promise<string | void>,
    ): Promise<boolean> => {
      try {
        const detail = await fn();
        checks.push({ id, label, status: 'ok', detail: detail ?? undefined });
        return true;
      } catch (error) {
        if (firstError === null) firstError = error;
        checks.push({
          id,
          label,
          status: 'failed',
          detail: error instanceof Error ? error.message : '未知错误',
        });
        return false;
      }
    };

    const rootOk = await run('propfind', 'PROPFIND 根目录', async () => {
      const entries = await this.propfind('/', 0);
      return `HTTP 207/200，返回 ${entries.length} 个条目`;
    });
    if (!rootOk) {
      return this.buildTestResult(checks, firstError);
    }

    await run('auth', '认证与访问权限', async () => {
      const probe = await this.propfind('/', 0);
      return `凭据可用，根目录返回 ${probe.length} 个条目`;
    });

    const dirOk = await run('mkcol', '递归创建目录', async () => {
      await this.ensureCollection(this.layout.spacePath);
      return this.layout.spacePath;
    });

    if (dirOk) {
      await run('depth1', '深度 1 列举', async () => {
        const entries = await this.list(this.layout.spacePath);
        return `${this.layout.spacePath} 下 ${entries.length} 个条目`;
      });

      await run('put', 'PUT 探针文件', async () => {
        await this.ensureCollection(parentPath(probePath));
        const result = await this.putImmutable(probePath, probeBytes);
        return result.created ? '已创建' : '已存在且内容一致';
      });

      const got = await run('get', 'GET 回读校验', async () => {
        const bytes = await this.getBytes(probePath);
        if (!bytesEqual(bytes, probeBytes)) {
          throw new WebDavError('CHUNK_CORRUPT', '回读内容与写入不一致');
        }
        return `sha256 ${sha256Hex(bytes).slice(0, 12)}… 一致`;
      });

      if (got) {
        await run('delete', 'DELETE 探针文件', async () => {
          await this.deletePath(probePath);
          return '已删除';
        });
      }

      await run('chunked', '分片写入与整体校验', async () => {
        const payload = new Uint8Array(1_024);
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] = (index * 31 + 7) & 0xff;
        }
        const asset = await this.putAsset(payload, { chunkSize: 256 });
        if (!asset.chunked) {
          throw new WebDavError('INVALID_DATA', '探针未走分片路径');
        }
        const readBack = await this.getAsset(asset.sha256);
        if (!bytesEqual(readBack, payload)) {
          throw new WebDavError('CHUNK_CORRUPT', '分片回读内容不一致');
        }
        if (asset.created) {
          await this.deleteAsset(asset.sha256);
        }
        return `4 片、${payload.length} 字节校验通过`;
      });

      // 清理：只删除自己创建的探针，不触碰用户数据。
      await this.deletePath(probePath);
      await this.deletePath(parentPath(probePath));
    }

    return this.buildTestResult(checks, firstError);
  }

  private buildTestResult(
    checks: ConnectionCheck[],
    firstError: unknown,
  ): ConnectionTestResult {
    const ok = checks.every((check) => check.status === 'ok');
    const error = ok
      ? null
      : (() => {
          if (firstError instanceof WebDavError) {
            return {
              code: firstError.code,
              message: firstError.message,
              hint:
                firstError.code === 'AUTH_FAILED'
                  ? 'OpenList/Alist 请使用用户名 + 应用密码'
                  : firstError.code === 'INSECURE_URL'
                    ? '远端必须 HTTPS；本机 127.0.0.1 可用 HTTP'
                    : undefined,
            };
          }
          return {
            code: 'UNKNOWN',
            message:
              firstError instanceof Error ? firstError.message : '连接测试失败',
            hint: undefined,
          };
        })();
    return {
      ok,
      baseUrl: safeUrlForLog(this.baseUrl),
      root: this.root,
      checks,
      error,
      testedAt: new Date(this.now()).toISOString(),
    };
  }
}

function dedupeOps(ops: SyncOp[]): SyncOp[] {
  const seen = new Set<string>();
  const output: SyncOp[] = [];
  for (const op of ops) {
    if (seen.has(op.op_id)) continue;
    seen.add(op.op_id);
    output.push(op);
  }
  return output;
}

function compareOps(a: SyncOp, b: SyncOp): number {
  const created = (a.created_at ?? '').localeCompare(b.created_at ?? '');
  if (created !== 0) return created;
  return compareHlc(a.hlc, b.hlc);
}

function parseNdjsonOps(content: string): SyncOp[] {
  const ops: SyncOp[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error('NDJSON 行不是合法 JSON');
    }
    ops.push(parsed as SyncOp);
  }
  if (ops.length === 0) throw new Error('op 文件为空');
  return ops;
}

function sanitizeCursors(cursors: Record<string, number>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const [device, seq] of Object.entries(cursors)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(device)) continue;
    if (!Number.isSafeInteger(seq) || seq < 0) continue;
    output[device] = seq;
  }
  return output;
}

export function validateSnapshotData(
  value: unknown,
  expectedSpaceId: string,
): SnapshotData {
  if (!value || typeof value !== 'object') {
    throw new WebDavError('INVALID_DATA', '快照不是对象');
  }
  const snapshot = value as Partial<SnapshotData>;
  if (snapshot.version !== 1) {
    throw new WebDavError('INVALID_DATA', '快照版本不支持');
  }
  if (snapshot.spaceId !== expectedSpaceId) {
    throw new WebDavError(
      'INVALID_DATA',
      `快照空间不匹配（${String(snapshot.spaceId)}）`,
    );
  }
  if (!Number.isSafeInteger(snapshot.coveredSeq) || (snapshot.coveredSeq ?? -1) < 0) {
    throw new WebDavError('INVALID_DATA', '快照 coveredSeq 非法');
  }
  if (!snapshot.cursors || typeof snapshot.cursors !== 'object') {
    throw new WebDavError('INVALID_DATA', '快照 cursors 非法');
  }
  if (!Array.isArray(snapshot.entities)) {
    throw new WebDavError('INVALID_DATA', '快照 entities 非法');
  }
  for (const entity of snapshot.entities) {
    if (
      !entity ||
      typeof entity !== 'object' ||
      typeof (entity as EntityState).entityType !== 'string' ||
      typeof (entity as EntityState).entityId !== 'string'
    ) {
      throw new WebDavError('INVALID_DATA', '快照实体结构非法');
    }
  }
  return {
    version: 1,
    spaceId: expectedSpaceId,
    deviceId: String(snapshot.deviceId ?? ''),
    coveredSeq: snapshot.coveredSeq ?? 0,
    createdAt: String(snapshot.createdAt ?? ''),
    cursors: sanitizeCursors(snapshot.cursors as Record<string, number>),
    entities: snapshot.entities as EntityState[],
  };
}

function validateExistingManifest(
  manifest: ChunkManifest,
  sha256: string,
  size: number,
): void {
  if (
    manifest.version !== 1 ||
    manifest.sha256 !== sha256 ||
    manifest.size !== size ||
    !Number.isSafeInteger(manifest.chunkSize) ||
    manifest.chunkSize < 1 ||
    !Number.isSafeInteger(manifest.chunks) ||
    manifest.chunks < 1
  ) {
    throw new WebDavError('CHUNK_CORRUPT', '远端分片清单与预期不一致');
  }
}
