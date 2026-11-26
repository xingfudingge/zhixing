/**
 * 当前激活的节假日查询。
 *
 * 日历页从 IndexedDB 读取缓存后写入这里；日期选择器等同步组件没有异步
 * Provider，直接读取这份运行时快照。未同步/内置源时回退内置 2026 包。
 */

import {
  builtinHolidayLookup,
  createHolidayLookup,
  type HolidayLookup,
  type HolidayPackage,
} from '../../../data/calendar/holidays';

let activeLookup: HolidayLookup = builtinHolidayLookup;

export function setRuntimeHolidayPackages(
  packages: readonly HolidayPackage[] | null | undefined,
): void {
  activeLookup =
    packages && packages.length > 0
      ? createHolidayLookup(packages)
      : builtinHolidayLookup;
}

export function getRuntimeHolidayLookup(): HolidayLookup {
  return activeLookup;
}
