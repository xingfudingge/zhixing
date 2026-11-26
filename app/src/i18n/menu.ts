/**
 * 知识库右键菜单中文文案表（ZX7-I18N-01）。
 *
 * 设计来源：`outputs/设计-第七轮编辑器浮层与菜单-2026-10-31.md` §8。
 * 约束：
 * - 本表是菜单文案的唯一真源；菜单模型只存 key，渲染时调用 `t()` / `tMenu()`。
 * - 当前只有 `zh-CN`，不引入 i18next/react-intl；后续如需多语言，再按 locale 增加目录。
 * - 不在本文件处理快捷键显示；快捷键使用 `Mod+Shift+Z` 这类平台无关 token。
 */
export const MENU_LOCALE = 'zh-CN' as const;

export const menuCatalog = Object.freeze({
  // §8.1 菜单标签与通用项
  'menu.label.text': '文本菜单',
  'menu.label.blank': '空白菜单',
  'menu.label.table': '表格菜单',
  'menu.label.formula': '公式菜单',
  'menu.label.formulaTemplate': '公式模板',
  'menu.label.image': '图片菜单',
  'menu.label.tree': '目录树菜单',
  'menu.label.tab': '标签页菜单',
  'menu.label.note': '笔记操作',
  'menu.label.board': '画板右键菜单',
  'menu.common.ok': '确定',
  'menu.common.cancel': '取消',
  'menu.common.delete': '删除',
  'menu.common.more': '更多',
  'menu.common.export': '导出…',
  'menu.heading.tableProperties': '表格属性',
  'menu.heading.export': '导出',
  'menu.heading.align': '对齐',
  'menu.heading.distribute': '等距',
  'menu.heading.layer': '层级',
  'menu.heading.routing': '线型',
  'menu.note.description': '说明',

  // §8.2 正文 / 空白
  'menu.text.cut': '剪切',
  'menu.text.copy': '复制',
  'menu.text.paste': '粘贴',
  'menu.text.selectAll': '全选',
  'menu.text.bold': '加粗',
  'menu.text.italic': '斜体',
  'menu.text.underline': '下划线',
  'menu.text.strike': '删除线',
  'menu.text.code': '行内代码',
  'menu.text.link': '链接…',
  'menu.text.toHeading2': '转为标题 2',
  'menu.text.toTodo': '转为待办',
  'menu.text.toQuote': '转为引用',
  'menu.text.insert': '插入',
  'menu.text.insert.table': '表格',
  'menu.text.insert.formula': '公式',
  'menu.text.insert.code': '代码块',
  'menu.text.insert.divider': '分割线',
  'menu.text.deleteBlock': '删除块',
  'menu.blank.paste': '粘贴',
  'menu.blank.newParagraph': '新建段落',
  'menu.blank.newTodo': '新建待办',
  'menu.blank.newHeading2': '新建标题 2',
  'menu.blank.insert': '插入',
  'menu.blank.selectAll': '全选',

  // §8.3 表格
  'menu.table.cutSelection': '剪切选区',
  'menu.table.copySelection': '复制选区',
  'menu.table.paste': '粘贴',
  'menu.table.merge': '合并选区',
  'menu.table.split': '拆分单元格',
  'menu.table.rowAbove': '上方插入行',
  'menu.table.rowBelow': '下方插入行',
  'menu.table.columnLeft': '左侧插入列',
  'menu.table.columnRight': '右侧插入列',
  'menu.table.rowRemove': '删除当前行',
  'menu.table.columnRemove': '删除当前列',
  'menu.table.alignLeft': '左对齐',
  'menu.table.alignCenter': '居中对齐',
  'menu.table.alignRight': '右对齐',
  'menu.table.header': '表头',
  'menu.table.averageWidth': '平均列宽',
  'menu.table.resetWidth': '恢复当前列宽',
  'menu.table.clearSelection': '清空选区',
  'menu.table.export': '导出',
  'menu.table.exportMarkdown': 'Markdown（.md）',
  'menu.table.exportHtml': 'HTML（.html）',
  'menu.table.deleteTable': '删除表格',
  'menu.table.copyTable': '复制整表',
  'menu.table.copyMarkdown': '复制 Markdown',
  'menu.table.copyHtml': '复制 HTML',

  // §8.4 公式 / 图片
  'menu.formula.edit': '编辑公式',
  'menu.formula.finish': '完成',
  'menu.formula.copyLatex': '复制 LaTeX',
  'menu.formula.toggleDisplay.toBlock': '切换为块级',
  'menu.formula.toggleDisplay.toInline': '切换为行内',
  'menu.formula.zoom': '缩放',
  'menu.formula.zoomIn': '放大公式',
  'menu.formula.zoomOut': '缩小公式',
  'menu.formula.zoomReset': '重置缩放',
  'menu.formula.export': '导出…',
  'menu.formula.deleteBlock': '删除块',
  'menu.image.preview': '预览图片',
  'menu.image.open': '打开',
  'menu.image.saveAs': '另存为…',
  'menu.image.remoteDownload': '从服务器下载',
  'menu.image.rename': '重命名…',
  'menu.image.copyName': '复制文件名',
  'menu.image.deleteFile': '删除文件卡',

  // §8.5 目录树 / 标签页 / 笔记
  'menu.tree.newNote': '新建笔记',
  'menu.tree.openInList': '在列表中打开',
  'menu.tree.refresh': '刷新列表',
  'menu.tree.copyFolderName': '复制目录名称',
  'menu.tab.close': '关闭',
  'menu.tab.closeOthers': '关闭其他',
  'menu.tab.closeAll': '关闭全部',
  'menu.tab.copyLink': '复制笔记内链',
  'menu.tab.locateInList': '在列表中定位',
  'menu.tab.pin': '置顶',
  'menu.tab.unpin': '取消置顶',
  'menu.tab.favorite': '收藏',
  'menu.tab.unfavorite': '取消收藏',
  'menu.tab.rename': '重命名…',
  'menu.tab.export': '导出…',
  'menu.note.open': '打开',
  'menu.note.openNew': '在新标签页打开',
  'menu.note.pin': '置顶',
  'menu.note.unpin': '取消置顶',
  'menu.note.favorite': '收藏',
  'menu.note.unfavorite': '取消收藏',
  'menu.note.copyLink': '复制笔记内链',
  'menu.note.copyBody': '复制正文',
  'menu.note.move': '移动到目录…',
  'menu.note.rename': '重命名…',
  'menu.note.export': '导出…',
  'menu.note.delete': '删除笔记',
  'menu.note.restore': '恢复笔记',
  'menu.note.exportSnapshot': '导出只读快照…',

  // §8.6 画板
  'menu.board.paste': '粘贴',
  'menu.board.selectAll': '全选',
  'menu.board.fit': '适配视图',
  'menu.board.undo': '撤销',
  'menu.board.redo': '重做',
  'menu.board.copy': '复制',
  'menu.board.layer': '层级',
  'menu.board.layerFront': '置顶',
  'menu.board.layerUp': '上移一层',
  'menu.board.layerDown': '下移一层',
  'menu.board.layerBack': '置底',
  'menu.board.lock': '锁定',
  'menu.board.unlock': '解锁',
  'menu.board.delete': '删除',
  'menu.board.routing': '线型',
  'menu.board.routingStraight': '直线',
  'menu.board.routingElbow': '折线',
  'menu.board.routingCurve': '曲线',
  'menu.board.reverse': '反向',
  'menu.board.deleteEdge': '删除连线',
  'menu.board.align': '对齐',
  'menu.board.alignLeft': '左对齐',
  'menu.board.alignHCenter': '水平居中',
  'menu.board.alignRight': '右对齐',
  'menu.board.alignTop': '顶对齐',
  'menu.board.alignVCenter': '垂直居中',
  'menu.board.alignBottom': '底对齐',
  'menu.board.distribute': '等距',
  'menu.board.distributeX': '水平等距',
  'menu.board.distributeY': '垂直等距',
  'menu.board.deleteSelection': '删除选中（{count}）',
  'menu.board.label.canvas': '空白画布',
  'menu.board.label.node': '已选 {count} 个对象',
  'menu.board.label.edge': '已选 {count} 条连线',
  'menu.board.label.multi': '已选 {nodeCount} 个对象 · {edgeCount} 条连线',

  // §8.7 禁用原因与提示
  'menu.hint.selectText': '先选中文字',
  'menu.hint.selectCells': '先选择单元格',
  'menu.hint.merge': '选择至少 2 个单元格',
  'menu.hint.noMerge': '选区没有合并单元格',
  'menu.hint.maxRows': '表格已达到最大行数',
  'menu.hint.maxColumns': '表格已达到最大列数',
  'menu.hint.lastRow': '至少保留 1 行',
  'menu.hint.lastColumn': '至少保留 1 列',
  'menu.hint.lastBlock': '至少保留 1 个块',
  'menu.hint.emptyFormula': '公式为空',
  'menu.hint.maxZoom': '已到最大缩放',
  'menu.hint.minZoom': '已到最小缩放',
  'menu.hint.zoom100': '当前已是 100%',
  'menu.hint.clipboardEmpty': '剪贴板为空',
  'menu.hint.noUndo': '没有可撤销的操作',
  'menu.hint.noRedo': '没有可重做的操作',
  'menu.hint.remoteOnly': '仅远端文件可用',
  'menu.hint.oneTab': '仅 1 个标签时不可用',
  'menu.hint.heading2': '当前已是标题 2',
  'menu.hint.todo': '当前已是待办',
  'menu.hint.quote': '当前已是引用',

  // §8.8 确认与结果
  'menu.confirm.deleteNote.title': '删除笔记',
  'menu.confirm.deleteNote.body': '笔记会移入回收站，可在回收站恢复。',
  'menu.confirm.deleteNote.ok': '删除笔记',
  'menu.toast.deletedUndo': '已删除 · 可撤销',
  'menu.toast.fileRemovedUndo': '已移除文件卡 · 可撤销',
  'menu.toast.edgeDeletedUndo': '已删除连线 · 可撤销',
  'menu.toast.movedToFolder': '已移动到「{folder}」',
  'menu.toast.copied': '已复制',
  'menu.toast.linkCopied': '已复制笔记内链',
  'menu.toast.copyFailed': '复制失败，请重试',
  'menu.toast.noClipboard': '无法读取剪贴板，请用快捷键粘贴',
} as const satisfies Readonly<Record<string, string>>);

/** 菜单文案 key。菜单模型（MenuItem.labelKey、aria-label 等）应使用该类型。 */
export type MenuKey = keyof typeof menuCatalog;

/** 插值参数；当前占位符为 `{count}`、`{nodeCount}`、`{edgeCount}`、`{folder}` 等。 */
export type MenuParams = Readonly<Record<string, string | number>>;

const catalog: Readonly<Record<string, string>> = menuCatalog;
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

function isStrictRuntime(): boolean {
  // Vitest 下 DEV=true、MODE='test'；生产构建由 Vite 静态替换为 false。
  return import.meta.env.DEV || import.meta.env.MODE === 'test';
}

function interpolate(template: string, params?: MenuParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * 判断字符串是否为已登记的菜单 key（运行时守卫）。
 * 用于接收外部数据（如命令表、持久化草稿）后再安全地调用 `t()`。
 */
export function isMenuKey(key: string): key is MenuKey {
  return Object.prototype.hasOwnProperty.call(menuCatalog, key);
}

/**
 * 翻译菜单 key，并替换 `{param}` 占位符。
 *
 * 未知 key 的处理：
 * - 开发/测试环境：抛错，避免拼写错误被静默吞掉；
 * - 生产环境：返回 key 本身，界面上仍能定位问题，且绝不返回空字符串。
 */
export function t(key: MenuKey, params?: MenuParams): string {
  const template = catalog[key as string];
  if (template === undefined) {
    if (isStrictRuntime()) {
      throw new Error(`[i18n] 未知菜单 key: ${String(key)}`);
    }
    return String(key);
  }
  return interpolate(template, params);
}

/** 设计文档 §6.6 使用的命名；与 `t()` 等价，供菜单卡直接引用。 */
export const tMenu: typeof t = t;
