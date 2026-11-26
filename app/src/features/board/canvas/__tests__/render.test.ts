import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BOARD_OBJECT_FONT_SIZE,
  BOARD_OBJECT_STROKE_WIDTH,
  createEmptyDocument,
  createObject,
} from '../../model';
import type { BoardDocument, BoardObject, IdFactory } from '../../types';
import {
  BOARD_FONT_FAMILY,
  DARK_BOARD_PALETTE,
  FALLBACK_DARK_THEME,
  FALLBACK_THEME,
  LIGHT_BOARD_PALETTE,
  paintBoardScene,
  readBoardTheme,
  resolveBoardColor,
  type BoardTheme,
} from '../render';

let sequence = 0;
const ids: IdFactory = (prefix) => `${prefix}-${++sequence}`;

type DrawCall = {
  method: string;
  args: unknown[];
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  globalAlpha: number;
};

function fakeContext() {
  const calls: DrawCall[] = [];
  const ctx: Record<string, unknown> = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    font: '',
    globalAlpha: 1,
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    measureText: (text: string) => ({ width: Array.from(text).length * 8 }),
  };
  for (const method of [
    'setTransform',
    'clearRect',
    'fillRect',
    'save',
    'restore',
    'scale',
    'translate',
    'beginPath',
    'moveTo',
    'lineTo',
    'quadraticCurveTo',
    'bezierCurveTo',
    'closePath',
    'ellipse',
    'rect',
    'arc',
    'clip',
    'fill',
    'stroke',
    'fillText',
    'strokeRect',
    'setLineDash',
  ]) {
    ctx[method] = (...args: unknown[]) => {
      calls.push({
        method,
        args,
        fillStyle: String(ctx.fillStyle),
        strokeStyle: String(ctx.strokeStyle),
        lineWidth: Number(ctx.lineWidth),
        font: String(ctx.font),
        globalAlpha: Number(ctx.globalAlpha),
      });
    };
  }
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    calls,
  };
}

function sceneNode(
  type: string,
  x: number,
  y: number,
  zIndex: number,
  extra: Partial<BoardObject> = {},
): BoardObject {
  return {
    ...createObject(type, { x: x + 80, y: y + 40 }, { idFactory: ids }),
    x,
    y,
    zIndex,
    ...extra,
  };
}

function scene(): BoardDocument {
  const document = createEmptyDocument({ boardId: 'board-style' });
  document.nodes = [
    sceneNode('frame', 20, 20, 0, { width: 300, height: 200, text: '容器' }),
    sceneNode('sticky', 60, 80, 1, { width: 140, height: 90, text: '便签' }),
    sceneNode('diamond', 340, 40, 2, { width: 160, height: 84, text: '继续？' }),
    sceneNode('pill', 340, 180, 3, { width: 130, height: 54, text: '开始' }),
    sceneNode('rect', 540, 180, 4, { width: 170, height: 58, text: '处理' }),
  ];
  return document;
}

function paint(theme: BoardTheme, document = scene(), options: {
  selection?: { nodeIds: string[]; edgeIds: string[] };
  hoveredNodeId?: string | null;
} = {}) {
  const { ctx, calls } = fakeContext();
  paintBoardScene({
    ctx,
    width: 900,
    height: 600,
    dpr: 1,
    document,
    view: { x: 0, y: 0, zoom: 1 },
    theme,
    selection: options.selection,
    hoveredNodeId: options.hoveredNodeId,
    showGrid: false,
    showBoundary: false,
    shadow: false,
  });
  return calls;
}

function fills(calls: DrawCall[]): string[] {
  return calls.filter((call) => call.method === 'fill').map((call) => call.fillStyle);
}

function strokes(calls: DrawCall[]): string[] {
  return calls
    .filter((call) => call.method === 'stroke')
    .map((call) => call.strokeStyle);
}

function textColors(calls: DrawCall[]): string[] {
  return calls
    .filter((call) => call.method === 'fillText')
    .map((call) => call.fillStyle);
}

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('style');
});

describe('画板 Canvas 渲染 · 主题与默认视觉', () => {
  it('泳道/容器先铺底、连线居中、普通对象最上层，避免底色盖住连线', () => {
    const document = scene();
    const sticky = document.nodes.find((node) => node.type === 'sticky')!;
    const diamond = document.nodes.find((node) => node.type === 'diamond')!;
    document.edges = [
      {
        id: 'edge-order',
        fromNodeId: sticky.id,
        toNodeId: diamond.id,
        label: '',
        style: {},
      },
    ];
    const calls = paint(FALLBACK_THEME, document);

    const frameFillIndex = calls.findIndex(
      (call) =>
        call.method === 'fill' &&
        call.fillStyle === LIGHT_BOARD_PALETTE['--board-frame-fill'],
    );
    const connectorStrokeIndex = calls.findIndex(
      (call) =>
        call.method === 'stroke' &&
        call.strokeStyle === LIGHT_BOARD_PALETTE['--board-connector'],
    );
    const stickyFillIndex = calls.findIndex(
      (call) =>
        call.method === 'fill' &&
        call.fillStyle === LIGHT_BOARD_PALETTE['--board-sticky-fill'],
    );

    expect(frameFillIndex).toBeGreaterThanOrEqual(0);
    expect(connectorStrokeIndex).toBeGreaterThan(frameFillIndex);
    expect(stickyFillIndex).toBeGreaterThan(connectorStrokeIndex);
  });

  it('浅色主题下 frame/sticky/diamond/pill/rect 的填充、描边、文字都解析语义令牌', () => {
    const calls = paint(FALLBACK_THEME);
    const expected = [
      ['--board-frame-fill', '--board-frame-stroke', '--board-frame-text'],
      ['--board-sticky-fill', '--board-sticky-stroke', '--board-sticky-text'],
      [
        '--board-diamond-fill',
        '--board-diamond-stroke',
        '--board-diamond-text',
      ],
      ['--board-pill-fill', '--board-pill-stroke', '--board-pill-text'],
      ['--board-rect-fill', '--board-rect-stroke', '--board-rect-text'],
    ] as const;

    expect(fills(calls)).toEqual(
      expected.map(([fill]) => LIGHT_BOARD_PALETTE[fill]),
    );
    expect(strokes(calls)).toEqual(
      expected.map(([, stroke]) => LIGHT_BOARD_PALETTE[stroke]),
    );
    expect(textColors(calls)).toEqual(
      expected.map(([, , text]) => LIGHT_BOARD_PALETTE[text]),
    );
    // 所有对象共用同一套描边粗细，不再按类型各写 1.2/1.5。
    for (const call of calls.filter(
      (item) => item.method === 'stroke' && expected.some(([, stroke]) =>
        item.strokeStyle === LIGHT_BOARD_PALETTE[stroke]),
    )) {
      expect(call.lineWidth).toBe(BOARD_OBJECT_STROKE_WIDTH);
    }
    for (const call of calls.filter((item) => item.method === 'fillText')) {
      expect(call.font).toContain(`${BOARD_OBJECT_FONT_SIZE}px`);
      expect(call.font).toContain(BOARD_FONT_FAMILY.split(',')[0]);
    }
  });

  it('暗色主题解析为暗色令牌，与浅色不同且对象文字保持可读对比度', () => {
    const lightFills = fills(paint(FALLBACK_THEME));
    const calls = paint(FALLBACK_DARK_THEME);
    const darkFills = fills(calls);
    expect(darkFills).toEqual([
      DARK_BOARD_PALETTE['--board-frame-fill'],
      DARK_BOARD_PALETTE['--board-sticky-fill'],
      DARK_BOARD_PALETTE['--board-diamond-fill'],
      DARK_BOARD_PALETTE['--board-pill-fill'],
      DARK_BOARD_PALETTE['--board-rect-fill'],
    ]);
    expect(darkFills).not.toEqual(lightFills);

    for (const palette of [LIGHT_BOARD_PALETTE, DARK_BOARD_PALETTE]) {
      // 容器透明底，文字对比度按画布底色校验。
      expect(
        contrast(palette['--board-frame-text'], palette['--board-canvas-bg']),
      ).toBeGreaterThanOrEqual(4.5);
      const pairs = [
        ['--board-sticky-text', '--board-sticky-fill'],
        ['--board-diamond-text', '--board-diamond-fill'],
        ['--board-pill-text', '--board-pill-fill'],
        ['--board-rect-text', '--board-rect-fill'],
      ] as const;
      for (const [text, fill] of pairs) {
        expect(contrast(palette[text], palette[fill])).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  it('用户自定义 hex 颜色不被主题解析覆盖', () => {
    const document = scene();
    document.nodes = document.nodes.map((node) =>
      node.type === 'sticky'
        ? {
            ...node,
            payload: {
              ...node.payload,
              style: {
                fill: '#123456',
                stroke: '#abcdef',
                textColor: '#fedcba',
              },
            },
          }
        : node,
    );
    const calls = paint(FALLBACK_DARK_THEME, document);
    expect(fills(calls)[1]).toBe('#123456');
    expect(strokes(calls)[1]).toBe('#abcdef');
    expect(textColors(calls)[1]).toBe('#fedcba');
  });

  it('选中/悬停/锁定态使用统一强调色与线宽；锁定对象改为弱化色', () => {
    const document = scene();
    const [frame, sticky, diamond] = document.nodes;
    const locked = {
      ...diamond,
      payload: { ...diamond.payload, locked: true },
    };
    document.nodes = [frame, sticky, locked, ...document.nodes.slice(3)];

    const calls = paint(FALLBACK_THEME, document, {
      selection: { nodeIds: [locked.id], edgeIds: [] },
      hoveredNodeId: frame.id,
    });
    const hoverStroke = calls.find(
      (call) =>
        call.method === 'stroke' &&
        call.globalAlpha === 0.42 &&
        call.strokeStyle === FALLBACK_THEME.accent,
    );
    expect(hoverStroke).toBeDefined();
    expect(hoverStroke?.lineWidth).toBeCloseTo(1.4);

    // 锁定对象选中框使用 muted，不再用强调色伪装成可编辑。
    const selectedFrame = calls.find(
      (call) =>
        call.method === 'strokeRect' &&
        call.lineWidth === 1.5 &&
        call.strokeStyle === FALLBACK_THEME.muted,
    );
    expect(selectedFrame).toBeDefined();
    // 锁定对象不出现缩放/快捷创建控件。
    const lockBadge = calls.find(
      (call) =>
        call.method === 'stroke' &&
        call.strokeStyle === FALLBACK_THEME.palette['--board-lock'],
    );
    expect(lockBadge).toBeDefined();
  });

  it('resolveBoardColor 只展开已知 board 令牌，其余颜色原样返回', () => {
    expect(resolveBoardColor('var(--board-sticky-fill)', FALLBACK_THEME)).toBe(
      LIGHT_BOARD_PALETTE['--board-sticky-fill'],
    );
    expect(resolveBoardColor('var(--board-sticky-fill)', FALLBACK_DARK_THEME)).toBe(
      DARK_BOARD_PALETTE['--board-sticky-fill'],
    );
    expect(resolveBoardColor('#123456', FALLBACK_DARK_THEME)).toBe('#123456');
    expect(resolveBoardColor('transparent', FALLBACK_DARK_THEME)).toBe(
      'transparent',
    );
    expect(resolveBoardColor('var(--surface)', FALLBACK_DARK_THEME)).toBe(
      'var(--surface)',
    );
  });

  it('readBoardTheme 读取 data-theme 与 computed custom properties', () => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.style.setProperty(
      '--board-sticky-fill',
      '#101820',
    );
    document.documentElement.style.setProperty('--surface', '#0b0f14');
    const theme = readBoardTheme();
    expect(theme.palette['--board-sticky-fill']).toBe('#101820');
    expect(theme.surface).toBe('#0b0f14');
    expect(theme.palette['--board-frame-fill']).toBe(
      DARK_BOARD_PALETTE['--board-frame-fill'],
    );
    expect(theme.fontFamily).toContain('PingFang SC');
  });

  it('board.css 的 --board-* 令牌与渲染色板一一对应', () => {
    const css = readFileSync('src/features/board/board.css', 'utf8');
    const cssTokens = new Set(
      Array.from(css.matchAll(/(--board-[a-z0-9-]+)\s*:/g), (match) => match[1]),
    );
    const lightTokens = new Set(
      Object.keys(LIGHT_BOARD_PALETTE).filter((token) =>
        token.startsWith('--board-'),
      ),
    );
    const darkTokens = new Set(
      Object.keys(DARK_BOARD_PALETTE).filter((token) =>
        token.startsWith('--board-'),
      ),
    );
    expect(lightTokens).toEqual(darkTokens);
    expect(cssTokens).toEqual(lightTokens);
  });
});
