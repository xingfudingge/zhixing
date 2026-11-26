/**
 * 清单树的增删改与移动弹层状态。侧栏树和清单页共用同一套语义，
 * 但侧栏不挂弹层（通过“管理”进入 /lists 树页完成）。
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import type { List } from '../../data/db/types';
import { ConfirmDialog, useToast } from '../../features/tasks/Feedback';
import { useTaskAction } from '../../features/tasks/actions';
import { useTaskStore } from '../../features/tasks/TaskStore';
import { ListDialog, type ListDraft } from './ListDialog';
import { ListMoveDialog } from './ListMoveDialog';
import { nextSortOrder } from './tree';

type CreateState = {
  mode: 'create';
  parentId: string | null;
  parentName: string | null;
};

type EditState = { mode: 'edit'; editing: List };

type DialogState = CreateState | EditState | null;

export type ListDialogsOptions = {
  onCreated?: (list: List) => void;
  onDeleted?: (list: List) => void;
};

export function useListDialogs(options: ListDialogsOptions = {}) {
  const store = useTaskStore();
  const toast = useToast();
  const run = useTaskAction();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleteTarget, setDeleteTarget] = useState<List | null>(null);
  const [moveTarget, setMoveTarget] = useState<List | null>(null);

  const openCreate = useCallback(
    (parentId: string | null = null) => {
      const parent = parentId
        ? store.lists.find((list) => list.id === parentId) ?? null
        : null;
      setDialog({
        mode: 'create',
        parentId,
        parentName: parent?.name ?? null,
      });
    },
    [store.lists],
  );

  const openEdit = useCallback((list: List) => {
    setDialog({ mode: 'edit', editing: list });
  }, []);

  const openDelete = useCallback((list: List) => {
    setDeleteTarget(list);
  }, []);

  const openMove = useCallback((list: List) => {
    setMoveTarget(list);
  }, []);

  const submit = async (draft: ListDraft) => {
    if (dialog?.mode === 'edit') {
      const updated = await store.updateList(dialog.editing.id, {
        name: draft.name,
        color: draft.color,
        icon: draft.icon,
        sortOrder: dialog.editing.sortOrder,
      });
      setDialog(null);
      toast('清单已更新', { tone: 'success' });
      options.onCreated?.(updated);
      return;
    }
    const parentId = dialog?.mode === 'create' ? dialog.parentId : null;
    const created = await store.createList({
      name: draft.name,
      color: draft.color,
      icon: draft.icon,
      parentId,
      sortOrder: nextSortOrder(store.lists, parentId),
    });
    setDialog(null);
    options.onCreated?.(created);
    navigate(`/lists/${created.id}`);
    toast('已新建清单', { tone: 'success' });
  };

  const deleteDescription = useMemo(() => {
    if (!deleteTarget) {
      return null;
    }
    const taskCount = store.tasks.filter(
      (task) => task.listId === deleteTarget.id && task.deletedAt === null,
    ).length;
    const childCount = store.lists.filter(
      (list) =>
        list.parentId === deleteTarget.id && list.deletedAt === null,
    ).length;
    if (childCount > 0) {
      return `删除「${deleteTarget.name}」清单？${taskCount} 个任务会移到未安排，${childCount} 个子清单会上移一级；无日期的任务会出现在未安排，有日期的任务仍按日期显示在今天与日历。清单本身删除，不可撤销。`;
    }
    return `删除「${deleteTarget.name}」清单？${taskCount} 个任务会移到未安排；无日期的任务会出现在未安排，有日期的任务仍按日期显示在今天与日历。清单本身删除，不可撤销。`;
  }, [deleteTarget, store.lists, store.tasks]);

  const confirmDelete = () => {
    const target = deleteTarget;
    if (!target) {
      return;
    }
    void (async () => {
      const result = await run(() => store.deleteList(target.id), {
        success: (deleted) =>
          deleted.promotedLists > 0
            ? `清单已删除，${deleted.movedTasks} 个任务已移到未安排，${deleted.promotedLists} 个子清单已上移`
            : `清单已删除，${deleted.movedTasks} 个任务已移到未安排`,
      });
      if (result !== undefined) {
        setDeleteTarget(null);
        options.onDeleted?.(target);
      }
    })();
  };

  const node: ReactNode = (
    <>
      <ListDialog
        open={dialog !== null}
        mode={dialog?.mode === 'edit' ? 'edit' : 'create'}
        lists={store.lists}
        editing={dialog?.mode === 'edit' ? dialog.editing : null}
        parentId={dialog?.mode === 'create' ? dialog.parentId : null}
        parentName={dialog?.mode === 'create' ? dialog.parentName : null}
        title={
          dialog?.mode === 'create' && dialog.parentId
            ? '新建子清单'
            : undefined
        }
        onClose={() => setDialog(null)}
        onSubmit={submit}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除清单"
        description={deleteDescription}
        confirmLabel="删除清单"
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />

      <ListMoveDialog
        open={moveTarget !== null}
        list={moveTarget}
        lists={store.lists}
        onClose={() => setMoveTarget(null)}
        onSubmit={async (parentId) => {
          if (!moveTarget) {
            return;
          }
          const moved = await run(
            () =>
              store.moveList(moveTarget.id, {
                parentId,
                sortOrder: nextSortOrder(store.lists, parentId),
              }),
            {
              success: `已移动「${moveTarget.name}」`,
            },
          );
          if (moved !== undefined) {
            setMoveTarget(null);
          }
        }}
      />
    </>
  );

  return { openCreate, openEdit, openDelete, openMove, node };
}

