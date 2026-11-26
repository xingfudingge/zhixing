/**
 * 白噪音：Web Audio 实时生成，不下载音频文件、不写入任何持久化状态。
 *
 * 控制器是模块级单例，音频图独立于 React 生命周期；切到其他页面时
 * 组件卸载不会停止声音，只有用户点“关闭”或调用 `stop()` 才会静音。
 * 计时状态同样不会写 localStorage。
 */

export type NoiseType = 'white' | 'pink' | 'brown' | 'rain';

export type NoiseSnapshot = {
  type: NoiseType | 'off';
  /** 0–100；实际增益只映射到很小的范围，避免刺耳。 */
  volume: number;
  supported: boolean;
  playing: boolean;
  error: string | null;
};

export const NOISE_LABELS: Record<NoiseType | 'off', string> = {
  off: '关闭',
  white: '白噪',
  pink: '粉噪',
  brown: '棕噪',
  rain: '雨声',
};

const UNSUPPORTED_MESSAGE = '当前环境不支持白噪音';
const MAX_GAIN = 0.16;

export function gainForVolume(volume: number): number {
  const safe = Math.min(100, Math.max(0, volume));
  return (safe / 100) * MAX_GAIN;
}

export type AudioContextFactory = () => AudioContext | null;

function defaultContextFactory(): AudioContextFactory {
  return () => {
    if (typeof window === 'undefined') {
      return null;
    }
    const scoped = window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    };
    const Ctor = window.AudioContext ?? scoped.webkitAudioContext;
    if (!Ctor) {
      return null;
    }
    return new Ctor();
  };
}

type NoiseControllerOptions = {
  /** 测试注入假 AudioContext；返回 null 表示当前环境不支持。 */
  contextFactory?: AudioContextFactory;
  /** 初始音量，默认 50。 */
  volume?: number;
};

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

export class NoiseController {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => NoiseSnapshot;

  private listeners = new Set<() => void>();
  private snapshot: NoiseSnapshot;
  private contextFactory: AudioContextFactory;
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;

  constructor(options: NoiseControllerOptions = {}) {
    this.contextFactory = options.contextFactory ?? defaultContextFactory();
    const supported = this.contextFactory !== null;
    this.snapshot = {
      type: 'off',
      volume: clampVolume(options.volume ?? 50),
      supported,
      playing: false,
      error: supported ? null : UNSUPPORTED_MESSAGE,
    };
    this.subscribe = (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    };
    this.getSnapshot = () => this.snapshot;
  }

  private emit(next: Partial<NoiseSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private releaseSource(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        // 已经停止的 source 再 stop 会抛错，忽略即可。
      }
      try {
        this.source.disconnect();
      } catch {
        // 断开已断开的节点同样可以安全忽略。
      }
      this.source = null;
    }
    if (this.gain) {
      try {
        this.gain.disconnect();
      } catch {
        // 同上。
      }
      this.gain = null;
    }
  }

  /** 生成 2 秒循环噪声；不同颜色用不同滤波近似。 */
  private buildBuffer(
    context: AudioContext,
    type: NoiseType,
  ): AudioBuffer {
    const length = Math.max(1, Math.round(context.sampleRate * 2));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;

    for (let index = 0; index < length; index += 1) {
      const white = Math.random() * 2 - 1;
      if (type === 'brown') {
        last = (last + 0.02 * white) / 1.02;
        data[index] = last * 3.5;
      } else {
        data[index] = white;
      }
    }
    return buffer;
  }

  start(type: NoiseType): void {
    if (!this.contextFactory) {
      this.releaseSource();
      this.emit({
        type: 'off',
        playing: false,
        supported: false,
        error: UNSUPPORTED_MESSAGE,
      });
      return;
    }

    try {
      if (!this.context) {
        const created = this.contextFactory();
        if (!created) {
          throw new Error('missing AudioContext');
        }
        this.context = created;
      }
      const context = this.context;
      if (context.state === 'suspended') {
        void context.resume().catch(() => undefined);
      }

      this.releaseSource();

      const source = context.createBufferSource();
      source.buffer = this.buildBuffer(context, type);
      source.loop = true;

      const filter = context.createBiquadFilter();
      if (type === 'pink') {
        filter.type = 'lowpass';
        filter.frequency.value = 1000;
      } else if (type === 'brown') {
        filter.type = 'lowpass';
        filter.frequency.value = 500;
      } else if (type === 'rain') {
        filter.type = 'bandpass';
        filter.frequency.value = 1400;
        filter.Q.value = 0.7;
      } else {
        filter.type = 'allpass';
      }

      const gain = context.createGain();
      gain.gain.value = gainForVolume(this.snapshot.volume);

      source.connect(filter);
      filter.connect(gain);
      gain.connect(context.destination);
      source.start();

      this.source = source;
      this.gain = gain;
      this.emit({
        type,
        playing: true,
        supported: true,
        error: null,
      });
    } catch {
      this.releaseSource();
      this.emit({
        type: 'off',
        playing: false,
        supported: false,
        error: UNSUPPORTED_MESSAGE,
      });
    }
  }

  /** 停止并释放音频节点；停止后无声，状态回到 off。 */
  stop(): void {
    this.releaseSource();
    this.emit({ type: 'off', playing: false, error: null });
  }

  setVolume(value: number): void {
    const volume = clampVolume(value);
    if (this.gain) {
      this.gain.gain.value = gainForVolume(volume);
    }
    this.emit({ volume });
  }
}

export function createNoiseController(
  options: NoiseControllerOptions = {},
): NoiseController {
  return new NoiseController(options);
}

/** 全应用共享的音频实例：路由切换不销毁。 */
export const noiseController = createNoiseController();
