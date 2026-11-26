// @ts-nocheck
/**
 * ZX-090 独立验收用的“浏览器内 Tauri IPC”替身。
 *
 * 不是产品代码，也不复用实现者的 fake source。它按 Rust 仓储的公开语义
 * 实现命令路由，让真实的 App / router / SQLite client / 所有页面在 jsdom 里
 * 走完整链路（invoke 命令名、参数形状、camelCase 返回）。
 */

const STAMP = () => new Date().toISOString();

function localToday() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function addDays(date, days) {
  const next = new Date(`${date}T12:00:00`);
  next.setDate(next.getDate() + days);
  const pad = (value) => String(value).padStart(2, '0');
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sortBy(rows, ...keys) {
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const left = a[key];
      const right = b[key];
      if (left === right) continue;
      if (left === null || left === undefined) return -1;
      if (right === null || right === undefined) return 1;
      return left < right ? -1 : 1;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}

function baseList(overrides) {
  return {
    spaceId: 'personal',
    color: '#5579d5',
    icon: '',
    parentId: null,
    sortOrder: 10,
    isInbox: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function listDepth(id, seen = 0) {
  if (seen > 32) fail('清单层级存在循环');
  const list = active(db.lists).find((row) => row.id === id);
  if (!list) fail(`清单不存在：${id}`);
  return list.parentId ? 1 + listDepth(list.parentId, seen + 1) : 1;
}

function subtreeHeight(id, seen = 0) {
  if (seen > 32) fail('清单层级存在循环');
  const children = active(db.lists).filter((row) => row.parentId === id);
  return 1 + Math.max(0, ...children.map((child) => subtreeHeight(child.id, seen + 1)));
}

function isDescendant(candidate, root) {
  let current = active(db.lists).find((row) => row.id === candidate);
  let guard = 0;
  while (current && guard < 32) {
    if (current.id === root) return true;
    guard += 1;
    current = current.parentId
      ? active(db.lists).find((row) => row.id === current.parentId)
      : undefined;
  }
  return false;
}

function baseTask(overrides) {
  return {
    spaceId: 'personal',
    parentId: null,
    noteId: null,
    notes: '',
    status: 'todo',
    priority: 0,
    quadrant: 4,
    dueDate: null,
    dueTime: null,
    dueAt: null,
    tz: 'Asia/Shanghai',
    reminder: '',
    sortOrder: 0,
    completedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function baseNote(overrides) {
  return {
    spaceId: 'personal',
    folderId: null,
    tags: [],
    body: '',
    bodyFormat: 'html',
    status: 'active',
    favorite: false,
    pinned: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function baseEvent(overrides) {
  return {
    spaceId: 'personal',
    eventType: '个人日程',
    allDay: false,
    startAt: null,
    endAt: null,
    tz: 'Asia/Shanghai',
    source: 'local',
    externalUid: null,
    repeatRule: '单次',
    calendarType: 'solar',
    noteId: null,
    color: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function assertCalendarType(value) {
  if (value === undefined || value === null) return;
  if (value !== 'solar' && value !== 'lunar') {
    throw new Error(`参数无效：历法类型无效：${value}`);
  }
}

function baseCountdown(overrides) {
  return {
    spaceId: 'personal',
    category: '自定义',
    calendarType: 'solar',
    repeatRule: '单次',
    lunarMonth: null,
    lunarDay: null,
    note: '',
    color: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function baseHabit(overrides) {
  return {
    spaceId: 'personal',
    schedule: '每天',
    icon: '✳',
    color: 'amber',
    goalPerWeek: 7,
    sortOrder: 0,
    archived: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function baseLog(overrides) {
  return {
    spaceId: 'personal',
    done: true,
    note: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function baseFocus(overrides) {
  return {
    spaceId: 'personal',
    endedAt: null,
    mode: 'pomodoro',
    note: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function baseBoard(overrides) {
  return {
    spaceId: 'personal',
    noteId: null,
    background: 'dot',
    snapshot: {},
    thumbnailKey: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function defaultSeed(today) {
  return {
    lists: [
      baseList({ id: 'inbox', name: '收件箱', color: '#8b96a3', icon: 'inbox', sortOrder: 0, isInbox: true }),
      baseList({ id: 'work', name: '工作', sortOrder: 10 }),
      baseList({ id: 'life', name: '生活', color: '#d89338', sortOrder: 20 }),
    ],
    tasks: [
      baseTask({
        id: 'task-acceptance',
        title: '完成验收报告',
        listId: 'work',
        dueDate: today,
        dueTime: '10:30',
        priority: 3,
        quadrant: 1,
        sortOrder: 1,
      }),
      baseTask({
        id: 'task-overdue',
        title: '交房租',
        listId: 'life',
        dueDate: addDays(today, -1),
        priority: 2,
        quadrant: 1,
        sortOrder: 2,
      }),
      baseTask({
        id: 'task-done',
        title: '买咖啡豆',
        listId: 'life',
        dueDate: today,
        status: 'done',
        completedAt: `${today}T01:00:00.000Z`,
        sortOrder: 3,
      }),
      baseTask({
        id: 'task-inbox',
        title: '整理收件箱',
        listId: 'inbox',
        sortOrder: 4,
      }),
      baseTask({
        id: 'task-future',
        title: '准备周会材料',
        listId: 'work',
        dueDate: addDays(today, 1),
        dueTime: '09:30',
        quadrant: 2,
        sortOrder: 5,
      }),
    ],
    subtasks: [],
    notes: [
      baseNote({
        id: 'note-welcome',
        title: '欢迎使用知行',
        folderId: 'f1',
        tags: ['开始', '验收'],
        favorite: true,
        body: '<h2>知行验收笔记</h2><p>任务、知识与时间在同一条工作流里。</p><ul><li>本地优先</li><li>控制台零报错</li></ul>',
        updatedAt: '2026-10-26T01:00:00.000Z',
      }),
      baseNote({
        id: 'note-workflow',
        title: '任务、笔记与日历：三源融合',
        folderId: 'f2',
        tags: ['产品'],
        pinned: true,
        body: '<h2>三条不变量</h2><ul><li>任务只有一个 ID。</li><li>待办状态独立。</li></ul>',
        updatedAt: '2026-10-25T01:00:00.000Z',
      }),
    ],
    blocks: [],
    todos: [],
    events: [
      baseEvent({
        id: 'event-review',
        title: '产品评审会',
        startDate: today,
        startAt: `${today}T10:00`,
        endAt: `${today}T11:00`,
        eventType: '工作',
      }),
    ],
    countdowns: [
      baseCountdown({
        id: 'countdown-newyear',
        title: '元旦',
        category: '节假日',
        targetDate: '2027-01-01',
      }),
    ],
    habits: [
      baseHabit({ id: 'habit-read', title: '阅读 20 分钟', icon: '📚' }),
    ],
    logs: [
      baseLog({ id: 'log-read-today', habitId: 'habit-read', logDate: today }),
    ],
    sessions: [
      baseFocus({
        id: 'focus-today',
        taskId: 'task-acceptance',
        minutes: 25,
        startedAt: `${today}T02:00:00.000Z`,
        endedAt: `${today}T02:25:00.000Z`,
      }),
    ],
    snapshots: [],
    boards: [
      baseBoard({
        id: 'board-acceptance',
        title: '验收画板',
        noteId: 'note-welcome',
        snapshot: { version: 1, nodeCount: 2, edgeCount: 1 },
      }),
    ],
    nodes: [
      {
        id: 'node-start',
        boardId: 'board-acceptance',
        nodeType: 'start',
        x: 120,
        y: 120,
        width: 130,
        height: 54,
        rotation: 0,
        zIndex: 0,
        text: '开始',
        payload: { style: { fill: '#eef8f1' }, locked: false },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        deletedAt: null,
        version: 1,
      },
      {
        id: 'node-process',
        boardId: 'board-acceptance',
        nodeType: 'process',
        x: 360,
        y: 120,
        width: 170,
        height: 58,
        rotation: 0,
        zIndex: 1,
        text: '收集信息',
        payload: { style: { fill: '#ffffff' }, locked: false },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        deletedAt: null,
        version: 1,
      },
    ],
    edges: [
      {
        id: 'edge-start-process',
        boardId: 'board-acceptance',
        fromNodeId: 'node-start',
        toNodeId: 'node-process',
        label: '下一步',
        style: { routing: 'straight', arrow: 'end', color: '#93a3b8', width: 1.5, dashed: false, fromSide: 'r', toSide: 'l' },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        deletedAt: null,
        version: 1,
      },
    ],
    attachments: [],
    settings: [],
  };
}

function emptySeed() {
  return {
    lists: [baseList({ id: 'inbox', name: '收件箱', color: '#8b96a3', icon: 'inbox', sortOrder: 0, isInbox: true })],
    tasks: [],
    subtasks: [],
    notes: [],
    blocks: [],
    todos: [],
    events: [],
    countdowns: [],
    habits: [],
    logs: [],
    sessions: [],
    snapshots: [],
    boards: [],
    nodes: [],
    edges: [],
    attachments: [],
    settings: [],
  };
}

export function createFakeWorld(options = {}) {
  const today = options.today ?? localToday();
  const db = options.empty ? emptySeed() : defaultSeed(today);
  const calls = [];
  const exportsWritten = [];
  let seq = 0;
  const nextId = (prefix) => {
    // 验收脚本会刷新页面并从 localStorage 恢复同一份 db；计数器必须从已有
    // 行继续，否则每次刷新都会重新生成 habit-1 / focus-1，造成主键冲突，
    // 而产品按 id 去重会把历史记录挤出内存统计。
    const pattern = new RegExp(`^${prefix}-(\\d+)$`);
    let max = seq;
    for (const rows of Object.values(db)) {
      if (!Array.isArray(rows)) {
        continue;
      }
      for (const row of rows) {
        const match = pattern.exec(String(row?.id ?? ''));
        if (match) {
          max = Math.max(max, Number(match[1]));
        }
      }
    }
    seq = max + 1;
    return `${prefix}-${seq}`;
  };

  const active = (rows) => rows.filter((row) => row.deletedAt === null);
  const findActive = (rows, id, label) => {
    const row = rows.find((item) => item.id === id && item.deletedAt === null);
    if (!row) fail(`${label}不存在：${id}`);
    return row;
  };
  const patchRow = (rows, id, patch, label) => {
    const row = findActive(rows, id, label);
    Object.assign(row, patch, { updatedAt: STAMP(), version: row.version + 1 });
    return row;
  };
  const softDelete = (rows, id, label) => {
    const row = findActive(rows, id, label);
    Object.assign(row, { deletedAt: STAMP(), updatedAt: STAMP(), version: row.version + 1 });
  };

  const listTasks = (query = {}) => {
    let rows = query.includeDeleted ? db.tasks : active(db.tasks);
    if (query.listId !== undefined && query.listId !== null) rows = rows.filter((row) => row.listId === query.listId);
    if (query.status !== undefined && query.status !== null) rows = rows.filter((row) => row.status === query.status);
    if (query.dueDate !== undefined && query.dueDate !== null) rows = rows.filter((row) => row.dueDate === query.dueDate);
    if (query.dueBefore !== undefined && query.dueBefore !== null) rows = rows.filter((row) => row.dueDate !== null && row.dueDate <= query.dueBefore);
    if (query.inbox) {
      const inboxIds = new Set(active(db.lists).filter((list) => list.isInbox).map((list) => list.id));
      rows = rows.filter((row) => inboxIds.has(row.listId));
    }
    return sortBy(rows, 'sortOrder', 'createdAt');
  };

  const listNotes = (query = {}) => {
    let rows = query.includeDeleted ? db.notes : active(db.notes);
    if (query.status) rows = rows.filter((row) => row.status === query.status);
    if (query.folderId !== undefined && query.folderId !== null) rows = rows.filter((row) => row.folderId === query.folderId);
    if (query.favorite !== undefined && query.favorite !== null) rows = rows.filter((row) => row.favorite === query.favorite);
    if (query.search) {
      const needle = String(query.search).toLowerCase();
      rows = rows.filter((row) => `${row.title} ${row.body}`.toLowerCase().includes(needle));
    }
    return [...rows].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.updatedAt < b.updatedAt ? 1 : -1;
    });
  };

  const createNoteRow = (input) => {
    assert(String(input.title ?? '').trim(), '笔记标题不能为空');
    const note = baseNote({
      id: input.id ?? nextId('note'),
      title: String(input.title).trim(),
      folderId: input.folderId ?? null,
      tags: input.tags ?? [],
      body: input.body ?? '',
      bodyFormat: input.bodyFormat ?? 'html',
      status: input.status ?? 'active',
      favorite: input.favorite ?? false,
      pinned: input.pinned ?? false,
      createdAt: STAMP(),
      updatedAt: STAMP(),
    });
    db.notes.push(note);
    return note;
  };

  const settingsKey = (scope, key) => active(db.settings).find((row) => row.scope === scope && row.key === key);

  const handlers = {
    db_status: () => ({
      path: '/tmp/zhixing-fake.db',
      ready: true,
      schemaVersion: 4,
      journalMode: 'wal',
      foreignKeys: true,
      applied: [
        '0001_bootstrap',
        '0002_domain',
        '0003_review_snapshots',
        '0004_event_calendar_type',
      ],
      error: null,
    }),
    db_migrate: () => handlers.db_status(),
    // 与 Rust reset_domain 对齐：业务表回种子，settings 保留。
    db_reset_domain: () => {
      const seed = defaultSeed(today);
      const businessKeys = [
        'lists', 'tasks', 'subtasks', 'notes', 'blocks', 'todos',
        'events', 'countdowns', 'habits', 'logs', 'sessions',
        'snapshots', 'boards', 'nodes', 'edges', 'attachments',
      ];
      let deletedRows = 0;
      for (const key of businessKeys) {
        deletedRows += db[key].length;
        db[key].splice(0, db[key].length, ...clone(seed[key]));
      }
      return {
        deletedRows,
        preservedSettings: db.settings.length,
        seedApplied: true,
        samplesInserted: businessKeys.reduce((sum, key) => sum + seed[key].length, 0),
        inboxCreated: true,
        workCreated: true,
        seedMarker: '0002_domain',
      };
    },
    shell_ready: ({ route } = {}) => ({ version: '0.1.0', route: route ?? '/' }),
    // AUD-020：桌面导出落点命令；记录字节，供独立验收断言不走 <a download>。
    save_export_file: ({ fileName, bytes } = {}) => {
      const path = `/tmp/zhixing-fake-app-data/exports/${fileName}`;
      exportsWritten.push({ fileName, bytes, path });
      return path;
    },
    // ZX-FILE-01：附件另存走桌面保存面板；验收断言真实调用与目标路径。
    save_attachment_file: ({ fileName, bytes, directory = null } = {}) => {
      const path = `/tmp/zhixing-fake-app-data/attachments/${fileName}`;
      exportsWritten.push({ fileName, bytes, path, directory });
      return path;
    },
    // ZX-EXPORT-06：默认导出目录选择器；默认取消，测试可注入返回值。
    pick_export_directory: () => null,
    'plugin:log|log': () => null,
    'plugin:event|listen': () => 1,
    'plugin:event|unlisten': () => null,

    lists_list: ({ includeDeleted = false } = {}) => sortBy(includeDeleted ? db.lists : active(db.lists), 'sortOrder', 'name'),
    lists_get: ({ id }) => clone(findActive(db.lists, id, '清单')),
    lists_create: ({ input }) => {
      assert(String(input.name ?? '').trim(), '清单名称不能为空');
      const parentId = input.parentId ?? null;
      const isInbox = input.isInbox ?? false;
      if (isInbox && parentId !== null) fail('收件箱必须位于根级');
      if (parentId !== null) {
        const parent = findActive(db.lists, parentId, '清单');
        if (parent.isInbox) fail('不能把清单放到收件箱下');
        if (listDepth(parentId) + 1 > 3) fail('最多支持 3 层清单');
      }
      const name = String(input.name).trim();
      if (active(db.lists).some((row) => row.parentId === parentId && row.name.toLowerCase() === name.toLowerCase())) {
        fail(`同一父级下已存在同名清单：${name}`);
      }
      const siblings = active(db.lists).filter((row) => row.parentId === parentId);
      const list = baseList({
        id: input.id ?? nextId('list'),
        name,
        color: input.color ?? '#5579d5',
        icon: input.icon ?? '',
        parentId,
        sortOrder: input.sortOrder ?? Math.max(0, ...siblings.map((row) => row.sortOrder)) + 10,
        isInbox,
        createdAt: STAMP(),
        updatedAt: STAMP(),
      });
      db.lists.push(list);
      return list;
    },
    lists_update: ({ id, input }) => {
      const list = findActive(db.lists, id, '清单');
      const name = String(input.name).trim();
      if (active(db.lists).some((row) => row.id !== id && row.parentId === list.parentId && row.name.toLowerCase() === name.toLowerCase())) {
        fail(`同一父级下已存在同名清单：${name}`);
      }
      Object.assign(list, {
        name,
        color: input.color,
        icon: input.icon ?? '',
        sortOrder: input.sortOrder,
        updatedAt: STAMP(),
        version: list.version + 1,
      });
      return list;
    },
    lists_move: ({ id, input }) => {
      const list = findActive(db.lists, id, '清单');
      if (list.isInbox) fail('收件箱是系统清单，不能移动');
      const parentId = input.parentId ?? null;
      if (parentId !== null) {
        if (parentId === id) fail('清单不能移动到自己的子清单下');
        const parent = findActive(db.lists, parentId, '清单');
        if (parent.isInbox) fail('不能把清单放到收件箱下');
        if (isDescendant(parentId, id)) fail('清单不能移动到自己的子清单下');
        if (listDepth(parentId) + subtreeHeight(id) > 3) fail('最多支持 3 层清单');
      }
      Object.assign(list, {
        parentId,
        sortOrder: input.sortOrder,
        updatedAt: STAMP(),
        version: list.version + 1,
      });
      return list;
    },
    lists_delete: ({ id }) => {
      const list = findActive(db.lists, id, '清单');
      if (list.isInbox) fail('收件箱不能删除');
      const inbox = active(db.lists).find((row) => row.isInbox);
      if (!inbox) fail('找不到收件箱');
      let moved = 0;
      for (const task of active(db.tasks)) {
        if (task.listId === id) {
          task.listId = inbox.id;
          task.updatedAt = STAMP();
          task.version += 1;
          moved += 1;
        }
      }
      let promotedLists = 0;
      for (const child of active(db.lists)) {
        if (child.parentId === id) {
          child.parentId = list.parentId;
          child.updatedAt = STAMP();
          child.version += 1;
          promotedLists += 1;
        }
      }
      softDelete(db.lists, id, '清单');
      return { movedTasks: moved, promotedLists, inboxId: inbox.id };
    },

    tasks_list: ({ query } = {}) => listTasks(query ?? {}),
    tasks_get: ({ id }) => clone(findActive(db.tasks, id, '任务')),
    tasks_create: ({ input }) => {
      assert(String(input.title ?? '').trim(), '任务标题不能为空');
      assert(active(db.lists).some((list) => list.id === input.listId), `清单不存在：${input.listId}`);
      const status = input.status ?? 'todo';
      const task = baseTask({
        id: input.id ?? nextId('task'),
        listId: input.listId,
        parentId: input.parentId ?? null,
        noteId: input.noteId ?? null,
        title: String(input.title).trim(),
        notes: input.notes ?? '',
        status,
        priority: input.priority ?? 0,
        quadrant: input.quadrant ?? 0,
        dueDate: input.dueDate ?? null,
        dueTime: input.dueTime ?? null,
        dueAt: input.dueAt ?? null,
        tz: input.tz ?? 'Asia/Shanghai',
        reminder: input.reminder ?? '',
        sortOrder: input.sortOrder ?? 0,
        completedAt: status === 'done' ? STAMP() : null,
        createdAt: STAMP(),
        updatedAt: STAMP(),
      });
      db.tasks.push(task);
      return task;
    },
    tasks_update: ({ id, input }) => {
      const task = findActive(db.tasks, id, '任务');
      assert(String(input.title ?? '').trim(), '任务标题不能为空');
      Object.assign(task, {
        listId: input.listId,
        parentId: input.parentId ?? null,
        noteId: input.noteId ?? null,
        title: String(input.title).trim(),
        notes: input.notes ?? '',
        status: input.status,
        priority: input.priority,
        quadrant: input.quadrant,
        dueDate: input.dueDate ?? null,
        dueTime: input.dueTime ?? null,
        dueAt: input.dueAt ?? null,
        tz: input.tz ?? 'Asia/Shanghai',
        reminder: input.reminder ?? '',
        sortOrder: input.sortOrder ?? 0,
        completedAt:
          input.status === 'done'
            ? task.completedAt ?? STAMP()
            : null,
        updatedAt: STAMP(),
        version: task.version + 1,
      });
      return task;
    },
    tasks_complete: ({ id, done }) => {
      const task = findActive(db.tasks, id, '任务');
      task.status = done ? 'done' : 'todo';
      task.completedAt = done ? task.completedAt ?? STAMP() : null;
      task.updatedAt = STAMP();
      task.version += 1;
      return task;
    },
    tasks_delete: ({ id }) => { softDelete(db.tasks, id, '任务'); return null; },
    tasks_restore: ({ id }) => {
      const task = db.tasks.find((row) => row.id === id && row.deletedAt !== null);
      if (!task) fail(`已删除任务不存在：${id}`);
      Object.assign(task, { deletedAt: null, updatedAt: STAMP(), version: task.version + 1 });
      return task;
    },

    subtasks_list: ({ taskId, includeDeleted = false }) =>
      sortBy((includeDeleted ? db.subtasks : active(db.subtasks)).filter((row) => row.taskId === taskId), 'sortOrder', 'createdAt'),
    subtasks_create: ({ input }) => {
      assert(String(input.title ?? '').trim(), '子任务标题不能为空');
      findActive(db.tasks, input.taskId, '任务');
      const subtask = {
        id: input.id ?? nextId('subtask'),
        taskId: input.taskId,
        title: String(input.title).trim(),
        done: input.done ?? false,
        sortOrder: input.sortOrder ?? 0,
        createdAt: STAMP(),
        updatedAt: STAMP(),
        deletedAt: null,
        version: 1,
      };
      db.subtasks.push(subtask);
      return subtask;
    },
    subtasks_update: ({ id, input }) => {
      const row = findActive(db.subtasks, id, '子任务');
      Object.assign(row, { title: String(input.title).trim(), done: input.done, sortOrder: input.sortOrder, updatedAt: STAMP(), version: row.version + 1 });
      return row;
    },
    subtasks_delete: ({ id }) => { softDelete(db.subtasks, id, '子任务'); return null; },

    notes_list: ({ query } = {}) => listNotes(query ?? {}),
    notes_get: ({ id }) => clone(findActive(db.notes, id, '笔记')),
    notes_create: ({ input }) => createNoteRow(input),
    notes_update: ({ id, input }) => {
      const note = findActive(db.notes, id, '笔记');
      assert(String(input.title ?? '').trim(), '笔记标题不能为空');
      Object.assign(note, {
        title: String(input.title).trim(),
        folderId: input.folderId ?? null,
        tags: input.tags ?? [],
        body: input.body ?? '',
        bodyFormat: input.bodyFormat ?? 'html',
        favorite: input.favorite ?? false,
        pinned: input.pinned ?? false,
        updatedAt: STAMP(),
        version: note.version + 1,
      });
      return note;
    },
    notes_delete: ({ id }) => {
      const note = findActive(db.notes, id, '笔记');
      Object.assign(note, { status: 'trashed', deletedAt: STAMP(), updatedAt: STAMP(), version: note.version + 1 });
      return null;
    },
    notes_restore: ({ id }) => {
      const note = db.notes.find((row) => row.id === id && row.deletedAt !== null);
      if (!note) fail(`已删除笔记不存在：${id}`);
      Object.assign(note, { status: 'active', deletedAt: null, updatedAt: STAMP(), version: note.version + 1 });
      return note;
    },
    note_blocks_list: ({ noteId, includeDeleted = false }) =>
      sortBy((includeDeleted ? db.blocks : active(db.blocks)).filter((row) => row.noteId === noteId), 'orderKey'),
    note_blocks_create: ({ input }) => {
      const block = {
        id: input.id ?? nextId('block'),
        noteId: input.noteId,
        blockType: input.blockType,
        orderKey: input.orderKey ?? 0,
        payload: input.payload ?? {},
        schemaVersion: input.schemaVersion ?? 1,
        createdAt: STAMP(),
        updatedAt: STAMP(),
        deletedAt: null,
        version: 1,
      };
      db.blocks.push(block);
      return block;
    },
    note_blocks_update: ({ id, input }) => {
      const row = findActive(db.blocks, id, '块');
      Object.assign(row, { blockType: input.blockType, orderKey: input.orderKey, payload: input.payload, schemaVersion: input.schemaVersion ?? 1, updatedAt: STAMP(), version: row.version + 1 });
      return row;
    },
    note_blocks_delete: ({ id }) => { softDelete(db.blocks, id, '块'); return null; },
    note_todos_list: ({ noteId, includeDeleted = false }) =>
      sortBy((includeDeleted ? db.todos : active(db.todos)).filter((row) => row.noteId === noteId), 'sortOrder'),
    note_todos_create: ({ input }) => {
      const todo = {
        id: input.id ?? nextId('todo'),
        spaceId: 'personal',
        noteId: input.noteId,
        taskId: input.taskId ?? null,
        title: String(input.title ?? '').trim() || '待办事项',
        done: input.done ?? false,
        dueDate: input.dueDate ?? null,
        reminderEnabled: input.reminderEnabled ?? false,
        sortOrder: input.sortOrder ?? 0,
        createdAt: STAMP(),
        updatedAt: STAMP(),
        deletedAt: null,
        version: 1,
      };
      db.todos.push(todo);
      return todo;
    },
    note_todos_update: ({ id, input }) => {
      const row = findActive(db.todos, id, '笔记待办');
      Object.assign(row, { taskId: input.taskId ?? null, title: String(input.title ?? '').trim() || '待办事项', done: input.done, dueDate: input.dueDate ?? null, reminderEnabled: input.reminderEnabled ?? false, sortOrder: input.sortOrder ?? 0, updatedAt: STAMP(), version: row.version + 1 });
      return row;
    },
    note_todos_delete: ({ id }) => { softDelete(db.todos, id, '笔记待办'); return null; },

    events_list: ({ query } = {}) => {
      const q = query ?? {};
      let rows = q.includeDeleted ? db.events : active(db.events);
      if (q.from) rows = rows.filter((row) => row.startDate >= q.from);
      if (q.to) rows = rows.filter((row) => row.startDate <= q.to);
      if (q.noteId) rows = rows.filter((row) => row.noteId === q.noteId);
      return sortBy(rows, 'startDate', 'startAt');
    },
    events_get: ({ id }) => clone(findActive(db.events, id, '事件')),
    events_create: ({ input }) => {
      assert(String(input.title ?? '').trim(), '事件标题不能为空');
      assertCalendarType(input.calendarType);
      const event = baseEvent({
        id: input.id ?? nextId('event'),
        title: String(input.title).trim(),
        eventType: input.eventType ?? '个人日程',
        allDay: input.allDay ?? false,
        startDate: input.startDate,
        startAt: input.startAt ?? null,
        endAt: input.endAt ?? null,
        tz: input.tz ?? 'Asia/Shanghai',
        source: input.source ?? 'local',
        externalUid: input.externalUid ?? null,
        repeatRule: input.repeatRule ?? '单次',
        calendarType: input.calendarType ?? 'solar',
        noteId: input.noteId ?? null,
        color: input.color ?? '',
        createdAt: STAMP(),
        updatedAt: STAMP(),
      });
      db.events.push(event);
      return event;
    },
    events_update: ({ id, input }) => {
      assertCalendarType(input.calendarType);
      const event = findActive(db.events, id, '事件');
      Object.assign(event, {
        title: String(input.title).trim(),
        eventType: input.eventType,
        allDay: input.allDay,
        startDate: input.startDate,
        startAt: input.startAt ?? null,
        endAt: input.endAt ?? null,
        tz: input.tz ?? event.tz,
        source: input.source ?? event.source,
        externalUid: input.externalUid ?? null,
        repeatRule: input.repeatRule ?? '单次',
        calendarType: input.calendarType ?? event.calendarType,
        noteId: input.noteId ?? null,
        color: input.color ?? '',
        updatedAt: STAMP(),
        version: event.version + 1,
      });
      return event;
    },
    events_delete: ({ id }) => { softDelete(db.events, id, '事件'); return null; },

    countdowns_list: ({ query } = {}) => {
      let rows = query?.includeDeleted ? db.countdowns : active(db.countdowns);
      if (query?.category) rows = rows.filter((row) => row.category === query.category);
      return sortBy(rows, 'targetDate');
    },
    countdowns_get: ({ id }) => clone(findActive(db.countdowns, id, '倒数日')),
    countdowns_create: ({ input }) => {
      assert(String(input.title ?? '').trim(), '倒数日标题不能为空');
      const row = baseCountdown({
        id: input.id ?? nextId('countdown'),
        title: String(input.title).trim(),
        category: input.category ?? '自定义',
        calendarType: input.calendarType ?? 'solar',
        targetDate: input.targetDate,
        repeatRule: input.repeatRule ?? '单次',
        lunarMonth: input.lunarMonth ?? null,
        lunarDay: input.lunarDay ?? null,
        note: input.note ?? '',
        color: input.color ?? '',
        createdAt: STAMP(),
        updatedAt: STAMP(),
      });
      db.countdowns.push(row);
      return row;
    },
    countdowns_update: ({ id, input }) => {
      const row = findActive(db.countdowns, id, '倒数日');
      Object.assign(row, {
        title: String(input.title).trim(),
        category: input.category,
        calendarType: input.calendarType,
        targetDate: input.targetDate,
        repeatRule: input.repeatRule,
        lunarMonth: input.lunarMonth ?? null,
        lunarDay: input.lunarDay ?? null,
        note: input.note ?? '',
        color: input.color ?? '',
        updatedAt: STAMP(),
        version: row.version + 1,
      });
      return row;
    },
    countdowns_delete: ({ id }) => { softDelete(db.countdowns, id, '倒数日'); return null; },

    habits_list: ({ query } = {}) => {
      let rows = query?.includeDeleted ? db.habits : active(db.habits);
      if (!query?.includeArchived) rows = rows.filter((row) => !row.archived);
      return sortBy(rows, 'sortOrder');
    },
    habits_get: ({ id }) => clone(findActive(db.habits, id, '习惯')),
    habits_create: ({ input }) => {
      assert(String(input.title ?? '').trim(), '习惯名称不能为空');
      const row = baseHabit({
        id: input.id ?? nextId('habit'),
        title: String(input.title).trim(),
        schedule: input.schedule ?? '每天',
        icon: input.icon ?? '✳',
        color: input.color ?? 'amber',
        goalPerWeek: input.goalPerWeek ?? 7,
        sortOrder: input.sortOrder ?? 0,
        archived: input.archived ?? false,
        createdAt: STAMP(),
        updatedAt: STAMP(),
      });
      db.habits.push(row);
      return row;
    },
    habits_update: ({ id, input }) => {
      const row = findActive(db.habits, id, '习惯');
      Object.assign(row, { title: String(input.title).trim(), schedule: input.schedule, icon: input.icon ?? '', color: input.color ?? '', goalPerWeek: input.goalPerWeek, sortOrder: input.sortOrder, archived: input.archived ?? false, updatedAt: STAMP(), version: row.version + 1 });
      return row;
    },
    habits_delete: ({ id }) => {
      softDelete(db.habits, id, '习惯');
      for (const log of active(db.logs)) if (log.habitId === id) softDelete(db.logs, log.id, '打卡');
      return null;
    },
    habit_logs_list: ({ habitId, query } = {}) => {
      let rows = (query?.includeDeleted ? db.logs : active(db.logs)).filter((row) => row.habitId === habitId);
      if (query?.from) rows = rows.filter((row) => row.logDate >= query.from);
      if (query?.to) rows = rows.filter((row) => row.logDate <= query.to);
      return sortBy(rows, 'logDate');
    },
    habit_logs_set: ({ habitId, date, note }) => {
      assert(habitId, '习惯 id 不能为空');
      assert(date, '打卡日期不能为空');
      const existing = active(db.logs).find((row) => row.habitId === habitId && row.logDate === date);
      if (existing) {
        Object.assign(existing, { done: true, note: note ?? '', updatedAt: STAMP(), version: existing.version + 1 });
        return existing;
      }
      const row = baseLog({ id: nextId('log'), habitId, logDate: date, note: note ?? '', createdAt: STAMP(), updatedAt: STAMP() });
      db.logs.push(row);
      return row;
    },
    habit_logs_delete: ({ habitId, date }) => {
      const row = active(db.logs).find((item) => item.habitId === habitId && item.logDate === date);
      if (!row) fail(`打卡记录不存在：${habitId} ${date}`);
      softDelete(db.logs, row.id, '打卡');
      return null;
    },

    focus_sessions_list: ({ query } = {}) => {
      let rows = query?.includeDeleted ? db.sessions : active(db.sessions);
      if (query?.from) rows = rows.filter((row) => row.startedAt.slice(0, 10) >= query.from);
      if (query?.to) rows = rows.filter((row) => row.startedAt.slice(0, 10) <= query.to);
      if (query?.taskId) rows = rows.filter((row) => row.taskId === query.taskId);
      return sortBy(rows, 'startedAt');
    },
    focus_sessions_get: ({ id }) => clone(findActive(db.sessions, id, '专注记录')),
    focus_sessions_create: ({ input }) => {
      assert(input.taskId, '专注记录必须关联任务');
      assert(Number(input.minutes) > 0, '专注分钟数必须大于 0');
      const row = baseFocus({
        id: input.id ?? nextId('focus'),
        taskId: input.taskId,
        minutes: input.minutes,
        startedAt: input.startedAt ?? STAMP(),
        endedAt: input.endedAt ?? null,
        mode: input.mode ?? 'pomodoro',
        note: input.note ?? '',
        createdAt: STAMP(),
        updatedAt: STAMP(),
      });
      db.sessions.push(row);
      return row;
    },
    focus_sessions_update: ({ id, input }) => {
      const row = findActive(db.sessions, id, '专注记录');
      Object.assign(row, { taskId: input.taskId, minutes: input.minutes, startedAt: input.startedAt, endedAt: input.endedAt ?? null, mode: input.mode ?? row.mode, note: input.note ?? '', updatedAt: STAMP(), version: row.version + 1 });
      return row;
    },
    focus_sessions_delete: ({ id }) => { softDelete(db.sessions, id, '专注记录'); return null; },

    review_snapshots_list: ({ query } = {}) => {
      let rows = query?.includeDeleted ? db.snapshots : active(db.snapshots);
      if (query?.from) rows = rows.filter((row) => row.rangeEnd >= query.from);
      if (query?.to) rows = rows.filter((row) => row.rangeStart <= query.to);
      if (query?.noteId) rows = rows.filter((row) => row.noteId === query.noteId);
      return sortBy(rows, 'rangeStart');
    },
    review_snapshots_get: ({ id }) => clone(findActive(db.snapshots, id, '复盘快照')),
    review_snapshots_get_by_range: ({ from, to }) =>
      clone(active(db.snapshots).find((row) => row.rangeStart === from && row.rangeEnd === to) ?? null),
    review_snapshots_save: ({ input }) => {
      const existing = active(db.snapshots).find((row) => row.rangeStart === input.rangeStart && row.rangeEnd === input.rangeEnd);
      if (existing) {
        const note = db.notes.find((row) => row.id === existing.noteId);
        return { snapshot: existing, note, created: false };
      }
      const note = createNoteRow(input.note);
      const snapshot = {
        id: input.id ?? nextId('snapshot'),
        spaceId: 'personal',
        rangeStart: input.rangeStart,
        rangeEnd: input.rangeEnd,
        taskIds: input.taskIds ?? [],
        focusIds: input.focusIds ?? [],
        habitIds: input.habitIds ?? [],
        noteId: note.id,
        createdAt: STAMP(),
        updatedAt: STAMP(),
        deletedAt: null,
        version: 1,
      };
      db.snapshots.push(snapshot);
      return { snapshot, note, created: true };
    },

    boards_list: ({ query } = {}) => {
      let rows = query?.includeDeleted ? db.boards : active(db.boards);
      if (query?.noteId) rows = rows.filter((row) => row.noteId === query.noteId);
      return sortBy(rows, 'updatedAt');
    },
    boards_get: ({ id }) => clone(findActive(db.boards, id, '画板')),
    boards_create: ({ input }) => {
      const row = baseBoard({
        id: input.id ?? nextId('board'),
        noteId: input.noteId ?? null,
        title: String(input.title ?? '').trim() || '未命名画板',
        background: input.background ?? 'dot',
        snapshot: input.snapshot ?? {},
        thumbnailKey: input.thumbnailKey ?? null,
        createdAt: STAMP(),
        updatedAt: STAMP(),
      });
      db.boards.push(row);
      return row;
    },
    boards_update: ({ id, input }) => {
      const row = findActive(db.boards, id, '画板');
      Object.assign(row, { noteId: input.noteId ?? null, title: String(input.title ?? '').trim() || '未命名画板', background: input.background ?? 'dot', snapshot: input.snapshot ?? {}, thumbnailKey: input.thumbnailKey ?? null, updatedAt: STAMP(), version: row.version + 1 });
      return row;
    },
    boards_delete: ({ id }) => {
      softDelete(db.boards, id, '画板');
      for (const node of active(db.nodes)) if (node.boardId === id) softDelete(db.nodes, node.id, '画板对象');
      for (const edge of active(db.edges)) if (edge.boardId === id) softDelete(db.edges, edge.id, '连线');
      return null;
    },
    board_nodes_list: ({ boardId, includeDeleted = false }) =>
      sortBy((includeDeleted ? db.nodes : active(db.nodes)).filter((row) => row.boardId === boardId), 'zIndex'),
    board_nodes_create: ({ input }) => {
      const row = {
        id: input.id ?? nextId('node'),
        boardId: input.boardId,
        nodeType: input.nodeType ?? 'rect',
        x: input.x ?? 0,
        y: input.y ?? 0,
        width: input.width ?? 120,
        height: input.height ?? 60,
        rotation: input.rotation ?? 0,
        zIndex: input.zIndex ?? 0,
        text: input.text ?? '',
        payload: input.payload ?? {},
        createdAt: STAMP(),
        updatedAt: STAMP(),
        deletedAt: null,
        version: 1,
      };
      db.nodes.push(row);
      return row;
    },
    board_nodes_update: ({ id, input }) => {
      const row = findActive(db.nodes, id, '画板对象');
      Object.assign(row, { nodeType: input.nodeType, x: input.x, y: input.y, width: input.width, height: input.height, rotation: input.rotation, zIndex: input.zIndex, text: input.text, payload: input.payload, updatedAt: STAMP(), version: row.version + 1 });
      return row;
    },
    board_nodes_delete: ({ id }) => { softDelete(db.nodes, id, '画板对象'); return null; },
    board_edges_list: ({ boardId, includeDeleted = false }) =>
      sortBy((includeDeleted ? db.edges : active(db.edges)).filter((row) => row.boardId === boardId), 'createdAt'),
    board_edges_create: ({ input }) => {
      const row = {
        id: input.id ?? nextId('edge'),
        boardId: input.boardId,
        fromNodeId: input.fromNodeId,
        toNodeId: input.toNodeId,
        label: input.label ?? '',
        style: input.style ?? {},
        createdAt: STAMP(),
        updatedAt: STAMP(),
        deletedAt: null,
        version: 1,
      };
      db.edges.push(row);
      return row;
    },
    board_edges_update: ({ id, input }) => {
      const row = findActive(db.edges, id, '连线');
      Object.assign(row, { fromNodeId: input.fromNodeId, toNodeId: input.toNodeId, label: input.label ?? '', style: input.style ?? {}, updatedAt: STAMP(), version: row.version + 1 });
      return row;
    },
    board_edges_delete: ({ id }) => { softDelete(db.edges, id, '连线'); return null; },

    attachments_list: ({ query } = {}) => {
      let rows = query?.includeDeleted ? db.attachments : active(db.attachments);
      if (query?.noteId) rows = rows.filter((row) => row.noteId === query.noteId);
      return rows;
    },
    attachments_get: ({ id }) => clone(findActive(db.attachments, id, '附件')),
    attachments_create: ({ input }) => {
      const row = {
        id: input.id ?? nextId('attachment'),
        spaceId: 'personal',
        noteId: input.noteId ?? null,
        blockId: input.blockId ?? null,
        fileName: input.fileName,
        sha256: input.sha256,
        byteSize: input.byteSize,
        mime: input.mime ?? '',
        storageKey: input.storageKey,
        createdAt: STAMP(),
        updatedAt: STAMP(),
        deletedAt: null,
        version: 1,
      };
      db.attachments.push(row);
      return row;
    },
    attachments_update: ({ id, input }) => {
      const row = findActive(db.attachments, id, '附件');
      Object.assign(row, { noteId: input.noteId ?? null, blockId: input.blockId ?? null, fileName: input.fileName, mime: input.mime ?? '', storageKey: input.storageKey, updatedAt: STAMP(), version: row.version + 1 });
      return row;
    },
    attachments_delete: ({ id }) => { softDelete(db.attachments, id, '附件'); return null; },

    settings_list: ({ query } = {}) => {
      let rows = query?.includeDeleted ? db.settings : active(db.settings);
      if (query?.scope) rows = rows.filter((row) => row.scope === query.scope);
      return sortBy(rows, 'scope', 'key');
    },
    settings_get: ({ scope, key }) => {
      const row = settingsKey(scope, key);
      if (!row) fail(`设置不存在：${scope}:${key}`);
      return clone(row);
    },
    settings_set: ({ input }) => {
      const scope = input.scope ?? 'device';
      assert(scope === 'device' || scope === 'space', `设置作用域无效：${scope}`);
      const existing = settingsKey(scope, input.key);
      if (existing) {
        Object.assign(existing, { value: input.value, updatedAt: STAMP(), version: existing.version + 1 });
        return existing;
      }
      const row = {
        id: input.id ?? nextId('setting'),
        spaceId: 'personal',
        scope,
        key: input.key,
        value: input.value,
        createdAt: STAMP(),
        updatedAt: STAMP(),
        deletedAt: null,
        version: 1,
      };
      db.settings.push(row);
      return row;
    },
    settings_delete: ({ id }) => { softDelete(db.settings, id, '设置'); return null; },
    // 桌面 HTTP 代理替身：真实 Tauri 命令在 src-tauri/src/http.rs。
    // 测试里转发到 Node fetch，保留状态码/ETag，让 ICS 的 304 分支可验证。
    http_fetch_text: async ({ url, headers, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        typeof timeoutMs === 'number' ? timeoutMs : 20_000,
      );
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: headers ?? {},
          signal: controller.signal,
        });
        const body =
          response.status === 304 || response.status === 204
            ? ''
            : await response.text();
        return {
          status: response.status,
          statusText: response.statusText,
          etag: response.headers.get('etag'),
          lastModified: response.headers.get('last-modified'),
          contentType: response.headers.get('content-type'),
          body,
          finalUrl: response.url,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };

  async function invoke(command, args = {}) {
    calls.push({ command, args: clone(args) });
    const handler = handlers[command];
    if (!handler) {
      throw new Error(`未实现的 IPC 命令：${command}`);
    }
    return clone(await handler(args ?? {}));
  }

  function install() {
    let callbackId = 0;
    const internals = {
      invoke,
      transformCallback(callback) {
        const id = ++callbackId;
        window[`_${id}`] = callback;
        return id;
      },
      convertFileSrc: (path) => path,
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    };
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: internals,
    });
    return () => {
      delete window.__TAURI_INTERNALS__;
    };
  }

  return {
    db,
    today,
    calls,
    exportsWritten,
    install,
    invoke,
  };
}
