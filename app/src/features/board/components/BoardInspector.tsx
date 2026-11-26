import { useEffect, useRef, useState } from 'react';

import {
  CONNECTOR_COLORS,
  OBJECT_FILLS,
  OBJECT_STROKES,
  OBJECT_TEXT_COLORS,
  OBJECT_TYPE_LABELS,
  OBJECT_TYPE_ORDER,
  connectorStyle,
  normalizeObjectType,
  objectLocked,
  objectStyle,
  type AlignMode,
  type BoardLayerDirection,
} from '../model';
import type {
  BoardConnector,
  BoardConnectorStyle,
  BoardDocument,
  BoardObject,
  BoardObjectStyle,
  BoardSelection,
} from '../types';

export type BoardInspectorProps = {
  document: BoardDocument;
  selection: BoardSelection;
  readOnly: boolean;
  focusLabelToken: number;
  onChangeObjectStyle: (patch: Partial<BoardObjectStyle>) => void;
  onChangeObjectType: (type: string) => void;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (axis: 'x' | 'y') => void;
  onDuplicate: () => void;
  onLayer: (direction: BoardLayerDirection) => void;
  onToggleLock: () => void;
  onDelete: () => void;
  onChangeEdgeStyle: (patch: Partial<BoardConnectorStyle>) => void;
  onChangeEdgeLabel: (label: string) => void;
  onReverseEdge: () => void;
};

function swatchColorName(color: string): string {
  return color.replace('#', '').toUpperCase();
}

function ColorSwatches({
  colors,
  value,
  disabled,
  onPick,
  label,
}: {
  colors: ReadonlyArray<string>;
  value: string;
  disabled: boolean;
  onPick: (color: string) => void;
  label: string;
}) {
  return (
    <div className="bw-swatches" role="group" aria-label={label}>
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          className={value === color ? 'bw-swatch is-active' : 'bw-swatch'}
          style={{ background: color }}
          aria-label={`${label} ${swatchColorName(color)}`}
          aria-pressed={value === color}
          disabled={disabled}
          onClick={() => onPick(color)}
        />
      ))}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  disabled,
  onPick,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  disabled: boolean;
  onPick: (value: T) => void;
  label: string;
}) {
  return (
    <div className="bw-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? 'is-active' : ''}
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onPick(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function EdgeInspector({
  edge,
  nodes,
  readOnly,
  focusLabelToken,
  onChangeStyle,
  onChangeLabel,
  onReverse,
  onDelete,
}: {
  edge: BoardConnector;
  nodes: BoardObject[];
  readOnly: boolean;
  focusLabelToken: number;
  onChangeStyle: (patch: Partial<BoardConnectorStyle>) => void;
  onChangeLabel: (label: string) => void;
  onReverse: () => void;
  onDelete: () => void;
}) {
  const style = connectorStyle(edge);
  const [labelDraft, setLabelDraft] = useState(edge.label);
  const labelRef = useRef<HTMLInputElement>(null);
  const from = nodes.find((node) => node.id === edge.fromNodeId);
  const to = nodes.find((node) => node.id === edge.toNodeId);

  useEffect(() => {
    setLabelDraft(edge.label);
  }, [edge.id, edge.label]);

  useEffect(() => {
    if (!readOnly && focusLabelToken > 0) {
      labelRef.current?.focus();
      labelRef.current?.select();
    }
  }, [focusLabelToken, readOnly]);

  const commitLabel = () => {
    if (labelDraft !== edge.label) {
      onChangeLabel(labelDraft);
    }
  };

  return (
    <div className="bw-inspector-body">
      <h3>连线</h3>
      <p className="bw-inspector-sub">
        {from?.text || '对象'} → {to?.text || '对象'}
      </p>
      <div className="bw-field">
        <span className="bw-field-label">线型</span>
        <Segmented
          label="线型"
          value={style.routing}
          disabled={readOnly}
          options={[
            { value: 'curve', label: '曲线' },
            { value: 'elbow', label: '折线' },
            { value: 'straight', label: '直线' },
          ]}
          onPick={(routing) => onChangeStyle({ routing })}
        />
      </div>
      <div className="bw-field">
        <span className="bw-field-label">箭头</span>
        <Segmented
          label="箭头"
          value={style.arrow}
          disabled={readOnly}
          options={[
            { value: 'end', label: '终点' },
            { value: 'both', label: '两端' },
            { value: 'none', label: '无' },
          ]}
          onPick={(arrow) => onChangeStyle({ arrow })}
        />
      </div>
      <div className="bw-field">
        <span className="bw-field-label">颜色</span>
        <ColorSwatches
          label="连线颜色"
          colors={CONNECTOR_COLORS}
          value={style.color}
          disabled={readOnly}
          onPick={(color) => onChangeStyle({ color })}
        />
      </div>
      <div className="bw-field bw-field-row">
        <label htmlFor="bw-edge-width">粗细</label>
        <select
          id="bw-edge-width"
          value={style.width}
          disabled={readOnly}
          onChange={(event) =>
            onChangeStyle({ width: Number(event.target.value) })
          }
        >
          {[1, 1.5, 2, 3, 4].map((width) => (
            <option key={width} value={width}>
              {width} px
            </option>
          ))}
        </select>
      </div>
      <div className="bw-field bw-field-row">
        <label htmlFor="bw-edge-dashed">虚线</label>
        <input
          id="bw-edge-dashed"
          type="checkbox"
          checked={style.dashed}
          disabled={readOnly}
          onChange={(event) => onChangeStyle({ dashed: event.target.checked })}
        />
      </div>
      <div className="bw-field">
        <label className="bw-field-label" htmlFor="bw-edge-label">
          标签
        </label>
        <input
          ref={labelRef}
          id="bw-edge-label"
          type="text"
          value={labelDraft}
          placeholder="如：是 / 否"
          disabled={readOnly}
          onChange={(event) => setLabelDraft(event.target.value)}
          onBlur={commitLabel}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              setLabelDraft(edge.label);
            }
          }}
        />
      </div>
      <div className="bw-inspector-actions">
        <button
          type="button"
          className="bw-button"
          disabled={readOnly}
          onClick={onReverse}
        >
          反向
        </button>
        <button
          type="button"
          className="bw-button is-danger"
          disabled={readOnly}
          onClick={onDelete}
        >
          删除连线
        </button>
      </div>
    </div>
  );
}

function BatchEdgeInspector({
  edges,
  readOnly,
  onChangeStyle,
  onDelete,
}: {
  edges: BoardConnector[];
  readOnly: boolean;
  onChangeStyle: (patch: Partial<BoardConnectorStyle>) => void;
  onDelete: () => void;
}) {
  const styles = edges.map(connectorStyle);
  const common = <K extends keyof BoardConnectorStyle>(
    key: K,
  ): BoardConnectorStyle[K] | null =>
    styles.every((style) => style[key] === styles[0][key])
      ? styles[0][key]
      : null;
  const routing = common('routing');
  const arrow = common('arrow');
  const color = common('color');
  const width = common('width');
  const dashed = common('dashed');
  return (
    <div className="bw-inspector-body">
      <h3>已选 {edges.length} 条连线</h3>
      <p className="bw-inspector-sub">批量修改线型、箭头、颜色与粗细</p>
      <div className="bw-field">
        <span className="bw-field-label">线型</span>
        <Segmented
          label="批量线型"
          value={(routing ?? '') as BoardConnectorStyle['routing']}
          disabled={readOnly}
          options={[
            { value: 'curve', label: '曲线' },
            { value: 'elbow', label: '折线' },
            { value: 'straight', label: '直线' },
          ]}
          onPick={(next) => onChangeStyle({ routing: next })}
        />
      </div>
      <div className="bw-field">
        <span className="bw-field-label">箭头</span>
        <Segmented
          label="批量箭头"
          value={(arrow ?? '') as BoardConnectorStyle['arrow']}
          disabled={readOnly}
          options={[
            { value: 'end', label: '终点' },
            { value: 'both', label: '两端' },
            { value: 'none', label: '无' },
          ]}
          onPick={(next) => onChangeStyle({ arrow: next })}
        />
      </div>
      <div className="bw-field">
        <span className="bw-field-label">颜色</span>
        <ColorSwatches
          label="批量连线颜色"
          colors={CONNECTOR_COLORS}
          value={color ?? ''}
          disabled={readOnly}
          onPick={(next) => onChangeStyle({ color: next })}
        />
      </div>
      <div className="bw-field bw-field-row">
        <label htmlFor="bw-batch-edge-width">粗细</label>
        <select
          id="bw-batch-edge-width"
          value={width ?? ''}
          disabled={readOnly}
          onChange={(event) =>
            onChangeStyle({ width: Number(event.target.value) })
          }
        >
          <option value="" disabled>
            多种
          </option>
          {[1, 1.5, 2, 3, 4].map((value) => (
            <option key={value} value={value}>
              {value} px
            </option>
          ))}
        </select>
      </div>
      <div className="bw-field bw-field-row">
        <label htmlFor="bw-batch-edge-dashed">虚线</label>
        <input
          id="bw-batch-edge-dashed"
          type="checkbox"
          checked={dashed ?? false}
          disabled={readOnly}
          ref={(element) => {
            if (element) {
              element.indeterminate = dashed === null;
            }
          }}
          onChange={(event) => onChangeStyle({ dashed: event.target.checked })}
        />
      </div>
      <div className="bw-inspector-actions">
        <button
          type="button"
          className="bw-button is-danger"
          disabled={readOnly}
          onClick={onDelete}
        >
          删除 {edges.length} 条连线
        </button>
      </div>
    </div>
  );
}


function NodeInspector({
  node,
  readOnly,
  onChangeStyle,
  onChangeType,
  onDuplicate,
  onLayer,
  onToggleLock,
  onDelete,
}: {
  node: BoardObject;
  readOnly: boolean;
  onChangeStyle: (patch: Partial<BoardObjectStyle>) => void;
  onChangeType: (type: string) => void;
  onDuplicate: () => void;
  onLayer: (direction: BoardLayerDirection) => void;
  onToggleLock: () => void;
  onDelete: () => void;
}) {
  const style = objectStyle(node);
  const locked = objectLocked(node);
  const type = normalizeObjectType(node.type);
  return (
    <div className="bw-inspector-body">
      <h3>{OBJECT_TYPE_LABELS[type]}</h3>
      <p className="bw-inspector-sub">
        {locked ? '已锁定 · 解锁后可编辑' : '拖动移动，双击改文字'}
      </p>
      <div className="bw-field">
        <label className="bw-field-label" htmlFor="bw-node-type">
          形状
        </label>
        <select
          id="bw-node-type"
          value={type}
          disabled={readOnly || locked}
          onChange={(event) => onChangeType(event.target.value)}
        >
          {OBJECT_TYPE_ORDER.map((option) => (
            <option key={option} value={option}>
              {OBJECT_TYPE_LABELS[option]}
            </option>
          ))}
        </select>
      </div>
      <div className="bw-field">
        <span className="bw-field-label">填充</span>
        <ColorSwatches
          label="填充色"
          colors={OBJECT_FILLS}
          value={style.fill}
          disabled={readOnly || locked}
          onPick={(fill) => onChangeStyle({ fill })}
        />
      </div>
      <div className="bw-field">
        <span className="bw-field-label">边框</span>
        <ColorSwatches
          label="边框色"
          colors={OBJECT_STROKES}
          value={style.stroke}
          disabled={readOnly || locked}
          onPick={(stroke) => onChangeStyle({ stroke })}
        />
      </div>
      <div className="bw-field">
        <span className="bw-field-label">文字</span>
        <ColorSwatches
          label="文字色"
          colors={OBJECT_TEXT_COLORS}
          value={style.textColor}
          disabled={readOnly || locked}
          onPick={(textColor) => onChangeStyle({ textColor })}
        />
        <div className="bw-field-row">
          <label htmlFor="bw-font-size">字号</label>
          <input
            id="bw-font-size"
            type="number"
            min={9}
            max={32}
            value={style.fontSize}
            disabled={readOnly || locked}
            onChange={(event) =>
              onChangeStyle({ fontSize: Number(event.target.value) })
            }
          />
          <button
            type="button"
            className={style.bold ? 'bw-button is-active' : 'bw-button'}
            aria-label="加粗"
            aria-pressed={style.bold}
            disabled={readOnly || locked}
            onClick={() => onChangeStyle({ bold: !style.bold })}
          >
            B
          </button>
        </div>
        <Segmented
          label="文字对齐"
          value={style.textAlign}
          disabled={readOnly || locked}
          options={[
            { value: 'left', label: '左' },
            { value: 'center', label: '中' },
            { value: 'right', label: '右' },
          ]}
          onPick={(textAlign) => onChangeStyle({ textAlign })}
        />
      </div>
      <div className="bw-inspector-actions">
        <button
          type="button"
          className="bw-button"
          disabled={readOnly}
          onClick={onDuplicate}
        >
          复制一份
        </button>
        <button
          type="button"
          className="bw-button"
          disabled={readOnly}
          onClick={() => onLayer('front')}
        >
          置顶
        </button>
        <button
          type="button"
          className="bw-button"
          disabled={readOnly}
          onClick={() => onLayer('back')}
        >
          置底
        </button>
        <button
          type="button"
          className="bw-button"
          disabled={readOnly}
          onClick={() => onLayer('up')}
        >
          上移一层
        </button>
        <button
          type="button"
          className="bw-button"
          disabled={readOnly}
          onClick={() => onLayer('down')}
        >
          下移一层
        </button>
        <button
          type="button"
          className="bw-button"
          disabled={readOnly}
          onClick={onToggleLock}
        >
          {locked ? '解锁' : '锁定'}
        </button>
        <button
          type="button"
          className="bw-button is-danger"
          disabled={readOnly}
          onClick={onDelete}
        >
          删除
        </button>
      </div>
    </div>
  );
}

export function BoardInspector({
  document,
  selection,
  readOnly,
  focusLabelToken,
  onChangeObjectStyle,
  onChangeObjectType,
  onAlign,
  onDistribute,
  onDuplicate,
  onLayer,
  onToggleLock,
  onDelete,
  onChangeEdgeStyle,
  onChangeEdgeLabel,
  onReverseEdge,
}: BoardInspectorProps) {
  const edgeIds = new Set(selection.edgeIds);
  const edges = document.edges.filter((edge) => edgeIds.has(edge.id));
  const nodeIds = new Set(selection.nodeIds);
  const nodes = document.nodes.filter((node) => nodeIds.has(node.id));

  if (nodes.length === 0) {
    if (edges.length === 1) {
      return (
        <aside className="bw-inspector" aria-label="检查器">
          <EdgeInspector
            edge={edges[0]}
            nodes={document.nodes}
            readOnly={readOnly}
            focusLabelToken={focusLabelToken}
            onChangeStyle={onChangeEdgeStyle}
            onChangeLabel={onChangeEdgeLabel}
            onReverse={onReverseEdge}
            onDelete={onDelete}
          />
        </aside>
      );
    }
    if (edges.length > 1) {
      return (
        <aside className="bw-inspector" aria-label="检查器">
          <BatchEdgeInspector
            edges={edges}
            readOnly={readOnly}
            onChangeStyle={onChangeEdgeStyle}
            onDelete={onDelete}
          />
        </aside>
      );
    }
    return (
      <aside className="bw-inspector" aria-label="检查器">
        <div className="bw-inspector-empty">
          <h3>检查器</h3>
          <p>选中对象后可改形状、填充、边框、文字、层级与锁定。</p>
          <p>拖动右下角手柄缩放；从四个锚点拖线连接对象。</p>
        </div>
      </aside>
    );
  }

  const nodePanel =
    nodes.length === 1 ? (
      <NodeInspector
        node={nodes[0]}
        readOnly={readOnly}
        onChangeStyle={onChangeObjectStyle}
        onChangeType={onChangeObjectType}
        onDuplicate={onDuplicate}
        onLayer={onLayer}
        onToggleLock={onToggleLock}
        onDelete={onDelete}
      />
    ) : (
      <div className="bw-inspector-body">
        <h3>已选 {nodes.length} 个对象</h3>
        <p className="bw-inspector-sub">对齐、等距、复制或调整层级</p>
        <div className="bw-field">
          <span className="bw-field-label">对齐</span>
          <div className="bw-inspector-grid">
            <button
              type="button"
              className="bw-button"
              disabled={readOnly}
              onClick={() => onAlign('left')}
            >
              左对齐
            </button>
            <button
              type="button"
              className="bw-button"
              disabled={readOnly}
              onClick={() => onAlign('hcenter')}
            >
              水平居中
            </button>
            <button
              type="button"
              className="bw-button"
              disabled={readOnly}
              onClick={() => onAlign('right')}
            >
              右对齐
            </button>
            <button
              type="button"
              className="bw-button"
              disabled={readOnly}
              onClick={() => onAlign('top')}
            >
              顶对齐
            </button>
            <button
              type="button"
              className="bw-button"
              disabled={readOnly}
              onClick={() => onAlign('vcenter')}
            >
              垂直居中
            </button>
            <button
              type="button"
              className="bw-button"
              disabled={readOnly}
              onClick={() => onAlign('bottom')}
            >
              底对齐
            </button>
          </div>
        </div>
        <div className="bw-field">
          <span className="bw-field-label">分布</span>
          <div className="bw-inspector-grid">
            <button
              type="button"
              className="bw-button"
              disabled={readOnly || nodes.length < 3}
              onClick={() => onDistribute('x')}
            >
              水平等距
            </button>
            <button
              type="button"
              className="bw-button"
              disabled={readOnly || nodes.length < 3}
              onClick={() => onDistribute('y')}
            >
              垂直等距
            </button>
          </div>
        </div>
        <div className="bw-inspector-actions">
          <button
            type="button"
            className="bw-button"
            disabled={readOnly}
            onClick={onDuplicate}
          >
            复制一份
          </button>
          <button
            type="button"
            className="bw-button"
            disabled={readOnly}
            onClick={() => onLayer('front')}
          >
            置顶
          </button>
          <button
            type="button"
            className="bw-button"
            disabled={readOnly}
            onClick={() => onLayer('back')}
          >
            置底
          </button>
          <button
            type="button"
            className="bw-button"
            disabled={readOnly}
            onClick={() => onLayer('up')}
          >
            上移一层
          </button>
          <button
            type="button"
            className="bw-button"
            disabled={readOnly}
            onClick={() => onLayer('down')}
          >
            下移一层
          </button>
          <button
            type="button"
            className="bw-button"
            disabled={readOnly}
            onClick={onToggleLock}
          >
            锁定/解锁
          </button>
          <button
            type="button"
            className="bw-button is-danger"
            disabled={readOnly}
            onClick={onDelete}
          >
            删除
          </button>
        </div>
      </div>
    );

  return (
    <aside className="bw-inspector" aria-label="检查器">
      {nodePanel}
      {edges.length > 0 ? (
        <BatchEdgeInspector
          edges={edges}
          readOnly={readOnly}
          onChangeStyle={onChangeEdgeStyle}
          onDelete={onDelete}
        />
      ) : null}
    </aside>
  );
}
