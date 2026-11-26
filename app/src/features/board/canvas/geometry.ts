/**
 * Canvas 命中测试与连线几何。
 *
 * 连线几何与渲染共用同一份采样数据，避免「看到的线」和「点得中的线」不一致。
 */

import {
  connectorStyle,
  normalizeObjectType,
  type Point,
  type Rect,
} from '../model';
import type {
  AnchorSide,
  BoardConnector,
  BoardObject,
} from '../types';

export type ConnectorGeometry =
  | { kind: 'polyline'; points: Point[] }
  | { kind: 'curve'; points: [Point, Point, Point, Point] };

export function sideDirection(side: AnchorSide): Point {
  switch (side) {
    case 'l':
      return { x: -1, y: 0 };
    case 'r':
      return { x: 1, y: 0 };
    case 't':
      return { x: 0, y: -1 };
    case 'b':
      return { x: 0, y: 1 };
  }
}

export function anchorPoint(node: BoardObject, side: AnchorSide): Point {
  switch (side) {
    case 'l':
      return { x: node.x, y: node.y + node.height / 2 };
    case 'r':
      return { x: node.x + node.width, y: node.y + node.height / 2 };
    case 't':
      return { x: node.x + node.width / 2, y: node.y };
    case 'b':
      return { x: node.x + node.width / 2, y: node.y + node.height };
  }
}

export function autoSides(
  from: BoardObject,
  to: BoardObject,
): [AnchorSide, AnchorSide] {
  if (from.x + from.width <= to.x) {
    return ['r', 'l'];
  }
  if (to.x + to.width <= from.x) {
    return ['l', 'r'];
  }
  if (from.y + from.height <= to.y) {
    return ['b', 't'];
  }
  return ['t', 'b'];
}

const MIN_ELBOW_STUB = 12;
const MAX_ELBOW_STUB = 24;

function simplifyPoints(points: ReadonlyArray<Point>): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (
      !last ||
      Math.abs(last.x - point.x) > 0.001 ||
      Math.abs(last.y - point.y) > 0.001
    ) {
      result.push(point);
    }
  }
  return result;
}

/**
 * 正交折线：首段必须沿起点的外法线离开，末段必须沿终点的外法线进入，
 * 否则箭头会朝对象内部、线也会穿过对象。普通相对锚点走中线，同侧/反向
 * 锚点则绕到对象外侧再折回来。
 */
function elbowPoints(
  p1: Point,
  d1: Point,
  p2: Point,
  d2: Point,
  from: BoardObject,
  to: BoardObject,
): Point[] {
  const stub = Math.max(
    MIN_ELBOW_STUB,
    Math.min(
      MAX_ELBOW_STUB,
      Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.12,
    ),
  );
  const left = Math.min(from.x, to.x) - stub;
  const right = Math.max(from.x + from.width, to.x + to.width) + stub;
  const top = Math.min(from.y, to.y) - stub;
  const bottom = Math.max(
    from.y + from.height,
    to.y + to.height,
  ) + stub;
  const horizontal1 = d1.x !== 0;
  const horizontal2 = d2.x !== 0;

  if (horizontal1 && horizontal2) {
    const facing =
      (d1.x > 0 && d2.x < 0 && p2.x > p1.x) ||
      (d1.x < 0 && d2.x > 0 && p2.x < p1.x);
    if (facing) {
      const midX = (p1.x + p2.x) / 2;
      return simplifyPoints([
        p1,
        { x: midX, y: p1.y },
        { x: midX, y: p2.y },
        p2,
      ]);
    }
    if (d1.x > 0 && d2.x > 0) {
      const q2 = { x: p2.x + stub, y: p2.y };
      const sx = from.x + from.width + stub;
      const y = p1.y <= q2.y ? top : bottom;
      return simplifyPoints([
        p1,
        { x: sx, y: p1.y },
        { x: sx, y },
        { x: q2.x, y },
        q2,
        p2,
      ]);
    }
    if (d1.x < 0 && d2.x < 0) {
      const q2 = { x: p2.x - stub, y: p2.y };
      const sx = from.x - stub;
      const y = p1.y <= q2.y ? top : bottom;
      return simplifyPoints([
        p1,
        { x: sx, y: p1.y },
        { x: sx, y },
        { x: q2.x, y },
        q2,
        p2,
      ]);
    }
    // 相向但目标在反方向：绕到两对象上下方，再折回目标锚点外侧。
    const y = p1.y <= p2.y ? top : bottom;
    const x1 = d1.x > 0 ? right : left;
    const x2 = d2.x > 0 ? right : left;
    return simplifyPoints([
      p1,
      { x: x1, y: p1.y },
      { x: x1, y },
      { x: x2, y },
      { x: x2, y: p2.y },
      p2,
    ]);
  }

  if (!horizontal1 && !horizontal2) {
    const facing =
      (d1.y > 0 && d2.y < 0 && p2.y > p1.y) ||
      (d1.y < 0 && d2.y > 0 && p2.y < p1.y);
    if (facing) {
      const midY = (p1.y + p2.y) / 2;
      return simplifyPoints([
        p1,
        { x: p1.x, y: midY },
        { x: p2.x, y: midY },
        p2,
      ]);
    }
    if (d1.y > 0 && d2.y > 0) {
      const q2 = { x: p2.x, y: p2.y + stub };
      const sy = from.y + from.height + stub;
      const x = q2.x >= p1.x ? left : right;
      return simplifyPoints([
        p1,
        { x: p1.x, y: sy },
        { x, y: sy },
        { x, y: q2.y },
        q2,
        p2,
      ]);
    }
    if (d1.y < 0 && d2.y < 0) {
      const q2 = { x: p2.x, y: p2.y - stub };
      const sy = from.y - stub;
      const x = q2.x >= p1.x ? left : right;
      return simplifyPoints([
        p1,
        { x: p1.x, y: sy },
        { x, y: sy },
        { x, y: q2.y },
        q2,
        p2,
      ]);
    }
    const x = p1.x <= p2.x ? left : right;
    const y1 = d1.y > 0 ? bottom : top;
    const y2 = d2.y > 0 ? bottom : top;
    return simplifyPoints([
      p1,
      { x: p1.x, y: y1 },
      { x, y: y1 },
      { x, y: y2 },
      { x: p2.x, y: y2 },
      p2,
    ]);
  }

  // 一横一竖：能走单拐点就走，否则先沿起点法线出一点，再从目标锚点外侧进入。
  if (horizontal1) {
    const aligned =
      (p2.x - p1.x) * d1.x > 0.001 &&
      (p2.y - p1.y) * -d2.y > 0.001;
    if (aligned) {
      return simplifyPoints([p1, { x: p2.x, y: p1.y }, p2]);
    }
    const x = d1.x > 0 ? from.x + from.width + stub : from.x - stub;
    const q2 = { x: p2.x, y: p2.y + d2.y * stub };
    return simplifyPoints([
      p1,
      { x, y: p1.y },
      { x, y: q2.y },
      q2,
      p2,
    ]);
  }

  const aligned =
    (p2.y - p1.y) * d1.y > 0.001 &&
    (p2.x - p1.x) * -d2.x > 0.001;
  if (aligned) {
    return simplifyPoints([p1, { x: p1.x, y: p2.y }, p2]);
  }
  const y = d1.y > 0 ? from.y + from.height + stub : from.y - stub;
  const q2 = { x: p2.x + d2.x * stub, y: p2.y };
  return simplifyPoints([
    p1,
    { x: p1.x, y },
    { x: q2.x, y },
    q2,
    p2,
  ]);
}

export function connectorGeometry(
  edge: BoardConnector,
  from: BoardObject,
  to: BoardObject,
): ConnectorGeometry {
  const style = connectorStyle(edge);
  const [autoFrom, autoTo] = autoSides(from, to);
  const fromSide = edge.style.fromSide ? style.fromSide : autoFrom;
  const toSide = edge.style.toSide ? style.toSide : autoTo;
  const p1 = anchorPoint(from, fromSide);
  const p2 = anchorPoint(to, toSide);
  const d1 = sideDirection(fromSide);
  const d2 = sideDirection(toSide);

  if (style.routing === 'straight') {
    return { kind: 'polyline', points: [p1, p2] };
  }

  if (style.routing === 'elbow') {
    return {
      kind: 'polyline',
      points: elbowPoints(p1, d1, p2, d2, from, to),
    };
  }

  const offset = Math.max(
    40,
    Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.38,
  );
  return {
    kind: 'curve',
    points: [
      p1,
      { x: p1.x + d1.x * offset, y: p1.y + d1.y * offset },
      { x: p2.x + d2.x * offset, y: p2.y + d2.y * offset },
      p2,
    ],
  };
}

function cubicPoint(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

export function connectorSamples(
  geometry: ConnectorGeometry,
  steps = 36,
): Point[] {
  if (geometry.kind === 'polyline') {
    const samples: Point[] = [];
    for (let i = 0; i < geometry.points.length - 1; i += 1) {
      const start = geometry.points[i];
      const end = geometry.points[i + 1];
      const span = Math.max(2, Math.ceil(steps / (geometry.points.length - 1)));
      for (let step = 0; step < span; step += 1) {
        const t = step / span;
        samples.push({
          x: start.x + (end.x - start.x) * t,
          y: start.y + (end.y - start.y) * t,
        });
      }
    }
    samples.push(geometry.points[geometry.points.length - 1]);
    return samples;
  }
  return Array.from({ length: steps + 1 }, (_, index) =>
    cubicPoint(
      geometry.points[0],
      geometry.points[1],
      geometry.points[2],
      geometry.points[3],
      index / steps,
    ),
  );
}

export function connectorLabelPoint(geometry: ConnectorGeometry): Point {
  if (geometry.kind === 'curve') {
    return cubicPoint(
      geometry.points[0],
      geometry.points[1],
      geometry.points[2],
      geometry.points[3],
      0.5,
    );
  }
  // 折线按弧长取中点，避免 L 形/多段折线的标签正好压在拐角上。
  const points = geometry.points;
  if (points.length <= 1) {
    return points[0] ?? { x: 0, y: 0 };
  }
  const lengths: number[] = [];
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const length = pointDistance(points[index], points[index + 1]);
    lengths.push(length);
    total += length;
  }
  if (total <= 0.001) {
    return points[0];
  }
  let remaining = total / 2;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (length <= 0.001) {
      continue;
    }
    if (remaining <= length || index === lengths.length - 1) {
      const t = Math.max(0, Math.min(1, remaining / length));
      return {
        x: points[index].x + (points[index + 1].x - points[index].x) * t,
        y: points[index].y + (points[index + 1].y - points[index].y) * t,
      };
    }
    remaining -= length;
  }
  return points[points.length - 1];
}

export type ConnectorEnds = {
  start: Point;
  end: Point;
  startTangent: Point;
  endTangent: Point;
};

export function connectorEnds(geometry: ConnectorGeometry): ConnectorEnds {
  if (geometry.kind === 'curve') {
    const [p0, c1, c2, p3] = geometry.points;
    return {
      start: p0,
      end: p3,
      startTangent: { x: p0.x - c1.x, y: p0.y - c1.y },
      endTangent: { x: p3.x - c2.x, y: p3.y - c2.y },
    };
  }
  const points = geometry.points;
  const start = points[0];
  const end = points[points.length - 1];
  const next = points[1] ?? start;
  const previous = points[points.length - 2] ?? start;
  return {
    start,
    end,
    startTangent: { x: start.x - next.x, y: start.y - next.y },
    endTangent: { x: end.x - previous.x, y: end.y - previous.y },
  };
}

export function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distanceToSegment(
  point: Point,
  start: Point,
  end: Point,
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) {
    return pointDistance(point, start);
  }
  const projection =
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, projection));
  return Math.hypot(
    point.x - (start.x + dx * t),
    point.y - (start.y + dy * t),
  );
}

export function distanceToGeometry(
  point: Point,
  geometry: ConnectorGeometry,
): number {
  const samples = connectorSamples(geometry, 30);
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < samples.length - 1; index += 1) {
    best = Math.min(
      best,
      distanceToSegment(point, samples[index], samples[index + 1]),
    );
  }
  return best;
}

export function hitTestConnector(
  edges: ReadonlyArray<BoardConnector>,
  nodes: ReadonlyArray<BoardObject>,
  point: Point,
  tolerance: number,
): BoardConnector | null {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  let best: { edge: BoardConnector; distance: number } | null = null;
  for (const edge of edges) {
    const from = nodeMap.get(edge.fromNodeId);
    const to = nodeMap.get(edge.toNodeId);
    if (!from || !to) {
      continue;
    }
    const distance = distanceToGeometry(
      point,
      connectorGeometry(edge, from, to),
    );
    if (distance <= tolerance && (!best || distance < best.distance)) {
      best = { edge, distance };
    }
  }
  return best?.edge ?? null;
}

export function pointInRotatedRect(
  point: Point,
  rect: Rect,
  rotation: number,
): boolean {
  if (!rotation) {
    return (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    );
  }
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const radians = (-rotation * Math.PI) / 180;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
  return (
    Math.abs(localX) <= rect.width / 2 && Math.abs(localY) <= rect.height / 2
  );
}

/** 形状级命中；第一阶段不处理 8 向手柄，但椭圆/菱形按压感更准确。 */
export function pointInObject(point: Point, node: BoardObject): boolean {
  if (node.rotation) {
    return pointInRotatedRect(
      point,
      { x: node.x, y: node.y, width: node.width, height: node.height },
      node.rotation,
    );
  }
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const dx = (point.x - cx) / Math.max(1, node.width / 2);
  const dy = (point.y - cy) / Math.max(1, node.height / 2);
  // 旧类型先归一，保证 process/start/decision 的命中区域与新形状一致。
  switch (normalizeObjectType(node.type)) {
    case 'ellipse':
      return dx * dx + dy * dy <= 1;
    case 'diamond':
      return Math.abs(dx) + Math.abs(dy) <= 1;
    case 'triangle': {
      const top = { x: cx, y: node.y };
      const bottomLeft = { x: node.x, y: node.y + node.height };
      const bottomRight = {
        x: node.x + node.width,
        y: node.y + node.height,
      };
      const cross = (a: Point, b: Point, c: Point) =>
        (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      const d1 = cross(top, bottomLeft, point);
      const d2 = cross(bottomLeft, bottomRight, point);
      const d3 = cross(bottomRight, top, point);
      return (
        (d1 >= 0 && d2 >= 0 && d3 >= 0) ||
        (d1 <= 0 && d2 <= 0 && d3 <= 0)
      );
    }
    case 'hexagon':
      return Math.abs(dx) <= 1 && Math.abs(dy) <= 1;
    default:
      return (
        point.x >= node.x &&
        point.x <= node.x + node.width &&
        point.y >= node.y &&
        point.y <= node.y + node.height
      );
  }
}

export function hitTestNode(
  nodes: ReadonlyArray<BoardObject>,
  point: Point,
): BoardObject | null {
  const ordered = [...nodes].sort((a, b) => b.zIndex - a.zIndex);
  for (const node of ordered) {
    if (pointInObject(point, node)) {
      return node;
    }
  }
  return null;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.x > b.x + b.width ||
    a.x + a.width < b.x ||
    a.y > b.y + b.height ||
    a.y + a.height < b.y
  );
}

export function marqueeNodeIds(
  nodes: ReadonlyArray<BoardObject>,
  rect: Rect,
): string[] {
  return nodes
    .filter((node) =>
      rectsIntersect(rect, {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      }),
    )
    .map((node) => node.id);
}

export function normalizeDragRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}
