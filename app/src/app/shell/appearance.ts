export type ThemePreference = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';
export type AccentName = 'blue' | 'violet' | 'coral' | 'teal' | 'amber';
export type DensityName = 'comfortable' | 'compact';

export type Appearance = {
  theme: ThemePreference;
  accent: AccentName;
  density: DensityName;
};

export const APPEARANCE_STORAGE_KEY = 'zhixing.appearance.v1';

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'light',
  accent: 'blue',
  density: 'comfortable',
};

const THEMES: readonly ThemePreference[] = ['light', 'dark', 'auto'];
const ACCENTS: readonly AccentName[] = [
  'blue',
  'violet',
  'coral',
  'teal',
  'amber',
];
const DENSITIES: readonly DensityName[] = ['comfortable', 'compact'];

function isTheme(value: unknown): value is ThemePreference {
  return typeof value === 'string' && THEMES.includes(value as ThemePreference);
}

function isAccent(value: unknown): value is AccentName {
  return typeof value === 'string' && ACCENTS.includes(value as AccentName);
}

function isDensity(value: unknown): value is DensityName {
  return (
    typeof value === 'string' && DENSITIES.includes(value as DensityName)
  );
}

/**
 * 读取本机外观偏好。localStorage 不可用时回退到默认值，不能让外壳因此白屏。
 */
export function readAppearance(): Appearance {
  if (typeof window === 'undefined') {
    return DEFAULT_APPEARANCE;
  }

  try {
    const raw = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_APPEARANCE;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return DEFAULT_APPEARANCE;
    }
    const value = parsed as Record<string, unknown>;
    return {
      theme: isTheme(value.theme) ? value.theme : DEFAULT_APPEARANCE.theme,
      accent: isAccent(value.accent)
        ? value.accent
        : DEFAULT_APPEARANCE.accent,
      density: isDensity(value.density)
        ? value.density
        : DEFAULT_APPEARANCE.density,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(appearance: Appearance): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify(appearance),
    );
  } catch {
    // 隐私模式 / 配额受限时只保留当前会话的外观，不影响使用。
  }
}

export function getSystemTheme(): ResolvedTheme {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return 'light';
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'auto' ? getSystemTheme() : preference;
}

/**
 * 把偏好写到 <html> 上，CSS 只消费解析后的 data-theme。
 * data-theme-preference 保留原始选择，便于后续设置页回显。
 */
export function applyAppearance(
  appearance: Appearance,
  root: HTMLElement | undefined = typeof document === 'undefined'
    ? undefined
    : document.documentElement,
): ResolvedTheme {
  const resolved = resolveTheme(appearance.theme);
  if (root) {
    root.dataset.theme = resolved;
    root.dataset.themePreference = appearance.theme;
    root.dataset.accent = appearance.accent;
    root.dataset.density = appearance.density;
  }
  return resolved;
}

/**
 * 监听系统深浅色变化。仅在偏好为 auto 时由 Shell 订阅。
 */
export function watchSystemTheme(listener: () => void): () => void {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return () => {};
  }

  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const handleChange = () => listener();

  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }

  // 兼容旧 WebView。
  if (typeof query.addListener === 'function') {
    query.addListener(handleChange);
    return () => query.removeListener(handleChange);
  }

  return () => {};
}
