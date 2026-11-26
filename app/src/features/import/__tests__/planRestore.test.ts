import { describe, expect, it } from 'vitest';

import { emptyBackupDataset, cloneDatasetShallow } from '../../export/dataset';
import { collectRelations, findDanglingRelations } from '../../export/relations';
import { SETTING_KEYS } from '../../../data/repositories/settings';
import {
  ATTACHMENT_TEXT,
  FIXED_NOW,
  makeDataset,
  makeParsed,
  makePayload,
} from '../../export/__tests__/testFixtures';
import { applyRestorePlan, planRestore } from '../planRestore';
import { createMemoryRestoreTarget } from './memoryTarget';

describe('恢复预览与计划', () => {
  it('空本机恢复完整备份：画板、附件、复盘、回收站对象与关系都在', async () => {
    const parsed = makeParsed();
    const local = emptyBackupDataset();
    const plan = planRestore(parsed, local);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.blocked).toHaveLength(0);

    const target = createMemoryRestoreTarget(local);
    const result = await applyRestorePlan(plan, target);
    expect(result.error).toBeNull();
    expect(result.applied).toBe(plan.operations.length);

    expect(target.dataset.notes.map((note) => note.id)).toEqual(
      expect.arrayContaining(['note-a', 'note-deleted', 'note-review']),
    );
    expect(target.dataset.notes.find((note) => note.id === 'note-deleted')?.deletedAt).toBeTruthy();
    expect(target.dataset.tasks.find((task) => task.id === 'task-deleted')?.deletedAt).toBeTruthy();
    expect(target.dataset.boards[0]!.nodes).toHaveLength(2);
    expect(target.dataset.boards[0]!.edges).toHaveLength(1);
    expect(target.dataset.reviewSnapshots[0]!.id).toBe('review-a');
    expect(target.dataset.attachments[0]!.id).toBe('attachment-a');
    expect(target.blobs.get('attachment-a')?.size).toBe(ATTACHMENT_TEXT.length);
    expect(
      target.dataset.settings.find((row) => row.key === SETTING_KEYS.editorFontSize)
        ?.value,
    ).toBe(15);
    expect(target.appearance).toEqual({
      theme: 'light',
      accent: 'blue',
      density: 'comfortable',
    });

    // 删除对象的关系不丢：任务仍在回收站，但 noteId 仍指向 note-a。
    expect(target.dataset.tasks.find((task) => task.id === 'task-deleted')?.noteId).toBe(
      'note-a',
    );
    expect(
      target.dataset.noteBlocks.find((block) => block.id === 'block-deleted')?.noteId,
    ).toBe('note-deleted');
    const relations = collectRelations(target.dataset);
    expect(findDanglingRelations(relations, target.dataset)).toHaveLength(0);
    expect(relations.length).toBe(collectRelations(parsed.payload.dataset).length);

    // 父对象先于子对象写入。
    const operationIndex = (predicate: (operation: (typeof plan.operations)[number]) => boolean) =>
      plan.operations.findIndex(predicate);
    const listIndex = operationIndex(
      (operation) => operation.type === 'create' && operation.row.id === 'list-work',
    );
    const taskIndex = operationIndex(
      (operation) => operation.type === 'create' && operation.row.id === 'task-a',
    );
    const todoIndex = operationIndex(
      (operation) => operation.type === 'create' && operation.row.id === 'todo-a',
    );
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(taskIndex).toBeGreaterThan(listIndex);
    expect(todoIndex).toBeGreaterThan(taskIndex);
  });

  it('复盘笔记在回收站时，先建块/快照，最后才软删除笔记', async () => {
    const backup = makePayload();
    const reviewNote = backup.dataset.notes.find((note) => note.id === 'note-review')!;
    reviewNote.status = 'trashed';
    reviewNote.deletedAt = '2026-10-26T11:00:00.000Z';
    backup.dataset.noteBlocks.push({
      id: 'block-review',
      noteId: 'note-review',
      blockType: 'paragraph',
      orderKey: 1,
      payload: { text: '复盘正文' },
      schemaVersion: 1,
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    });
    const plan = planRestore(makeParsed(backup), emptyBackupDataset());
    const reviewIndex = plan.operations.findIndex(
      (operation) => operation.type === 'review',
    );
    const blockIndex = plan.operations.findIndex(
      (operation) =>
        operation.type === 'create' && operation.row.id === 'block-review',
    );
    const deleteIndex = plan.operations.findIndex(
      (operation) =>
        operation.type === 'delete' &&
        operation.collection === 'notes' &&
        operation.id === 'note-review',
    );
    expect(reviewIndex).toBeGreaterThanOrEqual(0);
    expect(blockIndex).toBeGreaterThan(reviewIndex);
    expect(deleteIndex).toBeGreaterThan(blockIndex);

    const target = createMemoryRestoreTarget(emptyBackupDataset());
    const result = await applyRestorePlan(plan, target);
    expect(result.error).toBeNull();
    expect(target.dataset.reviewSnapshots).toHaveLength(1);
    expect(
      target.dataset.notes.find((note) => note.id === 'note-review')?.deletedAt,
    ).toBeTruthy();
    expect(
      target.dataset.noteBlocks.some((block) => block.id === 'block-review'),
    ).toBe(true);
  });

  it('清单父级成环时拍平为根级并提示，不阻断整份恢复', () => {
    const backup = makePayload();
    const stamp = '2026-10-01T00:00:00.000Z';
    backup.dataset.lists.push(
      {
        id: 'cycle-a',
        spaceId: 'personal',
        name: '环 A',
        color: '#5579d5',
        icon: '',
        parentId: 'cycle-b',
        sortOrder: 40,
        isInbox: false,
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
        version: 1,
      },
      {
        id: 'cycle-b',
        spaceId: 'personal',
        name: '环 B',
        color: '#5579d5',
        icon: '',
        parentId: 'cycle-a',
        sortOrder: 50,
        isInbox: false,
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
        version: 1,
      },
    );

    const plan = planRestore(makeParsed(backup), emptyBackupDataset());
    const creates = plan.operations.filter(
      (operation) =>
        operation.type === 'create' &&
        operation.collection === 'lists' &&
        (operation.row.id === 'cycle-a' || operation.row.id === 'cycle-b'),
    );
    expect(creates).toHaveLength(2);
    const parentOf = new Map(
      creates
        .filter((operation) => operation.type === 'create')
        .map((operation) => [
          operation.row.id,
          (operation.row as { parentId?: string | null }).parentId,
        ]),
    );
    // 至少一个环上的节点被拍平；剩余关系必须是无环树，不能拒绝整份备份。
    expect(parentOf.get('cycle-a')).toBeNull();
    expect(parentOf.get('cycle-b')).toBe('cycle-a');
    expect(plan.warnings.some((warning) => warning.includes('成环'))).toBe(true);
  });

  it('默认跳过冲突，不覆盖本机内容；选择覆盖才写入', async () => {
    const backup = makePayload();
    const local = cloneDatasetShallow(makeDataset());
    local.notes.find((note) => note.id === 'note-a')!.body = '<p>本机修改</p>';

    const parsed = makeParsed(backup);
    const skipPlan = planRestore(parsed, local);
    expect(skipPlan.conflicts.some((conflict) => conflict.key === 'notes:note-a')).toBe(
      true,
    );
    expect(skipPlan.summary.skip).toBeGreaterThan(0);
    expect(
      skipPlan.operations.some(
        (operation) => operation.type === 'update' && operation.row.id === 'note-a',
      ),
    ).toBe(false);

    const skipTarget = createMemoryRestoreTarget(local);
    await applyRestorePlan(skipPlan, skipTarget);
    expect(skipTarget.dataset.notes.find((note) => note.id === 'note-a')?.body).toBe(
      '<p>本机修改</p>',
    );

    const overwritePlan = planRestore(parsed, local, {
      decisions: { 'notes:note-a': 'overwrite' },
    });
    const overwriteTarget = createMemoryRestoreTarget(local);
    const result = await applyRestorePlan(overwritePlan, overwriteTarget);
    expect(result.error).toBeNull();
    expect(overwriteTarget.dataset.notes.find((note) => note.id === 'note-a')?.body).toBe(
      backup.dataset.notes.find((note) => note.id === 'note-a')!.body,
    );
  });

  it('保留两者生成新 ID，并复制笔记的块与待办', async () => {
    const backup = makePayload();
    const local = cloneDatasetShallow(makeDataset());
    local.notes.find((note) => note.id === 'note-a')!.body = '<p>本机版本</p>';
    const parsed = makeParsed(backup);
    const plan = planRestore(parsed, local, {
      decisions: { 'notes:note-a': 'keep-both' },
    });

    const target = createMemoryRestoreTarget(local);
    const result = await applyRestorePlan(plan, target);
    expect(result.error).toBeNull();

    const copies = target.dataset.notes.filter(
      (note) => note.title === '发布检查' && note.id !== 'note-a',
    );
    expect(copies).toHaveLength(1);
    const copy = copies[0]!;
    expect(copy.body).toBe(
      backup.dataset.notes.find((note) => note.id === 'note-a')!.body,
    );
    expect(
      target.dataset.noteBlocks.some(
        (block) => block.noteId === copy.id && block.id !== 'block-a',
      ),
    ).toBe(true);
    expect(
      target.dataset.noteTodos.some(
        (todo) => todo.noteId === copy.id && todo.id !== 'todo-a',
      ),
    ).toBe(true);
    expect(target.dataset.notes.find((note) => note.id === 'note-a')?.body).toBe(
      '<p>本机版本</p>',
    );
  });

  it('画板保留两者会复制节点/连线并重映射端点', async () => {
    const backup = makePayload();
    const local = cloneDatasetShallow(makeDataset());
    local.boards[0]!.board.title = '本机画板';
    local.boards[0]!.nodes[0]!.text = '本机开始';
    const plan = planRestore(makeParsed(backup), local, {
      decisions: { 'boards:board-a': 'keep-both' },
    });
    const target = createMemoryRestoreTarget(local);
    const result = await applyRestorePlan(plan, target);
    expect(result.error).toBeNull();
    const copies = target.dataset.boards.filter(
      (board) => board.board.title === '发布流程',
    );
    expect(copies).toHaveLength(1);
    const copy = copies[0]!;
    expect(copy.board.id).not.toBe('board-a');
    expect(copy.nodes).toHaveLength(2);
    expect(copy.nodes.map((node) => node.id)).not.toContain('node-1');
    expect(copy.edges).toHaveLength(1);
    expect(
      copy.nodes.some((node) => node.id === copy.edges[0]!.fromNodeId),
    ).toBe(true);
    expect(copy.nodes.some((node) => node.id === copy.edges[0]!.toNodeId)).toBe(
      true,
    );
  });

  it('附件同 SHA 冲突不提供保留两者（数据库唯一约束）', () => {
    const backup = makePayload();
    backup.dataset.attachments[0]!.noteId = 'note-review';
    const local = makeDataset();
    const plan = planRestore(makeParsed(backup), local);
    const conflict = plan.conflicts.find(
      (item) => item.key === 'attachments:attachment-a',
    );
    expect(conflict).toBeTruthy();
    expect(conflict!.choices).not.toContain('keep-both');
    expect(conflict!.choices).toContain('overwrite');
  });

  it('父对象选择跳过时，新增子对象被阻止而不是挂到本机旧父级', () => {
    const backup = makePayload();
    backup.dataset.noteBlocks.push({
      id: 'block-new',
      noteId: 'note-a',
      blockType: 'paragraph',
      orderKey: 2,
      payload: { text: '备份新增段落' },
      schemaVersion: 1,
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    });
    const local = cloneDatasetShallow(makeDataset());
    local.notes.find((note) => note.id === 'note-a')!.body = '<p>本机修改</p>';
    const plan = planRestore(makeParsed(backup), local);
    expect(plan.blocked.some((item) => item.id === 'block-new')).toBe(true);
    expect(
      plan.operations.some(
        (operation) =>
          operation.type === 'create' && operation.row.id === 'block-new',
      ),
    ).toBe(false);
  });

  it('本机已有收件箱时，保留两者按普通清单导入', async () => {
    const backup = makePayload();
    backup.dataset.lists.push({
      id: 'list-inbox-2',
      spaceId: 'personal',
      name: '另一个收件箱',
      color: '#5579d5',
      icon: '',
      parentId: null,
      sortOrder: 2,
      isInbox: true,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    });
    const local = makeDataset();
    const parsed = makeParsed(backup);
    const skipPlan = planRestore(parsed, local);
    const conflict = skipPlan.conflicts.find(
      (item) => item.key === 'lists:list-inbox-2',
    );
    expect(conflict?.choices).toEqual(['skip', 'keep-both']);
    expect(conflict?.defaultChoice).toBe('skip');

    const keepPlan = planRestore(parsed, local, {
      decisions: { 'lists:list-inbox-2': 'keep-both' },
    });
    const target = createMemoryRestoreTarget(local);
    const result = await applyRestorePlan(keepPlan, target);
    expect(result.error).toBeNull();
    const imported = target.dataset.lists.find(
      (list) => list.name === '另一个收件箱',
    );
    expect(imported).toBeTruthy();
    expect(imported!.isInbox).toBe(false);
    expect(imported!.id).not.toBe('list-inbox-2');
  });

  it('缺少附件二进制时仍恢复元数据，并在摘要中提示', async () => {
    const parsed = makeParsed(makePayload(), new Map());
    const plan = planRestore(parsed, emptyBackupDataset());
    expect(plan.summary.attachmentsWithoutBlob).toBe(1);
    const target = createMemoryRestoreTarget(emptyBackupDataset());
    const result = await applyRestorePlan(plan, target);
    expect(result.error).toBeNull();
    expect(target.dataset.attachments).toHaveLength(1);
    expect(target.blobs.size).toBe(0);
  });

  it('写入中途失败会停止并返回已应用数量', async () => {
    const parsed = makeParsed();
    const plan = planRestore(parsed, emptyBackupDataset());
    const memory = createMemoryRestoreTarget(emptyBackupDataset());
    let calls = 0;
    const failing = {
      async apply(operation: Parameters<typeof memory.apply>[0]) {
        calls += 1;
        if (calls === 3) throw new Error('模拟磁盘错误');
        await memory.apply(operation);
      },
    };
    const result = await applyRestorePlan(plan, failing);
    expect(result.error).toBe('模拟磁盘错误');
    expect(result.applied).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.stoppedAt).toBeTruthy();
  });

  it('外观恢复可以被取消', () => {
    const local = emptyBackupDataset();
    const plan = planRestore(makeParsed(), local, { restoreAppearance: false });
    expect(plan.summary.restoreAppearance).toBe(false);
    expect(plan.operations.some((operation) => operation.type === 'appearance')).toBe(
      false,
    );
  });
});

void FIXED_NOW;
