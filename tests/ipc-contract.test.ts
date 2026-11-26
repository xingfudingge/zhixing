// @ts-nocheck
/** ZX-090 独立验收 · JS ↔ Rust IPC 契约静态核对。 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const appRoot = join(root, 'app');

function read(path) {
  return readFileSync(join(appRoot, path), 'utf8');
}

function unique(values) {
  return [...new Set(values)].sort();
}

function jsCommands() {
  const source = read('src/data/db/client.ts');
  return unique(
    [...source.matchAll(/call<[^>]*>\(\s*'([^']+)'/g)].map((match) => match[1]),
  );
}

function rustCommandFns() {
  // 前端 client.ts 同时调用 repositories/* 与 note_encryption.rs 的命令。
  const roots = [
    join(appRoot, 'src-tauri/src/repositories'),
    join(appRoot, 'src-tauri/src/note_encryption.rs'),
  ];
  const names = [];
  const readOne = (file) => {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/#\[tauri::command\]\s*\npub fn (\w+)/g)) {
      names.push(match[1]);
    }
  };
  for (const root of roots) {
    let stat;
    try {
      stat = readdirSync(root);
    } catch {
      readOne(root);
      continue;
    }
    for (const file of stat.filter((name) => name.endsWith('.rs'))) {
      readOne(join(root, file));
    }
  }
  return unique(names);
}

function registeredCommands() {
  const source = read('src-tauri/src/lib.rs');
  const block = source.slice(
    source.indexOf('tauri::generate_handler!['),
    source.indexOf(']);', source.indexOf('tauri::generate_handler![')),
  );
  const names = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim().replace(/,$/, '');
    if (!line || line.startsWith('//') || line.startsWith('tauri::generate_handler')) {
      continue;
    }
    const name = line.split('::').pop();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.push(name);
  }
  return unique(names);
}

describe('IPC 契约', () => {
  it('前端调用的所有命令都有 Rust 命令与 generate_handler 注册', () => {
    const js = jsCommands();
    const rust = rustCommandFns();
    const registered = registeredCommands();
    const system = ['db_status', 'db_migrate'];
    // 数量只做下限守卫；真正的契约是下面的命令集合与注册表。
    expect(js.length).toBeGreaterThanOrEqual(84);
    expect(js.filter((name) => !system.includes(name)).sort()).toEqual(rust);
    for (const name of [...js, 'shell_ready']) {
      expect(registered).toContain(name);
    }
  });

  it('迁移不创建 users / memberships / seats 等账号表', () => {
    const dir = join(appRoot, 'src-tauri/migrations');
    const sql = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .join('\n');
    expect(sql).not.toMatch(/CREATE TABLE\s+(users|memberships|seats|accounts)\b/i);
  });

  it('业务仓储不把 localStorage 当权威库', () => {
    for (const file of readdirSync(join(appRoot, 'src/data/repositories'))) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      if (file === 'settings.ts') continue; // 设备偏好允许镜像 localStorage
      const source = readFileSync(join(appRoot, 'src/data/repositories', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(source).not.toMatch(/localStorage/);
    }
  });
});
