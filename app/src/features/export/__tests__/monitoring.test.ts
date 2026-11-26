import { afterEach, describe, expect, it } from 'vitest';

import { monitor } from '../monitoring';

afterEach(() => {
  monitor.setEnabled(false);
  monitor.reset();
});

describe('本机性能/错误监控', () => {
  it('记录耗时与错误，并统一脱敏', () => {
    monitor.setEnabled(true);
    monitor.timing('export.zip', 120, { format: 'zip' });
    monitor.timing('restore.apply', 4200, { format: 'zip' });
    monitor.error('export.zip', new Error('failed token=abc123 password=p@ss'));

    const snapshot = monitor.snapshot();
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.slowEvents.map((event) => event.name)).toContain('restore.apply');
    expect(snapshot.errors).toHaveLength(1);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('p@ss');
    expect(serialized).toContain('export.zip');
  });

  it('install 只注册一次，cleanup 后移除监听', () => {
    monitor.setEnabled(true);
    const cleanup = monitor.install();
    const cleanupAgain = monitor.install();
    expect(cleanupAgain).toBe(cleanup);
    window.dispatchEvent(
      new ErrorEvent('error', {
        error: new Error('window boom'),
        message: 'window boom',
      }),
    );
    const snapshot = monitor.snapshot();
    expect(snapshot.errors.some((event) => event.name === 'window.error')).toBe(
      true,
    );
    cleanup();
    // cleanup 会清空安装标记；再次安装返回新的 cleanup，而不是复用旧监听。
    const reinstall = monitor.install();
    expect(reinstall).not.toBe(cleanup);
    reinstall();
  });
});
