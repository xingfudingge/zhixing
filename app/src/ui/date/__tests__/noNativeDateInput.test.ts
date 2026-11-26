import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** 规范 §4.1 代码门禁：app/src 中不得存在 input[type=date]。 */
function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('日期控件代码门禁', () => {
  it('src 下不存在原生 input[type=date]', () => {
    // Vitest 的 root 是 app/；测试固定从仓库 app 目录扫描。
    const src = join(process.cwd(), 'src');
    const offenders = walk(src)
      .filter((file) => /\.(ts|tsx|html)$/.test(file))
      .filter((file) => !/\.test\./.test(file) && !file.includes('/__tests__/'))
      .filter((file) =>
        /type\s*=\s*["']date["']/.test(readFileSync(file, 'utf8')),
      );
    expect(offenders).toEqual([]);
  });
});
