/**
 * 设置页与外壳之间的轻量同步事件。
 * 设置页改主题后通知 Shell 重读 localStorage；顶栏改外观后也广播同一事件，
 * 让设置页的回显保持一致。
 */
export const APPEARANCE_CHANGED_EVENT = 'zhixing:appearance-changed';

/**
 * 完整设备偏好变化事件。外壳用它即时启停失焦遮挡与剪贴板保护，
 * 不必要求用户重启应用。事件详情是 `AppSettings`，不包含业务数据。
 */
export const SETTINGS_CHANGED_EVENT = 'zhixing:settings-changed';
