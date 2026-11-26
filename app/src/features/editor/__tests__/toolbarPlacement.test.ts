import { describe, expect, it } from 'vitest';

import {
  TOOLBAR_ANCHOR_MARGIN,
  TOOLBAR_GAP,
  TOOLBAR_VIEWPORT_GAP,
  isAnchorVisible,
  placeToolbar,
} from '../toolbarPlacement';

const viewport = {
  left: 0,
  top: 0,
  right: 1024,
  bottom: 768,
  width: 1024,
  height: 768,
};

function anchor(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

const layer = { width: 220, height: 34 };

describe('placeToolbar · 垂直翻转', () => {
  it('上方放得下时贴 caret 上方，右边缘对齐', () => {
    const placement = placeToolbar({
      anchor: anchor(100, 200, 200, 32),
      layer,
      viewport,
    });
    expect(placement).toMatchObject({
      side: 'top',
      left: 80,
      top: 200 - TOOLBAR_GAP - layer.height,
      maxHeight: null,
    });
    expect(placement.top + layer.height).toBeLessThanOrEqual(200 - TOOLBAR_GAP);
  });

  it('首行靠近视口顶部时翻到 caret 行下方，不遮 caret', () => {
    const placement = placeToolbar({
      anchor: anchor(100, 20, 200, 32),
      layer,
      viewport,
    });
    expect(placement.side).toBe('bottom');
    expect(placement.top).toBe(52 + TOOLBAR_GAP);
    expect(placement.top).toBeGreaterThanOrEqual(52 + TOOLBAR_GAP);
  });

  it('末行靠近视口底部时翻到 caret 行上方', () => {
    const placement = placeToolbar({
      anchor: anchor(100, 700, 200, 32),
      layer,
      viewport,
    });
    expect(placement.side).toBe('top');
    expect(placement.top).toBe(700 - TOOLBAR_GAP - layer.height);
    expect(placement.top + layer.height).toBeLessThanOrEqual(700 - TOOLBAR_GAP);
  });

  it('上下都放不下时选空间大的一侧并限高，仍不覆盖锚点', () => {
    const shortViewport = {
      left: 0,
      top: 0,
      right: 1024,
      bottom: 90,
      width: 1024,
      height: 90,
    };
    const placement = placeToolbar({
      anchor: anchor(100, 30, 200, 30),
      layer,
      viewport: shortViewport,
    });
    expect(placement.maxHeight).not.toBeNull();
    expect(placement.top + (placement.maxHeight ?? 0)).toBeLessThanOrEqual(
      30 - TOOLBAR_GAP,
    );
    expect(placement.top).toBeGreaterThanOrEqual(TOOLBAR_VIEWPORT_GAP);
  });
});

describe('placeToolbar · 水平夹取与窄窗', () => {
  it('首列靠左时向右夹取到视口安全边距', () => {
    const placement = placeToolbar({
      anchor: anchor(0, 200, 220, 32),
      layer,
      viewport,
    });
    expect(placement.left).toBe(TOOLBAR_VIEWPORT_GAP);
  });

  it('末列靠右时向左夹取，右边缘不越界', () => {
    const placement = placeToolbar({
      anchor: anchor(900, 200, 220, 32),
      layer,
      viewport,
    });
    expect(placement.left).toBe(
      viewport.right - TOOLBAR_VIEWPORT_GAP - layer.width,
    );
    expect(placement.left + layer.width).toBeLessThanOrEqual(
      viewport.right - TOOLBAR_VIEWPORT_GAP,
    );
  });

  it('390 窄窗保留安全边距且 maxWidth 可用', () => {
    const narrow = {
      left: 0,
      top: 0,
      right: 390,
      bottom: 800,
      width: 390,
      height: 800,
    };
    const placement = placeToolbar({
      anchor: anchor(280, 200, 100, 32),
      layer,
      viewport: narrow,
    });
    expect(placement.maxWidth).toBe(390 - TOOLBAR_VIEWPORT_GAP * 2);
    expect(placement.left).toBeGreaterThanOrEqual(TOOLBAR_VIEWPORT_GAP);
    expect(placement.left + layer.width).toBeLessThanOrEqual(
      390 - TOOLBAR_VIEWPORT_GAP,
    );
  });

  it('内容区左边界可兜底，避免工具条压住侧栏', () => {
    const placement = placeToolbar({
      anchor: anchor(0, 200, 120, 32),
      layer,
      viewport,
      contentLeft: 60,
    });
    expect(placement.left).toBe(60);
  });
});

describe('isAnchorVisible', () => {
  it('锚点离开视口超过 24px 时隐藏；临界值内仍可见', () => {
    expect(
      isAnchorVisible(
        anchor(0, viewport.bottom + TOOLBAR_ANCHOR_MARGIN + 1, 10, 10),
        viewport,
      ),
    ).toBe(false);
    expect(
      isAnchorVisible(
        anchor(0, viewport.bottom + TOOLBAR_ANCHOR_MARGIN - 1, 10, 10),
        viewport,
      ),
    ).toBe(true);
  });

  it('零尺寸锚点（jsdom / display:none）不做滚出判断', () => {
    expect(isAnchorVisible(anchor(0, 5000, 0, 0), viewport)).toBe(true);
  });
});
