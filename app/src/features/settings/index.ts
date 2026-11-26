/**
 * 设置功能入口。
 *
 * `SettingsPage` 被 `app/router.tsx` 静态导入，因此 runtime 桥会在应用启动时
 * 安装：编辑器排版立即应用，默认清单/目录在首次新建对象时生效。
 */

import '../../styles/density.css';
import './settings.css';

export { SettingsWorkspace } from './SettingsWorkspace';
export type { SettingsWorkspaceProps } from './SettingsWorkspace';
export { APPEARANCE_CHANGED_EVENT } from './events';
export {
  useSettingsWorkspace,
  type SettingsLoadState,
  type SettingsSaveState,
  type SettingsWorkspaceOptions,
  type SettingsWorkspaceValue,
} from './useSettingsWorkspace';
export {
  applyNoteDefaults,
  applySettingsToDocument,
  applyTaskDefaults,
  defaultNoteTitle,
  ensureRuntimeSettings,
  getRuntimeSettings,
  installSettingsBridge,
  refreshRuntimeFromLocal,
  setRuntimeSettings,
} from './runtime';
export type { SettingsSource } from './source';
