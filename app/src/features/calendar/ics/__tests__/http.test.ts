import { describe, expect, it, vi } from 'vitest';

import {
  createIcsHttpClient,
  type InvokeLike,
} from '../http';
import { IcsFetchError } from '../types';

describe('ICS HTTP 传输', () => {
  it('桌面壳通过 http_fetch_text 发送条件头并还原状态/ETag/正文', async () => {
    const invokeImpl = vi.fn<InvokeLike>(async (_command, args) => {
      expect(args).toMatchObject({
        url: 'https://example.com/team.ics',
        headers: { 'if-none-match': '"v1"', accept: 'text/calendar' },
        timeoutMs: 12_000,
      });
      return {
        status: 200,
        statusText: 'OK',
        etag: '"v2"',
        lastModified: 'Mon, 26 Oct 2026 10:00:00 GMT',
        contentType: 'text/calendar',
        body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
        finalUrl: 'https://example.com/team.ics',
      };
    });
    const client = createIcsHttpClient({ runtime: true, invokeImpl });
    expect(client.kind).toBe('desktop');
    expect(client.supportsConditionalHeaders('https://example.com/a.ics')).toBe(
      true,
    );

    const response = await client.fetch('https://example.com/team.ics', {
      method: 'GET',
      headers: { accept: 'text/calendar', 'if-none-match': '"v1"' },
      timeoutMs: 12_000,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"v2"');
    expect(await response.text()).toContain('BEGIN:VCALENDAR');
    expect(invokeImpl).toHaveBeenCalledWith('http_fetch_text', expect.any(Object));
  });

  it('桌面壳 304 返回空正文，仍保留 ETag', async () => {
    const client = createIcsHttpClient({
      runtime: true,
      invokeImpl: async () => ({
        status: 304,
        statusText: 'Not Modified',
        etag: '"v2"',
        body: '',
      }),
    });
    const response = await client.fetch('https://example.com/a.ics');
    expect(response.status).toBe(304);
    expect(response.ok).toBe(false);
    expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBe('"v2"');
  });

  it('桌面代理错误区分未注册、未授权与超时', async () => {
    const cases: Array<[string, RegExp]> = [
      ['未实现的 IPC 命令：http_fetch_text', /未注册/],
      ['permission denied by ACL capability', /未授权/],
      ['桌面网络代理请求超时：timed out', /超时/],
    ];
    for (const [raw, expected] of cases) {
      const client = createIcsHttpClient({
        runtime: true,
        invokeImpl: async () => {
          throw new Error(raw);
        },
      });
      await expect(client.fetch('https://example.com/a.ics')).rejects.toThrow(
        expected,
      );
    }
  });

  it('浏览器只对同源地址使用条件请求；跨域失败文案说明 CORS', async () => {
    const client = createIcsHttpClient({
      runtime: false,
      origin: 'http://localhost',
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(client.kind).toBe('browser');
    expect(client.supportsConditionalHeaders('http://localhost/a.ics')).toBe(
      true,
    );
    expect(
      client.supportsConditionalHeaders('https://example.com/a.ics'),
    ).toBe(false);

    await expect(
      client.fetch('https://example.com/a.ics'),
    ).rejects.toBeInstanceOf(IcsFetchError);
    await expect(
      client.fetch('https://example.com/a.ics'),
    ).rejects.toThrow(/CORS/);
    await expect(client.fetch('http://localhost/a.ics')).rejects.toThrow(
      /浏览器网络请求失败/,
    );
  });

  it('自定义 fetchImpl 视为具备条件请求能力（测试/CLI）', () => {
    const client = createIcsHttpClient({
      fetchImpl: async () => new Response(''),
    });
    expect(client.kind).toBe('custom');
    expect(
      client.supportsConditionalHeaders('https://any.example/a.ics'),
    ).toBe(true);
  });
});
