import { NavLink } from 'react-router-dom';

import {
  SETTINGS_GROUPS,
  type SettingsGroupId,
} from '../../app/shell/navigation';
import type { IcsSyncService } from '../calendar/ics';
import type { HolidaySyncService } from '../calendar/holiday';
import { AppearanceGroup } from './groups/AppearanceGroup';
import { CalendarGroup } from './groups/CalendarGroup';
import { DataGroup } from './groups/DataGroup';
import { NotifyGroup } from './groups/NotifyGroup';
import { OcrGroup } from './groups/OcrGroup';
import { PrivacyGroup } from './groups/PrivacyGroup';
import { SyncGroup } from './groups/SyncGroup';
import { TaskGroup } from './groups/TaskGroup';
import {
  useSettingsWorkspace,
  type SettingsWorkspaceOptions,
  type SettingsWorkspaceValue,
} from './useSettingsWorkspace';

function GroupBody({
  group,
  workspace,
  icsService,
  holidayService,
}: {
  group: SettingsGroupId;
  workspace: SettingsWorkspaceValue;
  icsService?: IcsSyncService;
  holidayService?: HolidaySyncService;
}) {
  switch (group) {
    case 'appearance':
      return <AppearanceGroup workspace={workspace} />;
    case 'task':
      return <TaskGroup workspace={workspace} />;
    case 'calendar':
      return (
        <CalendarGroup
          workspace={workspace}
          icsService={icsService}
          holidayService={holidayService}
        />
      );
    case 'notify':
      return <NotifyGroup />;
    case 'ocr':
      return <OcrGroup />;
    case 'privacy':
      return <PrivacyGroup workspace={workspace} />;
    case 'sync':
      return <SyncGroup sourceMode={workspace.sourceMode} />;
    case 'data':
      return <DataGroup workspace={workspace} />;
  }
}

function saveLabel(workspace: SettingsWorkspaceValue): string {
  if (workspace.status === 'loading') {
    return '正在读取本机偏好…';
  }
  if (workspace.status === 'error') {
    return '读取失败';
  }
  if (workspace.saveState === 'saving') {
    return '保存中…';
  }
  if (workspace.saveState === 'error') {
    return '保存失败';
  }
  return '已保存到本机';
}

export type SettingsWorkspaceProps = SettingsWorkspaceOptions & {
  group: SettingsGroupId;
  /** 供测试/预览注入 ICS 同步服务；正式桌面壳使用默认实现。 */
  icsService?: IcsSyncService;
  /** 供测试/预览注入节假日同步服务；正式桌面壳使用 IndexedDB 缓存。 */
  holidayService?: HolidaySyncService;
};

export function SettingsWorkspace({
  group,
  source,
  now,
  icsService,
  holidayService,
}: SettingsWorkspaceProps) {
  const workspace = useSettingsWorkspace({ source, now });
  const meta =
    SETTINGS_GROUPS.find((item) => item.id === group) ?? SETTINGS_GROUPS[0];

  return (
    <section className="page settings-page" aria-labelledby="settings-title">
      <header className="settings-head">
        <div>
          <p className="page-eyebrow">偏好 · 本机</p>
          <h1 id="settings-title">设置</h1>
          <p className="page-description">
            单用户、本机优先；修改即时生效并保存在本机，不需要账号。
          </p>
        </div>
        <div
          className={
            workspace.saveState === 'error'
              ? 'settings-head-status is-error'
              : 'settings-head-status'
          }
          role="status"
          aria-live="polite"
        >
          <span
            className={`settings-status-dot is-${workspace.saveState}`}
            aria-hidden="true"
          />
          {saveLabel(workspace)}
        </div>
      </header>

      {workspace.error ? (
        <div className="settings-banner is-error" role="alert">
          <b>设置操作失败</b>
          <span>{workspace.error}</span>
        </div>
      ) : null}

      {workspace.notice ? (
        <div className="settings-banner" role="status">
          {workspace.notice}
        </div>
      ) : null}

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分组">
          {SETTINGS_GROUPS.map((item) => (
            <NavLink
              key={item.id}
              to={`/settings/${item.id}`}
              aria-label={item.label}
              className={({ isActive }) =>
                isActive
                  ? 'settings-nav-link is-active'
                  : 'settings-nav-link'
              }
            >
              <span className="settings-nav-label">{item.label}</span>
              <span className="settings-nav-hint" aria-hidden="true">
                {item.hint}
              </span>
            </NavLink>
          ))}
        </nav>

        <div className="settings-body" aria-label={`${meta.label}设置`}>
          <GroupBody
            group={meta.id}
            workspace={workspace}
            icsService={icsService}
            holidayService={holidayService}
          />
        </div>
      </div>
    </section>
  );
}
