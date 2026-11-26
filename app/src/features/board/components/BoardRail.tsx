import {
  OBJECT_TYPE_LABELS,
  type AlignMode,
} from '../model';
import type {
  BoardObjectType,
  BoardRouting,
  BoardTool,
} from '../types';
import { Icon } from '../../../ui/icons/Icon';
import type { IconName } from '../../../ui/icons/icons';

export type BoardRailProps = {
  tool: BoardTool;
  onToolChange: (tool: BoardTool) => void;
  onInsert: (type: BoardObjectType) => void;
  onMoreShapes: () => void;
  onStarter: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  selectionCount: number;
  edgeSelectionCount: number;
  edgeRouting: BoardRouting | null;
  onEdgeRouting: (routing: BoardRouting) => void;
  onAlign: (mode: AlignMode) => void;
  onDelete: () => void;
};

type ShapeButton = {
  type: BoardObjectType;
  icon: IconName;
  /** 常显短标签，与 `OBJECT_TYPE_LABELS` 的长名称分开。 */
  caption: string;
  shortcut?: string;
};

/** 工具轨只放 6 类中性对象；菱形等低频形状在「更多」里。 */
const SHAPE_BUTTONS: ReadonlyArray<ShapeButton> = [
  { type: 'rect', icon: 'board-rect', caption: '矩形', shortcut: 'R' },
  { type: 'round', icon: 'board-round-rect', caption: '圆角' },
  { type: 'ellipse', icon: 'board-ellipse', caption: '椭圆', shortcut: 'O' },
  { type: 'text', icon: 'board-text', caption: '文本', shortcut: 'T' },
  { type: 'sticky', icon: 'board-sticky', caption: '便签', shortcut: 'S' },
  { type: 'frame', icon: 'board-frame', caption: '容器', shortcut: 'F' },
];

const ROUTING_OPTIONS: ReadonlyArray<{
  routing: BoardRouting;
  label: string;
  icon: IconName;
}> = [
  { routing: 'straight', label: '直线', icon: 'board-line-straight' },
  { routing: 'elbow', label: '折线', icon: 'board-line-elbow' },
  { routing: 'curve', label: '曲线', icon: 'board-line-curve' },
];

const ALIGN_OPTIONS: ReadonlyArray<{
  mode: AlignMode;
  label: string;
  icon: IconName;
}> = [
  { mode: 'left', label: '左对齐', icon: 'board-align-left' },
  { mode: 'hcenter', label: '水平居中', icon: 'board-align-center' },
  { mode: 'right', label: '右对齐', icon: 'board-align-right' },
  { mode: 'top', label: '顶对齐', icon: 'board-align-top' },
  { mode: 'vcenter', label: '垂直居中', icon: 'board-align-middle' },
  { mode: 'bottom', label: '底对齐', icon: 'board-align-bottom' },
];

export function BoardRail({
  tool,
  onToolChange,
  onInsert,
  onMoreShapes,
  onStarter,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  selectionCount,
  edgeSelectionCount,
  edgeRouting,
  onEdgeRouting,
  onAlign,
  onDelete,
}: BoardRailProps) {
  const alignDisabled = selectionCount < 2;

  return (
    <nav className="bw-rail" aria-label="画板工具">
      <div className="bw-rail-group" role="group" aria-label="选择">
        <span className="bw-rail-title" aria-hidden="true">
          选择
        </span>
        <button
          type="button"
          className={tool === 'select' ? 'bw-tool is-active' : 'bw-tool'}
          aria-label="选择与移动"
          aria-pressed={tool === 'select'}
          title="选择/移动 (V)"
          onClick={() => onToolChange('select')}
        >
          <Icon name="board-select" size={18} />
          <span className="bw-tool-caption">选择</span>
        </button>
        <button
          type="button"
          className={tool === 'hand' ? 'bw-tool is-active' : 'bw-tool'}
          aria-label="抓手平移"
          aria-pressed={tool === 'hand'}
          title="抓手 (H)：拖动画布"
          onClick={() => onToolChange('hand')}
        >
          <Icon name="board-hand" size={18} />
          <span className="bw-tool-caption">抓手</span>
        </button>
      </div>

      <div className="bw-rail-group" role="group" aria-label="形状">
        <span className="bw-rail-title" aria-hidden="true">
          形状
        </span>
        {SHAPE_BUTTONS.map((shape) => (
          <button
            key={shape.type}
            type="button"
            className="bw-tool"
            aria-label={`插入${OBJECT_TYPE_LABELS[shape.type]}`}
            title={`插入${OBJECT_TYPE_LABELS[shape.type]}${
              shape.shortcut ? ` (${shape.shortcut})` : ''
            }`}
            onClick={() => onInsert(shape.type)}
          >
            <Icon name={shape.icon} size={18} />
            <span className="bw-tool-caption">{shape.caption}</span>
          </button>
        ))}
        <button
          type="button"
          className="bw-tool"
          aria-label="更多形状"
          title="更多形状：菱形 / 三角形 / 六边形 / 胶囊 / 平行四边形"
          onClick={onMoreShapes}
        >
          <Icon name="board-shapes" size={18} />
          <span className="bw-tool-caption">更多</span>
        </button>
      </div>

      <div className="bw-rail-group" role="group" aria-label="连线">
        <span className="bw-rail-title" aria-hidden="true">
          连线
        </span>
        <button
          type="button"
          className={tool === 'connect' ? 'bw-tool is-active' : 'bw-tool'}
          aria-label="连线"
          aria-pressed={tool === 'connect'}
          title="连线 (L)：依次点击两个对象"
          onClick={() => onToolChange(tool === 'connect' ? 'select' : 'connect')}
        >
          <Icon name="board-connector" size={18} />
          <span className="bw-tool-caption">连线</span>
        </button>
        <div
          className="bw-rail-grid"
          role="group"
          aria-label="连线线型"
          title={
            edgeSelectionCount > 0
              ? '修改选中连线的线型'
              : '先选中连线再改线型'
          }
        >
          {ROUTING_OPTIONS.map((option) => (
            <button
              key={option.routing}
              type="button"
              className={
                edgeRouting === option.routing
                  ? 'bw-tool is-active'
                  : 'bw-tool'
              }
              aria-label={`线型${option.label}`}
              aria-pressed={edgeRouting === option.routing}
              disabled={edgeSelectionCount === 0}
              title={`${option.label}（选中连线可用）`}
              onClick={() => onEdgeRouting(option.routing)}
            >
              <Icon name={option.icon} size={18} />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="bw-tool"
          aria-label="起步结构"
          title="起步结构：流程 / 思维导图 / 泳道"
          onClick={onStarter}
        >
          <Icon name="board-template" size={18} />
          <span className="bw-tool-caption">起步</span>
        </button>
      </div>

      <div className="bw-rail-group" role="group" aria-label="编辑">
        <span className="bw-rail-title" aria-hidden="true">
          编辑
        </span>
        <button
          type="button"
          className="bw-tool"
          aria-label="撤销"
          title="撤销 (⌘Z / Ctrl+Z)"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Icon name="board-undo" size={18} />
          <span className="bw-tool-caption">撤销</span>
        </button>
        <button
          type="button"
          className="bw-tool"
          aria-label="重做"
          title="重做 (⇧⌘Z / Ctrl+Shift+Z)"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <Icon name="board-redo" size={18} />
          <span className="bw-tool-caption">重做</span>
        </button>
        <button
          type="button"
          className="bw-tool is-danger"
          aria-label="删除选中"
          title="删除选中 (Delete)"
          disabled={selectionCount === 0}
          onClick={onDelete}
        >
          <Icon name="common-trash" size={18} />
          <span className="bw-tool-caption">删除</span>
        </button>
      </div>

      <div className="bw-rail-group" role="group" aria-label="对齐">
        <span className="bw-rail-title" aria-hidden="true">
          对齐
        </span>
        <div
          className="bw-rail-grid"
          role="group"
          aria-label="对齐方式"
          title={
            alignDisabled ? '选择两个以上对象后可用' : '按选中对象范围对齐'
          }
        >
          {ALIGN_OPTIONS.map((option) => (
            <button
              key={option.mode}
              type="button"
              className="bw-tool"
              aria-label={option.label}
              title={`${option.label}${
                alignDisabled ? '' : '（对选中对象生效）'
              }`}
              disabled={alignDisabled}
              onClick={() => onAlign(option.mode)}
            >
              <Icon name={option.icon} size={18} />
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}
