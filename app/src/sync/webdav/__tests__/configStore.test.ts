import { describe, expect, it } from 'vitest';

import {
  defaultWebDavConfig,
  LocalStorageWebDavConfigStore,
} from '../configStore.ts';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
    },
  };
}

describe('WebDAV 配置存储', () => {
  it('只落盘地址/账号/目录/设备，不写入应用密码', async () => {
    const { map, storage } = memoryStorage();
    const store = new LocalStorageWebDavConfigStore(storage);
    const config = {
      ...defaultWebDavConfig(),
      baseUrl: 'https://dav.example.com/dav',
      username: 'alice',
      password: 'super-secret-password',
      updatedAt: '2026-10-26T00:00:00.000Z',
    };

    await store.save(config);
    const raw = [...map.values()].join('\n');
    expect(raw).toContain('https://dav.example.com/dav');
    expect(raw).toContain('alice');
    expect(raw).not.toContain('super-secret-password');
    expect(raw).not.toContain('"password"');

    const loaded = await store.load();
    expect(loaded?.baseUrl).toBe('https://dav.example.com/dav');
    expect(loaded?.passwordSaved).toBe(false);
  });

  it('损坏/版本不匹配的数据回退为空，不抛出', async () => {
    const { map, storage } = memoryStorage();
    map.set('zhixing.webdav.config.v1', '{not-json');
    const store = new LocalStorageWebDavConfigStore(storage);
    expect(await store.load()).toBeNull();

    map.set('zhixing.webdav.config.v1', JSON.stringify({ version: 2 }));
    expect(await store.load()).toBeNull();
  });
});
