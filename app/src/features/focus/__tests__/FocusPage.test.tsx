import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createNoiseController,
  type NoiseController,
} from '../../../audio/noise';
import { NO_TASK_MESSAGE } from '../../../data/repositories/focus';
import { FocusPage, NOISE_HINT_STORAGE_KEY } from '../FocusPage';
import {
  FocusRuntime,
  type FocusSource,
} from '../FocusRuntime';
import { focusMinutesBetween } from '../stats';
import {
  TEST_TODAY,
  createFakeFocusSource,
  type FakeFocusSource,
} from './fakeFocusSource';

type FakeAudio = {
  context: AudioContext;
  sources: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[];
  gains: { gain: { value: number } }[];
};

function createFakeAudio(): FakeAudio {
  const sources: FakeAudio['sources'] = [];
  const gains: { gain: { value: number } }[] = [];
  const context = {
    state: 'running',
    sampleRate: 8000,
    destination: {},
    resume: vi.fn(async () => undefined),
    createBuffer: vi.fn(() => ({
      getChannelData: () => new Float32Array(16),
    })),
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null,
        loop: false,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(source);
      return source;
    }),
    createBiquadFilter: vi.fn(() => ({
      type: 'allpass',
      frequency: { value: 0 },
      Q: { value: 0 },
      connect: vi.fn(),
    })),
    createGain: vi.fn(() => {
      const gain = {
        gain: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    }),
  } as unknown as AudioContext;
  return { context, sources, gains };
}

let runtime: FocusRuntime | null = null;
let noise: NoiseController | null = null;
let clock = 0;

afterEach(() => {
  runtime?.dispose();
  runtime = null;
  noise = null;
  window.localStorage.removeItem(NOISE_HINT_STORAGE_KEY);
});

async function setup(
  options: { source?: FakeFocusSource; supportedNoise?: boolean } = {},
) {
  clock = new Date(2026, 9, 26, 8, 0, 0).getTime();

  const source = options.source ?? createFakeFocusSource();
  const fakeAudio = createFakeAudio();
  const noiseController = createNoiseController({
    contextFactory:
      options.supportedNoise === false ? () => null : () => fakeAudio.context,
    volume: 50,
  });
  noise = noiseController;

  const activeRuntime = new FocusRuntime({
    source: source as FocusSource,
    available: true,
    today: TEST_TODAY,
    noise: noiseController,
    now: () => clock,
    // 关掉自动刷新，靠 advance()/sync() 精确推进，避免真实定时器干扰断言。
    tickMs: 60 * 60 * 1000,
  });
  runtime = activeRuntime;

  const user = userEvent.setup();
  const view = render(<FocusPage runtime={activeRuntime} />);
  await screen.findByRole('option', { name: '完成新版产品需求文档' });

  const advance = async (ms: number) => {
    await act(async () => {
      clock += ms;
      activeRuntime.sync();
    });
  };

  return {
    source,
    fakeAudio,
    runtime: activeRuntime,
    noise: noiseController,
    user,
    view,
    advance,
  };
}

function clockText(): string {
  return screen.getByTestId('focus-clock').textContent ?? '';
}

describe('专注页', () => {
  it('番茄默认 25/5/15/4，可开始、暂停、继续与重置', async () => {
    const { user, advance } = await setup();

    expect(
      screen.getByRole('heading', { level: 1, name: '专注' }),
    ).toBeInTheDocument();
    expect(clockText()).toBe('25:00');
    expect(screen.getByLabelText('专注时长')).toHaveValue('25');
    expect(screen.getByLabelText('短休时长')).toHaveValue('5');
    expect(screen.getByLabelText('长休时长')).toHaveValue('15');
    expect(screen.getByLabelText('轮数')).toHaveValue('4');
    expect(screen.getByLabelText('自动进入下一段')).toBeChecked();
    expect(screen.getByTestId('focus-phase')).toHaveTextContent(
      '专注中· 第 1 / 4 轮',
    );

    await user.click(screen.getByRole('button', { name: '开始专注' }));
    await advance(1000);
    expect(clockText()).toBe('24:59');

    await user.click(screen.getByRole('button', { name: '暂停' }));
    await advance(5000);
    expect(clockText()).toBe('24:59');

    await user.click(screen.getByRole('button', { name: '继续专注' }));
    await advance(1000);
    expect(clockText()).toBe('24:58');

    await user.click(screen.getByRole('button', { name: '重置' }));
    expect(clockText()).toBe('25:00');
    expect(
      screen.getByRole('button', { name: '开始专注' }),
    ).toBeInTheDocument();
  });

  it('完成一次 25 分钟：今日次数/分钟、本周分钟与复盘分钟同步增加', async () => {
    const { source, user, advance } = await setup();

    await user.selectOptions(
      screen.getByLabelText('关联任务'),
      'task-review',
    );
    await user.click(screen.getByRole('button', { name: '开始专注' }));
    await advance(25 * 60_000);

    await waitFor(() => {
      expect(source.snapshot().sessions).toHaveLength(1);
    });
    const sessions = source.snapshot().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      taskId: 'task-review',
      minutes: 25,
      mode: 'pomodoro',
    });
    expect(focusMinutesBetween(sessions, TEST_TODAY, TEST_TODAY)).toBe(25);

    expect(screen.getByTestId('focus-today-minutes')).toHaveTextContent(
      '25 分钟',
    );
    expect(screen.getByTestId('focus-today-count')).toHaveTextContent('1');
    expect(screen.getByTestId('focus-week-minutes')).toHaveTextContent('25');
    expect(screen.getByTestId('focus-phase')).toHaveTextContent('短休息');
    expect(clockText()).toBe('05:00');
    expect(screen.getByTestId('focus-toast')).toHaveTextContent(
      '已完成 25 分钟专注',
    );

    const recent = screen.getByLabelText('最近专注记录');
    expect(within(recent).getByText('完成新版产品需求文档')).toBeInTheDocument();
    expect(within(recent).getByText('25 分钟')).toBeInTheDocument();
  });

  it('无任务自然到点不写记录并提示；选好任务后可重试记录', async () => {
    const { source, user, advance } = await setup();

    await user.click(screen.getByRole('button', { name: '开始专注' }));
    await advance(25 * 60_000);

    await waitFor(() => {
      expect(screen.getAllByText(/先选择一个任务/).length).toBeGreaterThan(0);
    });
    expect(source.snapshot().sessions).toHaveLength(0);
    expect(screen.getByTestId('focus-phase')).toHaveTextContent('专注中');
    expect(clockText()).toBe('00:00');
    expect(screen.getByRole('alert')).toHaveTextContent(NO_TASK_MESSAGE);

    await user.selectOptions(
      screen.getByLabelText('关联任务'),
      'task-review',
    );
    await user.click(screen.getByRole('button', { name: '完成并记录' }));

    await waitFor(() => {
      expect(source.snapshot().sessions).toHaveLength(1);
    });
    expect(source.snapshot().sessions[0]).toMatchObject({
      taskId: 'task-review',
      minutes: 25,
    });
    expect(screen.getByTestId('focus-phase')).toHaveTextContent('短休息');
  });

  it('无任务点“完成并记录”被拒绝并提示，不产生假成功', async () => {
    const { source, user, advance } = await setup();

    // 未开始、未选任务：仍然明确提示选任务，而不是“已记录 0 分钟”。
    await user.click(screen.getByRole('button', { name: '完成并记录' }));
    await waitFor(() => {
      expect(screen.getByTestId('focus-toast')).toHaveTextContent(
        NO_TASK_MESSAGE,
      );
    });
    expect(source.snapshot().sessions).toHaveLength(0);
    expect(clockText()).toBe('25:00');

    await user.click(screen.getByRole('button', { name: '开始专注' }));
    await advance(60_000);
    await user.click(screen.getByRole('button', { name: '完成并记录' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(NO_TASK_MESSAGE);
    });
    expect(source.snapshot().sessions).toHaveLength(0);
    expect(clockText()).toBe('24:00');
    expect(screen.getByTestId('focus-today-minutes')).toHaveTextContent(
      '0 分钟',
    );
  });

  it('手动补记 30 分钟：先拒绝无任务，再写入并计入今日/本周', async () => {
    const { source, user } = await setup();

    await user.click(screen.getByRole('button', { name: '手动补记' }));
    await waitFor(() => {
      expect(screen.getByTestId('focus-toast')).toHaveTextContent(
        NO_TASK_MESSAGE,
      );
    });
    expect(source.snapshot().sessions).toHaveLength(0);

    await user.selectOptions(
      screen.getByLabelText('关联任务'),
      'task-review',
    );
    expect(screen.getByLabelText('补记分钟')).toHaveValue(30);
    await user.click(screen.getByRole('button', { name: '手动补记' }));

    await waitFor(() => {
      expect(source.snapshot().sessions).toHaveLength(1);
    });
    const sessions = source.snapshot().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      taskId: 'task-review',
      minutes: 30,
      mode: 'manual',
    });
    expect(screen.getByTestId('focus-today-minutes')).toHaveTextContent(
      '30 分钟',
    );
    expect(screen.getByTestId('focus-today-count')).toHaveTextContent('1');
    expect(screen.getByTestId('focus-week-minutes')).toHaveTextContent('30');
    expect(screen.getByTestId('focus-toast')).toHaveTextContent(
      '已补记 30 分钟专注',
    );

    const recent = screen.getByLabelText('最近专注记录');
    expect(within(recent).getByText('30 分钟')).toBeInTheDocument();
    expect(within(recent).getByText('补记')).toBeInTheDocument();
  });

  it('切页卸载后计时继续，到点仍会自动写入记录', async () => {
    const { source, runtime, user, view, advance } = await setup();

    await user.selectOptions(
      screen.getByLabelText('关联任务'),
      'task-review',
    );
    await user.click(screen.getByRole('button', { name: '开始专注' }));
    view.unmount();

    await advance(25 * 60_000);

    await waitFor(() => {
      expect(source.snapshot().sessions).toHaveLength(1);
    });
    expect(source.snapshot().sessions[0]?.minutes).toBe(25);

    render(<FocusPage runtime={runtime} />);
    await screen.findByRole('option', {
      name: '完成新版产品需求文档',
    });
    expect(screen.getByTestId('focus-today-minutes')).toHaveTextContent(
      '25 分钟',
    );
    expect(screen.getByTestId('focus-phase')).toHaveTextContent('短休息');
  });

  it('白噪音默认关闭，并说明用途、本地生成与类型差异', async () => {
    const { fakeAudio } = await setup();

    expect(screen.getByTestId('noise-state')).toHaveTextContent('未播放');
    expect(fakeAudio.sources).toHaveLength(0);
    expect(screen.getByTestId('noise-description')).toHaveTextContent(
      '用于屏蔽环境噪声、辅助进入专注',
    );
    expect(screen.getByTestId('noise-description')).toHaveTextContent(
      '不上传、不下载、不采集麦克风',
    );
    expect(screen.getByText('高频遮蔽')).toBeInTheDocument();
    expect(screen.getByText('低频稳定')).toBeInTheDocument();
  });

  it('白噪音说明首次显示，关闭后不再重复出现', async () => {
    window.localStorage.removeItem(NOISE_HINT_STORAGE_KEY);
    const { runtime, user, view } = await setup();

    expect(screen.getByTestId('noise-hint')).toHaveTextContent(
      '雨声偏高频遮蔽，棕噪偏低频稳定',
    );

    await user.click(
      screen.getByRole('button', { name: '关闭白噪音提示' }),
    );
    expect(screen.queryByTestId('noise-hint')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(NOISE_HINT_STORAGE_KEY)).toBe('1');

    view.unmount();
    render(<FocusPage runtime={runtime} />);
    await screen.findByRole('option', {
      name: '完成新版产品需求文档',
    });
    expect(screen.queryByTestId('noise-hint')).not.toBeInTheDocument();
  });

  it('白噪音切页继续播放，停止后音源释放且状态复位', async () => {
    const { fakeAudio, runtime, user, view } = await setup();

    await user.click(screen.getByRole('button', { name: '雨声' }));
    expect(screen.getByTestId('noise-state')).toHaveTextContent(
      '播放中 · 雨声',
    );
    expect(fakeAudio.sources).toHaveLength(1);
    expect(fakeAudio.sources[0]?.start).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('白噪音音量'), {
      target: { value: '30' },
    });
    expect(screen.getByText('30%')).toBeInTheDocument();
    expect(fakeAudio.gains[0]?.gain.value).toBeCloseTo(0.048);

    view.unmount();
    expect(noise?.getSnapshot()).toMatchObject({
      type: 'rain',
      playing: true,
    });

    render(<FocusPage runtime={runtime} />);
    await screen.findByRole('option', {
      name: '完成新版产品需求文档',
    });
    expect(screen.getByTestId('noise-state')).toHaveTextContent(
      '播放中 · 雨声',
    );

    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(fakeAudio.sources[0]?.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('noise-state')).toHaveTextContent('未播放');
    expect(noise?.getSnapshot()).toMatchObject({
      type: 'off',
      playing: false,
    });
  });

  it('不支持白噪音时明确提示，不伪造播放状态', async () => {
    const { user } = await setup({ supportedNoise: false });

    await user.click(screen.getByRole('button', { name: '雨声' }));

    expect(screen.getByTestId('noise-state')).toHaveTextContent('未播放');
    expect(screen.getByRole('alert')).toHaveTextContent(
      '当前环境不支持白噪音',
    );
  });

  it('计时与记录过程 console 零报错，也从不写 localStorage', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    try {
      const { user, advance } = await setup();
      await user.selectOptions(
        screen.getByLabelText('关联任务'),
        'task-review',
      );
      await user.click(screen.getByRole('button', { name: '开始专注' }));
      await advance(1000);
      await user.click(screen.getByRole('button', { name: '暂停' }));
      await user.click(screen.getByRole('button', { name: '重置' }));

      expect(errorSpy).not.toHaveBeenCalled();
      expect(setItemSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      setItemSpy.mockRestore();
    }
  });
});
