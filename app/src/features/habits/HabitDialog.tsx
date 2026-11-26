/** 新建 / 编辑习惯；删除走应用内确认弹层，确认后连同日志一起删除。 */

import { useEffect, useId, useState, type FormEvent } from 'react';

import type { Habit } from '../../data/db/types';
import { ConfirmDialog } from './Feedback';
import { HabitIcon } from './HabitIcon';
import {
  DEFAULT_HABIT_COLOR,
  DEFAULT_HABIT_ICON,
  HABIT_COLORS,
  HABIT_ICONS,
  normalizeHabitIcon,
  type HabitIconKey,
} from './stats';

export type HabitDraft = {
  title: string;
  schedule: string;
  icon: HabitIconKey;
  color: string;
};

export type HabitDialogProps = {
  open: boolean;
  habit: Habit | null;
  onClose: () => void;
  onSave: (draft: HabitDraft) => Promise<void>;
  onDelete?: () => Promise<void>;
};

export function HabitDialog({
  open,
  habit,
  onClose,
  onSave,
  onDelete,
}: HabitDialogProps) {
  const titleId = useId();
  const [title, setTitle] = useState('');
  const [schedule, setSchedule] = useState('每天');
  const [icon, setIcon] = useState<HabitIconKey>(DEFAULT_HABIT_ICON);
  const [color, setColor] = useState<string>(DEFAULT_HABIT_COLOR);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setTitle(habit?.title ?? '');
    setSchedule(habit?.schedule ?? '每天');
    setIcon(normalizeHabitIcon(habit?.icon));
    setColor(habit?.color || DEFAULT_HABIT_COLOR);
    setError(null);
    setSaving(false);
    setDeleting(false);
    setConfirmingDelete(false);
  }, [open, habit]);

  if (!open) {
    return null;
  }

  const close = () => {
    if (saving || deleting) {
      return;
    }
    setError(null);
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setError('先写个名称');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({
        title: trimmed,
        schedule: schedule.trim() || '每天',
        icon,
        color,
      });
      setSaving(false);
      onClose();
    } catch (reason) {
      setSaving(false);
      setError(reason instanceof Error ? reason.message : '保存失败，请重试');
    }
  };

  const confirmDelete = async () => {
    if (!onDelete) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
      setDeleting(false);
      setConfirmingDelete(false);
      onClose();
    } catch (reason) {
      setDeleting(false);
      setError(reason instanceof Error ? reason.message : '删除失败，请重试');
    }
  };

  if (confirmingDelete && habit) {
    return (
      <ConfirmDialog
        open
        danger
        pending={deleting}
        title="删除这个习惯？"
        description={
          <>
            将删除「{habit.title}」和它的全部打卡记录。已经安排的任务不会被删除，
            也不会变成任务。
          </>
        }
        confirmLabel="删除"
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          if (!deleting) {
            setConfirmingDelete(false);
          }
        }}
      />
    );
  }

  return (
    <div className="habit-overlay" role="presentation" onMouseDown={close}>
      <form
        className="habit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
      >
        <h2 id={titleId}>{habit ? '编辑习惯' : '新建习惯'}</h2>
        <p className="habit-dialog-desc">
          习惯只负责记录节奏；需要具体行动时，用「安排行动」创建任务。热力图里可以补卡。
        </p>

        <label className="habit-field">
          <span>名称</span>
          <input
            value={title}
            placeholder="例如：早起"
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>

        <label className="habit-field">
          <span>频率/时间</span>
          <input
            value={schedule}
            placeholder="每天 · 07:00"
            onChange={(event) => setSchedule(event.target.value)}
          />
        </label>

        <fieldset
          className={`habit-field habit-icon-field${
            saving ? ' is-disabled' : ''
          }`}
          disabled={saving}
        >
          <legend>图标</legend>
          <div className="habit-icon-picker">
            {HABIT_ICONS.map((item) => {
              const selected = icon === item.value;
              return (
                <label
                  key={item.value}
                  className={`habit-icon-option${
                    selected ? ' is-selected' : ''
                  }`}
                >
                  <input
                    type="radio"
                    name="habit-icon"
                    value={item.value}
                    checked={selected}
                    aria-label={`${item.label}图标`}
                    onChange={() => setIcon(item.value)}
                  />
                  <span className="habit-icon-option-glyph">
                    <HabitIcon icon={item.value} size={20} decorative />
                  </span>
                  <span className="habit-icon-option-label">{item.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <label className="habit-field">
          <span>颜色</span>
          <select
            value={color}
            onChange={(event) => setColor(event.target.value)}
          >
            {HABIT_COLORS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        {error ? (
          <p className="habit-dialog-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="habit-dialog-actions">
          {habit && onDelete ? (
            <button
              type="button"
              className="habit-button habit-button--danger"
              onClick={() => setConfirmingDelete(true)}
              disabled={saving}
            >
              删除
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            className="habit-button"
            onClick={close}
            disabled={saving}
          >
            取消
          </button>
          <button
            type="submit"
            className="habit-button habit-button--primary"
            disabled={saving}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}
