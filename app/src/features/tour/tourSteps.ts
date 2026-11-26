/** 产品导览内容。与原型导览的 7 个模块一致，并补充顶栏状态与快捷键。 */

export type TourStep = {
  id: string;
  index: number;
  title: string;
  body: string;
};

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'today',
    index: 1,
    title: '今天',
    body: '切换列表 / 四象限 / 看板；拖动卡片改象限或状态，点任务右侧 ··· 编辑日期、优先级和子任务。',
  },
  {
    id: 'calendar',
    index: 2,
    title: '日历',
    body: '顶部切「日历 / 事件 / 倒数日 / 小工具」；月 / 周 / 日视图可拖动任务改期。事件占时间，任务可完成，倒数日只计数。',
  },
  {
    id: 'rhythm',
    index: 3,
    title: '习惯 / 专注 / 复盘',
    body: '习惯按周打卡；专注计时可关联任务并记入复盘；复盘汇总最近 7 天的任务、专注和习惯数据。',
  },
  {
    id: 'knowledge',
    index: 4,
    title: '知识',
    body: '目录 / 笔记列表 / 编辑器三栏；没有固定格式工具栏，把鼠标移到段落左侧点 ＋／⠿ 插入块；选中文字浮出格式条。',
  },
  {
    id: 'board',
    index: 5,
    title: '画板',
    body: '左侧工具栏加对象；点连线可改线型 / 箭头 / 颜色；从节点锚点拖线；框选后对齐、复制；⌘Z 撤销。',
  },
  {
    id: 'lists',
    index: 6,
    title: '清单',
    body: '侧栏「清单」新建；清单页可改名、改色、删除。删除清单时任务会移到未安排，不会消失。',
  },
  {
    id: 'settings',
    index: 7,
    title: '设置与状态胶囊',
    body: '设置分 8 组；顶栏「本机 · 已保存」跳到同步与网络。本版本只支持本机 SQLite。',
  },
];

export type TourShortcut = {
  keys: string;
  label: string;
};

export const TOUR_SHORTCUTS: readonly TourShortcut[] = [
  { keys: '⌘K', label: '全局搜索' },
  { keys: '⌘N', label: '快速创建任务' },
  { keys: '⌘⇧N', label: '快速创建笔记' },
  { keys: '?', label: '打开导览' },
  { keys: 'Esc', label: '关闭面板' },
];

/** 导览的“先看四象限”目标；TodayPage 会消费 view=quadrant 并清理 URL。 */
export const TOUR_QUADRANT_PATH = '/today?view=quadrant';
