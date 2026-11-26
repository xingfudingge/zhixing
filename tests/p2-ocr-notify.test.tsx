// @ts-nocheck
/**
 * AUD-012 独立验收 · P2 OCR / 通知。
 *
 * 走真实 App 路由（/settings/ocr、/settings/notify）与真实 Shell：
 * - OCR 默认关闭；无 TextDetector 时显示真实不可用原因，不伪造结果；
 *   开启/范围/语言/保存位置写入设备偏好，重挂载后保持；
 *   提供真实 TextDetector 能力时，测试图片识别返回引擎原文。
 * - 应用内测试通知通过真实 NotificationScheduler → Shell NotificationRuntime
 *   弹出 toast；系统通道在未接 native plugin 时必须 unsupported；
 *   浏览器权限只在点击时请求，granted 后真实调用 Notification 构造器。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from '../app/node_modules/react/index.js';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '../app/node_modules/@testing-library/react/dist/index.js';
import userEvent from '../app/node_modules/@testing-library/user-event/dist/esm/index.js';

import { createFakeWorld } from './harness/fakeTauri';

let consoleErrors: string[] = [];
let consoleWarns: string[] = [];
let restoreConsole: (() => void) | null = null;

beforeEach(() => {
  consoleErrors = [];
  consoleWarns = [];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(args.map(String).join(' '));
  });
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
    consoleWarns.push(args.map(String).join(' '));
  });
  restoreConsole = () => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  };
  window.localStorage.clear();
  delete globalThis.TextDetector;
  delete globalThis.createImageBitmap;
  delete globalThis.Notification;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(async () => {
  cleanup();
  restoreConsole?.();
  delete window.__TAURI_INTERNALS__;
  delete globalThis.TextDetector;
  delete globalThis.createImageBitmap;
  delete globalThis.Notification;
  const { resetDefaultNotificationScheduler } = await import(
    '../app/src/features/notifications/runtime'
  );
  resetDefaultNotificationScheduler();
});

async function mountApp(world, path, options = {}) {
  if (options.install !== false) {
    world.install();
  } else {
    delete window.__TAURI_INTERNALS__;
  }
  window.history.replaceState({}, '', path);
  const { default: App } = await import('../app/src/App');
  return render(React.createElement(App));
}

describe('P2 OCR · 开关/范围/语言/引擎能力', () => {
  it('默认关闭且 TextDetector 缺失时如实显示不可用；偏好持久化；有引擎时返回真实文本', async () => {
    const world = createFakeWorld();
    const user = userEvent.setup();
    const view = await mountApp(world, '/settings/ocr', { install: false });
    await screen.findByRole('heading', { level: 1, name: '设置' });

    const panel = await screen.findByRole('region', { name: '图片 OCR' });
    const toggle = within(panel).getByRole('checkbox', { name: /启用图片 OCR/ });
    expect(toggle).not.toBeChecked();
    expect(await within(panel).findByText('引擎不可用')).toBeInTheDocument();
    expect(
      within(panel).getAllByText(/当前为浏览器预览，需桌面壳/).length,
    ).toBeGreaterThan(0);
    expect(
      within(panel).getByLabelText('选择 OCR 测试图片'),
    ).toBeDisabled();
    expect(within(panel).getByText(/先启用图片 OCR；默认关闭/)).toBeInTheDocument();

    // 开启并改范围/语言/保存位置。
    await user.click(toggle);
    await waitFor(() => {
      expect(
        JSON.parse(window.localStorage.getItem('zhixing.ocr.v1')).enabled,
      ).toBe(true);
    });
    await user.selectOptions(
      within(panel).getByLabelText('识别范围'),
      'all-images',
    );
    await waitFor(() => {
      expect(
        JSON.parse(window.localStorage.getItem('zhixing.ocr.v1')).scope,
      ).toBe('all-images');
    });
    // 英文默认开启：取消它，再开启日文，验证增删都落盘。
    fireEvent.click(within(panel).getByRole('checkbox', { name: '英文' }));
    await waitFor(() => {
      expect(
        JSON.parse(window.localStorage.getItem('zhixing.ocr.v1')).languages,
      ).not.toContain('en');
    });
    fireEvent.click(within(panel).getByRole('checkbox', { name: '日文' }));
    await waitFor(() => {
      expect(
        JSON.parse(window.localStorage.getItem('zhixing.ocr.v1')).languages,
      ).toEqual(expect.arrayContaining(['zh-Hans', 'ja']));
    });
    await user.click(within(panel).getByRole('radio', { name: /随附件同步/ }));
    await waitFor(() => {
      expect(
        JSON.parse(window.localStorage.getItem('zhixing.ocr.v1')).textStorage,
      ).toBe('sync');
    });

    const stored = JSON.parse(window.localStorage.getItem('zhixing.ocr.v1'));
    expect(stored).toMatchObject({
      enabled: true,
      engine: 'system-local',
      scope: 'all-images',
      textStorage: 'sync',
    });
    expect(stored.languages).toEqual(expect.arrayContaining(['zh-Hans', 'ja']));

    // 卸载重挂载：真实 localStorage 偏好回填。
    view.unmount();
    const remounted = await mountApp(world, '/settings/ocr', { install: false });
    const panelAgain = await screen.findByRole('region', { name: '图片 OCR' });
    expect(
      within(panelAgain).getByRole('checkbox', { name: /启用图片 OCR/ }),
    ).toBeChecked();
    expect(within(panelAgain).getByLabelText('识别范围')).toHaveValue(
      'all-images',
    );
    expect(
      within(panelAgain).getByRole('radio', { name: /随附件同步/ }),
    ).toBeChecked();

    // 注入真实可用的浏览能力（不是伪造识别结果）：TextDetector 返回原文。
    globalThis.TextDetector = class {
      async detect() {
        return [{ rawValue: '验收 OCR 文本', boundingBox: null }];
      }
    };
    globalThis.createImageBitmap = async () => ({ fakeBitmap: true });
    await user.click(
      within(panelAgain).getByRole('button', { name: '测试引擎可用性' }),
    );
    expect(await within(panelAgain).findByText('引擎可用')).toBeInTheDocument();

    const image = new File([new Uint8Array([1, 2, 3, 4])], '识别.png', {
      type: 'image/png',
    });
    fireEvent.change(
      within(panelAgain).getByLabelText('选择 OCR 测试图片'),
      { target: { files: [image] } },
    );
    const result = await within(panelAgain).findByLabelText('OCR 识别结果');
    expect(within(result).getByText('验收 OCR 文本')).toBeInTheDocument();
    expect(within(result).getByText(/结果会随附件同步/)).toBeInTheDocument();
    expect(consoleErrors).toEqual([]);
    expect(consoleWarns).toEqual([]);
    remounted.unmount();
  });
});

describe('P2 通知 · 应用内/浏览器/系统通道', () => {
  it('应用内测试通知真实触发 Shell toast；系统通道明确 unsupported', async () => {
    const world = createFakeWorld();
    const user = userEvent.setup();
    window.localStorage.setItem(
      'zhixing.notifications.v1',
      JSON.stringify({
        inApp: true,
        browser: false,
        system: true,
        sound: false,
        lockScreenPrivacy: true,
        quietHours: { enabled: false, start: '22:00', end: '08:00' },
        dailyDigest: { enabled: false, time: '09:00' },
      }),
    );
    const view = await mountApp(world, '/settings/notify');
    await screen.findByRole('heading', { level: 1, name: '设置' });
    const panel = document.querySelector('.zx-notify--embedded');
    expect(panel).not.toBeNull();

    const systemToggle = within(panel).getByRole('checkbox', { name: /^系统通知/ });
    expect(systemToggle).toBeDisabled();
    expect(
      within(panel).getByText(/当前壳层未接入原生通知插件/),
    ).toBeInTheDocument();

    await user.click(
      within(panel).getByRole('button', { name: '发送测试通知' }),
    );

    // 应用内通道：真实 CustomEvent → Shell NotificationRuntime → toast。
    expect(await screen.findByText('知行测试通知')).toBeInTheDocument();
    expect(
      (await screen.findAllByText(/系统：环境不支持/)).length,
    ).toBeGreaterThan(0);
    expect(consoleErrors).toEqual([]);
    view.unmount();
  });

  it('浏览器权限只在点击时请求；granted 后真实调用 Notification 构造器', async () => {
    const created = [];
    class FakeNotification {
      static permission = 'default';
      static async requestPermission() {
        FakeNotification.permission = 'granted';
        return 'granted';
      }
      constructor(title, options) {
        created.push({ title, options });
      }
    }
    globalThis.Notification = FakeNotification;
    const world = createFakeWorld();
    const user = userEvent.setup();
    const view = await mountApp(world, '/settings/notify');
    await screen.findByRole('heading', { level: 1, name: '设置' });
    const panel = document.querySelector('.zx-notify--embedded');
    expect(panel).not.toBeNull();
    expect(within(panel).getByText(/浏览器权限：未请求/)).toBeInTheDocument();

    await user.click(
      within(panel).getByRole('button', { name: '开启浏览器通知' }),
    );
    expect(
      await within(panel).findByText(/浏览器权限：已允许/),
    ).toBeInTheDocument();
    expect(
      within(panel).getByRole('checkbox', { name: /浏览器通知/ }),
    ).toBeChecked();

    await user.click(
      within(panel).getByRole('button', { name: '发送测试通知' }),
    );
    await waitFor(() => {
      expect(created.length).toBeGreaterThan(0);
    });
    expect(created[0].title).toBe('知行 · 待办提醒');
    expect(
      (await screen.findAllByText(/浏览器：已发送/)).length,
    ).toBeGreaterThan(0);
    expect(consoleErrors).toEqual([]);
    view.unmount();
  });
});
