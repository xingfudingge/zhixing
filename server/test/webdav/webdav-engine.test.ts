import { afterEach, describe, expect, it } from 'vitest';

import { MemorySyncStore } from '../../../app/src/sync/store.ts';
import { MemoryWebDavCursorStore } from '../../../app/src/sync/webdav/cursors.ts';
import { WebDavSyncEngine } from '../../../app/src/sync/webdav/engine.ts';
import {
  MemoryWebDavModeStore,
  WebDavModeController,
} from '../../../app/src/sync/webdav/modeController.ts';
import { evaluateModeSwitch } from '../../../packages/sync-webdav/src/index.ts';
import { MockWebDavServer } from './mock-webdav-server.ts';

const servers: MockWebDavServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.stop();
  }
});

async function startServer(): Promise<MockWebDavServer> {
  const server = new MockWebDavServer({
    username: 'alice',
    password: 'app-password',
  });
  await server.start();
  servers.push(server);
  return server;
}

function makeEngine(server: MockWebDavServer, deviceId: string): {
  engine: WebDavSyncEngine;
  store: MemorySyncStore;
  cursors: MemoryWebDavCursorStore;
} {
  const store = new MemorySyncStore();
  const cursors = new MemoryWebDavCursorStore({
    baseUrl: server.baseUrl,
    root: '/zhixing',
    spaceId: 'personal',
  });
  const engine = new WebDavSyncEngine(
    {
      baseUrl: server.baseUrl,
      username: 'alice',
      password: 'app-password',
      root: '/zhixing',
      spaceId: 'personal',
      deviceId,
      deviceName: deviceId,
      platform: 'macos',
      chunkSize: 512,
      retry: { maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} },
    },
    { store, cursors },
  );
  return { engine, store, cursors };
}

describe('WebDavSyncEngine', () => {
  it('两台设备通过 ops 目录增量同步，重复同步不重复写入', async () => {
    const server = await startServer();
    const a = makeEngine(server, 'device-a');
    const b = makeEngine(server, 'device-b');

    await a.engine.enqueue({
      entityType: 'task',
      entityId: 'task-1',
      payload: { title: '写周报', done: false },
    });
    const firstPush = await a.engine.sync();
    expect(firstPush.ok).toBe(true);
    expect(firstPush.pushed).toBe(1);
    expect(firstPush.outbox).toBe(0);
    expect(
      server.countFiles('/dav/zhixing/spaces/personal/ops/device-a'),
    ).toBe(1);

    const bPull = await b.engine.sync();
    expect(bPull.ok).toBe(true);
    expect(bPull.pulled).toBeGreaterThanOrEqual(1);
    expect((await b.store.getEntity('task', 'task-1'))?.fields.title).toBe(
      '写周报',
    );

    await b.engine.enqueue({
      entityType: 'task',
      entityId: 'task-1',
      payload: { title: '写周报（已改）' },
    });
    const bPush = await b.engine.sync();
    expect(bPush.pushed).toBe(1);

    const aPull = await a.engine.sync();
    expect(aPull.ok).toBe(true);
    expect(aPull.pulled).toBeGreaterThanOrEqual(1);
    expect((await a.store.getEntity('task', 'task-1'))?.fields.title).toBe(
      '写周报（已改）',
    );

    const before = server.countFiles('/dav/zhixing/spaces/personal/ops');
    const again = await a.engine.sync();
    expect(again.ok).toBe(true);
    expect(again.pushed).toBe(0);
    expect(again.pulled).toBe(0);
    expect(server.countFiles('/dav/zhixing/spaces/personal/ops')).toBe(before);
  });

  it('断网失败进入 outbox；恢复后强制重试只上传一次', async () => {
    const server = await startServer();
    const a = makeEngine(server, 'device-a');

    await a.engine.enqueue({
      entityType: 'task',
      entityId: 'task-offline',
      payload: { title: '离线创建' },
    });
    server.setOffline(true);
    const failed = await a.engine.sync();
    expect(failed.ok).toBe(false);
    expect(failed.online).toBe(false);
    expect(failed.outbox).toBe(1);
    expect(
      server.countFiles('/dav/zhixing/spaces/personal/ops/device-a'),
    ).toBe(0);

    server.setOffline(false);
    const recovered = await a.engine.sync({ force: true });
    expect(recovered.ok).toBe(true);
    expect(recovered.pushed).toBe(1);
    expect(recovered.outbox).toBe(0);
    expect(
      server.countFiles('/dav/zhixing/spaces/personal/ops/device-a'),
    ).toBe(1);

    const again = await a.engine.sync({ force: true });
    expect(again.pushed).toBe(0);
    expect(
      server.countFiles('/dav/zhixing/spaces/personal/ops/device-a'),
    ).toBe(1);
  });

  it('新设备通过快照 + 增量 op 完成首次同步', async () => {
    const server = await startServer();
    const a = makeEngine(server, 'device-a');
    await a.engine.enqueue({
      entityType: 'note',
      entityId: 'note-1',
      payload: { title: '架构笔记', body: '目录清单推导状态' },
    });
    await a.engine.sync();
    const snapshot = await a.engine.writeSnapshotNow();
    expect(snapshot.coveredSeq).toBeGreaterThanOrEqual(1);

    const b = makeEngine(server, 'device-b');
    const first = await b.engine.sync();
    expect(first.ok).toBe(true);
    const note = await b.store.getEntity('note', 'note-1');
    expect(note?.fields.title).toBe('架构笔记');
    const status = await b.engine.status();
    expect(status.entities).toBe(1);
    expect(status.snapshot?.coveredSeq).toBe(snapshot.coveredSeq);
  });

  it('remote status 从目录清单推导设备与最大 seq，不依赖 manifest', async () => {
    const server = await startServer();
    const a = makeEngine(server, 'device-a');
    await a.engine.enqueue({
      entityType: 'task',
      entityId: 'task-1',
      payload: { title: '一' },
    });
    await a.engine.sync();
    await a.engine.enqueue({
      entityType: 'task',
      entityId: 'task-2',
      payload: { title: '二' },
    });
    await a.engine.sync();

    const status = await a.engine.status({ includeRemote: true });
    expect(status.remote?.maxSeqByDevice['device-a']).toBe(2);
    expect(status.remote?.devices.map((device) => device.deviceId)).toContain(
      'device-a',
    );
  });
});

describe('同步模式切换保护', () => {
  it('纯函数：Web 端不能切 WebDAV；未上传修改需要确认', () => {
    const web = evaluateModeSwitch({
      platform: 'web',
      from: 'local',
      to: 'webdav',
      pendingUploads: 0,
    });
    expect(web.allowed).toBe(false);
    expect(web.code).toBe('WEBDAV_WEB_UNSUPPORTED');

    const pending = evaluateModeSwitch({
      platform: 'macos',
      from: 'local',
      to: 'webdav',
      pendingUploads: 3,
    });
    expect(pending.allowed).toBe(false);
    expect(pending.requiresConfirmation).toBe(true);
    expect(pending.code).toBe('PENDING_UPLOADS');

    const confirmed = evaluateModeSwitch({
      platform: 'macos',
      from: 'local',
      to: 'webdav',
      pendingUploads: 3,
      confirmed: true,
    });
    expect(confirmed.allowed).toBe(true);

    const toLocal = evaluateModeSwitch({
      platform: 'macos',
      from: 'webdav',
      to: 'local',
      pendingUploads: 2,
    });
    expect(toLocal.code).toBe('PENDING_UPLOADS_LOCAL');
    expect(toLocal.requiresConfirmation).toBe(true);
  });

  it('webdav → local 有未上传时阻止；确认后才写模式', async () => {
    const server = await startServer();
    const { engine } = makeEngine(server, 'device-a');
    const modeStore = new MemoryWebDavModeStore('webdav');
    const controller = new WebDavModeController({
      engine,
      platform: 'macos',
      store: modeStore,
    });
    await engine.enqueue({
      entityType: 'task',
      entityId: 'pending-task',
      payload: { title: '还没上传' },
    });

    const preview = await controller.preview('local');
    expect(preview.allowed).toBe(false);
    expect(preview.requiresConfirmation).toBe(true);

    await expect(controller.switchMode('local')).rejects.toMatchObject({
      decision: expect.objectContaining({ code: 'PENDING_UPLOADS_LOCAL' }),
    });
    expect(await modeStore.load()).toBe('webdav');

    const switched = await controller.switchMode('local', { confirmed: true });
    expect(switched.allowed).toBe(true);
    expect(await modeStore.load()).toBe('local');
  });

  it('local → webdav：先探测并上传 outbox，再写模式；失败不切模式', async () => {
    const server = await startServer();
    const { engine } = makeEngine(server, 'device-a');
    const modeStore = new MemoryWebDavModeStore('local');
    const controller = new WebDavModeController({
      engine,
      platform: 'macos',
      store: modeStore,
    });

    await engine.enqueue({
      entityType: 'task',
      entityId: 'switch-task',
      payload: { title: '切换前创建' },
    });

    const blocked = await controller.preview('webdav');
    expect(blocked.requiresConfirmation).toBe(true);

    const switched = await controller.switchMode('webdav', {
      confirmed: true,
    });
    expect(switched.allowed).toBe(true);
    expect(await modeStore.load()).toBe('webdav');
    expect(
      server.countFiles('/dav/zhixing/spaces/personal/ops/device-a'),
    ).toBe(1);
    expect(server.countFiles('/dav/zhixing/spaces/personal/snapshots')).toBe(2);
  });

  it('连接探测失败时保持原模式与 outbox', async () => {
    const server = await startServer();
    const { engine } = makeEngine(server, 'device-a');
    const modeStore = new MemoryWebDavModeStore('local');
    const controller = new WebDavModeController({
      engine,
      platform: 'macos',
      store: modeStore,
    });
    await engine.enqueue({
      entityType: 'task',
      entityId: 'keep-local',
      payload: { title: '不应丢失' },
    });
    server.setOffline(true);

    await expect(
      controller.switchMode('webdav', { confirmed: true }),
    ).rejects.toMatchObject({ code: 'MODE_SWITCH_BLOCKED' });
    expect(await modeStore.load()).toBe('local');
    expect(await engine.pendingCount()).toBe(1);
  });

  it('Web 端控制器拒绝 WebDAV', async () => {
    const server = await startServer();
    const { engine } = makeEngine(server, 'device-a');
    const modeStore = new MemoryWebDavModeStore('backend');
    const controller = new WebDavModeController({
      engine,
      platform: 'web',
      store: modeStore,
    });
    await expect(controller.switchMode('webdav')).rejects.toMatchObject({
      decision: expect.objectContaining({ code: 'WEBDAV_WEB_UNSUPPORTED' }),
    });
  });
});
