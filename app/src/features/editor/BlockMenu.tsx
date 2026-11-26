import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { menuGroups } from './blocks/registry';
import type { KnownBlockType } from './types';

type BlockMenuProps = {
  blockId: string;
  x: number;
  y: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canDelete: boolean;
  /** 引用块：块操作组里提供「编辑引用出处」（ZX-NOTE-04）。 */
  isQuote?: boolean;
  onEditQuote?: () => void;
  onSelect: (type: KnownBlockType) => void;
  onMove: (delta: number) => void;
  onDelete: () => void;
  onClose: () => void;
};

export function BlockMenu({
  blockId,
  x,
  y,
  canMoveUp,
  canMoveDown,
  canDelete,
  isQuote = false,
  onEditQuote,
  onSelect,
  onMove,
  onDelete,
  onClose,
}: BlockMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  if (typeof document === 'undefined') {
    return null;
  }

  const width = 252;
  const height = 452;
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight;
  const left = Math.max(8, Math.min(x, viewportWidth - width - 8));
  const top = Math.max(8, Math.min(y, viewportHeight - height - 8));

  return createPortal(
    <div
      ref={ref}
      className="zxe-menu"
      role="menu"
      aria-label="插入块"
      style={{ left, top, width }}
      onMouseDown={(event) => event.preventDefault()}
      data-block-id={blockId}
    >
      {menuGroups().map((group) => (
        <div className="zxe-menu-group" key={group.group}>
          <div className="zxe-menu-group-label">{group.group}</div>
          {group.items.map((item) => (
            <button
              type="button"
              role="menuitem"
              className="zxe-menu-item"
              key={item.type}
              onClick={() => {
                onSelect(item.type);
                onClose();
              }}
            >
              <span className="zxe-menu-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="zxe-menu-text">{item.label}</span>
              {item.description ? (
                <small className="zxe-menu-hint">{item.description}</small>
              ) : null}
            </button>
          ))}
        </div>
      ))}
      <div className="zxe-menu-group">
        <div className="zxe-menu-group-label">块操作</div>
        <div className="zxe-menu-actions">
          {isQuote && onEditQuote ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onEditQuote();
                onClose();
              }}
            >
              ❝ 编辑引用出处
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            disabled={!canMoveUp}
            onClick={() => {
              onMove(-1);
              onClose();
            }}
          >
            ↑ 上移
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canMoveDown}
            onClick={() => {
              onMove(1);
              onClose();
            }}
          >
            ↓ 下移
          </button>
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            disabled={!canDelete}
            onClick={() => {
              onDelete();
              onClose();
            }}
          >
            删除块
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
