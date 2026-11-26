/**
 * 全局命令宿主：挂在 Shell 里，统一承接 ⌘K / ⌘N / ? 与顶栏按钮。
 *
 * 三个面板互斥；命令只切换面板，不直接创建数据。顶栏通过
 * `dispatchAppCommand` 发同一个事件，所以点击和快捷键行为完全一致。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  APP_COMMAND_EVENT,
  installGlobalShortcuts,
  type AppCommand,
} from '../../app/shortcuts';
import { QuickAddDialog } from '../quickAdd/QuickAddDialog';
import type { QuickAddSource } from '../quickAdd/source';
import type { QuickAddTab } from '../quickAdd/model';
import { TourDialog } from '../tour/TourDialog';
import { SearchPalette } from './SearchPalette';
import type { SearchSource } from './source';

export type GlobalCommandsProps = {
  searchSource?: SearchSource;
  quickAddSource?: QuickAddSource;
  available?: boolean;
  today?: string;
};

type Overlay = 'search' | 'quickAdd' | 'tour' | null;

export function GlobalCommands({
  searchSource,
  quickAddSource,
  available,
  today,
}: GlobalCommandsProps = {}) {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const overlayRef = useRef<Overlay>(null);
  overlayRef.current = overlay;
  const [quickTab, setQuickTab] = useState<QuickAddTab>('task');

  const openSearch = useCallback(() => {
    if (overlayRef.current === null) {
      setOverlay('search');
    }
  }, []);

  const openQuickAdd = useCallback((kind: 'task' | 'note') => {
    if (overlayRef.current === null) {
      setQuickTab(kind);
      setOverlay('quickAdd');
    }
  }, []);

  const openTour = useCallback(() => {
    if (overlayRef.current === null) {
      setOverlay('tour');
    }
  }, []);

  const runCommand = useCallback(
    (command: AppCommand) => {
      switch (command) {
        case 'search':
          openSearch();
          break;
        case 'quick-add-task':
          openQuickAdd('task');
          break;
        case 'quick-add-note':
          openQuickAdd('note');
          break;
        case 'tour':
          openTour();
          break;
        default:
          break;
      }
    },
    [openQuickAdd, openSearch, openTour],
  );

  useEffect(() => {
    const removeShortcuts = installGlobalShortcuts({
      onSearch: openSearch,
      onQuickAdd: openQuickAdd,
      onTour: openTour,
    });
    const onCommand = (event: Event) => {
      runCommand((event as CustomEvent<AppCommand>).detail);
    };
    window.addEventListener(APP_COMMAND_EVENT, onCommand);
    return () => {
      removeShortcuts();
      window.removeEventListener(APP_COMMAND_EVENT, onCommand);
    };
  }, [openQuickAdd, openSearch, openTour, runCommand]);

  const close = () => setOverlay(null);

  return (
    <>
      <SearchPalette
        open={overlay === 'search'}
        onClose={close}
        source={searchSource}
        available={available}
        today={today}
      />
      <QuickAddDialog
        open={overlay === 'quickAdd'}
        initialTab={quickTab}
        onClose={close}
        source={quickAddSource}
        available={available}
        today={today}
      />
      <TourDialog open={overlay === 'tour'} onClose={close} />
    </>
  );
}
