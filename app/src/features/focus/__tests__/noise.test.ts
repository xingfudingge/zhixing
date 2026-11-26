import { describe, expect, it, vi } from 'vitest';

import { createNoiseController, gainForVolume } from '../../../audio/noise';

type FakeSource = {
  buffer: AudioBuffer | null;
  loop: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

type FakeFilter = {
  type: BiquadFilterType;
  frequency: { value: number };
  Q: { value: number };
  connect: ReturnType<typeof vi.fn>;
};

type FakeGain = {
  gain: { value: number };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

function createFakeAudio() {
  const sources: FakeSource[] = [];
  const filters: FakeFilter[] = [];
  const gains: FakeGain[] = [];
  const buffer = {
    getChannelData: () => new Float32Array(16),
  } as unknown as AudioBuffer;

  const context = {
    state: 'running',
    sampleRate: 8000,
    destination: {},
    resume: vi.fn(async () => undefined),
    createBuffer: vi.fn(() => buffer),
    createBufferSource: vi.fn(() => {
      const source: FakeSource = {
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
    createBiquadFilter: vi.fn(() => {
      const filter: FakeFilter = {
        type: 'allpass',
        frequency: { value: 0 },
        Q: { value: 0 },
        connect: vi.fn(),
      };
      filters.push(filter);
      return filter;
    }),
    createGain: vi.fn(() => {
      const gain: FakeGain = {
        gain: { value: 0 },
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      gains.push(gain);
      return gain;
    }),
  } as unknown as AudioContext;

  return { context, sources, filters, gains };
}

describe('白噪音控制器', () => {
  it('雨声生成带通噪声，音量映射到小增益；停止后释放音源', () => {
    const fake = createFakeAudio();
    const noise = createNoiseController({
      contextFactory: () => fake.context,
      volume: 50,
    });

    noise.start('rain');
    expect(noise.getSnapshot()).toMatchObject({
      type: 'rain',
      playing: true,
      supported: true,
      error: null,
    });
    expect(fake.sources).toHaveLength(1);
    expect(fake.filters[0]?.type).toBe('bandpass');
    expect(fake.filters[0]?.frequency.value).toBe(1400);
    expect(fake.sources[0]?.loop).toBe(true);
    expect(fake.sources[0]?.start).toHaveBeenCalledTimes(1);
    expect(fake.gains[0]?.gain.value).toBeCloseTo(0.08);

    noise.setVolume(0);
    expect(noise.getSnapshot().volume).toBe(0);
    expect(fake.gains[0]?.gain.value).toBe(0);

    noise.stop();
    expect(fake.sources[0]?.stop).toHaveBeenCalledTimes(1);
    expect(fake.sources[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(noise.getSnapshot()).toMatchObject({
      type: 'off',
      playing: false,
      error: null,
    });
  });

  it('没有页面卸载逻辑：未被 stop 时持续播放；换类型会替换旧音源', () => {
    const fake = createFakeAudio();
    const noise = createNoiseController({
      contextFactory: () => fake.context,
    });

    noise.start('white');
    noise.start('brown');

    expect(noise.getSnapshot()).toMatchObject({
      type: 'brown',
      playing: true,
    });
    expect(fake.sources[0]?.stop).toHaveBeenCalledTimes(1);
    expect(fake.filters[1]?.type).toBe('lowpass');
    expect(fake.filters[1]?.frequency.value).toBe(500);

    // 模拟切页只是不再渲染组件；控制器仍保持播放状态。
    expect(noise.getSnapshot().playing).toBe(true);
    noise.stop();
  });

  it('粉噪使用低通、白噪使用全通；音量限制在 0–100', () => {
    const fake = createFakeAudio();
    const noise = createNoiseController({
      contextFactory: () => fake.context,
      volume: 20,
    });

    noise.start('pink');
    expect(fake.filters[0]?.type).toBe('lowpass');
    expect(fake.filters[0]?.frequency.value).toBe(1000);

    noise.start('white');
    expect(fake.filters[1]?.type).toBe('allpass');

    noise.setVolume(180);
    expect(noise.getSnapshot().volume).toBe(100);
    noise.setVolume(-10);
    expect(noise.getSnapshot().volume).toBe(0);
    expect(gainForVolume(50)).toBeCloseTo(0.08);
  });

  it('环境不支持时明确报错且不抛异常', () => {
    const unsupported = createNoiseController({
      contextFactory: () => null,
    });

    expect(() => unsupported.start('rain')).not.toThrow();
    expect(unsupported.getSnapshot()).toMatchObject({
      type: 'off',
      playing: false,
      supported: false,
      error: '当前环境不支持白噪音',
    });
  });

  it('AudioContext 构造失败也不会让页面崩溃', () => {
    const noise = createNoiseController({
      contextFactory: () => {
        throw new Error('no audio');
      },
    });
    expect(() => noise.start('rain')).not.toThrow();
    expect(noise.getSnapshot()).toMatchObject({
      type: 'off',
      playing: false,
      error: '当前环境不支持白噪音',
    });
  });
});
