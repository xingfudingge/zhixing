/** 倒数日新建/编辑弹层。农历模式下由所选公历日派生农历月/日。 */

import { useEffect, useId, useState } from 'react';

import {
  COUNTDOWN_CATEGORIES,
  normalizeCountdownRepeat,
} from '../../data/calendar/countdowns';
import { lunarDayLabel, lunarInfo } from '../../data/calendar/lunar';
import type { CalendarType, Countdown } from '../../data/db/types';
import { DatePicker } from '../../ui/date';

export type CountdownDraft = {
  title: string;
  category: string;
  calendarType: CalendarType;
  targetDate: string;
  repeatRule: string;
  note: string;
};

export type CountdownPrefill = Partial<CountdownDraft>;

export type CountdownDialogProps = {
  open: boolean;
  initialDate: string;
  countdown: Countdown | null;
  prefill?: CountdownPrefill;
  onClose: () => void;
  onSubmit: (draft: CountdownDraft, countdownId?: string) => Promise<void>;
};

function draftFromCountdown(
  countdown: Countdown,
  initialDate: string,
): CountdownDraft {
  return {
    title: countdown.title,
    category: countdown.category || '自定义',
    calendarType: countdown.calendarType,
    targetDate: countdown.targetDate || initialDate,
    repeatRule: normalizeCountdownRepeat(
      countdown.calendarType,
      countdown.repeatRule || '单次',
    ),
    note: countdown.note,
  };
}

function emptyDraft(
  initialDate: string,
  prefill: CountdownPrefill = {},
): CountdownDraft {
  const merged: CountdownDraft = {
    title: '',
    category: '自定义',
    calendarType: 'solar',
    targetDate: initialDate,
    repeatRule: '单次',
    note: '',
    ...prefill,
  };
  return {
    ...merged,
    repeatRule: normalizeCountdownRepeat(
      merged.calendarType,
      merged.repeatRule,
    ),
  };
}

export function CountdownDialog({
  open,
  initialDate,
  countdown,
  prefill,
  onClose,
  onSubmit,
}: CountdownDialogProps) {
  const titleId = useId();
  const [draft, setDraft] = useState<CountdownDraft>(() =>
    countdown ? draftFromCountdown(countdown, initialDate) : emptyDraft(initialDate, prefill),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dateValid, setDateValid] = useState(true);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraft(
      countdown
        ? draftFromCountdown(countdown, initialDate)
        : emptyDraft(initialDate, prefill),
    );
    setError(null);
    setSubmitting(false);
    setDateValid(true);
  }, [open, countdown, initialDate, prefill]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const update = <K extends keyof CountdownDraft>(
    key: K,
    value: CountdownDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (error) {
      setError(null);
    }
  };

  const changeCalendarType = (calendarType: CalendarType) => {
    setDraft((current) => ({
      ...current,
      calendarType,
      repeatRule: normalizeCountdownRepeat(calendarType, current.repeatRule),
    }));
  };

  const repeatOptions =
    draft.calendarType === 'lunar'
      ? (['单次', '每年（农历）'] as const)
      : (['单次', '每年'] as const);

  const derivedLunar = draft.targetDate ? lunarInfo(draft.targetDate) : null;
  const derivedLunarLabel = derivedLunar
    ? `农历${derivedLunar.monthRaw}${lunarDayLabel(derivedLunar.day)}`
    : '';
  const lunarPreview =
    draft.calendarType === 'lunar' && derivedLunarLabel
      ? draft.repeatRule === '每年（农历）'
        ? `${derivedLunarLabel} → 每年此日`
        : derivedLunarLabel
      : '';

  const submit = async () => {
    if (!draft.title.trim()) {
      setError('请先写倒数日名称');
      return;
    }
    if (!draft.targetDate) {
      setError('请选择目标日期');
      return;
    }
    if (!dateValid) {
      setError('请先修正日期');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(
        {
          ...draft,
          title: draft.title.trim(),
          repeatRule: normalizeCountdownRepeat(
            draft.calendarType,
            draft.repeatRule,
          ),
        },
        countdown?.id,
      );
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : '保存倒数日失败，请重试',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="task-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="task-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(mouseEvent) => mouseEvent.stopPropagation()}
      >
        <h2 id={titleId}>{countdown ? '编辑倒数日' : '新建倒数日'}</h2>
        <p className="task-dialog-desc">
          倒数日只算距离目标日期还有几天：不占日历时间，没有完成状态，也不进入待办。
        </p>

        <form
          onSubmit={(formEvent) => {
            formEvent.preventDefault();
            void submit();
          }}
        >
          <div className="task-field">
            <label htmlFor={`${titleId}-title`}>名称</label>
            <input
              id={`${titleId}-title`}
              autoFocus
              value={draft.title}
              placeholder="例如：家庭纪念日"
              onChange={(inputEvent) => update('title', inputEvent.target.value)}
            />
          </div>

          <div className="task-field-row">
            <div className="task-field">
              <label htmlFor={`${titleId}-category`}>分类</label>
              <select
                id={`${titleId}-category`}
                value={draft.category}
                onChange={(selectEvent) =>
                  update('category', selectEvent.target.value)
                }
              >
                {COUNTDOWN_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
            </div>
            <div className="task-field">
              <label htmlFor={`${titleId}-calendar`}>历法</label>
              <select
                id={`${titleId}-calendar`}
                value={draft.calendarType}
                onChange={(selectEvent) =>
                  changeCalendarType(
                    selectEvent.target.value === 'lunar' ? 'lunar' : 'solar',
                  )
                }
              >
                <option value="solar">公历</option>
                <option value="lunar">农历</option>
              </select>
            </div>
          </div>

          <div className="task-field-row">
            <div className="task-field">
              <label htmlFor={`${titleId}-date`}>目标日期</label>
              <DatePicker
                id={`${titleId}-date`}
                value={draft.targetDate || null}
                required
                showHelper={false}
                onValidityChange={setDateValid}
                onChange={(next) => update('targetDate', next ?? '')}
              />
            </div>
            <div className="task-field">
              <label htmlFor={`${titleId}-repeat`}>重复</label>
              <select
                id={`${titleId}-repeat`}
                value={draft.repeatRule}
                onChange={(selectEvent) =>
                  update('repeatRule', selectEvent.target.value)
                }
              >
                {repeatOptions.map((rule) => (
                  <option key={rule} value={rule}>
                    {rule}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {lunarPreview ? (
            <p className="task-dialog-hint" data-testid="countdown-lunar-preview">
              目标公历日对应：{lunarPreview}
            </p>
          ) : null}

          <div className="task-field">
            <label htmlFor={`${titleId}-note`}>备注</label>
            <input
              id={`${titleId}-note`}
              value={draft.note}
              placeholder="可选"
              onChange={(inputEvent) => update('note', inputEvent.target.value)}
            />
          </div>

          {error ? (
            <p className="task-dialog-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="task-dialog-actions">
            <button type="button" className="task-button" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className="task-button task-button--primary"
              disabled={submitting || !dateValid}
            >
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
