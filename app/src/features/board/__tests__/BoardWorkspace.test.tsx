import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { BoardWorkspace } from '../BoardWorkspace';
import { buildBoardPackage } from '../export/package';
import {
  createEmptyDocument,
  fitViewport,
  parseBoardDocument,
  worldToScreen,
} from '../model';
import {
  createFakeBoardSource,
  sampleDocument,
} from './fakeBoardSource';

beforeAll(() => {
  // jsdom 没有 Canvas 实现；本文件的交互测试只验证状态机与数据流。
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterAll(() => {
  vi.restoreAllMocks();
});

function renderWorkspace(
  initial = sampleDocument(),
  saveDelayMs = 0,
) {
  const fake = createFakeBoardSource(initial);
  const view = render(
    <BoardWorkspace
      boardId={initial.boardId}
      noteId={initial.noteId}
      source={fake.source}
      saveDelayMs={saveDelayMs}
    />,
  );
  return { ...fake, unmount: view.unmount };
}

describe('画板工作区 · 加载与编辑', () => {
  it('加载真实文档，显示标题/对象数，插入矩形后自动保存并进入检查器', async () => {
    const user = userEvent.setup();
    const fake = renderWorkspace();

    expect(await screen.findByDisplayValue('测试画板')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: '画板' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/3 个对象 · 2 条连线/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '插入矩形' }));

    const inspector = screen.getByRole('complementary', { name: '检查器' });
    expect(
      within(inspector).getByRole('heading', { name: '矩形' }),
    ).toBeInTheDocument();

    await waitFor(() => expect(fake.saves.length).toBeGreaterThan(0));
    const stored = fake.getStored();
    expect(stored).not.toBeNull();
    expect(stored!.nodes).toHaveLength(4);
    expect(stored!.nodes.at(-1)!.type).toBe('rect');
    expect(
      screen.getByText(/4 个对象 · 2 条连线/),
    ).toBeInTheDocument();
  });

  it('⌘Z/⇧⌘Z 通过工具栏撤销、重做新增对象', async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await screen.findByDisplayValue('测试画板');
    await user.click(screen.getByRole('button', { name: '插入矩形' }));
    expect(screen.getByText(/4 个对象/)).toBeInTheDocument();

    const undo = screen.getByRole('button', { name: '撤销' });
    await waitFor(() => expect(undo).toBeEnabled());
    await user.click(undo);
    expect(screen.getByText(/3 个对象/)).toBeInTheDocument();

    const redo = screen.getByRole('button', { name: '重做' });
    expect(redo).toBeEnabled();
    await user.click(redo);
    expect(screen.getByText(/4 个对象/)).toBeInTheDocument();
  });

  it('刷新后从同一画板重新加载已保存对象', async () => {
    const user = userEvent.setup();
    const fake = createFakeBoardSource(sampleDocument());
    const first = render(
      <BoardWorkspace
        boardId="board-1"
        noteId="note-1"
        source={fake.source}
        saveDelayMs={0}
      />,
    );
    await screen.findByDisplayValue('测试画板');
    await user.click(screen.getByRole('button', { name: '插入矩形' }));
    await waitFor(() => expect(fake.saves.length).toBeGreaterThan(0));
    const persisted = fake.getStored();
    first.unmount();

    render(
      <BoardWorkspace
        boardId={persisted!.boardId}
        noteId="note-1"
        source={fake.source}
        saveDelayMs={0}
      />,
    );
    expect(await screen.findByText(/4 个对象 · 2 条连线/)).toBeInTheDocument();
  });

  it('修改标题后在失焦时写回文档并保存', async () => {
    const user = userEvent.setup();
    const fake = renderWorkspace();

    const input = await screen.findByDisplayValue('测试画板');
    await user.clear(input);
    await user.type(input, '需求评审画板');
    await user.tab();

    await waitFor(() => expect(fake.getStored()?.title).toBe('需求评审画板'));
  });

  it('导出 PNG 入口打开面板，显示按内容边界计算的尺寸', async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await screen.findByDisplayValue('测试画板');
    await user.click(screen.getByRole('button', { name: '导出画板 PNG' }));

    const dialog = await screen.findByRole('dialog', {
      name: '导出画板 PNG',
    });
    expect(dialog).toHaveTextContent(/输出尺寸/);
    expect(dialog).toHaveTextContent(/PNG · 不透明/);
    expect(
      within(dialog).getByRole('button', { name: '插入到笔记' }),
    ).toBeEnabled();
    // 只打开面板不生成图片：画板文档不会被保存/改动。
    expect(screen.getByText(/3 个对象 · 2 条连线/)).toBeInTheDocument();
  });

  it('阅读模式隐藏工具栏和检查器，并阻止继续插入/导入', async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await screen.findByDisplayValue('测试画板');
    await user.click(screen.getByRole('button', { name: '阅读' }));

    expect(
      screen.queryByRole('navigation', { name: '画板工具' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('complementary', { name: '检查器' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/阅读模式：只读/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出阅读' })).toBeInTheDocument();
    expect(screen.getByLabelText('画板标题')).toHaveAttribute('readonly');

    await user.click(
      screen.getByRole('button', { name: '导入或导出画板包' }),
    );
    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByRole('tab', { name: /开发者 · JSON/ }),
    );
    expect(within(dialog).getByRole('button', { name: '应用导入' })).toBeDisabled();
    expect(within(dialog).getByLabelText('画板 JSON')).toHaveAttribute(
      'readonly',
    );
  });

  it('右键节点复制、空白处粘贴，菜单动作写回文档并保存', async () => {
    const user = userEvent.setup();
    const fake = renderWorkspace();
    const initial = sampleDocument();
    await screen.findByDisplayValue('测试画板');
    const canvas = screen.getByRole('application', { name: '画板画布' });
    const view = fitViewport(initial.nodes, { width: 1000, height: 700 });
    const nodePoint = worldToScreen(view, {
      x: initial.nodes[0].x + initial.nodes[0].width / 2,
      y: initial.nodes[0].y + initial.nodes[0].height / 2,
    });
    await waitFor(() => expect(screen.getByRole('button', { name: '适配画布' })).toHaveTextContent('120%'));
    fireEvent.contextMenu(canvas, {
      clientX: nodePoint.x,
      clientY: nodePoint.y,
    });
    const firstMenu = await screen.findByRole('menu', {
      name: '画板右键菜单',
    });
    await user.click(
      within(firstMenu).getByRole('menuitem', { name: /^复制/ }),
    );
    expect(
      screen.queryByRole('menu', { name: '画板右键菜单' }),
    ).not.toBeInTheDocument();

    fireEvent.contextMenu(canvas, { clientX: 940, clientY: 660 });
    const secondMenu = await screen.findByRole('menu', {
      name: '画板右键菜单',
    });
    await user.click(
      within(secondMenu).getByRole('menuitem', { name: /^粘贴/ }),
    );

    await waitFor(() => expect(fake.getStored()?.nodes).toHaveLength(4));
    expect(screen.getByText(/4 个对象 · 2 条连线/)).toBeInTheDocument();
  });

  it('右键节点锁定/解锁、上移一层，Escape 关闭菜单', async () => {
    const user = userEvent.setup();
    const fake = renderWorkspace();
    const initial = sampleDocument();
    await screen.findByDisplayValue('测试画板');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '适配画布' })).toHaveTextContent(
        '120%',
      ),
    );
    const canvas = screen.getByRole('application', { name: '画板画布' });
    const view = fitViewport(initial.nodes, { width: 1000, height: 700 });
    const nodePoint = worldToScreen(view, {
      x: initial.nodes[1].x + initial.nodes[1].width / 2,
      y: initial.nodes[1].y + initial.nodes[1].height / 2,
    });

    fireEvent.contextMenu(canvas, {
      clientX: nodePoint.x,
      clientY: nodePoint.y,
    });
    let menu = await screen.findByRole('menu', { name: '画板右键菜单' });
    await user.click(
      within(menu).getByRole('menuitem', { name: /^层级/ }),
    );
    expect(
      within(menu).getByRole('menuitem', { name: '上移一层' }),
    ).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: '锁定' }));
    await waitFor(() =>
      expect(
        fake.getStored()?.nodes.find((node) => node.id === 'n-b')?.payload.locked,
      ).toBe(true),
    );

    fireEvent.contextMenu(canvas, {
      clientX: nodePoint.x,
      clientY: nodePoint.y,
    });
    menu = await screen.findByRole('menu', { name: '画板右键菜单' });
    await user.click(
      within(menu).getByRole('menuitem', { name: '解锁' }),
    );
    await waitFor(() =>
      expect(
        fake.getStored()?.nodes.find((node) => node.id === 'n-b')?.payload.locked,
      ).toBe(false),
    );

    canvas.focus();
    fireEvent.contextMenu(canvas, {
      clientX: nodePoint.x,
      clientY: nodePoint.y,
    });
    expect(
      await screen.findByRole('menu', { name: '画板右键菜单' }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByRole('menu', { name: '画板右键菜单' }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(canvas).toHaveFocus());
  });

  it('右键连线可改线型、反向与删除；阅读模式不出现菜单', async () => {
    const user = userEvent.setup();
    const fake = renderWorkspace();
    const initial = sampleDocument();
    await screen.findByDisplayValue('测试画板');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '适配画布' })).toHaveTextContent(
        '120%',
      ),
    );
    const canvas = screen.getByRole('application', { name: '画板画布' });
    const view = fitViewport(initial.nodes, { width: 1000, height: 700 });
    const edgePoint = worldToScreen(view, { x: 300, y: 126 });

    fireEvent.contextMenu(canvas, {
      clientX: edgePoint.x,
      clientY: edgePoint.y,
    });
    const menu = await screen.findByRole('menu', { name: '画板右键菜单' });
    await user.click(
      within(menu).getByRole('menuitem', { name: /^线型/ }),
    );
    await user.click(screen.getByRole('menuitemradio', { name: '直线' }));
    await waitFor(() =>
      expect(fake.getStored()?.edges[0].style.routing).toBe('straight'),
    );

    fireEvent.contextMenu(canvas, {
      clientX: edgePoint.x,
      clientY: edgePoint.y,
    });
    const again = await screen.findByRole('menu', { name: '画板右键菜单' });
    await user.click(within(again).getByRole('menuitem', { name: /^反向/ }));
    await waitFor(() =>
      expect(fake.getStored()?.edges[0].fromNodeId).toBe('n-b'),
    );

    await user.click(screen.getByRole('button', { name: '阅读' }));
    fireEvent.contextMenu(canvas, {
      clientX: edgePoint.x,
      clientY: edgePoint.y,
    });
    expect(
      screen.queryByRole('menu', { name: '画板右键菜单' }),
    ).not.toBeInTheDocument();
  });

  it('工具条批量切换连线线型，撤销/重做与重新加载都保持', async () => {
    const user = userEvent.setup();
    const fake = renderWorkspace();
    const initial = sampleDocument();
    await screen.findByDisplayValue('测试画板');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '适配画布' })).toHaveTextContent(
        '120%',
      ),
    );
    const view = fitViewport(initial.nodes, { width: 1000, height: 700 });
    const firstPoint = worldToScreen(view, { x: 285, y: 128 });
    const secondPoint = worldToScreen(view, { x: 560, y: 130 });

    const clickEdge = (
      canvas: HTMLElement,
      point: { x: number; y: number },
      shiftKey = false,
    ) => {
      fireEvent.pointerDown(canvas, {
        clientX: point.x,
        clientY: point.y,
        button: 0,
        shiftKey,
      });
      fireEvent.pointerUp(document.body, {
        clientX: point.x,
        clientY: point.y,
        button: 0,
        shiftKey,
      });
    };

    let canvas = screen.getByRole('application', { name: '画板画布' });
    clickEdge(canvas, firstPoint);
    expect(screen.getByRole('heading', { name: '连线' })).toBeInTheDocument();
    clickEdge(canvas, secondPoint, true);
    expect(
      screen.getByRole('heading', { name: '已选 2 条连线' }),
    ).toBeInTheDocument();

    const elbow = screen.getByRole('button', { name: '线型折线' });
    expect(elbow).toBeEnabled();
    await user.click(elbow);
    await waitFor(() =>
      expect(
        fake.getStored()?.edges.every(
          (edge) => edge.style.routing === 'elbow',
        ),
      ).toBe(true),
    );

    await user.click(screen.getByRole('button', { name: '撤销' }));
    await waitFor(() =>
      expect(
        fake.getStored()?.edges.every(
          (edge) => edge.style.routing === 'curve',
        ),
      ).toBe(true),
    );
    await user.click(screen.getByRole('button', { name: '重做' }));
    await waitFor(() =>
      expect(
        fake.getStored()?.edges.every(
          (edge) => edge.style.routing === 'elbow',
        ),
      ).toBe(true),
    );

    // 关闭后从同一 BoardSource 重新加载，线型仍保持。
    fake.unmount();
    render(
      <BoardWorkspace
        boardId="board-1"
        noteId="note-1"
        source={fake.source}
        saveDelayMs={0}
      />,
    );
    await screen.findByDisplayValue('测试画板');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '适配画布' })).toHaveTextContent(
        '120%',
      ),
    );
    canvas = screen.getByRole('application', { name: '画板画布' });
    clickEdge(canvas, firstPoint);
    expect(
      screen.getByRole('button', { name: '线型折线' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('保存失败时明确显示错误，而不是假装已保存', async () => {
    const user = userEvent.setup();
    const fake = createFakeBoardSource(sampleDocument());
    const failing = {
      ...fake.source,
      save: vi.fn(async () => {
        throw new Error('磁盘不可写');
      }),
    };
    render(
      <BoardWorkspace
        boardId="board-1"
        noteId="note-1"
        source={failing}
        saveDelayMs={0}
      />,
    );
    await screen.findByDisplayValue('测试画板');
    await user.click(screen.getByRole('button', { name: '插入矩形' }));
    await waitFor(() =>
      expect(screen.getByText(/保存失败：磁盘不可写/)).toBeInTheDocument(),
    );
    expect(screen.getByText('保存失败')).toBeInTheDocument();
  });
});

describe('画板工作区 · 起步结构与 JSON', () => {
  it('工具栏不暴露一级 JSON；空画板入口为「导入画板包…」', async () => {
    const user = userEvent.setup();
    const empty = createEmptyDocument({
      boardId: 'board-empty',
      noteId: 'note-1',
      title: '空白画板',
    });
    renderWorkspace(empty);

    await screen.findByDisplayValue('空白画板');
    expect(screen.queryByRole('button', { name: 'JSON' })).toBeNull();
    expect(screen.queryByRole('button', { name: '恢复 JSON' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '导入画板包…' }));
    const dialog = await screen.findByRole('dialog', {
      name: '导入 / 导出画板',
    });
    expect(
      within(dialog).getByRole('tab', { name: /画板包 .zxboard/ }),
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      within(dialog).queryByRole('button', { name: '恢复 JSON' }),
    ).toBeNull();
  });

  it('从空画板插入流程图起步结构，得到 6 个对象/5 条连线并保存', async () => {
    const user = userEvent.setup();
    const empty = createEmptyDocument({
      boardId: 'board-1',
      noteId: 'note-1',
      title: '空白画板',
    });
    const fake = renderWorkspace(empty);

    await screen.findByDisplayValue('空白画板');
    expect(screen.getByText('空白画板')).toBeInTheDocument();
    const starterButtons = screen.getAllByRole('button', { name: '起步结构' });
    await user.click(starterButtons[0]);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '起步结构' })).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /流程图/ }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(fake.saves.length).toBeGreaterThan(0));
    const stored = fake.getStored();
    expect(stored!.nodes).toHaveLength(6);
    expect(stored!.edges).toHaveLength(5);
    expect(stored!.nodes.map((node) => node.type)).toContain('diamond');
    expect(
      stored!.nodes.some((node) =>
        ['process', 'start', 'decision'].includes(node.type),
      ),
    ).toBe(false);
    expect(screen.getByText(/6 个对象 · 5 条连线/)).toBeInTheDocument();
  });

  it('更多形状只提供中性形状，不出现流程步骤/判定/开始结束', async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await screen.findByDisplayValue('测试画板');
    await user.click(screen.getByRole('button', { name: '更多形状' }));
    const dialog = screen.getByRole('dialog');

    for (const label of ['菱形', '三角形', '六边形', '胶囊', '平行四边形']) {
      expect(within(dialog).getByText(label)).toBeInTheDocument();
    }
    expect(within(dialog).queryByText('流程步骤')).toBeNull();
    expect(within(dialog).queryByText('判定')).toBeNull();
    expect(within(dialog).queryByText('开始/结束')).toBeNull();
  });

  it('旧 process/start/decision 文档加载后归一，文字与连线不丢', async () => {
    const legacy = createEmptyDocument({
      boardId: 'legacy-board',
      noteId: 'note-1',
      title: '旧画板',
    });
    legacy.nodes = [
      {
        id: 'old-process',
        type: 'process',
        x: 100,
        y: 100,
        width: 170,
        height: 62,
        rotation: 0,
        zIndex: 0,
        text: '流程步骤',
        payload: { style: { fill: '#ffffff' }, locked: false },
      },
      {
        id: 'old-start',
        type: 'start',
        x: 100,
        y: 240,
        width: 130,
        height: 54,
        rotation: 0,
        zIndex: 1,
        text: '开始',
        payload: { style: {}, locked: false },
      },
      {
        id: 'old-decision',
        type: 'decision',
        x: 320,
        y: 100,
        width: 160,
        height: 84,
        rotation: 0,
        zIndex: 2,
        text: '判断？',
        payload: { style: {}, locked: false },
      },
    ];
    legacy.edges = [
      {
        id: 'old-edge',
        fromNodeId: 'old-process',
        toNodeId: 'old-start',
        label: '',
        style: { routing: 'curve', arrow: 'end', fromSide: 'b', toSide: 't' },
      },
    ];
    const fake = renderWorkspace(legacy);

    await screen.findByDisplayValue('旧画板');
    // 归一发生在一进入编辑器时，自动保存会把新类型写回数据源。
    await waitFor(() => expect(fake.saves.length).toBeGreaterThan(0));
    const stored = fake.getStored()!;
    expect(stored.nodes.map((node) => node.type)).toEqual([
      'rect',
      'pill',
      'diamond',
    ]);
    expect(stored.nodes.map((node) => node.text)).toEqual([
      '流程步骤',
      '开始',
      '判断？',
    ]);
    expect(stored.nodes[0].payload.style).toEqual({ fill: '#ffffff' });
    expect(stored.edges).toHaveLength(1);
    expect(stored.edges[0].fromNodeId).toBe('old-process');
  });

  it('起步结构同时提供横向/纵向泳道，纵向插入 3 列 × 2 便签后可保存重开', async () => {
    const user = userEvent.setup();
    const empty = createEmptyDocument({
      boardId: 'board-1',
      noteId: 'note-1',
      title: '空白画板',
    });
    const fake = renderWorkspace(empty);

    await screen.findByDisplayValue('空白画板');
    await user.click(screen.getAllByRole('button', { name: '起步结构' })[0]);
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByRole('button', { name: /泳道 · 横向/ }),
    ).toBeInTheDocument();
    const vertical = within(dialog).getByRole('button', { name: /泳道 · 纵向/ });
    await user.click(vertical);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(fake.getStored()?.nodes).toHaveLength(9));
    const stored = fake.getStored()!;
    const frames = stored.nodes.filter((node) => node.type === 'frame');
    const stickies = stored.nodes.filter((node) => node.type === 'sticky');
    expect(frames.map((frame) => [frame.x, frame.y, frame.width, frame.height]))
      .toEqual([
        [0, 0, 280, 420],
        [300, 0, 280, 420],
        [600, 0, 280, 420],
      ]);
    expect(stickies.map((sticky) => [sticky.x, sticky.y, sticky.width, sticky.height]))
      .toEqual([
        [30, 74, 220, 100],
        [30, 234, 220, 100],
        [330, 74, 220, 100],
        [330, 234, 220, 100],
        [630, 74, 220, 100],
        [630, 234, 220, 100],
      ]);
    expect(stored.edges).toHaveLength(0);

    // 从同一 BoardSource 重开，纵向几何保持。
    fake.unmount();
    render(
      <BoardWorkspace
        boardId="board-1"
        noteId="note-1"
        source={fake.source}
        saveDelayMs={0}
      />,
    );
    expect(await screen.findByText(/9 个对象 · 0 条连线/)).toBeInTheDocument();
  });

  it('模板库提供 8 个规范模板；插入时间线 12 个对象后保存重开保持一致', async () => {
    const user = userEvent.setup();
    const empty = createEmptyDocument({
      boardId: 'board-1',
      noteId: 'note-1',
      title: '空白画板',
    });
    const fake = renderWorkspace(empty);

    await screen.findByDisplayValue('空白画板');
    await user.click(screen.getAllByRole('button', { name: '起步结构' })[0]);
    const dialog = screen.getByRole('dialog');
    for (const title of [
      '时间线',
      '组织架构',
      '系统架构',
      '思维导图',
      '金字塔',
      '增长飞轮',
      '泳道 · 横向',
      '泳道 · 纵向',
    ]) {
      expect(
        within(dialog).getByRole('button', { name: new RegExp(title) }),
      ).toBeInTheDocument();
    }

    await user.click(within(dialog).getByRole('button', { name: /时间线/ }));
    await waitFor(() => expect(fake.getStored()?.nodes).toHaveLength(12));
    const stored = fake.getStored()!;
    expect(stored.edges).toHaveLength(0);
    const axis = stored.nodes.find((node) => node.type === 'rect')!;
    expect([axis.x, axis.y, axis.width, axis.height]).toEqual([0, 120, 760, 6]);
    expect(stored.nodes.filter((node) => node.type === 'ellipse')).toHaveLength(5);
    expect(screen.getByText(/12 个对象 · 0 条连线/)).toBeInTheDocument();

    fake.unmount();
    render(
      <BoardWorkspace
        boardId="board-1"
        noteId="note-1"
        source={fake.source}
        saveDelayMs={0}
      />,
    );
    expect(await screen.findByText(/12 个对象 · 0 条连线/)).toBeInTheDocument();
  });

  it('插入增长飞轮为一步撤销：6 个对象/5 条连线，撤销后回到空画板', async () => {
    const user = userEvent.setup();
    const empty = createEmptyDocument({
      boardId: 'board-1',
      noteId: 'note-1',
      title: '空白画板',
    });
    const fake = renderWorkspace(empty);

    await screen.findByDisplayValue('空白画板');
    await user.click(screen.getAllByRole('button', { name: '起步结构' })[0]);
    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: /增长飞轮/ }),
    );

    await waitFor(() => expect(fake.getStored()?.nodes).toHaveLength(6));
    expect(fake.getStored()!.edges).toHaveLength(5);
    expect(screen.getByText(/6 个对象 · 5 条连线/)).toBeInTheDocument();

    const undo = screen.getByRole('button', { name: '撤销' });
    await waitFor(() => expect(undo).toBeEnabled());
    await user.click(undo);
    expect(screen.getByText(/0 个对象 · 0 条连线/)).toBeInTheDocument();
  });

  it('开发者 JSON 对话框可恢复画板，导入后可撤销', async () => {
    const user = userEvent.setup();
    const fake = renderWorkspace();
    await screen.findByDisplayValue('测试画板');

    await user.click(
      screen.getByRole('button', { name: '导入或导出画板包' }),
    );
    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByRole('tab', { name: /开发者 · JSON/ }),
    );
    const textarea = within(dialog).getByLabelText('画板 JSON');
    const minimal = {
      version: 1,
      boardId: 'ignored',
      noteId: null,
      title: '导入画板',
      background: 'dot',
      nodes: [
        {
          id: 'only',
          type: 'sticky',
          x: 50,
          y: 60,
          width: 160,
          height: 110,
          rotation: 0,
          zIndex: 0,
          text: '导入便签',
          payload: { style: { fill: '#fff7d9' }, locked: false },
        },
      ],
      edges: [],
    };
    fireEvent.change(textarea, {
      target: { value: JSON.stringify(minimal) },
    });
    await user.click(within(dialog).getByRole('button', { name: '应用导入' }));
    // 二次确认前不改动当前画板。
    expect(fake.getStored()?.nodes).toHaveLength(3);
    await user.click(
      within(dialog).getByRole('button', { name: '确认替换' }),
    );

    await waitFor(() => expect(fake.getStored()?.nodes).toHaveLength(1));
    expect(fake.getStored()?.title).toBe('导入画板');
    expect(screen.getByText(/1 个对象 · 0 条连线/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '撤销' }));
    expect(screen.getByText(/3 个对象 · 2 条连线/)).toBeInTheDocument();
  });

  it('非法 JSON 在对话框内显示错误，不覆盖当前画板', async () => {
    const user = userEvent.setup();
    const fake = renderWorkspace();
    await screen.findByDisplayValue('测试画板');

    await user.click(
      screen.getByRole('button', { name: '导入或导出画板包' }),
    );
    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByRole('tab', { name: /开发者 · JSON/ }),
    );
    const textarea = within(dialog).getByLabelText('画板 JSON');
    fireEvent.change(textarea, { target: { value: '{bad' } });
    await user.click(within(dialog).getByRole('button', { name: '应用导入' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent(/合法 JSON/);
    expect(fake.getStored()?.nodes).toHaveLength(3);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('导入为新画板：创建新 boardId，原画板对象不被改写', async () => {
    const user = userEvent.setup();
    const fake = renderWorkspace();
    await screen.findByDisplayValue('测试画板');

    await user.click(
      screen.getByRole('button', { name: '导入或导出画板包' }),
    );
    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByRole('tab', { name: /开发者 · JSON/ }),
    );
    fireEvent.change(within(dialog).getByLabelText('画板 JSON'), {
      target: {
        value: JSON.stringify({
          version: 1,
          boardId: 'foreign-board',
          noteId: 'foreign-note',
          title: '外部画板',
          background: 'dot',
          nodes: [
            {
              id: 'imported-only',
              type: 'rect',
              x: 10,
              y: 20,
              width: 120,
              height: 60,
              text: '导入对象',
              payload: {},
            },
          ],
          edges: [],
        }),
      },
    });
    await user.click(
      within(dialog).getByRole('radio', { name: /导入为新画板/ }),
    );
    await user.click(within(dialog).getByRole('button', { name: '应用导入' }));
    await user.click(
      within(dialog).getByRole('button', { name: '确认导入新画板' }),
    );

    await waitFor(() => expect(fake.created).toHaveLength(1));
    expect(fake.created[0].title).toBe('外部画板（导入）');
    expect(fake.created[0].noteId).toBe('note-1');
    const saved = fake.saves[fake.saves.length - 1];
    expect(saved.boardId).toBe(fake.created[0].boardId);
    expect(saved.boardId).not.toBe('foreign-board');
    expect(saved.noteId).toBe('note-1');
    // 导入必须重映射 ID，不能复用源 JSON 的节点 ID（全局主键会冲突）。
    expect(saved.nodes).toHaveLength(1);
    expect(saved.nodes[0].id).not.toBe('imported-only');
    expect(saved.nodes[0].text).toBe('导入对象');
    expect(screen.getByText(/1 个对象 · 0 条连线/)).toBeInTheDocument();
    expect(screen.getByDisplayValue('外部画板（导入）')).toBeInTheDocument();
  });

  it('导入 .zxboard 画板包：预览后新建画板，节点/连线 ID 全部重映射', async () => {
    const user = userEvent.setup();
    const fake = renderWorkspace();
    await screen.findByDisplayValue('测试画板');

    const report = await buildBoardPackage({
      document: sampleDocument(),
      viewport: { x: -40, y: -30, zoom: 0.9 },
      includeThumbnail: false,
    });
    const file = new File([report.bytes.slice().buffer], '测试画板.zxboard', {
      type: 'application/zip',
    });

    await user.click(screen.getByRole('button', { name: '导入或导出画板包' }));
    const dialog = await screen.findByRole('dialog', { name: '导入 / 导出画板' });
    expect(
      within(dialog).getByRole('button', { name: '导出画板包…' }),
    ).toBeEnabled();
    expect(
      within(dialog).getByLabelText('选择画板包文件'),
    ).toHaveAttribute('accept', expect.stringContaining('.zxboard'));
    // JSON 仍保留为开发/调试入口。
    expect(within(dialog).getByLabelText('画板 JSON')).toBeInTheDocument();
    fireEvent.change(
      within(dialog).getByLabelText('选择画板包文件'),
      { target: { files: [file] } },
    );

    await within(dialog).findByText(/包类型 board-package/);
    expect(within(dialog).getByText(/3 个对象 · 2 条连线/)).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole('radio', { name: /导入为新画板/ }),
    );
    await user.click(within(dialog).getByRole('button', { name: '应用导入' }));
    await user.click(
      within(dialog).getByRole('button', { name: '确认导入新画板' }),
    );

    await waitFor(() => expect(fake.created).toHaveLength(1));
    expect(fake.created[0].title).toBe('测试画板（导入）');
    const saved = fake.saves[fake.saves.length - 1]!;
    expect(saved.boardId).not.toBe('board-1');
    expect(saved.nodes).toHaveLength(3);
    expect(saved.edges).toHaveLength(2);
    expect(saved.nodes.map((node) => node.id)).not.toContain('n-a');
    for (const edge of saved.edges) {
      expect(saved.nodes.some((node) => node.id === edge.fromNodeId)).toBe(
        true,
      );
      expect(saved.nodes.some((node) => node.id === edge.toNodeId)).toBe(true);
    }
  });

  it('版本不兼容时明确报错，当前画板对象数不变', async () => {
    const user = userEvent.setup();
    const fake = renderWorkspace();
    await screen.findByDisplayValue('测试画板');

    await user.click(
      screen.getByRole('button', { name: '导入或导出画板包' }),
    );
    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByRole('tab', { name: /开发者 · JSON/ }),
    );
    fireEvent.change(within(dialog).getByLabelText('画板 JSON'), {
      target: { value: JSON.stringify({ version: 2, nodes: [], edges: [] }) },
    });

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      /仅支持 version=1/,
    );
    expect(
      within(dialog).getByRole('button', { name: '应用导入' }),
    ).toBeDisabled();
    expect(fake.getStored()?.nodes).toHaveLength(3);
    expect(screen.getByText(/3 个对象 · 2 条连线/)).toBeInTheDocument();
  });

  it('JSON round-trip 与 BoardWorkspace 的公开格式一致', () => {
    const document = sampleDocument();
    const json = JSON.stringify({ ...document, ignored: true });
    const parsed = parseBoardDocument(json);
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.edges[0].style.fromSide).toBe('r');
  });

  it('打开画板弹窗时收起右键菜单；Escape 后焦点回到触发按钮', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const initial = sampleDocument();
    await screen.findByDisplayValue('测试画板');

    const canvas = screen.getByRole('application', { name: '画板画布' });
    const view = fitViewport(initial.nodes, { width: 1000, height: 700 });
    const nodePoint = worldToScreen(view, {
      x: initial.nodes[0].x + initial.nodes[0].width / 2,
      y: initial.nodes[0].y + initial.nodes[0].height / 2,
    });
    fireEvent.contextMenu(canvas, {
      clientX: nodePoint.x,
      clientY: nodePoint.y,
    });
    expect(
      await screen.findByRole('menu', { name: '画板右键菜单' }),
    ).toBeInTheDocument();

    const trigger = screen.getByRole('button', {
      name: '导入或导出画板包',
    });
    await user.click(trigger);
    expect(
      screen.queryByRole('menu', { name: '画板右键菜单' }),
    ).not.toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: '导入 / 导出画板' });
    await waitFor(() =>
      expect(
        within(dialog).getByRole('tab', { name: /画板包 .zxboard/ }),
      ).toHaveFocus(),
    );

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it('弹窗底部取消在固定 footer 中，点击可关闭并归还焦点', async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByDisplayValue('测试画板');

    const trigger = screen.getByRole('button', {
      name: '导入或导出画板包',
    });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '导入 / 导出画板' });
    const cancel = within(dialog).getByRole('button', { name: '取消' });
    expect(cancel.closest('.bw-modal-foot')).not.toBeNull();
    expect(cancel.closest('.bw-modal-body')).toBeNull();

    const backdrop = dialog.parentElement!.parentElement as HTMLElement;
    expect(backdrop).toHaveClass('bw-modal-backdrop');
    expect(window.getComputedStyle(backdrop).position).toBe('fixed');

    await user.click(cancel);
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });
});
