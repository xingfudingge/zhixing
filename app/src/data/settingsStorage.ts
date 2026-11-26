/**
 * 设备偏好的存储键。
 *
 * 单独放在这里，避免「读取导出目录」与「设置仓储」互相依赖：
 * - `settings.ts` 负责完整偏好对象的读写；
 * - `features/export/location.ts` 只在保存时读取默认目录；
 * - 两边必须使用同一个 localStorage 镜像键与设置键，否则设置页里选了目录，
 *   保存面板却仍然拿不到。
 */

/** 设备偏好在 localStorage 的镜像键（SQLite 仍是桌面端权威）。 */
export const SETTINGS_STORAGE_KEY = 'zhixing.settings.v1';

/** 默认导出目录；`null` / 空字符串表示每次由保存面板选择。 */
export const EXPORT_DIRECTORY_SETTING_KEY = 'export.directory';
