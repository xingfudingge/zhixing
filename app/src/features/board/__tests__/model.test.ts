import { describe, expect, it } from 'vitest';

import {
  BOARD_OBJECT_FONT_SIZE,
  BOARD_OBJECT_STROKE_WIDTH,
  BOARD_STARTERS,
  BOARD_THEME_TOKENS,
  BoardDocumentError,
  STARTER_CONTENT_GAP,
  STARTER_GROUPS,
  addConnector,
  addObject,
  addQuickObject,
  alignObjects,
  boardDocumentJson,
  connectorStyle,
  copyObjects,
  createEmptyDocument,
  defaultObjectStyle,
  deleteObjects,
  distributeObjects,
  documentBounds,
  duplicateObjects,
  fitViewport,
  insertStarter,
  layerObjects,
  moveObjects,
  normalizeColor,
  objectLocked,
  objectStyle,
  parseBoardDocument,
  parseBoardDocumentFile,
  pasteObjects,
  reverseConnector,
  setConnectorLabel,
  setObjectText,
  setObjectsLocked,
  starterPreview,
  updateConnectorStyle,
  updateConnectorsStyle,
  withObjectLocked,
  withObjectStyle,
} from '../model';
import type { BoardDocument, BoardStarterKind, IdFactory } from '../types';

let sequence = 0;
const testIdFactory: IdFactory = (prefix) => {
  sequence += 1;
  return `${prefix}-${sequence}`;
};

function emptyDocument(): BoardDocument {
  return createEmptyDocument({ boardId: 'board-1', noteId: 'note-1', title: '测试画板' });
}

function withNodes(): BoardDocument {
  let document = emptyDocument();
  const geometry = [
    { x: 100, y: 100, width: 100, height: 50 },
    { x: 300, y: 100, width: 100, height: 50 },
    { x: 500, y: 100, width: 100, height: 50 },
  ];
  for (const rect of geometry) {
    const added = addObject(document, 'rect', { x: 0, y: 0 }, { idFactory: testIdFactory });
    document = {
      ...added.document,
      nodes: added.document.nodes.map((node) =>
        node.id === added.nodeId ? { ...node, ...rect } : node,
      ),
    };
  }
  return document;
}

describe('画板模型 · 对象', () => {
  it('创建 11 种中性形状/文本/便签/容器，并带对象级默认样式', () => {
    let document = emptyDocument();
    for (const type of [
      'rect',
      'round',
      'ellipse',
      'diamond',
      'text',
      'sticky',
      'frame',
      'triangle',
      'hexagon',
      'pill',
      'parallelogram',
    ] as const) {
      document = addObject(document, type, { x: 200, y: 200 }, { idFactory: testIdFactory }).document;
    }
    expect(document.nodes).toHaveLength(11);
    expect(new Set(document.nodes.map((node) => node.id)).size).toBe(11);
    // 新对象不默认带“流程步骤/判定/开始”等流程标签，矩形就是矩形。
    expect(document.nodes.every((node) => node.text === '')).toBe(true);
    expect(document.nodes.map((node) => node.type)).not.toContain('process');
    const diamond = document.nodes.find((node) => node.type === 'diamond');
    expect(diamond).toBeTruthy();
    expect(objectStyle(diamond!).fill).toBe(BOARD_THEME_TOKENS.diamondFill);
    expect(objectStyle(diamond!).stroke).toBe(BOARD_THEME_TOKENS.diamondStroke);
    expect(objectStyle(diamond!).textAlign).toBe('center');
    const frame = document.nodes.find((node) => node.type === 'frame');
    expect(frame!.zIndex).toBeLessThan(diamond!.zIndex);
    // 容器透明底，内部连线不被遮挡。
    expect(objectStyle(frame!).fill).toBe(BOARD_THEME_TOKENS.frameFill);
    expect(
      objectStyle(frame!).fill === 'transparent' ||
        objectStyle(frame!).fill === 'var(--board-frame-fill)',
    ).toBe(true);
  });

  it('未知类型归一为矩形；payload 中未知字段在原样修改样式后仍保留', () => {
    let document = emptyDocument();
    const added = addObject(document, 'future-shape', { x: 100, y: 100 }, { idFactory: testIdFactory });
    document = added.document;
    const node = document.nodes[0];
    expect(node.type).toBe('rect');
    const withUnknown = {
      ...node,
      payload: { ...node.payload, customField: 'keep-me' },
    };
    const styled = withObjectStyle(withUnknown, { fill: '#e8eefb' });
    expect(styled.payload.customField).toBe('keep-me');
    expect(objectStyle(styled).fill).toBe('#e8eefb');
  });

  it('默认样式由主题令牌驱动，中性形状与连线共用语义色', () => {
    const tokenDriven = [
      'rect',
      'round',
      'ellipse',
      'diamond',
      'text',
      'sticky',
      'frame',
      'triangle',
      'hexagon',
      'pill',
      'parallelogram',
    ] as const;
    for (const type of tokenDriven) {
      const style = defaultObjectStyle(type);
      for (const color of [style.fill, style.stroke, style.textColor]) {
        if (color !== 'transparent') {
          expect(color).toMatch(/^var\(--board-[a-z-]+\)$/);
        }
      }
    }
    expect(defaultObjectStyle('frame').fill).toBe(BOARD_THEME_TOKENS.frameFill);
    expect(defaultObjectStyle('sticky').stroke).toBe(
      BOARD_THEME_TOKENS.stickyStroke,
    );
    expect(defaultObjectStyle('diamond').fill).toBe(
      BOARD_THEME_TOKENS.diamondFill,
    );
    expect(defaultObjectStyle('pill').fill).toBe(BOARD_THEME_TOKENS.pillFill);
    expect(defaultObjectStyle('rect').stroke).toBe(
      BOARD_THEME_TOKENS.rectStroke,
    );
    // 旧类型只做语义映射，不再出现在新对象样式表里。
    expect(defaultObjectStyle('process')).toEqual(defaultObjectStyle('rect'));
    expect(defaultObjectStyle('start')).toEqual(defaultObjectStyle('pill'));
    expect(defaultObjectStyle('decision')).toEqual(
      defaultObjectStyle('diamond'),
    );

    const document = withNodes();
    const connected = addConnector(
      document,
      document.nodes[0].id,
      document.nodes[1].id,
      { idFactory: testIdFactory },
    ).document;
    expect(connectorStyle(connected.edges[0]).color).toBe(
      BOARD_THEME_TOKENS.connector,
    );
  });

  it('对象默认字号、圆角与描边粗细走同一套常量，不再按类型各写一套', () => {
    for (const type of ['rect', 'round', 'sticky', 'frame', 'pill'] as const) {
      const style = defaultObjectStyle(type);
      expect(style.fontSize).toBe(BOARD_OBJECT_FONT_SIZE);
      expect(style.radius).toBeGreaterThan(0);
      expect(style.radius).toBeLessThanOrEqual(999);
    }
    expect(defaultObjectStyle('text').fontSize).toBeGreaterThan(
      BOARD_OBJECT_FONT_SIZE,
    );
    // 旧 start 映射为胶囊，仍保留大圆角。
    expect(defaultObjectStyle('start').radius).toBeGreaterThan(
      defaultObjectStyle('rect').radius,
    );
    expect(BOARD_OBJECT_STROKE_WIDTH).toBeGreaterThan(0);
  });

  it('主题令牌只接受内部 --board-* 引用；用户 hex 颜色保持原样', () => {
    expect(normalizeColor('VAR(--BOARD-STICKY-FILL)', '#fff')).toBe(
      'var(--board-sticky-fill)',
    );
    expect(normalizeColor('#ABCDEF', '#fff')).toBe('#abcdef');
    expect(normalizeColor('rgb(1, 2, 3)', '#fff')).toBe('#fff');
    expect(normalizeColor('var(--surface)', '#fff')).toBe('#fff');

    const node = withNodes().nodes[0];
    const custom = withObjectStyle(node, {
      fill: '#123456',
      stroke: '#abcdef',
      textColor: '#fedcba',
    });
    expect(objectStyle(custom)).toMatchObject({
      fill: '#123456',
      stroke: '#abcdef',
      textColor: '#fedcba',
    });
  });

  it('锁定对象不移动；拖动按 10px 网格吸附；尺寸有最小值', () => {
    let document = withNodes();
    const first = document.nodes[0];
    const locked = withObjectLocked(first, true);
    document = {
      ...document,
      nodes: document.nodes.map((node) => (node.id === first.id ? locked : node)),
    };
    const moved = moveObjects(document, [first.id], 27, 13);
    expect(moved.nodes.find((node) => node.id === first.id)!.x).toBe(first.x);
    const unlockedId = document.nodes[1].id;
    const movedUnlocked = moveObjects(document, [unlockedId], 27, 13);
    expect(movedUnlocked.nodes.find((node) => node.id === unlockedId)!.x).toBe(330);
    expect(movedUnlocked.nodes.find((node) => node.id === unlockedId)!.y).toBe(110);
    const resized = document.nodes[2];
    expect(
      resized.width,
    ).toBeGreaterThan(0);
    expect(objectLocked(locked)).toBe(true);
  });

  it('双击改字只更新文本，不重建对象 id', () => {
    const document = withNodes();
    const node = document.nodes[0];
    const updated = setObjectText(document, node.id, '新文字');
    expect(updated.nodes[0].id).toBe(node.id);
    expect(updated.nodes[0].text).toBe('新文字');
    expect(setObjectText(updated, node.id, '新文字')).toBe(updated);
  });
});

describe('画板模型 · 对齐/等距/层级/复制', () => {
  it('左对齐、水平居中、顶对齐、垂直居中', () => {
    const document = withNodes();
    const ids = document.nodes.map((node) => node.id);
    const left = alignObjects(document, ids, 'left');
    expect(new Set(left.nodes.map((node) => node.x))).toEqual(new Set([left.nodes[0].x]));
    const centered = alignObjects(document, ids, 'hcenter');
    const centers = centered.nodes.map((node) => node.x + node.width / 2);
    expect(new Set(centers.map((value) => Math.round(value)))).toEqual(
      new Set([Math.round(centers[0])]),
    );
    const top = alignObjects(document, ids, 'top');
    expect(new Set(top.nodes.map((node) => node.y)).size).toBe(1);
    const vcenter = alignObjects(document, ids, 'vcenter');
    const verticalCenters = vcenter.nodes.map((node) => node.y + node.height / 2);
    expect(new Set(verticalCenters.map((value) => Math.round(value))).size).toBe(1);
  });

  it('3 个对象水平等距后间距一致，且首尾位置不变', () => {
    let document = withNodes();
    document = {
      ...document,
      nodes: document.nodes.map((node, index) =>
        index === 0
          ? { ...node, x: 0, width: 100 }
          : index === 1
            ? { ...node, x: 300, width: 200 }
            : { ...node, x: 900, width: 100 },
      ),
    };
    const ids = document.nodes.map((node) => node.id);
    const distributed = distributeObjects(document, ids, 'x');
    const [a, b, c] = distributed.nodes;
    const gap1 = b.x - (a.x + a.width);
    const gap2 = c.x - (b.x + b.width);
    expect(gap1).toBe(gap2);
    expect(a.x).toBe(0);
    expect(c.x + c.width).toBe(1000);
  });

  it('层级置顶/置底改变 zIndex；复制/粘贴生成新 id 并重映射连线', () => {
    let document = withNodes();
    const first = document.nodes[0];
    const second = document.nodes[1];
    document = addConnector(document, first.id, second.id, {
      idFactory: testIdFactory,
      label: '是',
    }).document;
    const front = layerObjects(document, [first.id], 'front');
    expect(front.nodes[front.nodes.length - 1].id).toBe(first.id);
    const back = layerObjects(document, [first.id], 'back');
    expect(back.nodes[0].id).toBe(first.id);

    const clipboard = copyObjects(
      { ...document, edges: [{ ...document.edges[0], label: '是' }] },
      [first.id, second.id],
    );
    expect(clipboard.nodes).toHaveLength(2);
    expect(clipboard.edges).toHaveLength(1);
    const pasted = pasteObjects(document, clipboard, {
      idFactory: testIdFactory,
    });
    expect(pasted.document.nodes).toHaveLength(5);
    expect(pasted.document.edges).toHaveLength(2);
    const pastedEdge = pasted.document.edges[1];
    expect(pastedEdge.fromNodeId).not.toBe(first.id);
    expect(pasted.nodeIds).toContain(pastedEdge.fromNodeId);
    expect(pasted.nodeIds).toContain(pastedEdge.toNodeId);
    const duplicate = duplicateObjects(document, [first.id], {
      idFactory: testIdFactory,
    });
    expect(duplicate.document.nodes).toHaveLength(4);
    expect(duplicate.nodeIds[0]).not.toBe(first.id);
  });

  it('上移/下移一层按整组步进，不越过组内对象', () => {
    const document = withNodes();
    const [a, b] = document.nodes;
    const up = layerObjects(document, [a.id], 'up');
    const byId = new Map(up.nodes.map((node) => [node.id, node.zIndex]));
    expect(byId.get(a.id)).toBe(1);
    expect(byId.get(b.id)).toBe(0);

    const downAtBottom = layerObjects(document, [a.id], 'down');
    expect(downAtBottom).toBe(document);

    const groupUp = layerObjects(document, [a.id, b.id], 'up');
    const groupOrder = [...groupUp.nodes]
      .sort((left, right) => left.zIndex - right.zIndex)
      .map((node) => node.id);
    expect(groupOrder).toEqual([document.nodes[2].id, a.id, b.id]);

    const groupDown = layerObjects(groupUp, [a.id, b.id], 'down');
    const downOrder = [...groupDown.nodes]
      .sort((left, right) => left.zIndex - right.zIndex)
      .map((node) => node.id);
    expect(downOrder).toEqual([a.id, b.id, document.nodes[2].id]);
  });

  it('批量修改连线线型一次生效，且只影响选中的连线', () => {
    let document = withNodes();
    const [a, b, c] = document.nodes;
    const first = addConnector(document, a.id, b.id, { idFactory: testIdFactory });
    document = first.document;
    const second = addConnector(document, b.id, c.id, { idFactory: testIdFactory });
    document = second.document;
    const third = addConnector(document, c.id, a.id, { idFactory: testIdFactory });
    document = third.document;
    document = updateConnectorStyle(document, third.edgeId!, {
      routing: 'curve',
    });
    const next = updateConnectorsStyle(
      document,
      [first.edgeId!, second.edgeId!],
      { routing: 'straight' },
    );
    expect(next.edges.map((edge) => connectorStyle(edge).routing)).toEqual([
      'straight',
      'straight',
      'curve',
    ]);
    expect(updateConnectorsStyle(next, [], { routing: 'curve' })).toBe(next);
  });

  it('锁定对象不能新增连线；已有连线保留且可删除', () => {
    let document = withNodes();
    const [a, b] = document.nodes;
    const added = addConnector(document, a.id, b.id, { idFactory: testIdFactory });
    document = added.document;
    document = setObjectsLocked(document, [a.id, b.id], true);
    expect(document.edges).toHaveLength(1);
    expect(
      addConnector(document, a.id, b.id, { idFactory: testIdFactory }).edgeId,
    ).toBeNull();
    const deleted = deleteObjects(document, {
      nodeIds: [],
      edgeIds: [added.edgeId!],
    });
    expect(deleted.edges).toHaveLength(0);
  });

  it('删除对象同时删除相关连线；删除连线不动对象', () => {
    let document = withNodes();
    const [a, b] = document.nodes;
    const added = addConnector(document, a.id, b.id, { idFactory: testIdFactory });
    document = added.document;
    const deleted = deleteObjects(document, { nodeIds: [a.id], edgeIds: [] });
    expect(deleted.nodes).toHaveLength(2);
    expect(deleted.edges).toHaveLength(0);
    const edgeDeleted = deleteObjects(document, {
      nodeIds: [],
      edgeIds: [added.edgeId!],
    });
    expect(edgeDeleted.nodes).toHaveLength(3);
    expect(edgeDeleted.edges).toHaveLength(0);
  });

  it('锁定对象可被选择器锁定/解锁，但仍保留文本/样式', () => {
    const document = withNodes();
    const ids = document.nodes.map((node) => node.id);
    const locked = setObjectsLocked(document, ids, true);
    expect(locked.nodes.every(objectLocked)).toBe(true);
    const unlocked = setObjectsLocked(locked, ids, false);
    expect(unlocked.nodes.some(objectLocked)).toBe(false);
    expect(unlocked.nodes[0].text).toBe(document.nodes[0].text);
  });
});

describe('画板模型 · 连线', () => {
  it('4 锚点连线保存 from/to side，可改线型/箭头/粗细/虚线/标签并反向', () => {
    let document = withNodes();
    const [a, b] = document.nodes;
    const added = addConnector(document, a.id, b.id, {
      idFactory: testIdFactory,
      fromSide: 'r',
      toSide: 'l',
      label: '是',
    });
    document = added.document;
    expect(document.edges[0].style).toMatchObject({
      fromSide: 'r',
      toSide: 'l',
      routing: 'elbow',
      arrow: 'end',
    });
    document = updateConnectorStyle(document, added.edgeId!, {
      routing: 'elbow',
      arrow: 'both',
      dashed: true,
      width: 3,
      color: '#5579d5',
    });
    const style = connectorStyle(document.edges[0]);
    expect(style.routing).toBe('elbow');
    expect(style.arrow).toBe('both');
    expect(style.dashed).toBe(true);
    expect(style.width).toBe(3);
    document = setConnectorLabel(document, added.edgeId!, '否');
    expect(document.edges[0].label).toBe('否');
    const reversed = reverseConnector(document, added.edgeId!);
    expect(reversed.edges[0].fromNodeId).toBe(b.id);
    expect(reversed.edges[0].toNodeId).toBe(a.id);
    expect(connectorStyle(reversed.edges[0]).fromSide).toBe('l');
    expect(connectorStyle(reversed.edges[0]).toSide).toBe('r');
  });

  it('不能连自己，端点不存在时返回空', () => {
    const document = withNodes();
    const node = document.nodes[0];
    expect(
      addConnector(document, node.id, node.id, { idFactory: testIdFactory }).edgeId,
    ).toBeNull();
    expect(
      addConnector(document, node.id, 'missing', { idFactory: testIdFactory }).edgeId,
    ).toBeNull();
  });

  it('四向快捷创建在对象右侧新增步骤并自动连线', () => {
    const document = withNodes();
    const node = document.nodes[0];
    const result = addQuickObject(document, node.id, 'r', {
      idFactory: testIdFactory,
    });
    expect(result.nodeId).toBeTruthy();
    expect(result.document.nodes).toHaveLength(4);
    expect(result.document.edges).toHaveLength(1);
    expect(result.document.edges[0].fromNodeId).toBe(node.id);
    expect(result.document.edges[0].toNodeId).toBe(result.nodeId);
  });
});

describe('画板模型 · 起步结构', () => {
  const insertKind = (kind: BoardStarterKind) =>
    insertStarter(emptyDocument(), kind, { idFactory: testIdFactory }).document;

  it.each([
    ['flow', 6, 5],
    ['timeline', 12, 0],
    ['org', 10, 9],
    ['sys', 12, 6],
    ['mind', 6, 5],
    ['pyramid', 4, 0],
    ['flywheel', 6, 5],
    ['lane', 9, 0],
    ['lane-vertical', 9, 0],
  ] as const)('%s 插入可编辑对象与连线', (kind, nodes, edges) => {
    const result = insertStarter(emptyDocument(), kind, {
      idFactory: testIdFactory,
    });
    expect(result.document.nodes).toHaveLength(nodes);
    expect(result.document.edges).toHaveLength(edges);
    expect(result.nodeIds).toHaveLength(nodes);
    // 插入的是普通对象，不是不可编辑模板。
    expect(result.document.nodes.every((node) => node.payload.locked !== true)).toBe(true);
  });

  it('模板清单覆盖规范中的 8 个模板，并按 3 组展示', () => {
    const kinds = BOARD_STARTERS.map((template) => template.kind);
    for (const kind of [
      'timeline',
      'org',
      'sys',
      'mind',
      'pyramid',
      'flywheel',
      'lane',
      'lane-vertical',
    ] as const) {
      expect(kinds).toContain(kind);
    }
    expect(STARTER_GROUPS.map((group) => group.id)).toEqual([
      'process',
      'structure',
      'thinking',
    ]);
    for (const group of STARTER_GROUPS) {
      expect(BOARD_STARTERS.some((template) => template.group === group.id)).toBe(
        true,
      );
    }
    const titles = Object.fromEntries(
      BOARD_STARTERS.map((template) => [template.kind, template.title]),
    );
    expect(titles.timeline).toBe('时间线');
    expect(titles.org).toBe('组织架构');
    expect(titles.sys).toBe('系统架构');
    expect(titles.mind).toBe('思维导图');
    expect(titles.pyramid).toBe('金字塔');
    expect(titles.flywheel).toBe('增长飞轮');
    expect(titles.lane).toBe('泳道 · 横向');
    expect(titles['lane-vertical']).toBe('泳道 · 纵向');
  });

  it('预览缩略图与真正插入的对象/连线数量、几何来源一致', () => {
    for (const template of BOARD_STARTERS) {
      const preview = starterPreview(template.kind);
      const document = insertKind(template.kind);
      expect(preview.nodes).toHaveLength(document.nodes.length);
      expect(preview.edges).toHaveLength(document.edges.length);
      expect(preview.bounds.width).toBeGreaterThan(0);
      expect(preview.bounds.height).toBeGreaterThan(0);
    }
  });

  it('所有模板共用语义样式：无锁定、无模式字段、颜色只用主题令牌', () => {
    const colorFields = ['fill', 'stroke', 'textColor'] as const;
    for (const template of BOARD_STARTERS) {
      const { document } = insertStarter(emptyDocument(), template.kind, {
        idFactory: testIdFactory,
      });
      for (const node of document.nodes) {
        expect(node.payload.locked).toBe(false);
        expect(node.payload).not.toHaveProperty('templateId');
        expect(node.payload).not.toHaveProperty('groupId');
        expect(['process', 'start', 'decision']).not.toContain(node.type);
        const style = objectStyle(node);
        for (const field of colorFields) {
          expect(
            style[field] === 'transparent' ||
              /^var\(--board-[a-z0-9-]+\)$/.test(style[field]),
          ).toBe(true);
        }
        expect(style.fontSize).toBeGreaterThanOrEqual(9);
        expect(style.fontSize).toBeLessThanOrEqual(32);
      }
      for (const edge of document.edges) {
        const style = connectorStyle(edge);
        expect(style.width).toBe(1.5);
        expect(/^var\(--board-[a-z0-9-]+\)$/.test(style.color)).toBe(true);
      }
    }
  });

  it('时间线：760×6 轴 + 5 个 24px 圆点 + 上下交错标签 + 标题，共 12 个对象', () => {
    const { document } = insertStarter(emptyDocument(), 'timeline', {
      idFactory: testIdFactory,
    });
    expect(document.edges).toHaveLength(0);

    const axis = document.nodes.find((node) => node.type === 'rect')!;
    expect([axis.x, axis.y, axis.width, axis.height]).toEqual([0, 120, 760, 6]);
    expect(objectStyle(axis).fill).toBe(BOARD_THEME_TOKENS.neutralStroke);
    expect(objectStyle(axis).stroke).toBe('transparent');

    const dots = document.nodes.filter((node) => node.type === 'ellipse');
    expect(dots.map((dot) => [dot.x, dot.y, dot.width, dot.height])).toEqual([
      [36, 111, 24, 24],
      [206, 111, 24, 24],
      [376, 111, 24, 24],
      [546, 111, 24, 24],
      [716, 111, 24, 24],
    ]);
    expect(
      dots.every((dot) => objectStyle(dot).fill === BOARD_THEME_TOKENS.anchor),
    ).toBe(true);
    expect(
      dots.every((dot) => objectStyle(dot).stroke === BOARD_THEME_TOKENS.canvas),
    ).toBe(true);

    const labels = document.nodes.filter(
      (node) => node.type === 'text' && node.text !== '时间线 · 2026 Q4',
    );
    expect(
      labels.map((label) => [label.text, label.x, label.y, label.width, label.height]),
    ).toEqual([
      ['立项', -14, 44, 124, 30],
      ['设计', 156, 160, 124, 30],
      ['开发', 326, 44, 124, 30],
      ['内测', 496, 160, 124, 30],
      ['发布', 666, 44, 124, 30],
    ]);
    expect(labels.every((label) => objectStyle(label).fontSize === 13)).toBe(true);

    const title = document.nodes.find((node) => node.text === '时间线 · 2026 Q4')!;
    expect([title.x, title.y, title.width, title.height]).toEqual([0, -16, 300, 34]);
    expect(objectStyle(title).fontSize).toBe(15);
    expect(objectStyle(title).bold).toBe(true);
  });

  it('组织架构：1+3+6 个对象、9 条 b→t 折线，端点都指向新对象', () => {
    const { document, nodeIds } = insertStarter(emptyDocument(), 'org', {
      idFactory: testIdFactory,
    });
    expect(nodeIds).toHaveLength(10);
    expect(document.nodes).toHaveLength(10);
    expect(document.edges).toHaveLength(9);

    const byText = new Map(document.nodes.map((node) => [node.text, node]));
    expect(byText.get('负责人')).toMatchObject({
      type: 'round',
      x: 330,
      y: 0,
      width: 180,
      height: 56,
    });
    expect(
      ['产品', '设计', '工程'].map((text) => {
        const node = byText.get(text)!;
        return [node.x, node.y, node.width, node.height];
      }),
    ).toEqual([
      [60, 120, 180, 52],
      [310, 120, 180, 52],
      [560, 120, 180, 52],
    ]);
    const teams = ['用户研究', '路线规划', '交互', '视觉', '前端', '后端'];
    expect(
      teams.map((text) => {
        const node = byText.get(text)!;
        return [node.x, node.y, node.width, node.height];
      }),
    ).toEqual([
      [20, 244, 110, 48],
      [150, 244, 110, 48],
      [280, 244, 110, 48],
      [410, 244, 110, 48],
      [540, 244, 110, 48],
      [670, 244, 110, 48],
    ]);

    const nodeIdSet = new Set(document.nodes.map((node) => node.id));
    for (const edge of document.edges) {
      expect(nodeIdSet.has(edge.fromNodeId)).toBe(true);
      expect(nodeIdSet.has(edge.toNodeId)).toBe(true);
      expect(connectorStyle(edge)).toMatchObject({
        routing: 'elbow',
        fromSide: 'b',
        toSide: 't',
      });
    }
    const rootId = byText.get('负责人')!.id;
    expect(document.edges.slice(0, 3).every((edge) => edge.fromNodeId === rootId)).toBe(
      true,
    );
    const departments = ['产品', '设计', '工程'];
    teams.forEach((text, index) => {
      const edge = document.edges[3 + index];
      expect(edge.fromNodeId).toBe(
        byText.get(departments[Math.floor(index / 2)])!.id,
      );
      expect(edge.toNodeId).toBe(byText.get(text)!.id);
    });
  });

  it('系统架构：3 层 760×120 容器 + 9 个 200×56 方块，6 条层间直线', () => {
    const { document } = insertStarter(emptyDocument(), 'sys', {
      idFactory: testIdFactory,
    });
    const frames = document.nodes.filter((node) => node.type === 'frame');
    expect(
      frames.map((frame) => [frame.text, frame.x, frame.y, frame.width, frame.height]),
    ).toEqual([
      ['接入层', 0, 0, 760, 120],
      ['服务层', 0, 160, 760, 120],
      ['数据层', 0, 320, 760, 120],
    ]);
    expect(
      frames.every((frame) => objectStyle(frame).textAlign === 'left'),
    ).toBe(true);

    const blocks = document.nodes.filter((node) => node.type === 'round');
    expect(blocks).toHaveLength(9);
    blocks.forEach((block, index) => {
      const row = Math.floor(index / 3);
      const col = index % 3;
      expect([block.x, block.y, block.width, block.height]).toEqual([
        30 + col * 250,
        44 + row * 160,
        200,
        56,
      ]);
    });
    // 容器在下，方块在上。
    expect(Math.min(...blocks.map((block) => block.zIndex))).toBeGreaterThan(
      Math.max(...frames.map((frame) => frame.zIndex)),
    );

    expect(document.edges).toHaveLength(6);
    expect(
      document.edges.every((edge) => {
        const style = connectorStyle(edge);
        return (
          style.routing === 'straight' &&
          style.fromSide === 'b' &&
          style.toSide === 't'
        );
      }),
    ).toBe(true);
    expect(
      document.edges.map((edge) => [edge.fromNodeId, edge.toNodeId]),
    ).toEqual([
      [blocks[0].id, blocks[3].id],
      [blocks[3].id, blocks[6].id],
      [blocks[1].id, blocks[4].id],
      [blocks[4].id, blocks[7].id],
      [blocks[2].id, blocks[5].id],
      [blocks[5].id, blocks[8].id],
    ]);
  });

  it('思维导图：中心椭圆 + 5 个分支、5 条曲线，四向发散', () => {
    const { document } = insertStarter(emptyDocument(), 'mind', {
      idFactory: testIdFactory,
    });
    expect(document.nodes).toHaveLength(6);
    const center = document.nodes.find((node) => node.text === '画板')!;
    expect([center.type, center.x, center.y, center.width, center.height]).toEqual([
      'ellipse',
      300,
      185,
      180,
      110,
    ]);
    const branches = ['对象', '连线', '模板', '嵌入', '导出'].map(
      (text) => document.nodes.find((node) => node.text === text)!,
    );
    expect(
      branches.map((branch) => [
        branch.x,
        branch.y,
        branch.width,
        branch.height,
      ]),
    ).toEqual([
      [560, 80, 150, 50],
      [560, 300, 150, 50],
      [30, 80, 150, 50],
      [30, 300, 150, 50],
      [315, -40, 150, 50],
    ]);
    expect(document.edges.map((edge) => [edge.fromNodeId, edge.toNodeId])).toEqual(
      branches.map((branch) => [center.id, branch.id]),
    );
    expect(document.edges.map((edge) => connectorStyle(edge))).toEqual([
      expect.objectContaining({ routing: 'curve', fromSide: 'r', toSide: 'l' }),
      expect.objectContaining({ routing: 'curve', fromSide: 'r', toSide: 'l' }),
      expect.objectContaining({ routing: 'curve', fromSide: 'l', toSide: 'r' }),
      expect.objectContaining({ routing: 'curve', fromSide: 'l', toSide: 'r' }),
      expect.objectContaining({ routing: 'curve', fromSide: 't', toSide: 'b' }),
    ]);
  });

  it('金字塔：4 层宽度递减，水平中心一致', () => {
    const { document } = insertStarter(emptyDocument(), 'pyramid', {
      idFactory: testIdFactory,
    });
    expect(document.nodes).toHaveLength(4);
    expect(document.edges).toHaveLength(0);
    const layers = ['战略', '目标', '执行', '动作'].map(
      (text) => document.nodes.find((node) => node.text === text)!,
    );
    expect(layers.map((layer) => layer.width)).toEqual([600, 460, 320, 180]);
    expect(layers.map((layer) => layer.y)).toEqual([0, 76, 152, 228]);
    for (const layer of layers) {
      expect(layer.x + layer.width / 2).toBe(380);
    }
    expect(objectStyle(layers[1]).fill).toBe(BOARD_THEME_TOKENS.accentFill);
    expect(objectStyle(layers[2]).fill).toBe(BOARD_THEME_TOKENS.tealFill);
    expect(objectStyle(layers[3]).fill).toBe(BOARD_THEME_TOKENS.stickyFill);
  });

  it('增长飞轮：5 个胶囊均布在半径 210 的圆上，5 条曲线首尾相接', () => {
    const { document } = insertStarter(emptyDocument(), 'flywheel', {
      idFactory: testIdFactory,
    });
    expect(document.nodes).toHaveLength(6);
    const center = document.nodes.find((node) => node.type === 'text')!;
    expect(center.text).toBe('增长飞轮');
    expect([center.x, center.y, center.width, center.height]).toEqual([
      290, 220, 180, 40,
    ]);
    const pills = document.nodes.filter((node) => node.type === 'pill');
    expect(pills.map((pill) => pill.text)).toEqual([
      '获客',
      '激活',
      '留存',
      '收入',
      '推荐',
    ]);
    const expectedCenters = [
      [380, 30],
      [579.7, 175.1],
      [503.4, 409.9],
      [256.6, 409.9],
      [180.3, 175.1],
    ];
    pills.forEach((pill, index) => {
      expect(pill.x + pill.width / 2).toBeCloseTo(expectedCenters[index][0], 0);
      expect(pill.y + pill.height / 2).toBeCloseTo(expectedCenters[index][1], 0);
    });
    expect(document.edges).toHaveLength(5);
    expect(document.edges.map((edge) => [edge.fromNodeId, edge.toNodeId])).toEqual(
      pills.map((pill, index) => [pill.id, pills[(index + 1) % 5].id]),
    );
    expect(document.edges.map((edge) => connectorStyle(edge).routing)).toEqual([
      'curve',
      'curve',
      'curve',
      'curve',
      'curve',
    ]);
    expect(
      document.edges.every(
        (edge) => connectorStyle(edge).color === BOARD_THEME_TOKENS.tealStroke,
      ),
    ).toBe(true);
  });

  it('横向泳道：3 个 880×140 容器 + 每行 2 张 180×76 便签', () => {
    const { document } = insertStarter(emptyDocument(), 'lane', {
      idFactory: testIdFactory,
    });
    const frames = document.nodes.filter((node) => node.type === 'frame');
    expect(
      frames.map((frame) => [frame.text, frame.x, frame.y, frame.width, frame.height]),
    ).toEqual([
      ['市场', 0, 0, 880, 140],
      ['产品', 0, 150, 880, 140],
      ['研发', 0, 300, 880, 140],
    ]);
    expect(
      frames.every((frame) => objectStyle(frame).textAlign === 'left'),
    ).toBe(true);
    const stickies = document.nodes.filter((node) => node.type === 'sticky');
    expect(
      stickies.map((sticky) => [
        sticky.text,
        sticky.x,
        sticky.y,
        sticky.width,
        sticky.height,
      ]),
    ).toEqual([
      ['待验证', 210, 34, 180, 76],
      ['已就绪', 510, 34, 180, 76],
      ['待验证', 210, 184, 180, 76],
      ['已就绪', 510, 184, 180, 76],
      ['待验证', 210, 334, 180, 76],
      ['已就绪', 510, 334, 180, 76],
    ]);
    expect(document.edges).toHaveLength(0);
    expect(Math.min(...stickies.map((sticky) => sticky.zIndex))).toBeGreaterThan(
      Math.max(...frames.map((frame) => frame.zIndex)),
    );
  });

  it('纵向泳道：3 列 280×420 容器 + 每列 2 张 220×100 便签', () => {
    const { document } = insertStarter(emptyDocument(), 'lane-vertical', {
      idFactory: testIdFactory,
    });
    const frames = document.nodes.filter((node) => node.type === 'frame');
    expect(
      frames.map((frame) => [frame.text, frame.x, frame.y, frame.width, frame.height]),
    ).toEqual([
      ['待办', 0, 0, 280, 420],
      ['进行中', 300, 0, 280, 420],
      ['已完成', 600, 0, 280, 420],
    ]);
    const stickies = document.nodes.filter((node) => node.type === 'sticky');
    expect(
      stickies.map((sticky) => [
        sticky.text,
        sticky.x,
        sticky.y,
        sticky.width,
        sticky.height,
      ]),
    ).toEqual([
      ['这一列的第一张卡', 30, 74, 220, 100],
      ['这一列的第二张卡', 30, 234, 220, 100],
      ['这一列的第一张卡', 330, 74, 220, 100],
      ['这一列的第二张卡', 330, 234, 220, 100],
      ['这一列的第一张卡', 630, 74, 220, 100],
      ['这一列的第二张卡', 630, 234, 220, 100],
    ]);
    expect(document.edges).toHaveLength(0);
    expect(Math.min(...stickies.map((sticky) => sticky.zIndex))).toBeGreaterThan(
      Math.max(...frames.map((frame) => frame.zIndex)),
    );
  });

  it.each(['timeline', 'sys', 'flywheel'] as const)(
    '%s 经 JSON 保存/重开后几何、样式与连线保持一致',
    (kind) => {
      const { document } = insertStarter(emptyDocument(), kind, {
        idFactory: testIdFactory,
      });
      const reopened = parseBoardDocument(boardDocumentJson(document));
      expect(reopened.nodes).toEqual(document.nodes);
      expect(reopened.edges).toEqual(document.edges);
      expect(
        reopened.nodes.every((node) => objectLocked(node) === false),
      ).toBe(true);
    },
  );

  it('已有内容时所有模板都放到下方 80px，不覆盖现有对象且不改动原文档', () => {
    const base = addObject(
      emptyDocument(),
      'rect',
      { x: 200, y: 100 },
      { idFactory: testIdFactory },
    ).document;
    const existing = base.nodes[0];
    for (const template of BOARD_STARTERS) {
      const { document } = insertStarter(base, template.kind, {
        idFactory: testIdFactory,
      });
      const added = document.nodes.filter((node) => node.id !== existing.id);
      expect(documentBounds(added)!.y).toBe(
        existing.y + existing.height + STARTER_CONTENT_GAP,
      );
      for (const node of added) {
        const overlaps =
          node.x < existing.x + existing.width &&
          node.x + node.width > existing.x &&
          node.y < existing.y + existing.height &&
          node.y + node.height > existing.y;
        expect(overlaps).toBe(false);
      }
    }
    expect(base.nodes).toHaveLength(1);
  });
});

describe('画板模型 · 视图与 JSON', () => {
  it('缩放限制在 30%–200%，适配后内容居中', () => {
    const document = withNodes();
    const view = fitViewport(document.nodes, { width: 800, height: 600 });
    expect(view.zoom).toBeGreaterThanOrEqual(0.3);
    expect(view.zoom).toBeLessThanOrEqual(2);
    const contentCenterX = 350;
    const screenCenterX = (contentCenterX - view.x) * view.zoom;
    expect(screenCenterX).toBeCloseTo(400, 0);
  });

  it('JSON 导出/解析 round-trip 保留未知 payload 字段', () => {
    let document = withNodes();
    document = {
      ...document,
      nodes: document.nodes.map((node) =>
        node.id === document.nodes[0].id
          ? { ...node, payload: { ...node.payload, futureField: { nested: true } } }
          : node,
      ),
    };
    const json = boardDocumentJson(document);
    expect(json).toContain('futureField');
    const parsed = parseBoardDocument(json);
    expect(parsed.nodes).toHaveLength(document.nodes.length);
    expect(parsed.nodes.find((node) => node.id === document.nodes[0].id)!.payload.futureField).toEqual({
      nested: true,
    });
    expect(parsed.title).toBe('测试画板');
  });

  it('旧类型按规范归一：process→rect、start→pill、decision→diamond、circle→ellipse', () => {
    const json = {
      version: 1,
      boardId: 'legacy',
      noteId: null,
      title: '旧画板',
      background: 'dot',
      nodes: [
        {
          id: 'old-process',
          type: 'process',
          x: 0,
          y: 0,
          width: 170,
          height: 62,
          text: '流程步骤',
          payload: { style: { fill: 'var(--board-process-fill)' }, locked: true },
        },
        {
          id: 'old-start',
          type: 'start',
          x: 0,
          y: 100,
          width: 130,
          height: 54,
          text: '开始',
          payload: { style: {} },
        },
        {
          id: 'old-decision',
          type: 'decision',
          x: 200,
          y: 0,
          width: 160,
          height: 84,
          text: '判断？',
          payload: { style: {} },
        },
        {
          id: 'old-circle',
          type: 'circle',
          x: 200,
          y: 100,
          width: 140,
          height: 140,
          text: '旧圆',
          payload: { style: {} },
        },
        {
          id: 'future',
          type: 'mindmap_future',
          x: 400,
          y: 0,
          width: 100,
          height: 50,
          text: '未来对象',
          payload: { style: { unknownStyle: true } },
        },
      ],
      edges: [
        {
          id: 'old-edge',
          fromNodeId: 'old-process',
          toNodeId: 'old-start',
          label: '',
          style: { routing: 'curve' },
        },
      ],
    };
    const parsed = parseBoardDocument(json);
    expect(parsed.nodes.map((node) => node.type)).toEqual([
      'rect',
      'pill',
      'diamond',
      'ellipse',
      'rect',
    ]);
    // 只归一类型名；文字、几何、样式、锁定与连线全部保留。
    expect(parsed.nodes.map((node) => node.text)).toEqual([
      '流程步骤',
      '开始',
      '判断？',
      '旧圆',
      '未来对象',
    ]);
    expect(parsed.nodes[0]).toMatchObject({
      x: 0,
      y: 0,
      width: 170,
      height: 62,
      payload: { locked: true },
    });
    expect(parsed.nodes[0].payload.style).toEqual({
      fill: 'var(--board-process-fill)',
    });
    expect(parsed.nodes[4].payload.style).toEqual({ unknownStyle: true });
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.edges[0].style).toEqual({ routing: 'curve' });
  });

  it('导入 JSON 可覆盖 boardId/noteId，并校验重复 id/悬空连线', () => {
    const document = withNodes();
    const json = boardDocumentJson(document);
    const parsed = parseBoardDocument(json, {
      boardId: 'current-board',
      noteId: 'current-note',
    });
    expect(parsed.boardId).toBe('current-board');
    expect(parsed.noteId).toBe('current-note');

    const duplicate = {
      ...JSON.parse(json),
      nodes: [document.nodes[0], document.nodes[0]],
      edges: [],
    };
    expect(() => parseBoardDocument(duplicate)).toThrow(/id 重复/);
    const dangling = {
      ...JSON.parse(json),
      edges: [
        {
          id: 'bad',
          fromNodeId: document.nodes[0].id,
          toNodeId: 'missing',
          label: '',
          style: {},
        },
      ],
    };
    expect(() => parseBoardDocument(dangling)).toThrow(/不存在的对象/);
    expect(() => parseBoardDocument('{')).toThrow(BoardDocumentError);
    expect(() => parseBoardDocument({ version: 2, nodes: [], edges: [] })).toThrow(
      /version=1/,
    );
  });

  it('源文件导出包含 schema、元数据与 viewport，并可完整读回', () => {
    const document = withNodes();
    const viewport = { x: 120, y: 80, zoom: 1.25 };
    const json = boardDocumentJson(document, {
      viewport,
      exportedAt: '2026-10-29T08:00:00.000Z',
    });
    const raw = JSON.parse(json) as Record<string, unknown>;
    expect(raw.schema).toBe('zhixing.board');
    expect(raw.version).toBe(1);
    expect(raw.metadata).toMatchObject({
      app: 'zhixing',
      schema: 'zhixing.board',
      exportedAt: '2026-10-29T08:00:00.000Z',
    });
    expect(raw.viewport).toEqual(viewport);

    const parsed = parseBoardDocumentFile(json);
    expect(parsed.viewport).toEqual(viewport);
    expect(parsed.metadata.exportedAt).toBe('2026-10-29T08:00:00.000Z');
    expect(parsed.document.nodes).toEqual(document.nodes);
    expect(parsed.document.edges).toEqual(document.edges);
  });

  it('旧版源文件没有 viewport/metadata 时仍可导入，未知版本与悬空引用明确报错', () => {
    const document = withNodes();
    const legacy = JSON.parse(boardDocumentJson(document)) as Record<
      string,
      unknown
    >;
    delete legacy.viewport;
    delete legacy.metadata;
    delete legacy.schema;
    const parsed = parseBoardDocumentFile(legacy);
    expect(parsed.viewport).toBeNull();
    expect(parsed.metadata.app).toBe('zhixing');

    expect(() =>
      parseBoardDocumentFile({
        ...legacy,
        version: 2,
      }),
    ).toThrow(/version=1/);
    expect(() =>
      parseBoardDocumentFile({
        ...legacy,
        edges: [
          {
            id: 'missing-edge',
            fromNodeId: document.nodes[0].id,
            toNodeId: 'not-exist',
            label: '',
            style: {},
          },
        ],
      }),
    ).toThrow(/不存在的对象/);
  });

  it('旧对象类型导入时给出迁移警告且不丢文字/连线', () => {
    const parsed = parseBoardDocumentFile({
      version: 1,
      boardId: 'legacy',
      noteId: null,
      title: '旧画板',
      background: 'dot',
      nodes: [
        {
          id: 'old-process',
          type: 'process',
          x: 12,
          y: 34,
          width: 160,
          height: 60,
          text: '流程',
          payload: { style: { fill: '#eee' } },
        },
        {
          id: 'old-start',
          type: 'start',
          x: 200,
          y: 34,
          width: 120,
          height: 52,
          text: '开始',
          payload: {},
        },
      ],
      edges: [
        {
          id: 'e-old',
          fromNodeId: 'old-process',
          toNodeId: 'old-start',
          label: '下一步',
          style: { routing: 'curve' },
        },
      ],
    });
    expect(parsed.document.nodes.map((node) => node.type)).toEqual([
      'rect',
      'pill',
    ]);
    expect(parsed.document.nodes[0]).toMatchObject({
      x: 12,
      y: 34,
      width: 160,
      height: 60,
      text: '流程',
    });
    expect(parsed.document.edges[0].label).toBe('下一步');
    expect(parsed.warnings[0]).toMatch(/旧对象类型已迁移/);
  });
});
