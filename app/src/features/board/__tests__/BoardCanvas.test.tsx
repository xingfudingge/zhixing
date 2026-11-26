import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import { BoardCanvas } from '../BoardCanvas';
import { createEmptyDocument } from '../model';
import { useBoardEditor } from '../useBoardEditor';
import type {
  BoardContextMenuState,
  BoardDocument,
  BoardObject,
  BoardSelection,
  BoardTool,
  BoardViewport,
} from '../types';

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterAll(() => {
  vi.restoreAllMocks();
});

function node(
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 50,
  type = 'rect',
): BoardObject {
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    rotation: 0,
    zIndex: 0,
    text: id,
    payload: { style: {}, locked: false },
  };
}

function doc(nodes: BoardObject[]): BoardDocument {
  return {
    ...createEmptyDocument({ boardId: 'b1', noteId: 'n1', title: '画布测试' }),
    nodes: nodes.map((item, index) => ({ ...item, zIndex: index })),
  };
}

function connector(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  routing: 'straight' | 'elbow' | 'curve' = 'straight',
) {
  return {
    id,
    fromNodeId,
    toNodeId,
    label: '',
    style: {
      routing,
      arrow: 'end',
      color: '#9fb0c2',
      width: 1.5,
      dashed: false,
      fromSide: 'r',
      toSide: 'l',
    },
  };
}

function Harness({
  initial,
  tool = 'select',
  onStatus,
  onEdgeLabel,
  onContextMenuRequest,
}: {
  initial: BoardDocument;
  tool?: BoardTool;
  onStatus: (message: string) => void;
  onEdgeLabel: (edgeId: string) => void;
  onContextMenuRequest?: (menu: BoardContextMenuState) => void;
}) {
  const editor = useBoardEditor(initial);
  const [selection, setSelection] = useState<BoardSelection>({
    nodeIds: [],
    edgeIds: [],
  });
  const [view, setView] = useState<BoardViewport>({
    x: 0,
    y: 0,
    zoom: 1,
  });
  return (
    <div>
      <BoardCanvas
        document={editor.document}
        selection={selection}
        tool={tool}
        readOnly={false}
        view={view}
        onViewChange={setView}
        onSelectionChange={setSelection}
        onApply={editor.apply}
        onBeginTransaction={editor.beginTransaction}
        onUpdateTransient={editor.updateTransient}
        onEndTransaction={editor.endTransaction}
        onStatus={onStatus}
        onRequestEdgeLabel={onEdgeLabel}
        onContextMenuRequest={onContextMenuRequest ?? (() => undefined)}
      />
      <button type="button" onClick={editor.undo}>
        撤销测试
      </button>
      <output data-testid="document">{JSON.stringify(editor.document)}</output>
      <output data-testid="selection">
        {JSON.stringify(selection)}
      </output>
    </div>
  );
}

function mount(initial: BoardDocument, tool: BoardTool = 'select') {
  const onStatus = vi.fn();
  const onEdgeLabel = vi.fn();
  const onContextMenuRequest = vi.fn();
  render(
    <Harness
      initial={initial}
      tool={tool}
      onStatus={onStatus}
      onEdgeLabel={onEdgeLabel}
      onContextMenuRequest={onContextMenuRequest}
    />,
  );
  const canvas = screen.getByRole('application', { name: '画板画布' });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  });
  return { canvas, onStatus, onEdgeLabel, onContextMenuRequest };
}

function currentDocument(): BoardDocument {
  return JSON.parse(screen.getByTestId('document').textContent ?? '{}') as BoardDocument;
}

function currentSelection(): BoardSelection {
  return JSON.parse(
    screen.getByTestId('selection').textContent ?? '{}',
  ) as BoardSelection;
}

function pointer(
  target: Element,
  type: 'pointerDown' | 'pointerMove' | 'pointerUp',
  x: number,
  y: number,
) {
  fireEvent[type](target, {
    clientX: x,
    clientY: y,
    button: type === 'pointerMove' ? -1 : 0,
  });
}

describe('Canvas2D 画布交互', () => {
  it('拖动对象：按 10px 网格移动，一次拖动只产生一步撤销', () => {
    const { canvas } = mount(doc([node('a', 100, 100)]));

    pointer(canvas, 'pointerDown', 120, 120);
    pointer(document.body, 'pointerMove', 170, 160);
    pointer(document.body, 'pointerUp', 170, 160);

    const moved = currentDocument().nodes[0];
    expect(moved.x).toBe(150);
    expect(moved.y).toBe(140);
    expect(currentSelection().nodeIds).toEqual(['a']);

    fireEvent.click(screen.getByRole('button', { name: '撤销测试' }));
    expect(currentDocument().nodes[0].x).toBe(100);
    expect(currentDocument().nodes[0].y).toBe(100);
  });

  it('锁定对象不可拖动，但可被选中', () => {
    const locked = {
      ...node('locked', 100, 100),
      payload: { locked: true },
    };
    const { canvas } = mount(doc([locked]));

    pointer(canvas, 'pointerDown', 120, 120);
    pointer(document.body, 'pointerMove', 180, 180);
    pointer(document.body, 'pointerUp', 180, 180);

    expect(currentDocument().nodes[0].x).toBe(100);
    expect(currentSelection().nodeIds).toEqual(['locked']);
  });

  it('SE 手柄缩放对象，保持最小尺寸', () => {
    const { canvas } = mount(doc([node('a', 100, 100)]));
    pointer(canvas, 'pointerDown', 120, 120);
    pointer(document.body, 'pointerUp', 120, 120);

    pointer(canvas, 'pointerDown', 200, 150);
    pointer(document.body, 'pointerMove', 240, 180);
    pointer(document.body, 'pointerUp', 240, 180);

    const resized = currentDocument().nodes[0];
    expect(resized.width).toBe(140);
    expect(resized.height).toBe(80);

    pointer(canvas, 'pointerDown', 240, 180);
    pointer(document.body, 'pointerMove', -900, -900);
    pointer(document.body, 'pointerUp', -900, -900);
    expect(currentDocument().nodes[0].width).toBeGreaterThanOrEqual(40);
    expect(currentDocument().nodes[0].height).toBeGreaterThanOrEqual(30);
  });

  it('双击对象出现 textarea，失焦后提交文字', () => {
    const { canvas } = mount(doc([node('a', 100, 100)]));

    fireEvent.doubleClick(canvas, { clientX: 150, clientY: 120 });
    const textarea = screen.getByLabelText('编辑对象文字');
    fireEvent.change(textarea, { target: { value: '改后的文字' } });
    fireEvent.blur(textarea);

    expect(currentDocument().nodes[0].text).toBe('改后的文字');
  });

  it('从 A 右锚点拖到 B 左锚点创建连线，锚点方向被保存', () => {
    const { canvas } = mount(
      doc([node('a', 100, 100), node('b', 400, 100)]),
    );

    pointer(canvas, 'pointerDown', 120, 120);
    pointer(document.body, 'pointerUp', 120, 120);
    expect(currentSelection().nodeIds).toEqual(['a']);

    pointer(canvas, 'pointerDown', 200, 125);
    pointer(document.body, 'pointerMove', 400, 125);
    pointer(document.body, 'pointerUp', 400, 125);

    const documentAfter = currentDocument();
    expect(documentAfter.edges).toHaveLength(1);
    expect(documentAfter.edges[0].fromNodeId).toBe('a');
    expect(documentAfter.edges[0].toNodeId).toBe('b');
    expect(documentAfter.edges[0].style.fromSide).toBe('r');
    expect(documentAfter.edges[0].style.toSide).toBe('l');
    expect(documentAfter.edges[0].style.routing).toBe('elbow');
    expect(currentSelection().edgeIds).toEqual([documentAfter.edges[0].id]);
  });

  it('框选多个对象并支持 Shift 加选', () => {
    const { canvas } = mount(
      doc([
        node('a', 100, 100),
        node('b', 300, 100),
        node('c', 500, 100),
      ]),
    );

    pointer(canvas, 'pointerDown', 60, 60);
    pointer(document.body, 'pointerMove', 650, 250);
    pointer(document.body, 'pointerUp', 650, 250);
    expect(currentSelection().nodeIds.sort()).toEqual(['a', 'b', 'c']);

    pointer(canvas, 'pointerDown', 60, 60);
    pointer(document.body, 'pointerUp', 60, 60);
    expect(currentSelection().nodeIds).toEqual([]);

    // Shift 点选两个对象。
    fireEvent.pointerDown(canvas, { clientX: 120, clientY: 120, button: 0 });
    fireEvent.pointerUp(document.body, { clientX: 120, clientY: 120, button: 0 });
    fireEvent.pointerDown(canvas, {
      clientX: 320,
      clientY: 120,
      button: 0,
      shiftKey: true,
    });
    fireEvent.pointerUp(document.body, {
      clientX: 320,
      clientY: 120,
      button: 0,
      shiftKey: true,
    });
    expect(currentSelection().nodeIds.sort()).toEqual(['a', 'b']);
  });

  it('Shift 点击连线可多选，再点一次移除；框选只选节点', () => {
    const base = doc([
      node('a', 100, 100),
      node('b', 400, 100),
      node('c', 700, 100),
    ]);
    base.edges = [
      connector('e1', 'a', 'b'),
      connector('e2', 'b', 'c'),
    ];
    const { canvas } = mount(base);

    pointer(canvas, 'pointerDown', 300, 125);
    pointer(document.body, 'pointerUp', 300, 125);
    expect(currentSelection().edgeIds).toEqual(['e1']);

    fireEvent.pointerDown(canvas, {
      clientX: 600,
      clientY: 125,
      button: 0,
      shiftKey: true,
    });
    fireEvent.pointerUp(document.body, {
      clientX: 600,
      clientY: 125,
      button: 0,
      shiftKey: true,
    });
    expect(currentSelection().edgeIds).toEqual(['e1', 'e2']);

    fireEvent.pointerDown(canvas, {
      clientX: 300,
      clientY: 125,
      button: 0,
      shiftKey: true,
    });
    fireEvent.pointerUp(document.body, {
      clientX: 300,
      clientY: 125,
      button: 0,
      shiftKey: true,
    });
    expect(currentSelection().edgeIds).toEqual(['e2']);

    pointer(canvas, 'pointerDown', 60, 60);
    pointer(document.body, 'pointerMove', 850, 250);
    pointer(document.body, 'pointerUp', 850, 250);
    expect(currentSelection().edgeIds).toEqual([]);
    expect(currentSelection().nodeIds.sort()).toEqual(['a', 'b', 'c']);
  });

  it('锁定对象不能作为连线起点，也不能作为终点', () => {
    const locked = {
      ...node('locked', 400, 100),
      payload: { locked: true },
    };
    const { canvas, onStatus } = mount(
      doc([node('a', 100, 100), locked]),
    );

    // 选中 A，从右锚点拖到锁定对象：不创建连线并提示。
    pointer(canvas, 'pointerDown', 120, 120);
    pointer(document.body, 'pointerUp', 120, 120);
    pointer(canvas, 'pointerDown', 200, 125);
    pointer(document.body, 'pointerMove', 450, 125);
    pointer(document.body, 'pointerUp', 450, 125);
    expect(currentDocument().edges).toHaveLength(0);
    expect(onStatus).toHaveBeenCalledWith('对象已锁定，不能连接');
  });

  it('锁定对象在连线工具下不能作为起点', () => {
    const locked = {
      ...node('locked', 400, 100),
      payload: { locked: true },
    };
    const { canvas, onStatus } = mount(doc([locked]), 'connect');
    pointer(canvas, 'pointerDown', 450, 125);
    pointer(document.body, 'pointerUp', 450, 125);
    expect(onStatus).toHaveBeenCalledWith('对象已锁定，不能作为连线起点');
    expect(currentDocument().edges).toHaveLength(0);
  });

  it('右键命中节点/连线/空白并回传菜单目标', () => {
    const base = doc([
      node('a', 100, 100),
      node('b', 400, 100),
    ]);
    base.edges = [connector('e1', 'a', 'b')];
    const { canvas, onContextMenuRequest } = mount(base);

    fireEvent.contextMenu(canvas, { clientX: 120, clientY: 120 });
    expect(onContextMenuRequest).toHaveBeenLastCalledWith({
      x: 120,
      y: 120,
      target: { kind: 'node', nodeId: 'a' },
    });
    expect(currentSelection().nodeIds).toEqual(['a']);

    fireEvent.contextMenu(canvas, { clientX: 300, clientY: 125 });
    expect(onContextMenuRequest).toHaveBeenLastCalledWith({
      x: 300,
      y: 125,
      target: { kind: 'edge', edgeId: 'e1' },
    });
    expect(currentSelection().edgeIds).toEqual(['e1']);

    fireEvent.contextMenu(canvas, { clientX: 60, clientY: 60 });
    expect(onContextMenuRequest).toHaveBeenLastCalledWith({
      x: 60,
      y: 60,
      target: { kind: 'canvas' },
    });
    expect(currentSelection()).toEqual({ nodeIds: [], edgeIds: [] });
  });
});
