import { Link } from 'react-router-dom';

import { dispatchAppCommand } from '../shortcuts';
import { AppearanceMenu } from './AppearanceMenu';
import type { Appearance } from './appearance';
import {
  HelpIcon,
  PlusIcon,
  SearchIcon,
  SyncIcon,
} from './icons';

type TopbarProps = {
  appearance: Appearance;
  onAppearanceChange: (next: Appearance) => void;
};

export function Topbar({
  appearance,
  onAppearanceChange,
}: TopbarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          知
        </span>
        <span className="brand-name">知行</span>
        <span className="brand-tag">工程骨架</span>
      </div>

      <button
        type="button"
        className="topbar-search"
        aria-label="全局搜索（⌘K）"
        aria-haspopup="dialog"
        title="全局搜索 ⌘K"
        onClick={() => dispatchAppCommand('search')}
      >
        <SearchIcon className="search-icon" />
        <span className="search-label">
          搜索任务、笔记、事件、倒数日、习惯
        </span>
        <kbd aria-hidden="true">⌘K</kbd>
      </button>

      <div className="topbar-actions">
        <Link
          to="/settings/sync"
          className="status-pill status-pill--sync"
          title="同步与网络设置"
        >
          <SyncIcon className="status-icon" />
          <span>本机 · 已保存</span>
        </Link>

        <AppearanceMenu value={appearance} onChange={onAppearanceChange} />

        <button
          type="button"
          className="icon-button"
          aria-label="产品导览"
          aria-haspopup="dialog"
          title="产品导览 ?"
          onClick={() => dispatchAppCommand('tour')}
        >
          <HelpIcon />
        </button>
        <button
          type="button"
          className="icon-button icon-button--primary"
          aria-label="快速创建"
          aria-haspopup="dialog"
          title="快速创建 ⌘N"
          onClick={() => dispatchAppCommand('quick-add-task')}
        >
          <PlusIcon />
        </button>
      </div>
    </header>
  );
}
