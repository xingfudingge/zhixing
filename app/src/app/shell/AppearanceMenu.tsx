import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

import type {
  AccentName,
  Appearance,
  DensityName,
  ThemePreference,
} from './appearance';
import { PaletteIcon } from './icons';

type AppearanceMenuProps = {
  value: Appearance;
  onChange: (next: Appearance) => void;
};

const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'auto', label: '跟随系统' },
];

const ACCENT_OPTIONS: Array<{
  value: AccentName;
  label: string;
  swatch: string;
}> = [
  { value: 'blue', label: '蓝色', swatch: 'var(--palette-blue)' },
  { value: 'violet', label: '紫色', swatch: 'var(--palette-violet)' },
  { value: 'coral', label: '珊瑚', swatch: 'var(--palette-coral)' },
  { value: 'teal', label: '青色', swatch: 'var(--palette-teal)' },
  { value: 'amber', label: '琥珀', swatch: 'var(--palette-amber)' },
];

const DENSITY_OPTIONS: Array<{ value: DensityName; label: string }> = [
  { value: 'comfortable', label: '舒适' },
  { value: 'compact', label: '紧凑' },
];

export function AppearanceMenu({ value, onChange }: AppearanceMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const update = (patch: Partial<Appearance>) => {
    onChange({ ...value, ...patch });
  };

  return (
    <div className="appearance" ref={containerRef}>
      <button
        type="button"
        className="icon-button"
        aria-label="外观设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        title="外观设置"
        onClick={() => setOpen((current) => !current)}
      >
        <PaletteIcon />
      </button>

      {open ? (
        <div
          className="appearance-panel"
          id={panelId}
          role="dialog"
          aria-label="外观设置"
        >
          <div className="appearance-panel-title">外观</div>

          <div className="appearance-group">
            <span className="appearance-label" id={`${panelId}-theme`}>
              主题
            </span>
            <div
              className="segmented"
              role="group"
              aria-labelledby={`${panelId}-theme`}
            >
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="segmented-button"
                  aria-pressed={value.theme === option.value}
                  onClick={() => update({ theme: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="appearance-group">
            <span className="appearance-label" id={`${panelId}-accent`}>
              强调色
            </span>
            <div
              className="swatches"
              role="group"
              aria-labelledby={`${panelId}-accent`}
            >
              {ACCENT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="swatch"
                  style={{ '--swatch': option.swatch } as CSSProperties}
                  aria-label={`强调色：${option.label}`}
                  title={option.label}
                  aria-pressed={value.accent === option.value}
                  onClick={() => update({ accent: option.value })}
                />
              ))}
            </div>
          </div>

          <div className="appearance-group">
            <span className="appearance-label" id={`${panelId}-density`}>
              信息密度
            </span>
            <div
              className="segmented"
              role="group"
              aria-labelledby={`${panelId}-density`}
            >
              {DENSITY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className="segmented-button"
                  aria-pressed={value.density === option.value}
                  onClick={() => update({ density: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
