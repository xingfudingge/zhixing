/**
 * 业务数据重置（AUD-005）。
 *
 * 桌面壳调用 Rust `db_reset_domain`：同一事务内清空业务表、重新写入种子，
 * 保留 settings（设备/空间偏好）与许可/安装信息。渲染层不拼 SQL，也不
 * 删除数据库文件。浏览器预览没有 SQLite 业务库，因此默认目标为 null。
 */

import {
  createDbClient,
  isTauriRuntime,
  tauriInvoker,
  type DbInvoker,
  type ResetDomainReport,
} from '../../data/db/client';

export type { ResetDomainReport };

export interface BusinessResetTarget {
  reset(): Promise<ResetDomainReport>;
}

export const RESET_DOMAIN_COMMAND = 'db_reset_domain';

function normalizeError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const message =
    typeof reason === 'string' && reason.trim() ? reason : '重置失败，请重试';
  return new Error(message);
}

export function createDbResetTarget(
  invoker: DbInvoker = tauriInvoker,
): BusinessResetTarget {
  const client = createDbClient(invoker);
  return {
    async reset(): Promise<ResetDomainReport> {
      try {
        const report = await client.system.resetDomain();
        if (!report || typeof report.deletedRows !== 'number') {
          throw new Error('桌面壳返回了无效的重置结果');
        }
        return report;
      } catch (reason) {
        const error = normalizeError(reason);
        if (/not found|unknown command|未实现/i.test(error.message)) {
          throw new Error(
            '当前桌面版本缺少业务数据重置命令，请更新应用后重试；数据未改动。',
          );
        }
        throw error;
      }
    },
  };
}

/**
 * 不传 invoker 时：桌面壳装配真实命令；浏览器为 null，不伪造可用入口。
 */
export function createDefaultResetTarget(
  invoker?: DbInvoker,
): BusinessResetTarget | null {
  if (!isTauriRuntime()) return null;
  return invoker ? createDbResetTarget(invoker) : createDbResetTarget();
}
