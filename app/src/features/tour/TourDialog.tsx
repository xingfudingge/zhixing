/**
 * `?` 产品导览。
 *
 * 与原型一致：介绍各模块，并有一个直接跳到“今天 → 四象限”的入口。
 * 导览只读，不创建数据、不改设置（跳转后的视图偏好由 TodayPage 正常保存）。
 */

import { useNavigate } from 'react-router-dom';

import { CommandDialog } from '../search/CommandDialog';
import {
  TOUR_QUADRANT_PATH,
  TOUR_SHORTCUTS,
  TOUR_STEPS,
} from './tourSteps';
import './tour.css';

export type TourDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function TourDialog({ open, onClose }: TourDialogProps) {
  const navigate = useNavigate();

  const goQuadrant = () => {
    onClose();
    navigate(TOUR_QUADRANT_PATH);
  };

  return (
    <CommandDialog
      open={open}
      label="产品导览"
      className="tour-dialog"
      onClose={onClose}
    >
      <header className="tour-head">
        <p className="tour-eyebrow">知行 · 导览</p>
        <h2 className="command-dialog__title">用一个工作台串起任务、知识与时间</h2>
        <p className="command-dialog__desc">
          这是一个单用户、本地优先的桌面工作台。没有账号、席位与云搜索；
          数据先写入本机 SQLite。
        </p>
      </header>

      <div className="tour-body">
        <ol className="tour-steps">
          {TOUR_STEPS.map((step) => (
            <li className="tour-step" key={step.id}>
              <span className="tour-index" aria-hidden="true">
                {step.index}
              </span>
              <div>
                <b>{step.title}</b>
                <p>{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="tour-shortcuts" aria-label="快捷键">
          <b>快捷键</b>
          <div className="tour-shortcut-grid">
            {TOUR_SHORTCUTS.map((shortcut) => (
              <span className="tour-shortcut" key={shortcut.keys}>
                <kbd className="command-kbd">{shortcut.keys}</kbd>
                {shortcut.label}
              </span>
            ))}
          </div>
          <p className="tour-note">
            在输入框、文本域或正文里输入问号不会触发导览；⌘K / ⌘N 仍可用。
          </p>
        </div>
      </div>

      <footer className="command-dialog__footer">
        <span className="command-dialog__hint">随时按 ? 重新打开导览</span>
        <button type="button" className="command-button" onClick={onClose}>
          知道了
        </button>
        <button
          type="button"
          className="command-button command-button--primary"
          onClick={goQuadrant}
        >
          先看四象限
        </button>
      </footer>
    </CommandDialog>
  );
}
