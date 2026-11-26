import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import { BoardEmbed } from '../BoardEmbed';
import {
  EMBED_MAX_HEIGHT,
  EMBED_MIN_HEIGHT,
  computeEmbedFit,
} from '../components/BoardThumbnail';
import type { BoardObject } from '../types';
import { createFakeBoardSource, sampleDocument } from './fakeBoardSource';

type FitFixture = {
  cases: Array<{
    id: string;
    label: string;
    bbox: { x: number; y: number; width: number; height: number };
    containerWidth: number;
    expected: {
      height: number;
      zoom: number;
      view: { x: number; y: number };
    };
  }>;
};

const FIT_FIXTURES = JSON.parse(
  readFileSync('src/features/board/__tests__/fixtures/board-embed-v4.fixtures.json', 'utf8'),
) as FitFixture;

function nodeForBbox(
  bbox: FitFixture['cases'][number]['bbox'],
): BoardObject {
  return {
    id: 'fixture-node',
    type: 'rect',
    x: bbox.x,
    y: bbox.y,
    width: bbox.width,
    height: bbox.height,
    rotation: 0,
    zIndex: 0,
    text: '',
    payload: {},
  };
}

beforeAll(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterAll(() => {
  vi.restoreAllMocks();
});

function Harness({
  mode,
  source,
  initialBoardId,
  saveDelayMs = 700,
}: {
  mode: 'empty' | 'existing';
  source?: ReturnType<typeof createFakeBoardSource>['source'];
  initialBoardId?: string | null;
  saveDelayMs?: number;
}) {
  const [boardId, setBoardId] = useState<string | null>(
    initialBoardId ?? (mode === 'existing' ? 'board-1' : null),
  );
  const [title, setTitle] = useState(
    mode === 'existing' ? '测试画板' : '未命名画板',
  );
  return (
    <BoardEmbed
      boardId={boardId}
      title={title}
      noteId="note-1"
      readOnly={false}
      source={source}
      saveDelayMs={saveDelayMs}
      onChangeTitle={setTitle}
      onChangeBoard={(patch) => {
        setBoardId(patch.boardId);
        setTitle(patch.title);
      }}
    />
  );
}

describe('笔记内嵌画板', () => {
  it('空白引用不伪造预览，点击后创建真实画板并给出打开链接', async () => {
    const user = userEvent.setup();
    const fake = createFakeBoardSource(null);
    render(<Harness mode="empty" source={fake.source} />);

    expect(screen.getByText(/不显示伪预览/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.querySelector('svg')).toBeNull();

    await user.click(screen.getByRole('button', { name: '创建空白画板' }));

    await waitFor(() => expect(fake.created).toHaveLength(1));
    const link = await screen.findByRole('link', { name: '打开画板' });
    expect(link).toHaveAttribute(
      'href',
      '/board/fake-board-1?note=note-1',
    );
    expect(screen.getByText(/0 个对象 · 0 条连线/)).toBeInTheDocument();
  });

  it('已有画板按真实节点/连线渲染只读 Canvas 预览、fit 信息与打开链接', async () => {
    const fake = createFakeBoardSource(sampleDocument());
    render(<Harness mode="existing" source={fake.source} />);

    const preview = await screen.findByRole('img', {
      name: /画板预览：3 个对象、2 条连线/,
    });
    expect(preview.tagName).toBe('CANVAS');
    expect(document.querySelector('svg')).toBeNull();
    expect(screen.getByText(/3 个对象 · 2 条连线/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开画板' })).toHaveAttribute(
      'href',
      '/board/board-1?note=note-1',
    );
    // 全宽 + 按内容 fit 的底部信息（jsdom 下容器宽取 760 兜底）。
    expect(screen.getByText(/按内容适应 · 全宽 · 高度 \d+px/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '展开' })).toBeInTheDocument();
  });

  it('预览 Canvas 的 CSS 宽高与 fit 同一组数，边框在预览容器外层', async () => {
    const fake = createFakeBoardSource(sampleDocument());
    render(<Harness mode="existing" source={fake.source} />);

    const preview = await screen.findByRole('img');
    // jsdom 下容器宽取 760 兜底，与 BoardEmbed 的 fit 完全一致。
    const fit = computeEmbedFit(sampleDocument().nodes, 760);
    expect(preview).toHaveStyle({
      width: `${fit.width}px`,
      height: `${fit.height}px`,
    });
    expect(preview.closest('.bw-embed-preview')).not.toBeNull();
    expect(screen.getByText(new RegExp(`高度 ${fit.height}px`))).toBeInTheDocument();
  });

  it('浏览器预览无 SQLite 时明确提示，不画伪预览', () => {
    render(
      <BoardEmbed
        boardId="board-1"
        title="测试画板"
        noteId="note-1"
        readOnly
        onChangeTitle={() => undefined}
        onChangeBoard={() => undefined}
      />,
    );
    expect(
      screen.getByText(/需在桌面壳内加载画板预览/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(document.querySelector('svg')).toBeNull();
  });

  it('嵌入头部标题只读，画板文档标题变化时回写块 payload', async () => {
    const document = sampleDocument();
    document.title = '服务端标题';
    const fake = createFakeBoardSource(document);
    const onChangeTitle = vi.fn();
    render(
      <BoardEmbed
        boardId="board-1"
        title="旧标题"
        noteId="note-1"
        readOnly={false}
        source={fake.source}
        onChangeTitle={onChangeTitle}
        onChangeBoard={() => undefined}
      />,
    );
    await screen.findByRole('img');
    expect(screen.getByText('服务端标题')).toBeInTheDocument();
    expect(screen.queryByLabelText('画板标题')).not.toBeInTheDocument();
    expect(onChangeTitle).toHaveBeenCalledWith('服务端标题');
  });

  it('空画板展示空态与展开/打开入口，不画伪预览', async () => {
    const document = sampleDocument();
    document.nodes = [];
    document.edges = [];
    const fake = createFakeBoardSource(document);
    render(<Harness mode="existing" source={fake.source} />);

    expect(
      await screen.findByText(/空白画板：展开后可插入模板/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '展开编辑' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '打开画板' })).toHaveAttribute(
      'href',
      '/board/board-1?note=note-1',
    );
  });

  it('展开后可在笔记内插入对象并保存，完成后收起并刷新预览', async () => {
    const user = userEvent.setup();
    const fake = createFakeBoardSource(sampleDocument());
    render(<Harness mode="existing" source={fake.source} saveDelayMs={0} />);

    await screen.findByRole('img');
    await user.click(screen.getByRole('button', { name: '展开' }));

    const toolbar = await screen.findByRole('toolbar', {
      name: '内嵌画板工具',
    });
    expect(toolbar).toBeInTheDocument();
    for (const name of ['选择', '矩形', '便签', '连线', '模板库', '完成']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }

    await user.click(screen.getByRole('button', { name: '便签' }));
    expect(screen.getByText(/4 个对象 · 2 条连线/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '模板库' }));
    expect(screen.getByRole('menu', { name: '模板库' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '矩形' }));

    await user.click(screen.getByRole('button', { name: '完成' }));

    // 收起后回到只读预览，内容按保存后的文档刷新。
    const preview = await screen.findByRole('img', {
      name: /画板预览：5 个对象、2 条连线/,
    });
    expect(preview.tagName).toBe('CANVAS');
    await waitFor(() => {
      const last = fake.saves[fake.saves.length - 1];
      expect(last).toBeDefined();
      expect(last.nodes).toHaveLength(5);
      // 收起后按编辑后的 bbox 重新适配：CSS 宽高与 fit 同步更新。
      const refit = computeEmbedFit(last.nodes, 760);
      expect(preview).toHaveStyle({
        width: `${refit.width}px`,
        height: `${refit.height}px`,
      });
    });
  });

  it('Esc 收起内联编辑器（改字浮层内的 Esc 除外）', async () => {
    const user = userEvent.setup();
    const fake = createFakeBoardSource(sampleDocument());
    render(<Harness mode="existing" source={fake.source} saveDelayMs={0} />);

    await screen.findByRole('img');
    await user.click(screen.getByRole('button', { name: '展开' }));
    await screen.findByRole('toolbar', { name: '内嵌画板工具' });

    fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'Escape' });
    await screen.findByRole('img', { name: /画板预览：3 个对象、2 条连线/ });
    expect(
      screen.queryByRole('toolbar', { name: '内嵌画板工具' }),
    ).not.toBeInTheDocument();
  });
});

describe('computeEmbedFit（规范 §4.3）', () => {
  it('种子画板 bbox 930×502、容器宽 802 → 高度 451、缩放 0.82', () => {
    const fit = computeEmbedFit(
      [
        {
          id: 'seed',
          type: 'rect',
          x: 0,
          y: 0,
          width: 930,
          height: 502,
          rotation: 0,
          zIndex: 0,
          text: '',
          payload: {},
        },
      ],
      802,
    );
    expect(fit.width).toBe(802);
    expect(fit.height).toBe(451);
    expect(fit.zoom).toBeCloseTo(0.82, 2);
    // view 是世界坐标视口左上角：view = bboxCenter − viewport/(2×zoom)。
    expect(fit.view.x).toBeCloseTo(465 - 802 / (2 * fit.zoom), 5);
    expect(fit.view.y).toBeCloseTo(251 - 451 / (2 * fit.zoom), 5);
    // 内容中心与容器中心重合（验收 ≤1px）。
    const screenCenterX = (0 + 930 / 2 - fit.view.x) * fit.zoom;
    const screenCenterY = (0 + 502 / 2 - fit.view.y) * fit.zoom;
    expect(Math.abs(screenCenterX - 802 / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(screenCenterY - 451 / 2)).toBeLessThanOrEqual(1);
  });

  it('按 bbox + 48 的比例给出高度与缩放，内容完整可见', () => {
    // sampleDocument 的 bbox：x 100..770，y 90..174 → 670×84。
    const fit = computeEmbedFit(sampleDocument().nodes, 802);
    expect(fit.empty).toBe(false);
    const ratio = (84 + 48) / (670 + 48);
    const height = Math.min(
      EMBED_MAX_HEIGHT,
      Math.max(EMBED_MIN_HEIGHT, Math.round(802 * ratio)),
    );
    expect(fit.height).toBe(height);
    expect(fit.height).toBeGreaterThanOrEqual(EMBED_MIN_HEIGHT);
    expect(fit.height).toBeLessThanOrEqual(EMBED_MAX_HEIGHT);
    // 缩放取宽/高两个方向的较小值，不裁切。
    expect(fit.zoom).toBeCloseTo(
      Math.min(802 / (670 + 48), height / (84 + 48)),
      5,
    );
  });

  it('很高内容触顶 560，按高度缩放；很宽内容触底 240，按宽度缩放', () => {
    const tall = computeEmbedFit(
      [
        {
          id: 'n',
          type: 'rect',
          x: 0,
          y: 0,
          width: 200,
          height: 2000,
          rotation: 0,
          zIndex: 0,
          text: '',
          payload: {},
        },
      ],
      800,
    );
    expect(tall.height).toBe(EMBED_MAX_HEIGHT);
    expect(tall.zoom).toBeCloseTo(560 / (2000 + 48), 5);

    const wide = computeEmbedFit(
      [
        {
          id: 'n',
          type: 'rect',
          x: 0,
          y: 0,
          width: 2000,
          height: 200,
          rotation: 0,
          zIndex: 0,
          text: '',
          payload: {},
        },
      ],
      800,
    );
    expect(wide.height).toBe(EMBED_MIN_HEIGHT);
    expect(wide.zoom).toBeCloseTo(800 / (2000 + 48), 5);
  });

  it('空画板返回 empty 标记与 240 高度', () => {
    const fit = computeEmbedFit([], 800);
    expect(fit.empty).toBe(true);
    expect(fit.width).toBe(800);
    expect(fit.height).toBe(240);
    // 空画板固定 240 / zoom 1 / 画布中心。
    expect(fit.view).toEqual({ x: 1200 - 400, y: 800 - 120, zoom: 1 });
  });
});

describe('computeEmbedFit · 10 组坐标 fixture（ZX-DESIGN-11）', () => {
  for (const fixture of FIT_FIXTURES.cases) {
    it(`${fixture.id}：${fixture.label} 内容完整、居中且与 fixture 一致`, () => {
      const fit = computeEmbedFit(
        [nodeForBbox(fixture.bbox)],
        fixture.containerWidth,
      );
      const { bbox, containerWidth, expected } = fixture;

      expect(fit.empty).toBe(false);
      expect(fit.width).toBe(containerWidth);
      expect(fit.height).toBe(expected.height);
      expect(fit.zoom).toBeCloseTo(expected.zoom, 5);
      // fixture 里的 view 只保留 3 位小数。
      expect(fit.view.x).toBeCloseTo(expected.view.x, 2);
      expect(fit.view.y).toBeCloseTo(expected.view.y, 2);

      // screen = (world − view) × zoom
      const left = (bbox.x - fit.view.x) * fit.zoom;
      const top = (bbox.y - fit.view.y) * fit.zoom;
      const right = left + bbox.width * fit.zoom;
      const bottom = top + bbox.height * fit.zoom;

      // 完整可见：bbox 四边都在容器内。
      expect(left).toBeGreaterThanOrEqual(-1e-6);
      expect(top).toBeGreaterThanOrEqual(-1e-6);
      expect(right).toBeLessThanOrEqual(containerWidth + 1e-6);
      expect(bottom).toBeLessThanOrEqual(fit.height + 1e-6);

      // 内容中心与容器中心误差 ≤1px。
      const centerX = left + (bbox.width * fit.zoom) / 2;
      const centerY = top + (bbox.height * fit.zoom) / 2;
      expect(Math.abs(centerX - containerWidth / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(centerY - fit.height / 2)).toBeLessThanOrEqual(1);

      // 左右/上下留白相等（≤0.5px）。
      expect(Math.abs(left - (containerWidth - right))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(top - (fit.height - bottom))).toBeLessThanOrEqual(0.5);

      // 高度始终在 240–560 内。
      expect(fit.height).toBeGreaterThanOrEqual(EMBED_MIN_HEIGHT);
      expect(fit.height).toBeLessThanOrEqual(EMBED_MAX_HEIGHT);
    });
  }

  it('旧屏幕像素公式（+24.115）复现偏左，新公式居中', () => {
    const fixture = FIT_FIXTURES.cases.find((item) => item.id === 'sys')!;
    const fit = computeEmbedFit(
      [nodeForBbox(fixture.bbox)],
      fixture.containerWidth,
    );
    expect(fit.view.x).toBeCloseTo(-24.314, 2);
    expect(fit.view.y).toBeCloseTo(-24, 2);

    const legacyView = {
      x:
        (fixture.containerWidth - fixture.bbox.width * fit.zoom) / 2 -
        fixture.bbox.x * fit.zoom,
      y:
        (fit.height - fixture.bbox.height * fit.zoom) / 2 -
        fixture.bbox.y * fit.zoom,
    };
    expect(legacyView.x).toBeGreaterThan(0);
    const legacyCenterX =
      (fixture.bbox.x + fixture.bbox.width / 2 - legacyView.x) * fit.zoom;
    expect(
      Math.abs(legacyCenterX - fixture.containerWidth / 2),
    ).toBeGreaterThan(1);
  });
});

describe('笔记内嵌画板 · 导出 PNG 入口', () => {
  it('有画板时头部提供导出入口，打开真实尺寸计划面板', async () => {
    const user = userEvent.setup();
    const fake = createFakeBoardSource(sampleDocument());
    render(<Harness mode="existing" source={fake.source} />);

    await screen.findByRole('img');
    await user.click(screen.getByRole('button', { name: '导出画板 PNG' }));

    const dialog = await screen.findByRole('dialog', {
      name: '导出画板 PNG',
    });
    expect(dialog).toHaveTextContent(/输出尺寸/);
    expect(dialog).toHaveTextContent(/PNG · 不透明/);
    expect(
      within(dialog).getByRole('button', { name: '保存 PNG' }),
    ).toBeEnabled();
    expect(
      within(dialog).queryByRole('button', { name: '插入到笔记' }),
    ).not.toBeInTheDocument();
  });

  it('空画板也能打开导出面板并明确提示没有内容', async () => {
    const user = userEvent.setup();
    const document = sampleDocument();
    document.nodes = [];
    document.edges = [];
    const fake = createFakeBoardSource(document);
    render(<Harness mode="existing" source={fake.source} />);

    await screen.findByText(/空白画板：展开后可插入模板/);
    await user.click(screen.getByRole('button', { name: '导出画板 PNG' }));

    const dialog = await screen.findByRole('dialog', {
      name: '导出画板 PNG',
    });
    expect(dialog).toHaveTextContent(/空白画板没有可导出的内容/);
    expect(
      within(dialog).getByRole('button', { name: '保存 PNG' }),
    ).toBeDisabled();
  });

  it('传入插入回调时导出面板显示「插入到笔记」', async () => {
    const user = userEvent.setup();
    const fake = createFakeBoardSource(sampleDocument());
    render(
      <BoardEmbed
        boardId="board-1"
        title="测试画板"
        noteId="note-1"
        readOnly={false}
        source={fake.source}
        onChangeTitle={() => undefined}
        onChangeBoard={() => undefined}
        onInsertExportedImage={async () => undefined}
      />,
    );

    await screen.findByRole('img');
    await user.click(screen.getByRole('button', { name: '导出画板 PNG' }));
    expect(
      await screen.findByRole('button', { name: '插入到笔记' }),
    ).toBeEnabled();
  });

  it('只读画板可以导出，但不提供插入笔记（不越过阅读模式）', async () => {
    const user = userEvent.setup();
    const fake = createFakeBoardSource(sampleDocument());
    render(
      <BoardEmbed
        boardId="board-1"
        title="测试画板"
        noteId="note-1"
        readOnly
        source={fake.source}
        onChangeTitle={() => undefined}
        onChangeBoard={() => undefined}
        onInsertExportedImage={async () => undefined}
      />,
    );

    await screen.findByRole('img');
    // 阅读态不出现「展开」等编辑控件。
    expect(
      screen.queryByRole('button', { name: '展开' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '展开编辑' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '导出画板 PNG' }));
    const dialog = await screen.findByRole('dialog', {
      name: '导出画板 PNG',
    });
    expect(
      within(dialog).queryByRole('button', { name: '插入到笔记' }),
    ).not.toBeInTheDocument();
  });
});

describe('笔记内嵌画板 · JSON 入口', () => {
  it('折叠态头部可直接打开画板 JSON 弹层', async () => {
    const user = userEvent.setup();
    const fake = createFakeBoardSource(sampleDocument());
    render(<Harness mode="existing" source={fake.source} />);

    await screen.findByRole('img');
    await user.click(screen.getByRole('button', { name: '打开画板 JSON' }));

    const dialog = await screen.findByRole('dialog', { name: '导入 / 导出画板' });
    await user.click(
      within(dialog).getByRole('tab', { name: /开发者 · JSON/ }),
    );
    expect(within(dialog).getByLabelText('画板 JSON')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: '导出 JSON…' }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole('button', { name: '从文件导入 .json…' }),
    ).toBeEnabled();
  });

  it('展开态工具轨提供同一 JSON 入口', async () => {
    const user = userEvent.setup();
    const fake = createFakeBoardSource(sampleDocument());
    render(<Harness mode="existing" source={fake.source} />);

    await screen.findByRole('img');
    await user.click(screen.getByRole('button', { name: '展开' }));
    const toolbar = await screen.findByRole('toolbar', {
      name: '内嵌画板工具',
    });
    await user.click(
      within(toolbar).getByRole('button', { name: '打开画板 JSON' }),
    );

    expect(
      await screen.findByRole('dialog', { name: '导入 / 导出画板' }),
    ).toBeInTheDocument();
  });

  it('内嵌导入 JSON 经二次确认后写回当前画板，可继续编辑', async () => {
    const user = userEvent.setup();
    const fake = createFakeBoardSource(sampleDocument());
    render(<Harness mode="existing" source={fake.source} saveDelayMs={0} />);

    await screen.findByRole('img');
    await user.click(screen.getByRole('button', { name: '打开画板 JSON' }));
    const dialog = await screen.findByRole('dialog', { name: '导入 / 导出画板' });
    fireEvent.change(within(dialog).getByLabelText('画板 JSON'), {
      target: {
        value: JSON.stringify({
          version: 1,
          boardId: 'foreign',
          noteId: null,
          title: '导入标题',
          background: 'dot',
          nodes: [
            {
              id: 'imported-node',
              type: 'sticky',
              x: 30,
              y: 40,
              width: 150,
              height: 100,
              text: '导入便签',
              payload: {},
            },
          ],
          edges: [],
        }),
      },
    });
    await user.click(within(dialog).getByRole('button', { name: '应用导入' }));
    expect(fake.saves).toHaveLength(0);
    await user.click(
      within(dialog).getByRole('button', { name: '确认替换' }),
    );

    await waitFor(() => expect(fake.saves).toHaveLength(1));
    expect(fake.saves[0].boardId).toBe('board-1');
    // 替换也重映射：不能把源 JSON 的节点 ID 直接写进全局主键。
    expect(fake.saves[0].nodes).toHaveLength(1);
    expect(fake.saves[0].nodes[0].id).not.toBe('imported-node');
    expect(fake.saves[0].nodes[0].text).toBe('导入便签');
    await waitFor(() =>
      expect(screen.getByText(/1 个对象 · 0 条连线/)).toBeInTheDocument(),
    );
    // 对象仍是普通画板对象，可继续编辑/导出。
    expect(
      screen.getByRole('button', { name: '打开画板 JSON' }),
    ).toBeEnabled();
  });
});

describe('笔记内嵌画板 · 空白引用导入 JSON', () => {
  it('空画板块默认“导入为新画板”，不要求先创建空白画板', async () => {
    const user = userEvent.setup();
    const fake = createFakeBoardSource(null);
    render(<Harness mode="empty" source={fake.source} />);

    await user.click(screen.getByRole('button', { name: '导入 JSON' }));
    const dialog = await screen.findByRole('dialog', { name: '导入 / 导出画板' });
    await user.click(
      within(dialog).getByRole('tab', { name: /开发者 · JSON/ }),
    );
    expect(
      within(dialog).queryByRole('radio', { name: /替换当前画板/ }),
    ).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByRole('textbox', {
      name: '画板 JSON',
    }), {
      target: {
        value: JSON.stringify({
          version: 1,
          boardId: 'foreign',
          noteId: null,
          title: '空白块导入',
          background: 'dot',
          nodes: [
            {
              id: 'imported',
              type: 'rect',
              x: 0,
              y: 0,
              width: 120,
              height: 60,
              text: '对象',
              payload: {},
            },
          ],
          edges: [],
        }),
      },
    });
    await user.click(within(dialog).getByRole('button', { name: '应用导入' }));
    await user.click(
      within(dialog).getByRole('button', { name: '确认导入新画板' }),
    );

    await waitFor(() => expect(fake.created).toHaveLength(1));
    expect(fake.created[0].title).toBe('空白块导入（导入）');
    await waitFor(() =>
      expect(screen.getByText(/1 个对象 · 0 条连线/)).toBeInTheDocument(),
    );
  });
});
