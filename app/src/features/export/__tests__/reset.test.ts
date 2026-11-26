import { describe, expect, it } from 'vitest';

import type { DbInvoker } from '../../../data/db/client';
import {
  createDbResetTarget,
  createDefaultResetTarget,
  RESET_DOMAIN_COMMAND,
  type ResetDomainReport,
} from '../reset';

const REPORT: ResetDomainReport = {
  deletedRows: 12,
  preservedSettings: 4,
  seedApplied: true,
  samplesInserted: 28,
  inboxCreated: true,
  workCreated: true,
  seedMarker: '0002_domain',
};

describe('业务数据重置目标', () => {
  it('桌面目标只调用 db_reset_domain，并原样返回报告', async () => {
    const calls: Array<{ command: string; args: unknown }> = [];
    const invoker: DbInvoker = async (command, args) => {
      calls.push({ command, args });
      return REPORT as never;
    };

    const report = await createDbResetTarget(invoker).reset();

    expect(calls).toEqual([
      { command: RESET_DOMAIN_COMMAND, args: undefined },
    ]);
    expect(report).toEqual(REPORT);
  });

  it('缺命令时给出可操作提示，而不是伪成功', async () => {
    const invoker: DbInvoker = async () => {
      throw new Error('Command db_reset_domain not found');
    };
    await expect(createDbResetTarget(invoker).reset()).rejects.toThrow(
      /当前桌面版本缺少业务数据重置命令.*数据未改动/,
    );
  });

  it('失败原因原样抛给 UI，便于显示事务回滚提示', async () => {
    const invoker: DbInvoker = async () => {
      throw new Error('database is locked');
    };
    await expect(createDbResetTarget(invoker).reset()).rejects.toThrow(
      'database is locked',
    );
  });

  it('浏览器环境不伪造重置目标', () => {
    expect(createDefaultResetTarget()).toBeNull();
  });
});
