/**
 * 知行统一日期选择器 `DatePicker`（DOM 层为单行字段 + `.dp-popover`）。
 *
 * 约定（详见 outputs/设计-表单控件统一-2026-10-29.md）：
 *   * 全应用禁止 `input[type=date]`；事件/倒数日/任务/快速创建/批量改期共用本组件。
 *   * 触发字段是「文本输入 + 尾部日历图标」，与 select 同高同圆角同边框。
 *   * 手输支持 `YYYY-MM-DD` / `YYYY/M/D` / `YYYY年M月D日`，提交后归一化为 `YYYY-MM-DD`。
 *   * 合法值只在 Enter / 失焦 / 弹层操作时提交；非法值保留原文并给行内错误，绝不改成今天。
 *   * 选择器永远选公历日；农历只回显在辅助行或弹层，不做农历输入或逆换算。
 *   * 日期字符串始终是本地日历日 `YYYY-MM-DD`，不经过 UTC 切日。
 *   * 手输合法日期时面板立即跟随（不要求 Enter），但只有 Enter/失焦才写库。
 *   * 点日期格把待提交值回写到输入框并标记「待确定」；「确定」/Enter/双击/今天/明天才提交。
 *   * 取消（Esc / 点外部 / 关闭按钮）一律丢弃草稿并清错误，恢复最后一次已提交值，
 *     不触发 `onChange`；取消后再失焦也不会把被取消的草稿写库。
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';

import {
  addDaysISO,
  addMonthsISO,
  formatISO,
  formatWeekday,
  isValidISODate,
  lunarDayLabel,
  lunarInfo,
  monthKeyOf,
  pad2,
  parseISODate,
  todayISO,
} from '../../data/calendar';
import { getRuntimeSettings } from '../../features/settings/runtime';
import { getRuntimeHolidayLookup } from '../../features/calendar/holiday/runtime';
import {
  isRestStatus,
  monthGrid,
  normalizeWeekStart,
  startOfWeekISO,
  weekdayLabels,
  workdayStatus,
  type WeekStart,
} from '../../features/calendar/workweek';
import './datePicker.css';

const FULL_WEEKDAYS = [
  '星期日',
  '星期一',
  '星期二',
  '星期三',
  '星期四',
  '星期五',
  '星期六',
] as const;

const POPOVER_WIDTH = 320;
const VIEWPORT_GAP = 8;
const MOBILE_BREAKPOINT = 480;
/** 矮于该高度不再尝试 popover，直接回退底部 sheet（规范 §3.4）。 */
const SHORT_VIEWPORT_HEIGHT = 360;
/** 触发器上下任一侧的可用空间小于该值时，popover 会过于局促，回退 sheet。 */
const MIN_POPOVER_SIDE = 120;
/** 底部 sheet 与视口边缘的间距。 */
const SHEET_INSET = 12;
/** 触发器离开可视视口超过该距离后关闭，避免浮层悬空。 */
const ANCHOR_CLOSE_MARGIN = 24;
/** 日期字段所在的模态容器；portal 到 body 后需要自行提升层级。 */
const MODAL_SELECTOR = '.zx-modal, .zxe-dialog, .task-dialog, .bw-modal';
/** jsdom 没有布局，给一个面板估高，避免测试环境算出 0。 */
const FALLBACK_POPOVER_HEIGHT = 430;

export type DatePopoverPlacement = 'bottom-start' | 'top-start' | 'sheet';

type RectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type ViewportRect = RectLike & { width: number; height: number };

export type DatePopoverLayout = {
  placement: DatePopoverPlacement;
  left: number;
  top: number;
  width: number;
  maxHeight: number | null;
  layer: 'base' | 'modal';
};

type PlacementInput = {
  anchor: RectLike;
  layer: { width: number; height: number };
  viewport: ViewportRect;
  gap?: number;
  /** 字段位于共享模态内：portal 后需要提升到遮罩之上。 */
  inModal?: boolean;
};

/**
 * 日期弹层定位（规范 §2.2 / §3.3）。
 *
 * 不变量：
 *  1. popover 模式下弹层与触发器矩形不相交；
 *  2. 弹层完整落在视口内（含 gap）；
 *  3. 放不下时按可用空间较大的一侧限高，内部滚动；
 *  4. 窄窗、矮视口、两侧都局促时回退 sheet（sheet 是唯一允许覆盖触发器的形态）。
 */
export function computeDatePopoverLayout({
  anchor,
  layer,
  viewport,
  gap = VIEWPORT_GAP,
  inModal = false,
}: PlacementInput): DatePopoverLayout {
  const width = Math.round(
    Math.max(
      0,
      Math.min(
        layer.width || POPOVER_WIDTH,
        Math.max(0, viewport.width - gap * 2),
      ),
    ),
  );

  // 水平：优先与触发器左对齐；右侧溢出时改为右对齐，最后夹取到视口内。
  let left = anchor.left;
  if (left + width > viewport.right - gap) {
    left = anchor.right - width;
  }
  const minLeft = viewport.left + gap;
  const maxLeft = Math.max(minLeft, viewport.right - gap - width);
  left = Math.round(Math.min(Math.max(left, minLeft), maxLeft));

  // 预留触发器与视口边缘各一个 gap。
  const spaceBelow = Math.max(0, viewport.bottom - gap - (anchor.bottom + gap));
  const spaceAbove = Math.max(0, anchor.top - gap - (viewport.top + gap));
  const useSheet =
    viewport.width <= MOBILE_BREAKPOINT ||
    viewport.height < SHORT_VIEWPORT_HEIGHT ||
    (spaceBelow < MIN_POPOVER_SIDE && spaceAbove < MIN_POPOVER_SIDE);

  if (useSheet) {
    return {
      placement: 'sheet',
      left: 0,
      top: 0,
      width,
      maxHeight: Math.round(Math.max(0, viewport.height - SHEET_INSET * 2)),
      layer: inModal ? 'modal' : 'base',
    };
  }

  const naturalHeight =
    layer.height > 0 ? layer.height : FALLBACK_POPOVER_HEIGHT;
  let side: 'bottom' | 'top';
  if (naturalHeight <= spaceBelow) {
    side = 'bottom';
  } else if (naturalHeight <= spaceAbove) {
    side = 'top';
  } else {
    side = spaceBelow >= spaceAbove ? 'bottom' : 'top';
  }

  const available = side === 'bottom' ? spaceBelow : spaceAbove;
  const maxHeight =
    naturalHeight > available ? Math.round(Math.max(0, available)) : null;
  const height = maxHeight ?? naturalHeight;
  let top =
    side === 'bottom' ? anchor.bottom + gap : anchor.top - gap - height;
  const minTop = viewport.top + gap;
  const maxTop = Math.max(minTop, viewport.bottom - gap - height);
  top = Math.round(Math.min(Math.max(top, minTop), maxTop));

  return {
    placement: side === 'bottom' ? 'bottom-start' : 'top-start',
    left,
    top,
    width,
    maxHeight,
    layer: inModal ? 'modal' : 'base',
  };
}

type Viewport = ViewportRect;

/** 优先使用 visualViewport（缩放 / 软键盘），不可用时回落 window 尺寸。 */
function getViewport(): Viewport {
  const visual = window.visualViewport;
  const width = visual?.width ?? window.innerWidth;
  const height = visual?.height ?? window.innerHeight;
  const left = visual?.offsetLeft ?? 0;
  const top = visual?.offsetTop ?? 0;
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

function getPortalRoot(): HTMLElement {
  return document.getElementById('floating-layer') ?? document.body;
}


const DATE_INPUT_PATTERNS = [
  /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
  /^(\d{4})年(\d{1,2})月(\d{1,2})日$/,
] as const;

const DATE_INPUT_MESSAGES = {
  format: '日期格式无效，请按 YYYY-MM-DD 输入',
  invalid: '日期不存在，请检查年月日',
  required: '请选择日期',
} as const;

export type DateInputFailure = keyof typeof DATE_INPUT_MESSAGES | 'range';

export type DateInputResult =
  | { ok: true; value: string | null }
  | { ok: false; reason: DateInputFailure; message: string };

export type DateInputOptions = {
  required?: boolean;
  min?: string;
  max?: string;
};

/**
 * 解析手输日期。只接受三种整串格式，并按本地日历回读校验真实日期；
 * 空字符串在非必填时归一化为 null，在必填时返回 required 错误。
 */
export function parseDateInput(
  raw: string,
  { required = false, min, max }: DateInputOptions = {},
): DateInputResult {
  const text = raw.trim();
  if (!text) {
    return required
      ? { ok: false, reason: 'required', message: DATE_INPUT_MESSAGES.required }
      : { ok: true, value: null };
  }

  let matched: RegExpExecArray | null = null;
  for (const pattern of DATE_INPUT_PATTERNS) {
    matched = pattern.exec(text);
    if (matched) {
      break;
    }
  }
  if (!matched) {
    return {
      ok: false,
      reason: 'format',
      message: DATE_INPUT_MESSAGES.format,
    };
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const date = new Date(year, month - 1, day);
  if (
    year < 1000 ||
    year > 9999 ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return {
      ok: false,
      reason: 'invalid',
      message: DATE_INPUT_MESSAGES.invalid,
    };
  }

  const value = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  if (min && value < min) {
    return {
      ok: false,
      reason: 'range',
      message: max
        ? `日期需在 ${min} 至 ${max} 之间`
        : `日期需在 ${min} 之后`,
    };
  }
  if (max && value > max) {
    return {
      ok: false,
      reason: 'range',
      message: min
        ? `日期需在 ${min} 至 ${max} 之间`
        : `日期需在 ${max} 之前`,
    };
  }

  return { ok: true, value };
}

export type DatePickerProps = {
  /** 受控值：合法 `YYYY-MM-DD` 或 null。非法值按无值处理。 */
  value: string | null;
  onChange: (value: string | null) => void;
  /** true 时隐藏「清除」，空值校验为必填。 */
  required?: boolean;
  disabled?: boolean;
  /** 只读：可聚焦/复制，但不可编辑、不可打开弹层。 */
  readOnly?: boolean;
  /** 落在 input 上，保证 `<label htmlFor>` 点击聚焦输入框。 */
  id?: string;
  /** 无值时的 placeholder；任务语境传「未安排」。 */
  emptyLabel?: string;
  ariaLabel?: string;
  className?: string;
  /** 仅供测试注入「今天」，运行时每次打开重新取本地今天。 */
  today?: string;
  min?: string;
  max?: string;
  /** 是否显示公历 + 农历辅助行；快速添加/批量改期/日历工具传 false。 */
  showHelper?: boolean;
  /** 周起始日；不传时跟随设置里的「日历与工作日」偏好。 */
  weekStart?: WeekStart;
  /** 当前草稿是否可提交；供父级禁用相邻「创建 / 应用 / 保存」动作。 */
  onValidityChange?: (valid: boolean) => void;
};

function validDate(value: string | null): string | null {
  return value && isValidISODate(value) ? value : null;
}

/** 字段主值：2026年10月28日 周三。 */
export function formatDateFieldLabel(value: string): string {
  const date = parseISODate(value);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${formatWeekday(value)}`;
}

/** 月格农历短标签：初一显示月名，其余显示「初二…三十」。 */
export function lunarShortLabel(value: string): string {
  const info = lunarInfo(value);
  if (!info) {
    return '';
  }
  return info.day === 1 ? info.monthRaw : lunarDayLabel(info.day);
}

/** 辅助行 / footer：农历丙午年九月十九。 */
export function lunarFullLabel(value: string): string {
  const info = lunarInfo(value);
  if (!info) {
    return '当前环境不支持农历回显';
  }
  return `农历${info.yearName ? `${info.yearName}年` : ''}${info.monthRaw}${lunarDayLabel(
    info.day,
  )}`;
}

function shiftMonth(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split('-').map(Number);
  return formatISO(new Date(year, month - 1 + delta, 1)).slice(0, 7);
}

function monthTitle(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  return `${year}年${month}月`;
}

function inRange(value: string, min?: string, max?: string): boolean {
  if (min && value < min) {
    return false;
  }
  if (max && value > max) {
    return false;
  }
  return true;
}

/** 文本已经写满一个完整日期格式（值仍可能非法），用于决定输入中是否立刻给行内错误。 */
function isCompleteDateText(text: string): boolean {
  const value = text.trim();
  return DATE_INPUT_PATTERNS.some((pattern) => pattern.test(value));
}

/** 越界按钮/日格的 title 说明，复用规范值，不另造文案。 */
function rangeHint(value: string, min?: string, max?: string): string {
  if (min && value < min) {
    return max ? `仅可选 ${min} 至 ${max}` : `仅可选 ${min} 之后`;
  }
  if (max && value > max) {
    return min ? `仅可选 ${min} 至 ${max}` : `仅可选 ${max} 之前`;
  }
  return '';
}

/** 日历图标：16px 描边图标，颜色随按钮 currentColor。 */
function CalendarIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 9.5h17" />
      <path d="M8 3.5V7" />
      <path d="M16 3.5V7" />
    </svg>
  );
}

export function DatePicker({
  value,
  onChange,
  required = false,
  disabled = false,
  readOnly = false,
  id,
  emptyLabel = '选择日期',
  ariaLabel,
  className,
  today,
  min,
  max,
  showHelper = true,
  weekStart,
  onValidityChange,
}: DatePickerProps) {
  const autoId = useId();
  // 日期选择器没有全局 Provider；设置页保存后 runtime 缓存已更新，这里每次
  // 渲染重新读取，保证日历、任务和弹层使用同一份周起始/工作日规则。
  const calendarPreferences = getRuntimeSettings().calendar;
  const resolvedWeekStart = normalizeWeekStart(
    weekStart ?? calendarPreferences.weekStart,
  );
  const fieldId = id ?? `date-field-${autoId}`;
  const groupId = `${fieldId}-group`;
  const helpId = `${fieldId}-help`;
  const errorId = `${fieldId}-error`;
  const panelId = `${fieldId}-panel`;
  const labelId = `${fieldId}-preview`;

  const groupRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const committed = validDate(value);
  const [draft, setDraft] = useState(() => committed ?? '');
  const [invalid, setInvalid] = useState<{
    reason: DateInputFailure;
    message: string;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState('');
  const [focused, setFocused] = useState('');
  const [viewMonth, setViewMonth] = useState('');
  const [openToday, setOpenToday] = useState('');
  /** 测量后的定位结果；null 表示首帧尚未测量，按隐藏处理避免左上角闪一下。 */
  const [layout, setLayout] = useState<DatePopoverLayout | null>(null);
  /** 合并滚动 / resize / ResizeObserver 触发的重算，一帧最多一次。 */
  const repositionFrameRef = useRef<number | null>(null);

  /** 有未提交草稿（dirty）时，外部 value 变化不覆盖输入框；取消 / 提交后清零。 */
  const dirtyRef = useRef(false);
  /** 最近一次已提交值（Enter / 确定 / 今天 / 明天 / 清除 / 合法面板选择）；取消时恢复它。 */
  const committedRef = useRef<string | null>(committed);
  /** 上一次同步到输入框的父级值，用来区分「外部改值」与「弹层打开」。 */
  const lastSyncedRef = useRef<string | null>(committed);
  /** 指针正按在弹层内：此时输入框失焦不应提交草稿。 */
  const pointerInPopoverRef = useRef(false);
  /** 指针正按在尾部图标上：面板打开时这是「关闭/取消」，失焦不得提交草稿。 */
  const closingViaTriggerRef = useRef(false);
  /** 面板预览是否由手输驱动；手输回退成非法/不完整时用它把面板还原。 */
  const inputDrivenRef = useRef(false);
  const validityChangeRef = useRef(onValidityChange);

  useEffect(() => {
    validityChangeRef.current = onValidityChange;
  }, [onValidityChange]);

  const parseDraft = useCallback(
    () => parseDateInput(draft, { required, min, max }),
    [draft, required, min, max],
  );

  const lunarSupported = preview ? lunarInfo(preview) !== null : true;

  useEffect(() => {
    validityChangeRef.current?.(parseDateInput(draft, { required, min, max }).ok);
  }, [draft, required, min, max]);

  useEffect(() => {
    if ((disabled || readOnly) && open) {
      setOpen(false);
    }
  }, [disabled, open, readOnly]);

  /**
   * 关闭面板。提交路径会先更新 `committedRef`，因此这里可以统一按「取消」处理：
   * 丢弃草稿与行内错误，恢复最后一次已提交值，绝不触发 `onChange`。
   * 这样 Esc / 点外部 / 关闭按钮语义一致，取消后失焦也不会把草稿写库。
   */
  const close = useCallback((restoreFocus: boolean) => {
    if (repositionFrameRef.current !== null) {
      window.cancelAnimationFrame(repositionFrameRef.current);
      repositionFrameRef.current = null;
    }
    setOpen(false);
    dirtyRef.current = false;
    closingViaTriggerRef.current = false;
    inputDrivenRef.current = false;
    setDraft(committedRef.current ?? '');
    setInvalid(null);
    if (restoreFocus) {
      inputRef.current?.focus();
    }
  }, []);

  /**
   * 用 DOM 的视口坐标重新计算弹层位置。滚动容器、window resize、
   * visualViewport 变化与尺寸变化都走这里；结果不变时不触发重渲染。
   */
  const reposition = useCallback(() => {
    const anchor = fieldRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover || typeof window === 'undefined') {
      return;
    }

    const viewport = getViewport();
    const rect = anchor.getBoundingClientRect();

    // jsdom / 隐藏元素没有布局（rect 全 0），不能用它判断「锚点滚出视口」。
    if (rect.width > 0 || rect.height > 0) {
      if (
        rect.bottom < viewport.top - ANCHOR_CLOSE_MARGIN ||
        rect.top > viewport.bottom + ANCHOR_CLOSE_MARGIN ||
        rect.right < viewport.left - ANCHOR_CLOSE_MARGIN ||
        rect.left > viewport.right + ANCHOR_CLOSE_MARGIN
      ) {
        // 锚点滚出视口：关闭但不抢焦点，避免滚动过程中焦点乱跳。
        close(false);
        return;
      }
    }

    const next = computeDatePopoverLayout({
      anchor: rect,
      layer: {
        width: popover.offsetWidth || POPOVER_WIDTH,
        // 限高后 offsetHeight 会变小；scrollHeight 保留内容自然高度。
        height:
          Math.max(popover.offsetHeight, popover.scrollHeight) ||
          FALLBACK_POPOVER_HEIGHT,
      },
      viewport,
      inModal: Boolean(anchor.closest(MODAL_SELECTOR)),
    });

    setLayout((previous) => {
      if (
        previous &&
        previous.placement === next.placement &&
        previous.left === next.left &&
        previous.top === next.top &&
        previous.width === next.width &&
        previous.maxHeight === next.maxHeight &&
        previous.layer === next.layer
      ) {
        return previous;
      }
      return next;
    });
  }, [close]);

  /** rAF 合并：滚动/resize 高频触发时一帧只读一次布局、只写一次状态。 */
  const scheduleReposition = useCallback(() => {
    if (
      typeof window === 'undefined' ||
      repositionFrameRef.current !== null
    ) {
      return;
    }
    repositionFrameRef.current = window.requestAnimationFrame(() => {
      repositionFrameRef.current = null;
      reposition();
    });
  }, [reposition]);

  const openPicker = useCallback(() => {
    const now = today && isValidISODate(today) ? today : todayISO();
    // 输入框里已经是合法日期时，面板直接定位到它（含尚未失焦提交的草稿）；
    // 非法草稿按设计以最后已提交值为基准，不把非法文本当预览。
    const draftResult = parseDateInput(draft, { required, min, max });
    const base =
      (draftResult.ok ? draftResult.value : null) ??
      committedRef.current ??
      validDate(value) ??
      now;
    setOpenToday(now);
    inputDrivenRef.current = false;
    setPreview(base);
    setFocused(base);
    setViewMonth(monthKeyOf(base));
    setLayout(null);
    setOpen(true);
  }, [draft, max, min, required, today, value]);

  /** 弹层打开时把选中日、预览与视图月份对齐到某个值（null 回落到今天）。 */
  const syncPanel = useCallback(
    (next: string | null) => {
      const base =
        next ??
        openToday ??
        (today && isValidISODate(today) ? today : todayISO());
      setPreview(base);
      setFocused(base);
      setViewMonth(monthKeyOf(base));
    },
    [openToday, today],
  );

  /**
   * 手输内容不再能驱动面板时，把面板还原到最后一次已提交值（无值则今天）。
   * 这样「非法/不完整输入不移动面板」成立，不会停留在临时合法前缀的月份。
   */
  const resetPanelSelection = useCallback(() => {
    const fallback =
      committedRef.current ??
      openToday ??
      (today && isValidISODate(today) ? today : todayISO());
    inputDrivenRef.current = false;
    setPreview(fallback);
    setFocused(fallback);
    setViewMonth(monthKeyOf(fallback));
  }, [openToday, today]);

  const commitValue = useCallback(
    (next: string | null) => {
      // min/max 越界不写回，但必须给行内反馈（而不是静默 return）。
      if (next) {
        const result = parseDateInput(next, { min, max });
        if (!result.ok) {
          setInvalid({ reason: result.reason, message: result.message });
          return;
        }
      }
      inputDrivenRef.current = false;
      dirtyRef.current = false;
      committedRef.current = next;
      setDraft(next ?? '');
      setInvalid(null);
      if (open) {
        // 清除后弹层内部回到今天，再次打开时不会停留在旧月份。
        syncPanel(next);
      }
      if (next !== committed) {
        onChange(next);
      }
      close(true);
    },
    [close, committed, max, min, onChange, open, syncPanel],
  );

  const commitDraft = useCallback((): boolean => {
    const result = parseDraft();
    if (!result.ok) {
      setInvalid({ reason: result.reason, message: result.message });
      return false;
    }
    dirtyRef.current = false;
    inputDrivenRef.current = false;
    committedRef.current = result.value;
    setDraft(result.value ?? '');
    setInvalid(null);
    if (open) {
      // 弹层已打开时手输合法值：面板月份、选中高亮与页脚立即跟随。
      syncPanel(result.value);
    }
    if (result.value !== committed) {
      onChange(result.value);
    }
    return true;
  }, [committed, onChange, open, parseDraft, syncPanel]);

  useEffect(() => {
    committedRef.current = committed;
    if (dirtyRef.current) {
      return;
    }
    const changed = lastSyncedRef.current !== committed;
    lastSyncedRef.current = committed;
    if (changed) {
      setDraft(committed ?? '');
      setInvalid(null);
    }
    if (open) {
      // 外部改值（父组件归一化/重置）时，打开着的面板也跟随。
      inputDrivenRef.current = false;
      syncPanel(committed);
    }
  }, [committed, open, syncPanel]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (
        popoverRef.current?.contains(target) ||
        groupRef.current?.contains(target)
      ) {
        return;
      }
      // 点外部取消：不写值，也不抢焦点。
      close(false);
    };
    const onReposition = () => scheduleReposition();
    const onPointerUp = () => {
      pointerInPopoverRef.current = false;
    };
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('resize', onReposition);
    // capture 能收到任意滚动容器（含弹层内部）的 scroll，而不只 window。
    window.addEventListener('scroll', onReposition, true);

    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener('resize', onReposition);
    visualViewport?.addEventListener('scroll', onReposition);

    // 锚点尺寸、字段组（辅助行/错误行）与弹层自身高度变化都要重算。
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(onReposition);
      if (fieldRef.current) {
        observer.observe(fieldRef.current);
      }
      if (groupRef.current) {
        observer.observe(groupRef.current);
      }
      if (popoverRef.current) {
        observer.observe(popoverRef.current);
      }
    }

    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
      visualViewport?.removeEventListener('resize', onReposition);
      visualViewport?.removeEventListener('scroll', onReposition);
      observer?.disconnect();
    };
  }, [open, close, scheduleReposition]);

  useEffect(
    () => () => {
      if (repositionFrameRef.current !== null) {
        window.cancelAnimationFrame(repositionFrameRef.current);
        repositionFrameRef.current = null;
      }
    },
    [],
  );

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    // 先同步测一次，首帧就写对 left/top（初始以 visibility:hidden 挂载）；
    // 下一帧再修正字体加载/滚动条带来的 1px 误差。
    reposition();
    scheduleReposition();
  }, [open, reposition, scheduleReposition, viewMonth, invalid]);

  useEffect(() => {
    if (!open || !focused) {
      return;
    }
    const cell = popoverRef.current?.querySelector<HTMLElement>(
      `[data-date="${focused}"]`,
    );
    if (!cell || document.activeElement === cell) {
      return;
    }
    // 面板打开时手输日期并提交，不能把焦点从输入框抢走；
    // 从日历图标打开或方向键移动时，焦点仍进入目标日格。
    const active = document.activeElement as HTMLElement | null;
    if (active === inputRef.current) {
      return;
    }
    cell.focus();
  }, [open, focused]);

  const moveTo = (next: string) => {
    inputDrivenRef.current = false;
    setFocused(next);
    setPreview(next);
    if (monthKeyOf(next) !== viewMonth) {
      setViewMonth(monthKeyOf(next));
    }
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const text = event.target.value;
    dirtyRef.current = true;
    setDraft(text);

    // 手输合法日期时面板立即联动（月份/选中/预览），但绝不写库。
    // 仍不完整（例如只输入到 2026-1）时保持面板不动；已写满格式但非法时给行内错误。
    const result = parseDateInput(text, { required, min, max });
    if (result.ok) {
      setInvalid(null);
      if (result.value) {
        inputDrivenRef.current = true;
        if (open) {
          setPreview(result.value);
          setFocused(result.value);
          setViewMonth(monthKeyOf(result.value));
        }
      } else if (open && inputDrivenRef.current) {
        // 清空/退格到空值：面板不再由这份草稿驱动。
        resetPanelSelection();
      }
      return;
    }
    if (open && inputDrivenRef.current) {
      resetPanelSelection();
    }
    setInvalid(
      isCompleteDateText(text)
        ? { reason: result.reason, message: result.message }
        : null,
    );
  };

  const onInputBlur = (event: ReactFocusEvent<HTMLInputElement>) => {
    if (!dirtyRef.current) {
      return;
    }
    // 点面板内的日期格/导航/底部按钮会让输入框失焦：此时草稿只是待提交预览，
    // 由面板的「确定」语义决定是否写值，不能在这里顺手提交。
    // 面板打开时点尾部图标是「关闭/取消」，同样不能把草稿提交（由 close 统一回滚）。
    const nextFocus = event.relatedTarget as Node | null;
    if (
      pointerInPopoverRef.current ||
      (nextFocus && popoverRef.current?.contains(nextFocus))
    ) {
      return;
    }
    if (open && closingViaTriggerRef.current) {
      return;
    }
    // 失焦（包括点尾部日历图标）时提交合法草稿；非法草稿保留并显示错误。
    commitDraft();
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === 'Enter') {
      // 日期字段在表单内时，Enter 只提交日期，不提交外层表单。
      event.preventDefault();
      event.stopPropagation();
      commitDraft();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (open) {
        close(true);
        return;
      }
      dirtyRef.current = false;
      closingViaTriggerRef.current = false;
      setDraft(committedRef.current ?? '');
      setInvalid(null);
    }
  };

  const onPopoverKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const key = event.key;
    const target = event.target as HTMLElement;
    const isDay = Boolean(target.closest('.dp-day'));

    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (key === 'Enter') {
      if (isDay) {
        event.preventDefault();
        event.stopPropagation();
        commitValue(focused || preview);
      }
      return;
    }
    if (key === 'Tab') {
      const focusables = Array.from(
        popoverRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled])',
        ) ?? [],
      );
      if (focusables.length === 0) {
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    const base = focused || preview;
    if (!base) {
      return;
    }
    let next: string | null = null;
    if (key === 'ArrowLeft') {
      next = addDaysISO(base, -1);
    } else if (key === 'ArrowRight') {
      next = addDaysISO(base, 1);
    } else if (key === 'ArrowUp') {
      next = addDaysISO(base, -7);
    } else if (key === 'ArrowDown') {
      next = addDaysISO(base, 7);
    } else if (key === 'PageUp') {
      next = addMonthsISO(base, -1);
    } else if (key === 'PageDown') {
      next = addMonthsISO(base, 1);
    } else if (key === 'Home') {
      next = startOfWeekISO(base, resolvedWeekStart);
    } else if (key === 'End') {
      next = addDaysISO(startOfWeekISO(base, resolvedWeekStart), 6);
    }
    if (!next) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    moveTo(next);
  };

  const cells = viewMonth
    ? monthGrid(viewMonth, resolvedWeekStart)
    : [];
  const helperText = committed
    ? `${formatDateFieldLabel(committed)}${
        lunarInfo(committed) ? ` · ${lunarFullLabel(committed)}` : ''
      }`
    : '';
  const describedBy =
    [
      showHelper && helperText ? helpId : null,
      invalid ? errorId : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  const state = invalid ? 'invalid' : committed ? 'filled' : 'empty';
  /** 预览值与已提交值不同：面板里显示「待确定」，提醒尚未写库。 */
  const pending = Boolean(preview) && preview !== (committed ?? '');
  const todayValue = openToday ? addDaysISO(openToday, 0) : '';
  const tomorrowValue = openToday ? addDaysISO(openToday, 1) : '';
  const todayBlocked = !todayValue || !inRange(todayValue, min, max);
  const tomorrowBlocked = !tomorrowValue || !inRange(tomorrowValue, min, max);
  const isSheet = layout?.placement === 'sheet';
  const popoverStyle: CSSProperties = layout
    ? layout.placement === 'sheet'
      ? { maxHeight: layout.maxHeight ?? undefined }
      : {
          left: layout.left,
          top: layout.top,
          width: layout.width,
          maxHeight: layout.maxHeight ?? undefined,
        }
    : // 未测量前固定在 0,0 并隐藏，避免首帧在左上角闪一下。
      { left: 0, top: 0, visibility: 'hidden' };

  const popover = open ? (
    <div
      ref={popoverRef}
      id={panelId}
      className={isSheet ? 'dp-popover is-sheet' : 'dp-popover'}
      role="dialog"
      aria-label="选择日期"
      aria-describedby={labelId}
      data-view-month={viewMonth}
      data-placement={layout?.placement ?? 'pending'}
      data-ready={layout ? 'true' : 'false'}
      data-layer={layout?.layer ?? 'base'}
      style={popoverStyle}
      onKeyDown={onPopoverKeyDown}
      onPointerDown={() => {
        pointerInPopoverRef.current = true;
      }}
      onPointerUp={() => {
        pointerInPopoverRef.current = false;
      }}
      onPointerCancel={() => {
        pointerInPopoverRef.current = false;
      }}
    >
      <div className="dp-header">
        <button
          type="button"
          className="dp-nav"
          aria-label="上个月"
          onClick={() => {
            inputDrivenRef.current = false;
            setViewMonth((current) => shiftMonth(current, -1));
          }}
        >
          ‹
        </button>
        <span className="dp-title" aria-live="polite">
          {monthTitle(viewMonth)}
        </span>
        <button
          type="button"
          className="dp-nav"
          aria-label="下个月"
          onClick={() => {
            inputDrivenRef.current = false;
            setViewMonth((current) => shiftMonth(current, 1));
          }}
        >
          ›
        </button>
      </div>

      <div className="dp-weekdays" aria-hidden="true">
        {weekdayLabels(resolvedWeekStart).map((day) => (
          <span key={day}>{day.replace('周', '')}</span>
        ))}
      </div>

      <div
        className="dp-grid"
        role="grid"
        aria-label={`${monthTitle(viewMonth)}日期`}
      >
        {cells.map((cell) => {
          const date = parseISODate(cell.date);
          const short = lunarSupported ? lunarShortLabel(cell.date) : '';
          const selected = cell.date === preview;
          const dayStatus = workdayStatus(
            cell.date,
            calendarPreferences.workdayRule,
            {
              exceptions: calendarPreferences.dateExceptions,
              holidayLookup: getRuntimeHolidayLookup(),
            },
          );
          const classes = [
            'dp-day',
            cell.inMonth ? '' : 'is-outside',
            cell.date === openToday ? 'is-today' : '',
            selected ? 'is-selected' : '',
            isRestStatus(dayStatus) ? 'is-rest' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const label = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${
            FULL_WEEKDAYS[date.getDay()]
          }${short ? ` 农历${short}` : ''}`;
          const blocked = !inRange(cell.date, min, max);
          return (
            <button
              key={cell.date}
              type="button"
              className={classes}
              data-date={cell.date}
              data-workday={dayStatus}
              aria-label={label}
              aria-selected={selected}
              aria-disabled={blocked || undefined}
              disabled={blocked}
              tabIndex={cell.date === focused ? 0 : -1}
              onClick={() => {
                setFocused(cell.date);
                setPreview(cell.date);
                // 面板 → 输入框实时回写：显示待提交值，但仍需「确定」才写库。
                setDraft(cell.date);
                setInvalid(null);
                dirtyRef.current = true;
                inputDrivenRef.current = false;
                if (monthKeyOf(cell.date) !== viewMonth) {
                  setViewMonth(monthKeyOf(cell.date));
                }
              }}
              onDoubleClick={() => {
                if (!blocked) {
                  commitValue(cell.date);
                }
              }}
            >
              <span className="dp-day-num">{date.getDate()}</span>
              {short ? <span className="dp-day-lunar">{short}</span> : null}
            </button>
          );
        })}
      </div>

      <div className="dp-footer">
        <div className="dp-preview" id={labelId}>
          <strong>{preview ? formatDateFieldLabel(preview) : '未选择日期'}</strong>
          <span className="dp-preview-lunar">
            {lunarSupported
              ? lunarFullLabel(preview)
              : '当前环境不支持农历回显'}
            {pending ? (
              <span className="dp-preview-pending">待确定</span>
            ) : null}
          </span>
        </div>
        <div className="dp-actions">
          <button
            type="button"
            className="dp-chip"
            disabled={todayBlocked}
            title={
              todayBlocked && todayValue
                ? `今天 ${todayValue}：${rangeHint(todayValue, min, max)}`
                : undefined
            }
            onClick={() => commitValue(todayValue)}
          >
            今天
          </button>
          <button
            type="button"
            className="dp-chip"
            disabled={tomorrowBlocked}
            title={
              tomorrowBlocked && tomorrowValue
                ? `明天 ${tomorrowValue}：${rangeHint(tomorrowValue, min, max)}`
                : undefined
            }
            onClick={() => commitValue(tomorrowValue)}
          >
            明天
          </button>
          <span className="dp-spacer" />
          {required ? null : (
            <button
              type="button"
              className="dp-clear"
              onClick={() => commitValue(null)}
            >
              清除
            </button>
          )}
          <button
            type="button"
            className="dp-confirm"
            onClick={() => commitValue(preview)}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <div
        ref={groupRef}
        id={groupId}
        className={['date-field-group', className ?? ''].filter(Boolean).join(' ')}
        data-state={state}
        data-disabled={disabled || undefined}
        data-readonly={readOnly || undefined}
      >
        <div
          ref={fieldRef}
          className={[
            'date-field',
            open ? 'is-open' : '',
            invalid ? 'is-invalid' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <input
            ref={inputRef}
            id={fieldId}
            className="date-field-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            placeholder={emptyLabel}
            aria-label={ariaLabel}
            aria-required={required || undefined}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={describedBy}
            aria-readonly={readOnly || undefined}
            data-value={committed ?? ''}
            disabled={disabled}
            readOnly={readOnly}
            onChange={onInputChange}
            onKeyDown={onInputKeyDown}
            onBlur={onInputBlur}
          />
          <button
            type="button"
            id={`${fieldId}-trigger`}
            className="date-field-icon"
            aria-label={open ? '关闭日期选择' : '打开日期选择'}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            disabled={disabled || readOnly}
            onPointerDown={() => {
              // 面板打开时点图标 = 关闭（取消）：随后输入框失焦不得提交草稿，
              // 由 onClick 的 close 统一回滚到已提交值。
              closingViaTriggerRef.current = open;
            }}
            onPointerUp={() => {
              closingViaTriggerRef.current = false;
            }}
            onPointerCancel={() => {
              closingViaTriggerRef.current = false;
            }}
            onClick={() => {
              closingViaTriggerRef.current = false;
              if (open) {
                close(true);
              } else {
                openPicker();
              }
            }}
          >
            <CalendarIcon />
          </button>
        </div>
        {showHelper && helperText ? (
          <p id={helpId} className="date-field-help" aria-live="polite">
            {helperText}
          </p>
        ) : null}
        {invalid ? (
          <p id={errorId} className="date-field-error" role="alert">
            {invalid.message}
          </p>
        ) : null}
      </div>
      {popover && typeof document !== 'undefined'
        ? createPortal(popover, getPortalRoot())
        : null}
    </>
  );
}

export default DatePicker;
