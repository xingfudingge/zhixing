import { NOTE_FOLDERS } from '../../../data/repositories/notes';
import {
  normalizeTaskCompletionBehavior,
  normalizeTaskDefaultReminder,
} from '../../../data/repositories/settings';
import { TASK_DEFAULT_REMINDER_OPTIONS } from '../../tasks/reminders';
import type { SettingsWorkspaceValue } from '../useSettingsWorkspace';
import {
  SelectField,
  SettingsCard,
  SettingsRow,
} from './Controls';

export function TaskGroup({
  workspace,
}: {
  workspace: SettingsWorkspaceValue;
}) {
  const { settings, lists, updateTaskDefaults } = workspace;
  const usableLists = lists.filter((list) => !list.isInbox);
  const storedListId = settings.task.defaultListId ?? '';
  const defaultListId = usableLists.some((list) => list.id === storedListId)
    ? storedListId
    : '';
  const noteFolderId = settings.task.noteFolderId ?? '';
  const defaultReminder = normalizeTaskDefaultReminder(
    settings.task.defaultReminder,
  );
  const completionBehavior = normalizeTaskCompletionBehavior(
    settings.task.completionBehavior,
  );

  const change = (patch: Parameters<typeof updateTaskDefaults>[0]) => {
    void updateTaskDefaults(patch).catch(() => undefined);
  };

  return (
    <SettingsCard
      title="任务与记录"
      description="新建任务与笔记的默认值；不改变已有对象。"
    >
      <SettingsRow
        label="默认清单"
        description="新建任务未手动改清单时使用；无日期任务仍进入未安排"
      >
        <SelectField
          label="默认清单"
          value={defaultListId}
          onChange={(value) =>
            change({ defaultListId: value === '' ? null : value })
          }
          disabled={usableLists.length === 0}
          hint={
            usableLists.length === 0
              ? '需在桌面壳内读取真实清单；浏览器预览不能设置默认清单。'
              : undefined
          }
        >
          <option value="">跟随清单顺序（第一个用户清单）</option>
          {usableLists.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name}
            </option>
          ))}
        </SelectField>
      </SettingsRow>

      <SettingsRow
        label="新笔记默认目录"
        description="知识页新建通用笔记时落到该目录"
      >
        <SelectField
          label="新笔记默认目录"
          value={noteFolderId}
          onChange={(value) => change({ noteFolderId: value || null })}
        >
          <option value="">不指定（沿用知识页当前目录）</option>
          {NOTE_FOLDERS.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </SelectField>
      </SettingsRow>

      <SettingsRow
        label="默认提醒"
        description="新建有日期任务且未单独设置提醒时使用；已有任务不变，无日期任务不写提醒。"
      >
        <SelectField
          label="默认提醒"
          value={defaultReminder}
          onChange={(value) =>
            change({
              defaultReminder: normalizeTaskDefaultReminder(value),
            })
          }
          hint="实际发送取决于「提醒与通知」中开启的通道与系统权限；未授权时会标记为权限阻止，不会伪造已发送。"
        >
          {TASK_DEFAULT_REMINDER_OPTIONS.map((option) => (
            <option key={option.value || 'off'} value={option.value}>
              {option.value === '' ? '关闭（不自动提醒）' : option.label}
            </option>
          ))}
        </SelectField>
      </SettingsRow>

      <SettingsRow
        label="完成后行为"
        description="勾选完成后是否让任务留在当前活动视图；不改变任务状态与完成时间。"
      >
        <SelectField
          label="完成后行为"
          value={completionBehavior}
          onChange={(value) =>
            change({
              completionBehavior: normalizeTaskCompletionBehavior(value),
            })
          }
          hint="只影响今天、清单、四象限与看板的活动视图；任务中心的「已完成」筛选与搜索始终可见。"
        >
          <option value="keep">保留在当前视图</option>
          <option value="remove">立即移出</option>
        </SelectField>
      </SettingsRow>
    </SettingsCard>
  );
}
