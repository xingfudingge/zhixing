/**
 * 设置页 WebDAV 配置组件。
 *
 * 复用 `sync/webdav` 已有的表单、真实连接探测与安全配置存储；模式选择由
 * 同步分组统一负责，因此这里关闭面板内置的模式按钮，避免两处状态打架。
 * Web 端不渲染该组件（入口保护在 SyncGroup 与 WebDavSettingsPanel 双层存在）。
 */

import type { Platform } from '../../../../packages/sync-webdav/src/index.ts';
import type {
  WebDavConfigStore,
  WebDavSavedConfig,
} from '../../sync/webdav/configStore.ts';
import {
  WebDavSettingsPanel,
  type WebDavConnectionTester,
  type WebDavFormValues,
} from '../../sync/webdav/WebDavSettingsPanel.tsx';

export type WebDavConfigProps = {
  platform: Platform;
  initialValues?: Partial<WebDavFormValues>;
  tester?: WebDavConnectionTester;
  configStore?: WebDavConfigStore;
  onValuesChange?: (values: WebDavFormValues) => void;
  onSaved?: (config: WebDavSavedConfig) => void;
};

export function WebDavConfig(props: WebDavConfigProps) {
  return <WebDavSettingsPanel {...props} showModeSwitch={false} />;
}
