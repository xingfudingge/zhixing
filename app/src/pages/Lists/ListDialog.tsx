/** 清单新建 / 编辑弹层：名称必填、颜色可选、名称不重复。 */

import { useEffect, useId, useState, type CSSProperties } from 'react';

import type { List } from '../../data/db/types';
import { formatError } from '../../features/tasks/TaskStore';
import { LIST_ICON_OPTIONS, ListIconGlyph } from './ListIcon';

export const LIST_COLORS = [
  { value: '#5579d5', label: '蓝色' },
  { value: '#d97664', label: '珊瑚' },
  { value: '#3a9b9a', label: '青色' },
  { value: '#8066c7', label: '紫色' },
  { value: '#d89338', label: '琥珀' },
  { value: '#2f9e73', label: '绿色' },
  { value: '#8b96a3', label: '灰色' },
] as const;

export type ListDraft = {
  name: string;
  color: string;
  icon: string;
};

export type ListDialogProps = {
  open: boolean;
  mode: 'create' | 'edit';
  lists: List[];
  editing: List | null;
  /** 新建时的父清单；null 表示根级。 */
  parentId?: string | null;
  parentName?: string | null;
  title?: string;
  onClose: () => void;
  onSubmit: (draft: ListDraft) => Promise<void>;
};

export function ListDialog({
  open,
  mode,
  lists,
  editing,
  parentId = null,
  parentName = null,
  title,
  onClose,
  onSubmit,
}: ListDialogProps) {
  const titleId = useId();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(LIST_COLORS[0].value);
  const [icon, setIcon] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setName(editing?.name ?? '');
    setColor(editing?.color ?? LIST_COLORS[0].value);
    setIcon(editing?.icon ?? '');
    setError(null);
    setSubmitting(false);
  }, [open, editing]);

  if (!open) {
    return null;
  }

  const submit = async () => {
    const value = name.trim();
    if (!value) {
      setError('请先写清单名称');
      return;
    }
    const targetParentId = editing?.parentId ?? parentId;
    const duplicate = lists.some(
      (list) =>
        list.deletedAt === null &&
        list.id !== editing?.id &&
        list.parentId === targetParentId &&
        list.name.toLowerCase() === value.toLowerCase(),
    );
    if (duplicate) {
      setError('同一父级下已存在同名清单');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ name: value, color, icon });
    } catch (reason) {
      setError(formatError(reason));
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
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>
          {title ?? (mode === 'create' ? '新建清单' : '编辑清单')}
        </h2>
        <p className="task-dialog-desc">
          {mode === 'create' && parentName
            ? `在「${parentName}」下新建子清单；用户清单最多 3 层。清单只做归类。`
            : '清单只做归类；删除清单不会删除任务，任务会移到未安排。'}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="task-field">
            <label htmlFor={`${titleId}-name`}>名称</label>
            <input
              id={`${titleId}-name`}
              autoFocus
              value={name}
              placeholder="例如：工作 / 生活 / 阅读"
              onChange={(event) => {
                setName(event.target.value);
                if (error) {
                  setError(null);
                }
              }}
            />
          </div>

          <div className="task-field">
            <span className="task-field-label">颜色</span>
            <div className="task-color-swatches" role="group" aria-label="清单颜色">
              {LIST_COLORS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className="task-color-swatch"
                  style={{ '--swatch': item.value } as CSSProperties}
                  aria-label={`颜色：${item.label}`}
                  aria-pressed={color === item.value}
                  onClick={() => setColor(item.value)}
                />
              ))}
            </div>
          </div>

          <div className="task-field">
            <span className="task-field-label">图标</span>
            <div className="list-icon-options" role="group" aria-label="清单图标">
              {LIST_ICON_OPTIONS.map((item) => (
                <button
                  key={item.value || 'none'}
                  type="button"
                  className="list-icon-option"
                  aria-label={`图标：${item.label}`}
                  aria-pressed={icon === item.value}
                  title={item.label}
                  onClick={() => setIcon(item.value)}
                >
                  <ListIconGlyph icon={item.value} color={color} size={16} />
                </button>
              ))}
            </div>
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
              disabled={submitting}
            >
              {submitting ? '保存中…' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
