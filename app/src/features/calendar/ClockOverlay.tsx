/** 全屏沉浸时钟：只展示时间，不写数据、不记录专注。 */

import { useEffect, useMemo, useState } from 'react';

import {
  formatLunarText,
  formatMonthDayWithYear,
  pad2,
  parseISODate,
  WEEKDAYS,
} from '../../data/calendar';

export type ClockTheme = 'midnight' | 'dawn' | 'paper';
export type ClockMode = 'digital' | 'analog';

export type ClockOverlayProps = {
  open: boolean;
  onClose: () => void;
};

const THEMES: ReadonlyArray<{ value: ClockTheme; label: string }> = [
  { value: 'midnight', label: '极夜' },
  { value: 'dawn', label: '晨雾' },
  { value: 'paper', label: '暖砂' },
];

function analogTicks() {
  return Array.from({ length: 60 }, (_, index) => {
    const angle = (index * 6 * Math.PI) / 180;
    const outer = 136;
    const inner = index % 5 === 0 ? 122 : 128;
    return {
      x1: 150 + Math.sin(angle) * inner,
      y1: 150 - Math.cos(angle) * inner,
      x2: 150 + Math.sin(angle) * outer,
      y2: 150 - Math.cos(angle) * outer,
      strong: index % 5 === 0,
    };
  });
}

export function ClockOverlay({ open, onClose }: ClockOverlayProps) {
  const [now, setNow] = useState(() => new Date());
  const [theme, setTheme] = useState<ClockTheme>('midnight');
  const [mode, setMode] = useState<ClockMode>('digital');
  const [hourFormat, setHourFormat] = useState<'24' | '12'>('24');
  const [showSeconds, setShowSeconds] = useState(false);
  const ticks = useMemo(analogTicks, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const element = document.documentElement;
    try {
      const request = element.requestFullscreen;
      if (request) {
        void request.call(element).catch(() => undefined);
      }
    } catch {
      // 全屏 API 被拒绝时静默降级。
    }
    let wakeLock: { release: () => Promise<void> } | null = null;
    try {
      const wakeLockApi = (
        navigator as Navigator & {
          wakeLock?: { request: (type: 'screen') => Promise<unknown> };
        }
      ).wakeLock;
      if (wakeLockApi) {
        void wakeLockApi
          .request('screen')
          .then((lock) => {
            wakeLock = lock as { release: () => Promise<void> };
          })
          .catch(() => undefined);
      }
    } catch {
      // Wake Lock 拒绝时时钟仍可用。
    }
    return () => {
      if (wakeLock) {
        void wakeLock.release().catch(() => undefined);
      }
      if (document.fullscreenElement && document.exitFullscreen) {
        void document.exitFullscreen().catch(() => undefined);
      }
    };
  }, [open]);

  if (!open) {
    return null;
  }

  const hours24 = now.getHours();
  const hours = hourFormat === '12' ? hours24 % 12 || 12 : hours24;
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(
    now.getDate(),
  )}`;
  const timeText = `${pad2(hours)}:${pad2(minutes)}`;
  const ampm = hours24 < 12 ? 'AM' : 'PM';
  const weekday = WEEKDAYS[parseISODate(date).getDay()];

  return (
    <div
      className={`clock-overlay clock-overlay--${theme}`}
      role="dialog"
      aria-modal="true"
      aria-label="沉浸时钟"
      data-theme={theme}
      data-mode={mode}
    >
      <header className="clock-top">
        <span className="clock-brand">知行 · 沉浸时钟</span>
        <button type="button" className="clock-exit" onClick={onClose}>
          退出 ESC
        </button>
      </header>

      <div className="clock-center">
        {mode === 'digital' ? (
          <div className="clock-digital">
            {timeText}
            {showSeconds ? <span className="clock-seconds">:{pad2(seconds)}</span> : null}
            {hourFormat === '12' ? <span className="clock-ampm">{ampm}</span> : null}
          </div>
        ) : (
          <svg className="clock-analog" viewBox="0 0 300 300" aria-label="模拟时钟">
            {ticks.map((tick, index) => (
              <line
                key={index}
                x1={tick.x1.toFixed(1)}
                y1={tick.y1.toFixed(1)}
                x2={tick.x2.toFixed(1)}
                y2={tick.y2.toFixed(1)}
                className={tick.strong ? 'clock-tick clock-tick--strong' : 'clock-tick'}
              />
            ))}
            <line
              className="clock-hand clock-hand--hour"
              x1="150"
              y1="150"
              x2="150"
              y2="76"
              transform={`rotate(${(hours24 % 12) * 30 + minutes * 0.5} 150 150)`}
            />
            <line
              className="clock-hand clock-hand--minute"
              x1="150"
              y1="150"
              x2="150"
              y2="44"
              transform={`rotate(${minutes * 6 + seconds * 0.1} 150 150)`}
            />
            {showSeconds ? (
              <line
                className="clock-hand clock-hand--second"
                x1="150"
                y1="150"
                x2="150"
                y2="30"
                transform={`rotate(${seconds * 6} 150 150)`}
              />
            ) : null}
            <circle className="clock-cap" cx="150" cy="150" r="4" />
          </svg>
        )}
        <p className="clock-date">
          {formatMonthDayWithYear(date)} · {weekday}
        </p>
        <p className="clock-lunar">农历 {formatLunarText(date)}</p>
      </div>

      <div className="clock-controls">
        <span className="clock-control-label">主题</span>
        {THEMES.map((item) => (
          <button
            type="button"
            key={item.value}
            className={theme === item.value ? 'clock-control is-on' : 'clock-control'}
            onClick={() => setTheme(item.value)}
          >
            {item.label}
          </button>
        ))}
        <span className="clock-control-label">显示</span>
        <button
          type="button"
          className={mode === 'digital' ? 'clock-control is-on' : 'clock-control'}
          onClick={() => setMode('digital')}
        >
          数字
        </button>
        <button
          type="button"
          className={mode === 'analog' ? 'clock-control is-on' : 'clock-control'}
          onClick={() => setMode('analog')}
        >
          模拟
        </button>
        <button
          type="button"
          className="clock-control"
          onClick={() => setHourFormat((current) => (current === '24' ? '12' : '24'))}
        >
          {hourFormat} 小时
        </button>
        <button
          type="button"
          className={showSeconds ? 'clock-control is-on' : 'clock-control'}
          onClick={() => setShowSeconds((current) => !current)}
        >
          {showSeconds ? '隐藏秒' : '显示秒'}
        </button>
      </div>
    </div>
  );
}
