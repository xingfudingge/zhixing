/** 键盘可达的“移动到…”弹层：树选择目标父级，根级也是显式选项。 */

import { useEffect, useId, useState } from 'react';

import type { List } from '../../data/db/types';
import {
  listDepthOf,
  listPath,
  orderedUserLists,
  validateListMove,
} from './tree';

export type ListMoveDialogProps = {
  open: boolean;
  list: List | null;
  lists: List[];
  onClose: () => void;
  onSubmit: (parentId: string | null) => Promise<void>;
};

export function ListMoveDialog({
  open,
  list,
  lists,
  onClose,
  onSubmit,
}: ListMoveDialogProps) {
  const titleId = useId();
  const [parentId, setParentId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !list) {
      return;
    }
    setParentId(list.parentId ?? '');
    setError(null);
    setSubmitting(false);
  }, [open, list]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!open || !list) {
    return null;
  }

  const options = orderedUserLists(lists).filter((candidate) => {
    if (candidate.id === list.id) {
      return false;
    }
    return validateListMove(lists, list.id, candidate.id) === null;
  });

  const submit = async () => {
    const target = parentId === '' ? null : parentId;
    const reason = validateListMove(lists, list.id, target);
    if (reason) {
      setError(reason);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(target);
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : '移动失败');
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
        <h2 id={titleId}>移动「{list.name}」</h2>
        <p className="task-dialog-desc">
          选择新的父清单；移到根级不会删除任何任务。当前层级：
          {listDepthOf(lists, list.id)} / 3。
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="task-field">
            <label htmlFor={`${titleId}-parent`}>移动到</label>
            <select
              id={`${titleId}-parent`}
              value={parentId}
              onChange={(event) => {
                setParentId(event.target.value);
                setError(null);
              }}
            >
              <option value="">根级</option>
              {options.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {'　'.repeat(Math.max(0, listDepthOf(lists, candidate.id) - 1))}
                  {listPath(lists, candidate.id)}
                </option>
              ))}
            </select>
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
              {submitting ? '移动中…' : '移动'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
