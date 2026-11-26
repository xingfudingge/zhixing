/**
 * 测试用 WebDAV 服务器：故意只实现 OpenList/Alist 常见的弱能力子集。
 *
 * - 默认不返回 ETag，不实现 LOCK/MOVE/COPY；
 * - PROPFIND 支持 Depth 0/1，可关闭深度 1 以测试退化探测；
 * - 可注入“写入成功后返回 502”与断网，用于验证重试不重复写；
 * - 记录所有请求头，测试据此断言客户端从不发送 If-Match/LOCK。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type MockWebDavOptions = {
  username?: string;
  password?: string;
  /** 默认 false：响应里没有 ETag。 */
  etag?: boolean;
  /** 默认 true；false 时深度 1 返回 403。 */
  propfindDepth1?: boolean;
  /** 每个请求额外延迟，便于测试超时。 */
  latencyMs?: number;
};

export type MockFile = {
  data: Buffer;
  isDirectory: boolean;
  modified: string;
};

export type RecordedRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
};

type FailurePlan = {
  method: string;
  status: number;
  /** true：先完成写入再返回错误（模拟响应丢失）。 */
  afterWrite: boolean;
  remaining: number;
};

export class MockWebDavServer {
  private readonly options: MockWebDavOptions;
  private readonly files = new Map<string, MockFile>();
  private readonly failures: FailurePlan[] = [];
  private readonly server: Server;
  readonly requests: RecordedRequest[] = [];
  private offline = false;
  private port = 0;

  constructor(options: MockWebDavOptions = {}) {
    this.options = options;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        if (!response.headersSent) {
          response.writeHead(500, { 'Content-Type': 'text/plain' });
        }
        response.end(error instanceof Error ? error.message : 'server error');
      });
    });
    // 根目录与挂载点 /dav 必须存在。
    this.files.set('/dav', {
      data: Buffer.alloc(0),
      isDirectory: true,
      modified: new Date(0).toISOString(),
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('mock WebDAV 服务器启动失败');
    }
    this.port = address.port;
    return `http://127.0.0.1:${this.port}/dav`;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/dav`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  setOffline(value: boolean): void {
    this.offline = value;
  }

  /** 注入一次失败；afterWrite=true 时模拟“已写入但响应丢失”。 */
  failNext(input: {
    method: string;
    status?: number;
    afterWrite?: boolean;
    times?: number;
  }): void {
    this.failures.push({
      method: input.method.toUpperCase(),
      status: input.status ?? 502,
      afterWrite: input.afterWrite ?? false,
      remaining: Math.max(1, input.times ?? 1),
    });
  }

  seedFile(path: string, data: string | Uint8Array): void {
    const normalized = normalizePath(path);
    this.ensureDirectory(parentPath(normalized));
    this.files.set(normalized, {
      data: Buffer.from(data),
      isDirectory: false,
      modified: new Date().toISOString(),
    });
  }

  seedDirectory(path: string): void {
    this.ensureDirectory(normalizePath(path));
  }

  has(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  read(path: string): Buffer | null {
    const file = this.files.get(normalizePath(path));
    return file && !file.isDirectory ? file.data : null;
  }

  list(prefix: string): string[] {
    const normalized = normalizePath(prefix);
    return [...this.files.keys()]
      .filter(
        (path) =>
          path === normalized || path.startsWith(`${normalized}/`),
      )
      .sort();
  }

  countFiles(prefix: string): number {
    return this.list(prefix).filter((path) => !this.files.get(path)?.isDirectory)
      .length;
  }

  private takeFailure(method: string): FailurePlan | null {
    const plan = this.failures.find(
      (item) => item.method === method && item.remaining > 0,
    );
    if (!plan) return null;
    plan.remaining -= 1;
    if (plan.remaining <= 0) {
      const index = this.failures.indexOf(plan);
      this.failures.splice(index, 1);
    }
    return plan;
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = (request.method ?? 'GET').toUpperCase();
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = normalizePath(decodeURIComponent(url.pathname));
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers[key.toLowerCase()] = value;
      else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(',');
    }
    this.requests.push({ method, path, headers });

    if (this.offline) {
      request.socket.destroy();
      return;
    }

    if (this.options.latencyMs && this.options.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
    }

    if (this.options.username !== undefined && !this.authorized(headers)) {
      response.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="zhixing-test"',
        'Content-Type': 'text/plain',
      });
      response.end('unauthorized');
      return;
    }

    const failure = this.takeFailure(method);
    if (failure && !failure.afterWrite) {
      response.writeHead(failure.status, { 'Content-Type': 'text/plain' });
      response.end(`injected ${failure.status}`);
      return;
    }

    switch (method) {
      case 'OPTIONS':
        response.writeHead(200, {
          Allow: 'OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE',
          DAV: '1',
        });
        response.end();
        return;
      case 'PROPFIND':
        this.handlePropfind(request, response, path);
        break;
      case 'GET':
        this.handleGet(response, path, false);
        break;
      case 'HEAD':
        this.handleGet(response, path, true);
        break;
      case 'PUT':
        await this.handlePut(
          request,
          response,
          path,
          failure?.afterWrite ? failure : null,
        );
        break;
      case 'MKCOL':
        this.handleMkcol(response, path);
        break;
      case 'DELETE':
        this.handleDelete(response, path);
        break;
      default:
        response.writeHead(405, { Allow: 'PROPFIND, GET, PUT, MKCOL, DELETE' });
        response.end('method not allowed');
        return;
    }
  }

  private authorized(headers: Record<string, string>): boolean {
    const header = headers.authorization;
    if (!header?.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString(
      'utf8',
    );
    return (
      decoded === `${this.options.username ?? ''}:${this.options.password ?? ''}`
    );
  }

  private handlePropfind(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): void {
    const entry = this.files.get(path);
    if (!entry) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
      return;
    }
    const depthHeader = (request.headers.depth ?? '0').toString();
    if (depthHeader !== '0' && this.options.propfindDepth1 === false) {
      response.writeHead(403, { 'Content-Type': 'text/plain' });
      response.end('depth 1 not supported');
      return;
    }
    const entries: { path: string; file: MockFile }[] = [{ path, file: entry }];
    if (depthHeader !== '0' && entry.isDirectory) {
      for (const [childPath, child] of this.files) {
        if (childPath === path) continue;
        if (parentPath(childPath) === path) {
          entries.push({ path: childPath, file: child });
        }
      }
    }
    const body = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<D:multistatus xmlns:D="DAV:">',
      ...entries.map(({ path: entryPath, file }) => {
        const href = encodePath(entryPath) + (file.isDirectory ? '/' : '');
        const props = [
          '<D:displayname>',
          escapeXml(basename(entryPath)),
          '</D:displayname>',
          file.isDirectory
            ? '<D:resourcetype><D:collection/></D:resourcetype>'
            : '<D:resourcetype/>',
        ];
        if (!file.isDirectory) {
          props.push(
            `<D:getcontentlength>${file.data.length}</D:getcontentlength>`,
            `<D:getlastmodified>${file.modified}</D:getlastmodified>`,
          );
          if (this.options.etag) {
            props.push(
              `<D:getetag>"${entryPath.length.toString(16)}-${file.data.length.toString(16)}"</D:getetag>`,
            );
          }
        }
        return [
          '<D:response>',
          `<D:href>${escapeXml(href)}</D:href>`,
          '<D:propstat><D:prop>',
          props.join(''),
          '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>',
          '</D:response>',
        ].join('');
      }),
      '</D:multistatus>',
    ].join('');
    response.writeHead(207, {
      'Content-Type': 'application/xml; charset=utf-8',
      ...(this.options.etag ? {} : {}),
    });
    response.end(body);
  }

  private handleGet(
    response: ServerResponse,
    path: string,
    headOnly: boolean,
  ): void {
    const entry = this.files.get(path);
    if (!entry || entry.isDirectory) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
      return;
    }
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': entry.data.length,
      'Last-Modified': entry.modified,
    };
    if (this.options.etag) {
      headers.ETag = `"${path.length.toString(16)}-${entry.data.length.toString(16)}"`;
    }
    response.writeHead(200, headers);
    response.end(headOnly ? undefined : entry.data);
  }

  private async handlePut(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    afterWriteFailure: FailurePlan | null,
  ): Promise<void> {
    const parent = this.files.get(parentPath(path));
    if (!parent || !parent.isDirectory) {
      response.writeHead(409, { 'Content-Type': 'text/plain' });
      response.end('parent missing');
      return;
    }
    const existing = this.files.get(path);
    if (existing?.isDirectory) {
      response.writeHead(405, { 'Content-Type': 'text/plain' });
      response.end('is a collection');
      return;
    }
    const body = await readBody(request);
    this.files.set(path, {
      data: body,
      isDirectory: false,
      modified: new Date().toISOString(),
    });
    if (afterWriteFailure) {
      // 写入已经发生，但客户端收到 5xx；客户端重试时应识别“同内容已存在”。
      response.writeHead(afterWriteFailure.status, {
        'Content-Type': 'text/plain',
      });
      response.end(`injected ${afterWriteFailure.status} after write`);
      return;
    }
    response.writeHead(existing ? 204 : 201);
    response.end();
  }

  private handleMkcol(response: ServerResponse, path: string): void {
    if (this.files.has(path)) {
      response.writeHead(405, { 'Content-Type': 'text/plain' });
      response.end('already exists');
      return;
    }
    const parent = this.files.get(parentPath(path));
    if (!parent || !parent.isDirectory) {
      response.writeHead(409, { 'Content-Type': 'text/plain' });
      response.end('parent missing');
      return;
    }
    this.files.set(path, {
      data: Buffer.alloc(0),
      isDirectory: true,
      modified: new Date().toISOString(),
    });
    response.writeHead(201);
    response.end();
  }

  private handleDelete(response: ServerResponse, path: string): void {
    const entry = this.files.get(path);
    if (!entry) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
      return;
    }
    if (entry.isDirectory) {
      for (const key of [...this.files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) {
          this.files.delete(key);
        }
      }
    } else {
      this.files.delete(path);
    }
    response.writeHead(204);
    response.end();
  }

  private ensureDirectory(path: string): void {
    if (path === '/' || path === '') return;
    const segments = path.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current += `/${segment}`;
      if (!this.files.has(current)) {
        this.files.set(current, {
          data: Buffer.alloc(0),
          isDirectory: true,
          modified: new Date().toISOString(),
        });
      }
    }
  }
}

function normalizePath(value: string): string {
  const decoded = value.replace(/\\/g, '/');
  const segments: string[] = [];
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function parentPath(path: string): string {
  if (path === '/') return '/';
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
}

function basename(path: string): string {
  if (path === '/') return '';
  return path.slice(path.lastIndexOf('/') + 1);
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
