/**
 * 设置页数据与保存编排。
 *
 * 保存采用“乐观更新 + 失败回滚”：UI 立即变，随后写入设置源；任何一条失败
 * 都恢复到上一个完整状态，并在页面显示错误，避免出现“看起来改了、其实没存”。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_APPEARANCE,
  applyAppearance,
  readAppearance,
  saveAppearance,
  type Appearance,
} from '../../app/shell/appearance';
import type { DbStatus, List } from '../../data/db/types';
import {
  DEFAULT_APP_SETTINGS,
  diffSettings,
  normalizeAppSettings,
  parseStoredSettings,
  writeLocalSettings,
  type AppSettings,
  type CalendarPreferences,
  type EditorSettings,
  type ExportLocationPreferences,
  type PrivacyPreferences,
  type TaskDefaults,
} from '../../data/repositories/settings';
import {
  createSettingsBackup,
  downloadTextFile,
  parseSettingsBackup,
  serializeSettingsBackup,
} from './backup';
import { monitor } from '../export/monitoring';
import { APPEARANCE_CHANGED_EVENT } from './events';
import {
  refreshRuntimeFromLocal,
  setRuntimeSettings,
} from './runtime';
import { defaultSettingsSource, type SettingsSource } from './source';

export type SettingsSaveState = 'saved' | 'saving' | 'error';
export type SettingsLoadState = 'loading' | 'ready' | 'error';

export type SettingsWorkspaceOptions = {
  /** 测试注入；不传时桌面端用 SQLite、浏览器用 localStorage。 */
  source?: SettingsSource;
  /** 固定时间，便于测试导出与默认标题。 */
  now?: () => Date;
};

function formatError(reason: unknown): string {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim()) {
    return reason;
  }
  return '操作失败，请重试';
}

function cloneDefaults(): AppSettings {
  return normalizeAppSettings(DEFAULT_APP_SETTINGS);
}

export function useSettingsWorkspace({
  source: injected,
  now = () => new Date(),
}: SettingsWorkspaceOptions = {}) {
  const source = useMemo<SettingsSource>(
    () => injected ?? defaultSettingsSource(),
    [injected],
  );

  const [settings, setSettings] = useState<AppSettings>(() =>
    refreshRuntimeFromLocal(),
  );
  const [appearance, setAppearance] = useState<Appearance>(() =>
    readAppearance(),
  );
  const [lists, setLists] = useState<List[]>([]);
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);
  const [status, setStatus] = useState<SettingsLoadState>(() =>
    source.mode === 'sqlite' && injected === undefined ? 'loading' : 'ready',
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SettingsSaveState>('saved');

  const settingsRef = useRef(settings);
  const appearanceRef = useRef(appearance);
  const dirtyRef = useRef(false);
  const noticeTimer = useRef<number | null>(null);

  const rememberNotice = useCallback((message: string | null) => {
    setNotice(message);
    if (noticeTimer.current !== null) {
      window.clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
    if (message) {
      noticeTimer.current = window.setTimeout(() => {
        setNotice(null);
        noticeTimer.current = null;
      }, 2800);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimer.current !== null) {
        window.clearTimeout(noticeTimer.current);
      }
    };
  }, []);

  // 诊断默认关闭；设置加载/修改后同步到本机监控开关（关闭时立即清空缓冲）。
  useEffect(() => {
    monitor.setEnabled(settings.privacy.diagnosticsEnabled);
  }, [settings.privacy.diagnosticsEnabled]);

  // 顶栏外观菜单与设置页共用 localStorage；互相广播，避免回显不一致。
  useEffect(() => {
    const sync = () => {
      const next = readAppearance();
      appearanceRef.current = next;
      setAppearance(next);
    };
    window.addEventListener(APPEARANCE_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener(APPEARANCE_CHANGED_EVENT, sync);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    // 浏览器预览的默认源已经同步读过 localStorage，无需再制造一次异步渲染。
    if (injected === undefined && source.mode === 'browser') {
      setStatus('ready');
      return () => {
        cancelled = true;
      };
    }

    async function load() {
      try {
        const rows = await source.settings.list({ scope: 'device' });
        if (cancelled) {
          return;
        }
        if (!dirtyRef.current) {
          const next = parseStoredSettings(rows);
          settingsRef.current = next;
          setSettings(next);
          writeLocalSettings(next);
          setRuntimeSettings(next);
        }
        setStatus('ready');
        setError(null);

        try {
          const nextLists = source.lists ? await source.lists.list() : [];
          if (!cancelled) {
            setLists(nextLists);
          }
        } catch {
          if (!cancelled) {
            setLists([]);
          }
        }

        try {
          const nextStatus = source.system ? await source.system.status() : null;
          if (!cancelled) {
            setDbStatus(nextStatus);
          }
        } catch {
          if (!cancelled) {
            setDbStatus(null);
          }
        }
      } catch (reason) {
        if (cancelled) {
          return;
        }
        setError(formatError(reason));
        setStatus(source.mode === 'browser' ? 'ready' : 'error');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [injected, source]);

  const commitSettings = useCallback(
    async (
      nextInput: AppSettings,
      message: string | null,
    ): Promise<AppSettings> => {
      const next = normalizeAppSettings(nextInput);
      const previous = settingsRef.current;
      const changed = diffSettings(previous, next);
      if (changed.length === 0) {
        return previous;
      }

      dirtyRef.current = true;
      settingsRef.current = next;
      setSettings(next);
      writeLocalSettings(next);
      setRuntimeSettings(next);
      setSaveState('saving');
      setError(null);

      try {
        for (const item of changed) {
          await source.settings.set(item);
        }
        setSaveState('saved');
        rememberNotice(message);
        return next;
      } catch (reason) {
        // 逐条写入可能只成功了一部分；尽力把已变化的键写回旧值。
        try {
          for (const item of diffSettings(next, previous)) {
            await source.settings.set(item);
          }
        } catch {
          // 回滚失败不掩盖原始错误；下次读取会以 SQLite 为准。
        }
        settingsRef.current = previous;
        setSettings(previous);
        writeLocalSettings(previous);
        setRuntimeSettings(previous);
        setSaveState('error');
        setError(formatError(reason));
        throw reason;
      }
    },
    [rememberNotice, source],
  );

  const updateAppearance = useCallback((patch: Partial<Appearance>) => {
    const next: Appearance = { ...appearanceRef.current, ...patch };
    appearanceRef.current = next;
    saveAppearance(next);
    applyAppearance(next);
    setAppearance(next);
    window.dispatchEvent(
      new CustomEvent(APPEARANCE_CHANGED_EVENT, { detail: next }),
    );
  }, []);

  const resetAppearance = useCallback(() => {
    updateAppearance(DEFAULT_APPEARANCE);
  }, [updateAppearance]);

  const updateEditor = useCallback(
    async (patch: Partial<EditorSettings>) => {
      const current = settingsRef.current;
      return commitSettings(
        {
          ...current,
          editor: { ...current.editor, ...patch },
        },
        '编辑器设置已保存',
      );
    },
    [commitSettings],
  );

  const updateTaskDefaults = useCallback(
    async (patch: Partial<TaskDefaults>) => {
      const current = settingsRef.current;
      return commitSettings(
        {
          ...current,
          task: { ...current.task, ...patch },
        },
        '任务与记录默认值已保存',
      );
    },
    [commitSettings],
  );

  const updateCalendar = useCallback(
    async (patch: Partial<CalendarPreferences>) => {
      const current = settingsRef.current;
      return commitSettings(
        {
          ...current,
          calendar: { ...current.calendar, ...patch },
        },
        '日历偏好已保存',
      );
    },
    [commitSettings],
  );

  const updatePrivacy = useCallback(
    async (patch: Partial<PrivacyPreferences>) => {
      const current = settingsRef.current;
      return commitSettings(
        {
          ...current,
          privacy: { ...current.privacy, ...patch },
        },
        '隐私与安全设置已保存',
      );
    },
    [commitSettings],
  );

  /**
   * 设置/清除默认导出目录。目录是否存在与可写由保存命令在落盘前校验；
   * 这里只记录用户选择的设备偏好，不写任何业务元数据。
   */
  const updateExportDirectory = useCallback(
    async (directory: string | null) => {
      const current = settingsRef.current;
      const next: Partial<ExportLocationPreferences> = { directory };
      return commitSettings(
        {
          ...current,
          export: { ...current.export, ...next },
        },
        directory ? '默认导出目录已保存' : '已清除默认导出目录',
      );
    },
    [commitSettings],
  );

  const resetPreferences = useCallback(async () => {
    const previousAppearance = appearanceRef.current;
    resetAppearance();
    try {
      await commitSettings(cloneDefaults(), '已重置本机偏好');
    } catch (reason) {
      updateAppearance(previousAppearance);
      throw reason;
    }
  }, [commitSettings, resetAppearance, updateAppearance]);

  const importBackup = useCallback(
    async (text: string) => {
      const backup = parseSettingsBackup(text);
      const previousAppearance = appearanceRef.current;
      updateAppearance(backup.appearance);
      try {
        await commitSettings(backup.settings, '已导入本机偏好');
      } catch (reason) {
        updateAppearance(previousAppearance);
        throw reason;
      }
    },
    [commitSettings, updateAppearance],
  );

  const exportBackup = useCallback(async () => {
    const stamp = now();
    const text = serializeSettingsBackup(
      settingsRef.current,
      appearanceRef.current,
      stamp,
    );
    const date = stamp.toISOString().slice(0, 10);
    const ok = await downloadTextFile(`zhixing-preferences-${date}.json`, text);
    rememberNotice(
      ok ? '已导出本机偏好备份' : '当前环境不支持下载，备份内容已在内存中生成',
    );
    return { text, downloaded: ok, backup: createSettingsBackup(
      settingsRef.current,
      appearanceRef.current,
      stamp,
    ) };
  }, [now, rememberNotice]);

  return {
    source,
    sourceMode: source.mode,
    settings,
    appearance,
    lists,
    dbStatus,
    status,
    saveState,
    error,
    notice,
    updateAppearance,
    updateEditor,
    updateTaskDefaults,
    updateCalendar,
    updatePrivacy,
    updateExportDirectory,
    resetPreferences,
    importBackup,
    exportBackup,
    clearNotice: () => rememberNotice(null),
  };
}

export type SettingsWorkspaceValue = ReturnType<typeof useSettingsWorkspace>;
