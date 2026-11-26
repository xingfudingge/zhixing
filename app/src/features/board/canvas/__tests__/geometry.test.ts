import { describe, expect, it } from 'vitest';

import { createEmptyDocument, createObject } from '../../model';
import type {
  BoardConnector,
  BoardObject,
  IdFactory,
} from '../../types';
import {
  anchorPoint,
  autoSides,
  connectorEnds,
  connectorGeometry,
  connectorLabelPoint,
  connectorSamples,
  distanceToGeometry,
  hitTestConnector,
  hitTestNode,
  marqueeNodeIds,
  normalizeDragRect,
  pointInObject,
  rectsIntersect,
  sideDirection,
} from '../geometry';

let sequence = 0;
const ids: IdFactory = (prefix) => `${prefix}-${++sequence}`;

function node(
  type: string,
  x: number,
  y: number,
  width = 100,
  height = 60,
): BoardObject {
  return {
    ...createObject(type, { x: x + width / 2, y: y + height / 2 }, {
      idFactory: ids,
      width,
      height,
    }),
    x,
    y,
  };
}

function connector(
  from: BoardObject,
  to: BoardObject,
  style: Record<string, unknown> = {},
): BoardConnector {
  return {
    id: ids('edge'),
    fromNodeId: from.id,
    toNodeId: to.id,
    label: '',
    style: style as BoardConnector['style'],
  };
}

describe('画板几何 · 锚点与自动方向', () => {
  const rect = node('rect', 100, 100, 100, 60);

  it('四个锚点位于边中点', () => {
    expect(anchorPoint(rect, 'l')).toEqual({ x: 100, y: 130 });
    expect(anchorPoint(rect, 'r')).toEqual({ x: 200, y: 130 });
    expect(anchorPoint(rect, 't')).toEqual({ x: 150, y: 100 });
    expect(anchorPoint(rect, 'b')).toEqual({ x: 150, y: 160 });
  });

  it('自动选择最近的左右/上下锚点', () => {
    const right = node('rect', 400, 100);
    expect(autoSides(rect, right)).toEqual(['r', 'l']);
    expect(autoSides(right, rect)).toEqual(['l', 'r']);
    const below = node('rect', 100, 300);
    expect(autoSides(rect, below)).toEqual(['b', 't']);
  });
});

describe('画板几何 · 连线', () => {
  const from = node('rect', 100, 100, 100, 60);
  const to = node('rect', 400, 100, 100, 60);

  it('直线/折线/曲线三种线型生成可采样路径', () => {
    const straight = connectorGeometry(
      connector(from, to, { routing: 'straight', fromSide: 'r', toSide: 'l' }),
      from,
      to,
    );
    expect(straight.kind).toBe('polyline');
    expect(straight.points).toEqual([
      { x: 200, y: 130 },
      { x: 400, y: 130 },
    ]);
    const samples = connectorSamples(straight, 20);
    expect(samples.length).toBeGreaterThan(2);
    const straightEnds = connectorEnds(straight);
    expect(straightEnds.start).toEqual({ x: 200, y: 130 });
    expect(straightEnds.end).toEqual({ x: 400, y: 130 });
    expect(straightEnds.startTangent.x).toBeLessThan(0);
    expect(straightEnds.endTangent.x).toBeGreaterThan(0);

    const elbow = connectorGeometry(
      connector(from, to, { routing: 'elbow', fromSide: 'r', toSide: 'l' }),
      from,
      to,
    );
    expect(elbow.kind).toBe('polyline');
    expect(elbow.points).toEqual([
      { x: 200, y: 130 },
      { x: 300, y: 130 },
      { x: 400, y: 130 },
    ]);
    const elbowEnds = connectorEnds(elbow);
    expect(elbowEnds.startTangent.x).toBeLessThan(0);
    expect(elbowEnds.endTangent.x).toBeGreaterThan(0);

    const curve = connectorGeometry(
      connector(from, to, { routing: 'curve', fromSide: 'r', toSide: 'l' }),
      from,
      to,
    );
    expect(curve.kind).toBe('curve');
    if (curve.kind === 'curve') {
      expect(curve.points[0]).toEqual({ x: 200, y: 130 });
      expect(curve.points[3]).toEqual({ x: 400, y: 130 });
      expect(curve.points[1].x).toBeGreaterThan(200);
      expect(curve.points[2].x).toBeLessThan(400);
    }
    expect(connectorLabelPoint(curve).y).toBeCloseTo(130, 3);
    const ends = connectorEnds(curve);
    expect(ends.start.x).toBe(200);
    expect(ends.end.x).toBe(400);
    expect(ends.startTangent.x).toBeLessThan(0);
    expect(ends.endTangent.x).toBeGreaterThan(0);
  });

  it('三种线型都能按实际路径命中', () => {
    const down = node('rect', 400, 300);
    const straight = connector(from, to, {
      routing: 'straight',
      fromSide: 'r',
      toSide: 'l',
    });
    const elbow = connector(from, down, {
      routing: 'elbow',
      fromSide: 'r',
      toSide: 'l',
    });
    const curve = connector(from, to, {
      routing: 'curve',
      fromSide: 'r',
      toSide: 'l',
    });
    expect(
      hitTestConnector([straight], [from, to], { x: 300, y: 130 }, 8)?.id,
    ).toBe(straight.id);
    expect(
      hitTestConnector([elbow], [from, down], { x: 300, y: 230 }, 8)?.id,
    ).toBe(elbow.id);
    const curveGeometry = connectorGeometry(curve, from, to);
    const curveMidpoint = connectorSamples(curveGeometry, 40)[20];
    expect(
      hitTestConnector([curve], [from, to], curveMidpoint, 2)?.id,
    ).toBe(curve.id);
  });

  it('折线标签取弧长中点，不会压在 L 形拐角上', () => {
    const target = node('rect', 400, 300);
    const geometry = connectorGeometry(
      connector(from, target, {
        routing: 'elbow',
        fromSide: 'r',
        toSide: 't',
      }),
      from,
      target,
    );
    expect(geometry.kind).toBe('polyline');
    expect(geometry.points).toEqual([
      { x: 200, y: 130 },
      { x: 450, y: 130 },
      { x: 450, y: 300 },
    ]);
    expect(connectorLabelPoint(geometry)).toEqual({ x: 410, y: 130 });
  });

  it('折线在 16 种锚点组合下都沿外法线离开/进入且保持正交', () => {
    const sides = ['l', 'r', 't', 'b'] as const;
    const positions = [
      [400, 300],
      [-300, -200],
      [400, -200],
      [-300, 300],
      [400, 100],
      [-300, 100],
      [100, 300],
      [100, -200],
    ];
    for (const [x, y] of positions) {
      for (const fromSide of sides) {
        for (const toSide of sides) {
          const source = node('rect', 100, 100);
          const target = node('rect', x, y);
          const geometry = connectorGeometry(
            connector(source, target, {
              routing: 'elbow',
              fromSide,
              toSide,
            }),
            source,
            target,
          );
          expect(geometry.kind).toBe('polyline');
          if (geometry.kind !== 'polyline') {
            continue;
          }
          const points = geometry.points;
          expect(points[0]).toEqual(anchorPoint(source, fromSide));
          expect(points[points.length - 1]).toEqual(
            anchorPoint(target, toSide),
          );

          for (let index = 0; index < points.length - 1; index += 1) {
            const start = points[index];
            const end = points[index + 1];
            expect(
              Math.abs(start.x - end.x) < 0.001 ||
                Math.abs(start.y - end.y) < 0.001,
            ).toBe(true);
          }

          const first = points[1];
          const d1 = sideDirection(fromSide);
          expect(
            (first.x - points[0].x) * d1.x +
              (first.y - points[0].y) * d1.y,
          ).toBeGreaterThan(0);

          const last = points[points.length - 1];
          const previous = points[points.length - 2];
          const d2 = sideDirection(toSide);
          expect(
            (last.x - previous.x) * d2.x +
              (last.y - previous.y) * d2.y,
          ).toBeLessThan(0);

          const ends = connectorEnds(geometry);
          expect(
            ends.startTangent.x * d1.x + ends.startTangent.y * d1.y,
          ).toBeLessThanOrEqual(0);
          expect(
            ends.endTangent.x * d2.x + ends.endTangent.y * d2.y,
          ).toBeLessThan(0);

          // 折线不应穿过起点/终点对象内部（端点本身除外）。
          const samples = connectorSamples(geometry, 60).slice(1, -1);
          for (const sample of samples) {
            expect(pointInObject(sample, source)).toBe(false);
            expect(pointInObject(sample, target)).toBe(false);
          }
        }
      }
    }
  });

  it('命中测试只选中距离足够近的连线', () => {
    const edge = connector(from, to, {
      routing: 'straight',
      fromSide: 'r',
      toSide: 'l',
    });
    const nodes = [from, to];
    expect(
      hitTestConnector([edge], nodes, { x: 300, y: 132 }, 8)?.id,
    ).toBe(edge.id);
    expect(hitTestConnector([edge], nodes, { x: 300, y: 180 }, 8)).toBeNull();
    expect(
      distanceToGeometry(
        { x: 300, y: 130 },
        connectorGeometry(edge, from, to),
      ),
    ).toBeCloseTo(0, 3);
  });
});

describe('画板几何 · 形状与框选', () => {
  it('椭圆/菱形按真实形状命中，矩形按边界命中', () => {
    const ellipse = node('ellipse', 0, 0, 100, 100);
    expect(pointInObject({ x: 50, y: 50 }, ellipse)).toBe(true);
    expect(pointInObject({ x: 2, y: 2 }, ellipse)).toBe(false);
    const decision = node('diamond', 0, 0, 100, 100);
    expect(pointInObject({ x: 50, y: 50 }, decision)).toBe(true);
    expect(pointInObject({ x: 2, y: 2 }, decision)).toBe(false);
    const rect = node('rect', 0, 0, 100, 100);
    expect(pointInObject({ x: 99, y: 99 }, rect)).toBe(true);
    expect(pointInObject({ x: 101, y: 50 }, rect)).toBe(false);
  });

  it('重叠对象命中 zIndex 更高的一个', () => {
    const lower = { ...node('rect', 0, 0, 100, 100), zIndex: 0 };
    const upper = { ...node('rect', 20, 20, 100, 100), zIndex: 2 };
    expect(hitTestNode([lower, upper], { x: 50, y: 50 })?.id).toBe(upper.id);
  });

  it('框选返回相交对象，支持反向拖动', () => {
    const a = node('rect', 100, 100);
    const b = node('rect', 300, 100);
    const rect = normalizeDragRect({ x: 400, y: 240 }, { x: 250, y: 80 });
    expect(rect).toEqual({ x: 250, y: 80, width: 150, height: 160 });
    expect(marqueeNodeIds([a, b], rect)).toEqual([b.id]);
    expect(rectsIntersect(rect, { x: 390, y: 150, width: 50, height: 50 })).toBe(
      true,
    );
  });
});

describe('画板几何 · 文档仍可渲染', () => {
  it('空文档不产生对象', () => {
    expect(createEmptyDocument({ boardId: 'b' }).nodes).toHaveLength(0);
  });
});
