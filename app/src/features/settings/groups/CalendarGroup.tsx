import { useEffect, useMemo, useState } from 'react';

import { addDaysISO, formatWeekday, todayISO } from '../../../data/calendar/date';
import {
  DATE_EXCEPTION_KIND_LABELS,
  normalizeDateExceptions,
  removeDateException,
  upsertDateException,
  type DateException,
  type DateExceptionKind,
} from '../../../data/calendar/exceptions';
import { HOLIDAY_PACKAGE_2026 } from '../../../data/calendar/holidays';
import { isTauriRuntime } from '../../../data/db/client';
import {
  IcsSubscriptionsPanel,
  createDefaultIcsSyncService,
  type IcsSyncService,
} from '../../calendar/ics';
import {
  BUILTIN_OFFLINE_SOURCE,
  HOLIDAY_SOURCE_CHOICES,
  HOLIDAY_SOURCE_DEFINITIONS,
  applyHolidaySourceChoice,
  createDefaultHolidaySyncService,
  defaultHolidaySyncState,
  holidaySourceChoice,
  holidaySourceDefinition,
  inferHolidayCustomFormat,
  normalizeHolidayPreferences,
  resolveHolidayTransports,
  validateHolidayCustomUrl,
  type HolidayPreferences,
  type HolidaySourceChoice,
  type HolidaySourceId,
  type HolidaySyncService,
  type HolidaySyncState,
  type HolidayTransport,
} from '../../calendar/holiday';
import {
  WEEKDAY_OPTIONS,
  WEEK_START_OPTIONS,
  WORKDAY_RULE_OPTIONS,
  isAlternatingDoubleWeek,
  normalizeWeekStart,
  normalizeWorkdayRule,
  startOfWeekISO,
  toggleCustomWorkday,
  type WorkdayRuleKind,
} from '../../calendar/workweek';
import { DatePicker } from '../../../ui/date/DatePicker';
import type { SettingsWorkspaceValue } from '../useSettingsWorkspace';
import {
  Segmented,
  SelectField,
  SettingsCard,
  SettingsRow,
  SettingsSwitch,
} from './Controls';

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '本机时区';
  } catch {
    return '本机时区';
  }
}

function describeWorkdayRule(
  rule: ReturnType<typeof normalizeWorkdayRule>,
  currentMonday: string,
): string {
  if (rule.rule === 'double') {
    return '周一至周五上班；个人例外/法定节假日/调休优先于该规则。';
  }
  if (rule.rule === 'single') {
    return '周一至周六上班、周日休息；个人例外/法定节假日/调休优先。';
  }
  if (rule.rule === 'alternating') {
    const isDouble = isAlternatingDoubleWeek(currentMonday, rule);
    return `一周双休、一周单休；本周为${isDouble ? '双休周' : '单休周'}。`;
  }
  return '仅勾选的周几上班；个人例外/法定节假日/调休优先。';
}

function formatError(reason: unknown, fallback = '操作失败，请重试'): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  return fallback;
}

function formatTimestamp(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatExceptionDate(value: string): string {
  return `${value} ${formatWeekday(value)}`;
}

function holidaySourceDescription(preferences: HolidayPreferences): string {
  if (preferences.mode === 'builtin') {
    return `内置 ${HOLIDAY_PACKAGE_2026.version} 离线数据包，不联网，也不会覆盖官方节假日。`;
  }
  if (preferences.mode === 'custom') {
    return preferences.customUrl
      ? '自定义 JSON/ICS 数据源；支持 {year} 占位符，只接受 http/https。'
      : '尚未填写自定义地址；填写并保存后才会同步。';
  }
  if (preferences.mode === 'auto') {
    return '自动按 holiday-cn → chinese-days → china-mainland-calendar 顺序同步；当前年失败才回退，下一年未公布不触发回退。';
  }
  const definition = holidaySourceDefinition(preferences.sourceId);
  return `${definition.name}（${definition.license}，覆盖 ${definition.coverageLabel}）；失败时保留上次成功缓存。`;
}

function holidayCacheSourceLabel(sourceId: string | null | undefined): string {
  if (!sourceId) return '内置离线 2026';
  if (sourceId === 'builtin') return '内置离线 2026';
  if (sourceId === 'custom') return '自定义 URL';
  try {
    return holidaySourceDefinition(sourceId as HolidaySourceId).shortName;
  } catch {
    return sourceId;
  }
}

function holidayStateDescription(
  preferences: HolidayPreferences,
  state: HolidaySyncState | null,
  years: readonly number[],
): string {
  if (preferences.mode === 'builtin') {
    return `内置版本 ${HOLIDAY_PACKAGE_2026.version} · 缓存年份 ${
      years.length > 0 ? years.join('、') : String(HOLIDAY_PACKAGE_2026.year)
    }`;
  }
  const last = state?.lastSyncAt
    ? `上次成功 ${formatTimestamp(state.lastSyncAt)}`
    : '尚未成功同步';
  const attempt = state?.lastAttemptAt
    ? `最近尝试 ${formatTimestamp(state.lastAttemptAt)}`
    : '尚未尝试';
  const cache =
    years.length > 0
      ? `缓存 ${years.join('、')} 年`
      : '暂无缓存，显示内置 2026';
  const pending =
    state && state.notPublishedYears.length > 0
      ? `；${state.notPublishedYears.join('、')} 年数据未公布`
      : '';
  const retry = state?.lastError && state.nextRetryAt
    ? `；下次自动重试 ${formatTimestamp(state.nextRetryAt)}`
    : '';
  return `${last} · ${attempt} · ${cache}${pending}${retry}`;
}

function holidayActiveText(
  preferences: HolidayPreferences,
  state: HolidaySyncState | null,
): string {
  if (preferences.mode === 'builtin') {
    return '内置离线 2026（不联网）';
  }
  if (!state?.activeSourceId) {
    return preferences.mode === 'custom'
      ? '自定义 URL（尚未同步）'
      : '内置离线 2026（未使用远端缓存）';
  }
  const transport =
    state.activeTransport && state.activeTransport !== 'auto'
      ? ` · ${state.activeTransport}`
      : '';
  return `${holidayCacheSourceLabel(state.activeSourceId)}${transport}`;
}

function holidayFallbackText(
  preferences: HolidayPreferences,
  state: HolidaySyncState | null,
): string {
  if (preferences.mode === 'builtin' || !state?.fallbackUsed) return '未回退';
  const from = state.fallbackFromSourceId
    ? holidayCacheSourceLabel(state.fallbackFromSourceId)
    : '原源/主传输';
  const to = holidayCacheSourceLabel(state.activeSourceId);
  const reason = state.fallbackReason ? `；原因：${state.fallbackReason}` : '';
  return `从 ${from} 回退到 ${to}${reason}`;
}

function holidaySourceStatusText(
  sourceId: HolidaySourceId,
  state: HolidaySyncState | null,
  mode: HolidayPreferences['mode'],
): string {
  const status = state?.perSource[sourceId];
  const parts: string[] = [];
  if (mode !== 'builtin' && state?.activeSourceId === sourceId) {
    parts.push('当前使用');
  }
  if (status?.lastSuccessAt) {
    parts.push(`上次成功 ${formatTimestamp(status.lastSuccessAt)}`);
  } else {
    parts.push('尚未成功同步');
  }
  if (status?.cachedYears.length) {
    parts.push(`缓存 ${status.cachedYears.join('、')} 年`);
  }
  if (status?.notPublishedYears.length) {
    parts.push(`${status.notPublishedYears.join('、')} 年未公布`);
  }
  if (status?.lastError) {
    parts.push(`失败：${status.lastError}`);
  }
  return parts.join(' · ');
}

function holidaySourceBadge(
  sourceId: HolidaySourceId,
  state: HolidaySyncState | null,
  mode: HolidayPreferences['mode'],
): { label: string; className: string } {
  if (mode !== 'builtin' && state?.activeSourceId === sourceId) {
    return { label: '当前源', className: 'settings-badge is-ok' };
  }
  const status = state?.perSource[sourceId];
  if (status?.lastError) {
    return { label: '失败', className: 'settings-badge is-danger' };
  }
  if (status?.lastSuccessAt) {
    return { label: '可用', className: 'settings-badge' };
  }
  return { label: '未使用', className: 'settings-badge' };
}

export type CalendarGroupProps = {
  workspace: SettingsWorkspaceValue;
  /** 测试或浏览器预览注入；不传时使用 IndexedDB + SQLite 事件仓储。 */
  icsService?: IcsSyncService;
  /** 测试注入节假日同步服务；不传时使用 IndexedDB/内存缓存。 */
  holidayService?: HolidaySyncService;
};

export function CalendarGroup({
  workspace,
  icsService,
  holidayService,
}: CalendarGroupProps) {
  const { settings, updateCalendar } = workspace;
  const weekStart = normalizeWeekStart(settings.calendar.weekStart);
  const workdayRule = normalizeWorkdayRule(settings.calendar.workdayRule);
  const today = todayISO();
  const currentMonday = startOfWeekISO(today, 'monday');
  const alternatingAnchor = workdayRule.anchorMonday ?? currentMonday;
  const currentWeekIsDouble = isAlternatingDoubleWeek(today, {
    ...workdayRule,
    anchorMonday: alternatingAnchor,
  });
  // 订阅与最后同步时间存在 IndexedDB，重挂载/刷新后仍可读取。
  const [service] = useState<IcsSyncService>(
    () => icsService ?? createDefaultIcsSyncService(),
  );
  const [holidayServiceInstance] = useState<HolidaySyncService>(
    () => holidayService ?? createDefaultHolidaySyncService(),
  );
  const browserPreviewWithoutRuntime = !icsService && !isTauriRuntime();

  const holidayPreferences = useMemo(
    () => normalizeHolidayPreferences(settings.calendar.holidaySource),
    [settings.calendar.holidaySource],
  );
  const dateExceptions = useMemo(
    () => normalizeDateExceptions(settings.calendar.dateExceptions),
    [settings.calendar.dateExceptions],
  );

  const [holidayState, setHolidayState] = useState<HolidaySyncState | null>(
    null,
  );
  const [holidayYears, setHolidayYears] = useState<number[]>([]);
  const [holidayBusy, setHolidayBusy] = useState(false);
  const [holidayError, setHolidayError] = useState<string | null>(null);
  const [holidayNotice, setHolidayNotice] = useState<string | null>(null);
  const [customUrlDraft, setCustomUrlDraft] = useState(
    holidayPreferences.customUrl,
  );
  const [customUrlError, setCustomUrlError] = useState<string | null>(null);

  const [exceptionDate, setExceptionDate] = useState<string | null>(null);
  const [exceptionKind, setExceptionKind] =
    useState<DateExceptionKind>('rest');
  const [exceptionNote, setExceptionNote] = useState('');
  const [exceptionEditing, setExceptionEditing] = useState(false);
  const [exceptionError, setExceptionError] = useState<string | null>(null);

  const changeCalendar = (patch: Parameters<typeof updateCalendar>[0]) => {
    void updateCalendar(patch).catch(() => undefined);
  };

  const refreshHolidayState = async () => {
    const [state, packages] = await Promise.all([
      holidayServiceInstance.getState(),
      holidayServiceInstance.listPackages(),
    ]);
    setHolidayState(state);
    setHolidayYears(packages.map((item) => item.year));
  };

  useEffect(() => {
    setCustomUrlDraft(holidayPreferences.customUrl);
  }, [holidayPreferences.customUrl]);

  useEffect(() => {
    let cancelled = false;
    void refreshHolidayState()
      .then(() => {
        if (!cancelled) setHolidayError(null);
      })
      .catch((reason) => {
        if (!cancelled) setHolidayError(formatError(reason));
      });
    return () => {
      cancelled = true;
    };
    // 只在服务实例变化时重新读取；偏好变化由自动同步/手动同步刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holidayServiceInstance]);

  // 自动同步：默认关闭；打开后仍按服务内 24h 节流，失败只提示不伪装成功。
  useEffect(() => {
    if (
      holidayPreferences.mode === 'builtin' ||
      !holidayPreferences.autoSync
    ) {
      return;
    }
    let cancelled = false;
    void holidayServiceInstance
      .maybeAutoSync(holidayPreferences)
      .then(async (result) => {
        if (cancelled) return;
        await refreshHolidayState();
        if (cancelled) return;
        if (result) {
          setHolidayNotice(
            result.fallbackUsed
              ? `自动同步已回退到 ${holidayCacheSourceLabel(
                  result.activeSourceId,
                )}`
              : '自动同步完成',
          );
          setHolidayError(null);
        }
      })
      .catch(async (reason) => {
        if (cancelled) return;
        const state = await holidayServiceInstance
          .getState()
          .catch(() => null);
        if (cancelled) return;
        setHolidayState(state);
        setHolidayError(formatError(reason));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holidayServiceInstance, holidayPreferences]);

  const changeWorkdayKind = (value: WorkdayRuleKind) => {
    const next: ReturnType<typeof normalizeWorkdayRule> = {
      ...workdayRule,
      rule: value,
    };
    // 第一次选「大小周」时以本周为双休周，避免用 1970 年的基准
    // 让用户看到与预期相反的“本周单休”。
    if (value === 'alternating' && !next.anchorMonday) {
      next.anchorMonday = currentMonday;
    }
    changeCalendar({ workdayRule: next });
  };

  const setAlternatingWeek = (isDouble: boolean) => {
    changeCalendar({
      workdayRule: {
        ...workdayRule,
        rule: 'alternating',
        anchorMonday: isDouble
          ? currentMonday
          : addDaysISO(currentMonday, -7),
      },
    });
  };

  const changeHolidaySource = (value: string) => {
    setHolidayError(null);
    setHolidayNotice(null);
    setCustomUrlError(null);
    const next = applyHolidaySourceChoice(
      holidayPreferences,
      value as HolidaySourceChoice,
    );
    const supported =
      next.mode === 'builtin' || next.mode === 'custom'
        ? []
        : resolveHolidayTransports(next.sourceId, next.transport);
    changeCalendar({
      holidaySource:
        next.mode !== 'builtin' &&
        next.mode !== 'custom' &&
        supported.length === 0
          ? { ...next, transport: 'auto' }
          : next,
    });
  };

  const changeHolidayTransport = (value: string) => {
    setHolidayError(null);
    setHolidayNotice(null);
    changeCalendar({
      holidaySource: {
        ...holidayPreferences,
        transport: value as HolidayTransport,
      },
    });
  };

  const saveCustomUrl = () => {
    try {
      const customUrl = validateHolidayCustomUrl(customUrlDraft);
      setCustomUrlError(null);
      changeCalendar({
        holidaySource: normalizeHolidayPreferences({
          ...holidayPreferences,
          mode: 'custom',
          customUrl,
          customFormat: inferHolidayCustomFormat(customUrl),
        }),
      });
    } catch (reason) {
      setCustomUrlError(formatError(reason));
    }
  };

  const changeCustomFormat = (value: string) => {
    changeCalendar({
      holidaySource: normalizeHolidayPreferences({
        ...holidayPreferences,
        mode: 'custom',
        customFormat: value,
      }),
    });
  };

  const toggleHolidayAutoSync = (next: boolean) => {
    changeCalendar({
      holidaySource: { ...holidayPreferences, autoSync: next },
    });
  };

  const toggleHolidayFallback = (next: boolean) => {
    changeCalendar({
      holidaySource: { ...holidayPreferences, autoFallback: next },
    });
  };

  const runHolidaySync = async () => {
    setHolidayBusy(true);
    setHolidayError(null);
    setHolidayNotice(null);
    try {
      const result = await holidayServiceInstance.sync(holidayPreferences);
      setHolidayState(result.state);
      setHolidayYears(result.packages.map((item) => item.year));
      const warnings =
        result.warnings.length > 0 ? `；${result.warnings.join('；')}` : '';
      const activeLabel = holidayCacheSourceLabel(result.activeSourceId);
      if (result.fallbackUsed) {
        setHolidayNotice(
          `已回退到 ${activeLabel}${
            result.fallbackReason ? `（${result.fallbackReason}）` : ''
          }；已同步 ${result.fetchedYears.join('、') || activeLabel} 年数据${warnings}`,
        );
      } else if (result.notPublishedYears.length > 0) {
        setHolidayNotice(
          `${result.notPublishedYears.join('、')} 年数据尚未公布，已保留上次成功缓存${warnings}`,
        );
      } else if (result.notModified) {
        setHolidayNotice(`数据未变化（304，${activeLabel}）${warnings}`);
      } else if (result.fetchedYears.length > 0) {
        setHolidayNotice(
          `已同步 ${result.fetchedYears.join('、')} 年节假日（${activeLabel}）${warnings}`,
        );
      } else {
        setHolidayNotice(
          `同步完成，但没有取到新的年份数据（${activeLabel}）${warnings}`,
        );
      }
    } catch (reason) {
      setHolidayError(formatError(reason));
      const state = await holidayServiceInstance
        .getState()
        .catch(() => null);
      setHolidayState(state);
    } finally {
      setHolidayBusy(false);
    }
  };

  const clearHolidayCurrent = async () => {
    setHolidayBusy(true);
    setHolidayError(null);
    setHolidayNotice(null);
    try {
      const cleared = await holidayServiceInstance.clearCurrent(
        holidayPreferences,
      );
      await refreshHolidayState();
      setHolidayNotice(
        cleared && cleared !== 'builtin'
          ? `已清除当前源缓存（${holidayCacheSourceLabel(
              cleared,
            )}），已回退到内置离线 2026；其它源缓存、源设置与个人日期例外均保留`
          : '当前已是内置离线源，没有远端缓存可清除；源设置与个人日期例外均保留',
      );
    } catch (reason) {
      setHolidayError(formatError(reason));
    } finally {
      setHolidayBusy(false);
    }
  };

  const clearHolidayAll = async () => {
    setHolidayBusy(true);
    setHolidayError(null);
    setHolidayNotice(null);
    try {
      await holidayServiceInstance.clearAll();
      await refreshHolidayState();
      setHolidayState(defaultHolidaySyncState());
      setHolidayYears([]);
      setHolidayNotice('已清除全部节假日公共缓存；个人日期例外与源设置均保留');
    } catch (reason) {
      setHolidayError(formatError(reason));
    } finally {
      setHolidayBusy(false);
    }
  };

  const resetExceptionForm = () => {
    setExceptionDate(null);
    setExceptionKind('rest');
    setExceptionNote('');
    setExceptionEditing(false);
    setExceptionError(null);
  };

  const editException = (item: DateException) => {
    setExceptionDate(item.date);
    setExceptionKind(item.kind);
    setExceptionNote(item.note);
    setExceptionEditing(true);
    setExceptionError(null);
  };

  const saveException = () => {
    if (!exceptionDate) {
      setExceptionError('请选择例外日期');
      return;
    }
    const next = upsertDateException(dateExceptions, {
      date: exceptionDate,
      kind: exceptionKind,
      note: exceptionNote,
    });
    setExceptionError(null);
    void updateCalendar({ dateExceptions: next })
      .then(() => resetExceptionForm())
      .catch((reason) => setExceptionError(formatError(reason)));
  };

  const deleteException = (date: string) => {
    setExceptionError(null);
    void updateCalendar({
      dateExceptions: removeDateException(dateExceptions, date),
    }).catch((reason) => setExceptionError(formatError(reason)));
  };

  const remoteSource = holidayPreferences.mode !== 'builtin';
  const sourceChoice = holidaySourceChoice(holidayPreferences);
  const transportDefinitions =
    holidayPreferences.mode === 'auto' || holidayPreferences.mode === 'single'
      ? resolveHolidayTransports(holidayPreferences.sourceId, 'auto')
      : [];
  const holidayDescription = holidayStateDescription(
    holidayPreferences,
    holidayState,
    holidayPreferences.mode === 'builtin' ? [] : holidayYears,
  );

  return (
    <div className="settings-stack">
      <SettingsCard
        title="日历与工作日"
        description="显示、工作日规则、节假日同步源与个人日期例外即时生效；个人例外优先于法定节假日与周规则。"
      >
        <SettingsRow
          label="时区"
          description="本机时区；提醒与重复规则的时区设置在后续卡接入"
        >
          <span className="settings-value">{localTimeZone()}</span>
        </SettingsRow>

        <SettingsRow
          label="显示农历与节气"
          description="关闭后月、周、日视图与日期面板不再显示农历；公历与节假日保留"
        >
          <SettingsSwitch
            label="显示农历与节气"
            checked={settings.calendar.showLunar}
            onChange={(next) => {
              void updateCalendar({ showLunar: next }).catch(() => undefined);
            }}
          />
        </SettingsRow>

        <SettingsRow
          label="周起始日"
          description="月视图、周视图与日期选择器共用；ISO 周号仍按周一计算"
        >
          <Segmented
            label="周起始日"
            value={weekStart}
            options={WEEK_START_OPTIONS}
            onChange={(value) =>
              changeCalendar({ weekStart: normalizeWeekStart(value) })
            }
          />
        </SettingsRow>

        <SettingsRow
          label="工作日规则"
          description={describeWorkdayRule(workdayRule, currentMonday)}
        >
          <SelectField
            label="工作日规则"
            value={workdayRule.rule}
            onChange={(value) =>
              changeWorkdayKind(value as WorkdayRuleKind)
            }
            hint="个人例外 > 法定节假日/调休 > 周规则；日历与日期选择器按同一结果标记工作日/休息日。"
          >
            {WORKDAY_RULE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
        </SettingsRow>

        {workdayRule.rule === 'alternating' ? (
          <SettingsRow
            label="本周大小周"
            description={`本周为${
              currentWeekIsDouble ? '双休周' : '单休周'
            }；之后按周交替。`}
          >
            <Segmented
              label="本周大小周"
              value={currentWeekIsDouble ? 'double' : 'single'}
              options={[
                { value: 'double', label: '本周双休' },
                { value: 'single', label: '本周单休' },
              ]}
              onChange={(value) => setAlternatingWeek(value === 'double')}
            />
          </SettingsRow>
        ) : null}

        {workdayRule.rule === 'custom' ? (
          <SettingsRow
            label="自定义工作日"
            description="逐项勾选上班的周几；至少保留一天"
          >
            <div
              className="settings-segmented"
              role="group"
              aria-label="自定义工作日"
              style={{ flexWrap: 'wrap', maxWidth: 280 }}
            >
              {WEEKDAY_OPTIONS.map((day) => (
                <button
                  key={day.value}
                  type="button"
                  className="settings-segmented-button"
                  aria-label={`自定义工作日 ${day.label}`}
                  aria-pressed={workdayRule.customWorkdays.includes(
                    day.value,
                  )}
                  onClick={() =>
                    changeCalendar({
                      workdayRule: toggleCustomWorkday(
                        workdayRule,
                        day.value,
                      ),
                    })
                  }
                >
                  {day.label.replace('周', '')}
                </button>
              ))}
            </div>
          </SettingsRow>
        ) : null}

        <div className="settings-subhead">
          <b>节假日同步源</b>
          <span>
            3 个独立内置上游（均 MIT）；同一仓库的 jsDelivr/GitHub Raw
            只算传输镜像，不重复计源
          </span>
        </div>

        <SettingsRow
          label="数据源"
          description={holidaySourceDescription(holidayPreferences)}
        >
          <SelectField
            label="节假日数据源"
            value={sourceChoice}
            onChange={changeHolidaySource}
            hint="独立源：holiday-cn / chinese-days / china-mainland-calendar；不使用 GPL/AGPL 数据。"
          >
            {HOLIDAY_SOURCE_CHOICES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
        </SettingsRow>

        {holidayPreferences.mode === 'auto' ||
        holidayPreferences.mode === 'single' ? (
          <SettingsRow
            label="传输方式"
            description="传输镜像只降低 CDN 单点风险，不增加独立源数量"
          >
            <SelectField
              label="节假日传输方式"
              value={
                transportDefinitions.some(
                  (item) => item.id === holidayPreferences.transport,
                )
                  ? holidayPreferences.transport
                  : 'auto'
              }
              onChange={changeHolidayTransport}
              hint="GitHub Raw / unpkg 与主传输属于同一上游，故障转移时不会当成新源。"
            >
              <option value="auto">自动（主传输优先）</option>
              {transportDefinitions.map((transport) => (
                <option key={transport.id} value={transport.id}>
                  {transport.label}
                </option>
              ))}
            </SelectField>
          </SettingsRow>
        ) : null}

        {holidayPreferences.mode === 'custom' ? (
          <>
            <SettingsRow
              label="自定义源地址"
              description="支持 {year} 占位符；只允许 http/https，不内嵌账号密码"
            >
              <div className="settings-holiday-url">
                <input
                  className="settings-text-input"
                  aria-label="自定义节假日 URL"
                  value={customUrlDraft}
                  onChange={(event) => setCustomUrlDraft(event.target.value)}
                  placeholder="https://example.com/holidays-{year}.json"
                />
                <button
                  type="button"
                  className="settings-button settings-button--small"
                  onClick={saveCustomUrl}
                >
                  保存地址
                </button>
                {customUrlError ? (
                  <p className="settings-error" role="alert">
                    {customUrlError}
                  </p>
                ) : null}
              </div>
            </SettingsRow>
            <SettingsRow
              label="自定义格式"
              description="按 URL 自动推断；也可手动指定中文节假日 JSON 或 ICS"
            >
              <SelectField
                label="自定义数据格式"
                value={holidayPreferences.customFormat}
                onChange={changeCustomFormat}
              >
                <option value="holiday-cn-json">holiday-cn JSON</option>
                <option value="chinese-days-json">chinese-days JSON</option>
                <option value="ics">iCalendar（ICS）</option>
              </SelectField>
            </SettingsRow>
          </>
        ) : null}

        <SettingsRow
          label="失败回退"
          description={
            remoteSource
              ? holidayPreferences.mode === 'auto'
                ? '自动模式固定按优先级回退；下一年未公布不触发回退'
                : '当前源失败/坏包时按优先级回退；下一年未公布不触发回退'
              : '内置离线源不联网，无需回退'
          }
        >
          <SettingsSwitch
            label="失败时按优先级回退节假日源"
            checked={
              holidayPreferences.mode === 'auto'
                ? true
                : holidayPreferences.autoFallback
            }
            disabled={!remoteSource || holidayPreferences.mode === 'auto'}
            onChange={toggleHolidayFallback}
          />
        </SettingsRow>

        <SettingsRow
          label="自动同步"
          description={
            remoteSource
              ? '打开后进入日历/设置页时检查更新，成功最多每 24 小时一次；失败按 15m 起退避'
              : '内置源不联网；切换到远端源后可打开'
          }
        >
          <SettingsSwitch
            label="自动同步节假日"
            checked={holidayPreferences.autoSync}
            disabled={!remoteSource}
            onChange={toggleHolidayAutoSync}
          />
        </SettingsRow>

        <SettingsRow label="同步状态" description={holidayDescription}>
          <div className="settings-data-actions">
            <button
              type="button"
              className="settings-button settings-button--primary settings-button--small"
              onClick={() => void runHolidaySync()}
              disabled={!remoteSource || holidayBusy}
            >
              {holidayBusy ? '同步中…' : '立即同步'}
            </button>
            <button
              type="button"
              className="settings-button settings-button--small"
              onClick={() => void clearHolidayCurrent()}
              disabled={
                holidayBusy ||
                !remoteSource ||
                holidayPreferences.mode === 'builtin'
              }
            >
              清除当前源缓存
            </button>
            <button
              type="button"
              className="settings-button settings-button--small settings-button--danger"
              onClick={() => void clearHolidayAll()}
              disabled={holidayBusy || !remoteSource}
            >
              清除全部缓存
            </button>
          </div>
        </SettingsRow>

        <SettingsRow
          label="当前使用"
          description="只有当前年成功或 304 才会标记为当前源；回退不会污染原源缓存"
        >
          <span className="settings-value">
            {holidayActiveText(holidayPreferences, holidayState)}
          </span>
        </SettingsRow>

        <SettingsRow
          label="回退情况"
          description={holidayFallbackText(holidayPreferences, holidayState)}
        >
          <span className="settings-value">
            {holidayPreferences.mode !== 'builtin' && holidayState?.fallbackUsed
              ? '已回退'
              : '未回退'}
          </span>
        </SettingsRow>

        <ul className="settings-exception-list" aria-label="内置节假日源">
          {HOLIDAY_SOURCE_DEFINITIONS.map((source) => {
            const badge = holidaySourceBadge(
              source.id,
              holidayState,
              holidayPreferences.mode,
            );
            return (
              <li className="settings-exception-item" key={source.id}>
                <div className="settings-exception-main">
                  <b>{source.shortName}</b>
                  <span className="settings-badge">{source.license}</span>
                  <span className="settings-badge">
                    {source.priority === 1
                      ? '主源'
                      : source.priority === 2
                        ? '备源'
                        : '最后备源'}
                  </span>
                  <span className="settings-row-desc">
                    覆盖 {source.coverageLabel} · {source.availability}
                  </span>
                  <span className="settings-row-desc">{source.repository}</span>
                  <span className="settings-row-desc">
                    {holidaySourceStatusText(source.id, holidayState, holidayPreferences.mode)}
                  </span>
                </div>
                <span className={badge.className}>{badge.label}</span>
              </li>
            );
          })}
          <li className="settings-exception-item">
            <div className="settings-exception-main">
              <b>{BUILTIN_OFFLINE_SOURCE.name}</b>
              <span className="settings-badge">离线</span>
              <span className="settings-row-desc">
                {BUILTIN_OFFLINE_SOURCE.coverageLabel} ·{' '}
                {BUILTIN_OFFLINE_SOURCE.description}
              </span>
            </div>
            <span className="settings-badge">
              {holidayPreferences.mode === 'builtin' ? '当前源' : '兜底'}
            </span>
          </li>
        </ul>

        <SettingsRow
          label="同步源版本"
          description="内置版本来自人工数据包；远端版本优先取 ETag/Last-Modified"
        >
          <span className="settings-value">
            {holidayPreferences.mode === 'builtin'
              ? HOLIDAY_PACKAGE_2026.version
              : holidayState?.version ?? '尚未同步'}
          </span>
        </SettingsRow>

        {holidayError || (remoteSource && holidayState?.lastError) ? (
          <p className="settings-error" role="alert">
            节假日同步失败：{holidayError ?? holidayState?.lastError}
          </p>
        ) : null}
        {typeof navigator !== 'undefined' && navigator.onLine === false ? (
          <p className="settings-hint" role="status">
            当前离线：显示已缓存数据，联网后自动重试。
          </p>
        ) : null}
        {!holidayError &&
        holidayPreferences.mode !== 'builtin' &&
        holidayState?.fallbackUsed &&
        holidayState.fallbackReason ? (
          <p className="settings-hint" role="status">
            已回退：{holidayState.fallbackReason}
          </p>
        ) : null}
        {holidayNotice ? (
          <p className="settings-hint" role="status">
            {holidayNotice}
          </p>
        ) : null}

        <div className="settings-subhead">
          <b>个人日期例外</b>
          <span>调休上班、请假或临时上班；只影响工作日计算与日历标记</span>
        </div>

        <SettingsRow
          label="例外记录"
          description="优先级：个人例外 > 法定节假日/调休 > 周规则；同一天再次保存会更新而不是追加"
        >
          <span className="settings-value">{dateExceptions.length} 天</span>
        </SettingsRow>

        <div className="settings-exception-form">
          <label className="settings-sync-field">
            <span>日期</span>
            <DatePicker
              value={exceptionDate}
              onChange={setExceptionDate}
              ariaLabel="例外日期"
              emptyLabel="选择例外日期"
              showHelper={false}
            />
          </label>
          <label className="settings-sync-field">
            <span>类型</span>
            <select
              className="settings-select"
              aria-label="例外类型"
              value={exceptionKind}
              onChange={(event) =>
                setExceptionKind(event.target.value as DateExceptionKind)
              }
            >
              <option value="work">上班（调休/临时上班）</option>
              <option value="rest">休息（请假/调休）</option>
            </select>
          </label>
          <label className="settings-sync-field settings-sync-field-wide">
            <span>备注</span>
            <input
              className="settings-text-input"
              aria-label="例外备注"
              value={exceptionNote}
              onChange={(event) => setExceptionNote(event.target.value)}
              placeholder="可选，例如：补班 / 产检 / 年假"
              maxLength={200}
            />
          </label>
          <div className="settings-sync-actions">
            <button
              type="button"
              className="settings-button settings-button--primary settings-button--small"
              onClick={saveException}
              disabled={!exceptionDate}
            >
              {exceptionEditing ? '更新例外' : '添加例外'}
            </button>
            {exceptionEditing ? (
              <button
                type="button"
                className="settings-button settings-button--small"
                onClick={resetExceptionForm}
              >
                取消编辑
              </button>
            ) : null}
            {exceptionError ? (
              <span className="settings-error" role="alert">
                {exceptionError}
              </span>
            ) : null}
          </div>
        </div>

        {dateExceptions.length > 0 ? (
          <ul
            className="settings-exception-list"
            aria-label="个人日期例外列表"
          >
            {dateExceptions.map((item) => (
              <li className="settings-exception-item" key={item.date}>
                <div className="settings-exception-main">
                  <b>{formatExceptionDate(item.date)}</b>
                  <span
                    className={
                      item.kind === 'work'
                        ? 'settings-badge is-ok'
                        : 'settings-badge'
                    }
                  >
                    {DATE_EXCEPTION_KIND_LABELS[item.kind]}
                  </span>
                  {item.note ? (
                    <span className="settings-row-desc">{item.note}</span>
                  ) : null}
                </div>
                <div className="settings-data-actions">
                  <button
                    type="button"
                    className="settings-button settings-button--small"
                    onClick={() => editException(item)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="settings-button settings-button--small settings-button--danger"
                    onClick={() => deleteException(item.date)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-hint">还没有个人日期例外。</p>
        )}
      </SettingsCard>

      {browserPreviewWithoutRuntime ? (
        <p className="settings-hint" role="note">
          当前是浏览器预览：可以填写并校验 ICS 地址；同源订阅可读取，跨域订阅会受
          CORS 限制（条件请求还可能被预检拦截）。正式同步请在桌面壳内进行，走内置
          网络代理，不受 CSP/CORS 限制，也不影响只读语义。
        </p>
      ) : null}

      <IcsSubscriptionsPanel service={service} />
    </div>
  );
}
