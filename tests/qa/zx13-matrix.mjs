#!/usr/bin/env node
/**
 * ZX13-FULL-QA-01 卡 → 测试/证据矩阵生成器。
 *
 * 输入：tests/evidence/zx13-full-qa/kanban-done.json（看板 done 卡快照）
 * 输出：Markdown 表格（stdout），报告直接粘贴。
 *
 * 判定口径：
 * - 直接证据：tests/ 下的测试/证据文件、tests/e2e 脚本、或 outputs/ 验收报告
 *   中出现卡号；
 * - 仅文档：只在 outputs/、docs/ 的设计/审视文档中出现；
 * - 无直接证据：仓库里没有卡号引用。
 * 该矩阵只证明“有对应验收资产”，不代表本轮重新点击通过；本轮实测结论见报告正文。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const cards = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'tests/evidence/zx13-full-qa/kanban-done.json'),
    'utf8',
  ),
);

const MODULES = [
  ['QA/打包/工程', /QA|PKG|ZX-090|AUD-000|AUD-001|AUD-012|工程|打包|验收/],
  ['导入导出/附件', /(^|-)IO-|EXPORT|FILE-|ZX5-IO|ZX6-IO|AUD-018|P2-04|附件|导入|导出/],
  ['画板', /ZX-BOARD|ZX-DESIGN-0[7]|ZX-DESIGN-1[16]|P1-04|AUD-016|画板/],
  ['日历/事件/倒数日', /ZX-(DATE|CAL)|ZX5-CAL|ZX6-DATE|ZX7-(DATE|POPOVER)|ZX11-CAL|ZX12|ZX-DESIGN-17|P0-06|AUD-01[4]|AUD-02[34]|日历|倒数日|事件/],
  ['任务/今天/清单', /ZX-TASK|ZX-UX-01|ZX10-UI|ZX6-QA-04|P0-0[45]|P1-03|TaskCenter|任务中心|四象限|清单/],
  ['设置/外壳/导航', /ZX-DESIGN-0[12]|ZX-DESIGN-1[45]|ZX-(NAV|LIST|CLEAN|STYLE|ICON)|ZX5-(UI|NAV|RAIL)|ZX10-STYLE|P0-0[12]|P1-05|AUD-00[5]|AUD-008|AUD-009|AUD-010|AUD-019|AUD-021|AUD-022|设置|导航|外壳/],
  ['编辑器/知识', /ZX-(NOTE|BLOCK|CODE|FORMULA|TABLE|LINK|GRAPH|TOOLBAR|DESIGN-0[4589]|DESIGN-1[23])|ZX10-(EDITOR|BLOCKSEL|HIST|STYLE)|ZX6-|ZX7-(MENU|TOOLBAR|POPOVER|I18N)|ZX8-|P1-0[12]|AUD-00[234]|AUD-013|将正文内容块/],
  ['OCR', /OCR|AUD-007|ZX11-OCR/],
  ['隐私/加密', /PRIVACY|ENC|LOCK|ZX11-PRIVACY|AUD-019/],
  ['同步/WebDAV', /SYNC|WEBDAV|P2-0[12]|同步|配对/],
  ['授权', /license|AUD-011|授权/],
  ['习惯/专注/复盘', /P0-0[789]|AUD-015|ZX-UX-0[34]|习惯|专注|复盘/],
  ['搜索/快速创建', /P1-06|搜索|快速创建|导览/],
];

function tokenOf(card) {
  const title = card.title;
  const bracket = title.match(/^\[([A-Za-z0-9-]+)\]/);
  if (bracket) return bracket[1];
  const token = title.match(/\b([A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]+)+)\b/);
  if (token) return token[1];
  const aud = title.match(/\b(AUD-\d{3})\b/);
  if (aud) return aud[1];
  return null;
}

function moduleOf(card) {
  for (const [name, pattern] of MODULES) {
    if (pattern.test(card.title)) return name;
  }
  return '其他/设计交付';
}

function filesFor(token) {
  if (!token) return [];
  try {
    const output = execFileSync(
      'rg',
      ['-l', '--fixed-strings', token, 'tests', 'outputs', 'app/src', 'docs'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter(
        (file) =>
          file !== 'tests/evidence/zx13-full-qa/kanban-done.json' &&
          file !== 'tests/qa/zx13-matrix.mjs',
      );
  } catch {
    return [];
  }
}

function classify(card) {
  const token = tokenOf(card);
  const files = filesFor(token);
  const tests = files.filter(
    (file) =>
      /\/tests\//.test(`/${file}`) &&
      /\.(test\.(ts|tsx)|mjs|sh|json)$/.test(file),
  );
  const evidence = files.filter(
    (file) => file.startsWith('tests/evidence/') && /\.(json|md|txt)$/.test(file),
  );
  const reports = files.filter(
    (file) => file.startsWith('outputs/') && /\.md$/.test(file),
  );
  const docs = files.filter(
    (file) => (file.startsWith('outputs/') || file.startsWith('docs/')) && /\.md$/.test(file),
  );
  if (tests.length || evidence.length) {
    return { token, kind: '直接测试/证据', files: [...tests, ...evidence].slice(0, 3), filesAll: files };
  }
  if (reports.length) {
    return { token, kind: '验收报告', files: reports.slice(0, 3), filesAll: files };
  }
  if (docs.length) {
    return { token, kind: '仅设计/文档', files: docs.slice(0, 3), filesAll: files };
  }
  return { token, kind: '无直接证据', files: [], filesAll: files };
}

const rows = cards.map((card) => ({ card, ...classify(card), module: moduleOf(card) }));
const byModule = new Map();
for (const row of rows) {
  if (!byModule.has(row.module)) byModule.set(row.module, []);
  byModule.get(row.module).push(row);
}

console.log('| 模块 | done 卡 | 直接测试/证据 | 验收报告 | 仅设计/文档 | 无直接证据 |');
console.log('|---|---:|---:|---:|---:|---:|');
for (const [name, list] of byModule) {
  const count = (kind) => list.filter((row) => row.kind === kind).length;
  console.log(
    `| ${name} | ${list.length} | ${count('直接测试/证据')} | ${count('验收报告')} | ${count('仅设计/文档')} | ${count('无直接证据')} |`,
  );
}

console.log('\n<!-- CARD MATRIX START -->');
console.log('| 卡 | 标题 | 模块 | 证据类型 | 直接证据（最多 3 条） |');
console.log('|---|---|---|---|---|');
for (const row of rows) {
  console.log(
    `| ${row.card.id} | ${row.card.title.replace(/\|/g, '\\|')} | ${row.module} | ${row.kind} | ${
      row.files.length ? row.files.map((file) => `\`${file}\``).join('<br>') : '—'
    } |`,
  );
}
console.log('<!-- CARD MATRIX END -->');

const uncovered = rows.filter((row) => row.kind === '无直接证据');
console.log(`\n未找到卡号引用的 done 卡：${uncovered.length}`);
for (const row of uncovered) console.log(`- ${row.card.id} ${row.card.title}`);
