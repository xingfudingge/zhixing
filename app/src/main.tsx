import {
  error as logError,
  info as logInfo,
  warn as logWarn,
} from '@tauri-apps/plugin-log';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { installGlobalModalFocusTrap } from './app/a11y';
import { applyAppearance, readAppearance } from './app/shell/appearance';
import { installMonitoring } from './features/export/monitoring';
import './styles/tokens.css';
import './app/shell/shell.css';
import './pages/pages.css';

applyAppearance(readAppearance());

function formatLogArg(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function enableDesktopLogging() {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return;
  }

  const writeError = (...args: unknown[]) => {
    void logError(args.map(formatLogArg).join(' ')).catch(() => {});
  };
  const writeWarn = (...args: unknown[]) => {
    void logWarn(args.map(formatLogArg).join(' ')).catch(() => {});
  };

  const originalError = console.error;
  const originalWarn = console.warn;

  console.error = (...args: unknown[]) => {
    originalError(...args);
    writeError(...args);
  };
  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    writeWarn(...args);
  };

  window.addEventListener('error', (event) => {
    writeError(
      `[window.error] ${event.message} @ ${event.filename}:${event.lineno}`,
    );
  });
  window.addEventListener('unhandledrejection', (event) => {
    writeError(`[unhandledrejection] ${formatLogArg(event.reason)}`);
  });

  void logInfo('zhixing webview console bridge active').catch(() => {});
}

enableDesktopLogging();
installMonitoring();
installGlobalModalFocusTrap();

const container = document.getElementById('root');

if (!container) {
  throw new Error('缺少 #root 挂载节点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
