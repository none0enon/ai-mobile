import { reactive } from 'vue';
import { audioContext, playbackSession } from './audio';

/**
 * 哄睡的白噪音：雨声、炉火、海浪、风扇（设计文档 §9.4）。
 * 全部在本机用 Web Audio 合成，不联网、不调 API、没有版权问题：
 * 第一次播放时把每种声音算成一段十几秒、首尾无缝衔接的循环（等功率交叉淡化接缝），之后按滑块调各自的音量。
 * - start() 要在点击里调用：浏览器只允许用户操作之后出声；
 * - 她说话（讲故事、低语）时白噪音自动压低一点（duck），说完回来；
 * - 定时到点 fadeOut(秒) 慢慢变小直到停；
 * - iPhone：Safari 17 起把音频会话设成"播放"，静音键打开时也听得到；PWA 锁屏后系统会暂停网页的声音（系统限制）。
 */

export const NOISE_KINDS = ['rain', 'fire', 'waves', 'fan'] as const;
export type NoiseKind = (typeof NOISE_KINDS)[number];
export type NoiseMix = Record<NoiseKind, number>;

export const NOISE_LABEL: Record<NoiseKind, { label: string; icon: string }> = {
  rain: { label: '雨声', icon: 'i-lucide-cloud-rain' },
  fire: { label: '炉火', icon: 'i-lucide-flame' },
  waves: { label: '海浪', icon: 'i-lucide-waves' },
  fan: { label: '风扇', icon: 'i-lucide-fan' },
};

/** 合成用的采样率：白噪音的能量基本在 10 kHz 以下，22.05 kHz 足够，内存和计算量只要一半 */
const RATE = 22050;
/** 每种声音循环多长（秒）：不同长度，叠在一起不会每隔几秒重复一次同样的组合 */
const LOOP_SEC: Record<NoiseKind, number> = { rain: 17, fire: 19, waves: 24, fan: 12 };
/** 接缝处交叉淡化的长度 */
const SEAM_SEC = 0.6;
/** 各自的响度微调：滑块拉满时听起来差不多响 */
const TRIM: Record<NoiseKind, number> = { rain: 1, fire: 1.15, waves: 1, fan: 0.75 };

const coef = (hz: number) => 1 - Math.exp((-2 * Math.PI * hz) / RATE);
const white = () => Math.random() * 2 - 1;

/** 粉红噪声（Paul Kellet 的近似）：比白噪声柔和，像远处的雨和风 */
function pinkNoise(): () => number {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return () => {
    const w = white();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const out = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
    return out;
  };
}

/** 棕噪声（随机游走）：低沉的轰鸣，炉火的底、风扇的风、海浪的水体 */
function brownNoise(): () => number {
  let last = 0;
  return () => {
    last = (last + 0.02 * white()) / 1.02;
    return last * 3.5;
  };
}

/** 一段短促的"嗒"：差分白噪声（高频）乘指数衰减 */
function addClick(out: Float32Array, at: number, lenSamples: number, amp: number) {
  let prev = 0;
  const tau = Math.max(1, lenSamples / 4);
  for (let k = 0; k < lenSamples && at + k < out.length; k += 1) {
    const w = white();
    out[at + k]! += (w - prev) * 0.5 * amp * Math.exp(-k / tau);
    prev = w;
  }
}

/** 一声"啵"：衰减的正弦（雨滴打在东西上、木柴爆开） */
function addPing(out: Float32Array, at: number, hz: number, lenSamples: number, amp: number) {
  const tau = Math.max(1, lenSamples / 5);
  const step = (2 * Math.PI * hz) / RATE;
  for (let k = 0; k < lenSamples && at + k < out.length; k += 1) out[at + k]! += Math.sin(k * step) * amp * Math.exp(-k / tau);
}

function rain(n: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(n);
  const pink = pinkNoise();
  const hp = coef(450);
  const lp = coef(7500);
  let low = 0;
  let smooth = 0;
  const gustPhase = Math.random() * Math.PI * 2;
  for (let i = 0; i < n; i += 1) {
    const p = pink();
    low += hp * (p - low);
    smooth += lp * (p - low - smooth);
    // 雨势有一点起伏
    out[i] = smooth * 0.75 * (1 + 0.12 * Math.sin((2 * Math.PI * i) / (RATE * 8.5) + gustPhase));
  }
  // 细密的雨点
  const small = Math.round((n / RATE) * 55);
  for (let d = 0; d < small; d += 1) {
    const amp = 0.08 + Math.random() ** 3 * 0.5;
    addClick(out, Math.floor(Math.random() * n), Math.round(RATE * (0.002 + Math.random() * 0.005)), amp);
  }
  // 偶尔一颗大的打在窗沿上
  const big = Math.round((n / RATE) * 2.5);
  for (let d = 0; d < big; d += 1) {
    addPing(out, Math.floor(Math.random() * n), 900 + Math.random() * 1300, Math.round(RATE * (0.012 + Math.random() * 0.02)), 0.05 + Math.random() * 0.12);
  }
  return out;
}

function fire(n: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(n);
  const brown = brownNoise();
  const pink = pinkNoise();
  const lpLow = coef(320);
  const hpMid = coef(700);
  const lpMid = coef(2600);
  let low = 0;
  let midLow = 0;
  let mid = 0;
  // 火苗的明暗：慢慢游走的包络
  let flicker = 0.75;
  let target = 0.75;
  for (let i = 0; i < n; i += 1) {
    if (i % 2048 === 0) target = 0.45 + Math.random() * 0.55;
    flicker += (target - flicker) * 0.0004;
    low += lpLow * (brown() - low);
    const p = pink();
    midLow += hpMid * (p - midLow);
    mid += lpMid * (p - midLow - mid);
    out[i] = low * 0.9 + mid * 0.22 * flicker;
  }
  // 噼啪声：一簇一簇的短"嗒"
  const clusters = Math.round((n / RATE) * 5);
  for (let c = 0; c < clusters; c += 1) {
    let at = Math.floor(Math.random() * n);
    const count = 1 + Math.floor(Math.random() ** 2 * 6);
    for (let k = 0; k < count; k += 1) {
      const amp = 0.15 + Math.random() ** 2 * 0.9;
      addClick(out, at, Math.round(RATE * (0.0006 + Math.random() * 0.0025)), amp);
      at += Math.round(RATE * (0.003 + Math.random() * 0.04));
    }
  }
  // 木柴爆开
  const pops = Math.round((n / RATE) * 0.6);
  for (let k = 0; k < pops; k += 1) {
    addPing(out, Math.floor(Math.random() * n), 500 + Math.random() * 1100, Math.round(RATE * (0.008 + Math.random() * 0.012)), 0.2 + Math.random() * 0.3);
  }
  return out;
}

function waves(n: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(n);
  // 每一浪的包络：涌上来（sin²），再慢慢退下去
  const env = new Float32Array(n);
  let start = 0;
  while (start < n) {
    const len = Math.round(RATE * (5.5 + Math.random() * 3.5));
    const rise = Math.round(len * (0.35 + Math.random() * 0.1));
    const peak = 0.75 + Math.random() * 0.25;
    for (let k = 0; k < len && start + k < n; k += 1) {
      const e = k < rise ? Math.sin(((k / rise) * Math.PI) / 2) ** 2 : Math.exp(-((k - rise) / (len - rise)) * 3);
      env[start + k] = Math.max(env[start + k]!, e * peak);
    }
    start += Math.round(len * (0.8 + Math.random() * 0.15));
  }
  const brown = brownNoise();
  const pink = pinkNoise();
  let body = 0;
  let foamLow = 0;
  for (let i = 0; i < n; i += 1) {
    const e = env[i]!;
    // 浪越高越亮（截止频率跟着包络走），退下去时只剩低沉的水声
    body += coef(220 + 2300 * e) * (brown() * 0.6 + pink() * 0.5 - body);
    const w = white();
    foamLow += coef(2200) * (w - foamLow);
    out[i] = body * (0.18 + 0.82 * e) + (w - foamLow) * 0.12 * e ** 3;
  }
  return out;
}

function fan(n: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(n);
  const brown = brownNoise();
  const pink = pinkNoise();
  const lpA = coef(520);
  const lpB = coef(1900);
  let a = 0;
  let b = 0;
  // 扇叶转动带来的一点点起伏（14 Hz × 12 秒 = 整数个周期，循环接缝处也对得上）
  const blade = (2 * Math.PI * 14) / RATE;
  for (let i = 0; i < n; i += 1) {
    a += lpA * (brown() - a);
    b += lpB * (pink() - b);
    out[i] = (a * 1.0 + b * 0.3) * (1 + 0.035 * Math.sin(i * blade));
  }
  return out;
}

const GENERATORS: Record<NoiseKind, (n: number) => Float32Array<ArrayBuffer>> = { rain, fire, waves, fan };

/** 算出一段能无缝循环的样本：多算 SEAM 那么长，把尾巴等功率地淡进开头 */
export function renderLoop(kind: NoiseKind): Float32Array<ArrayBuffer> {
  const n = Math.round(LOOP_SEC[kind] * RATE);
  const seam = Math.round(SEAM_SEC * RATE);
  const s = GENERATORS[kind](n + seam);
  const out = s.slice(0, n);
  for (let i = 0; i < seam; i += 1) {
    const t = (i / seam) * (Math.PI / 2);
    out[i] = s[i]! * Math.sin(t) + s[n + i]! * Math.cos(t);
  }
  // 按均方根统一响度，再防削波
  let sum = 0;
  for (const x of out) sum += x * x;
  const rms = Math.sqrt(sum / out.length) || 1;
  const k = 0.2 / rms;
  for (let i = 0; i < out.length; i += 1) out[i] = Math.max(-1, Math.min(1, out[i]! * k));
  return out;
}

/** 滑块 0–100 → 增益（按听感，前面细、后面粗） */
export function sliderGain(kind: NoiseKind, v: number): number {
  const x = Math.max(0, Math.min(100, v)) / 100;
  return x ** 1.7 * TRIM[kind];
}

interface Channel {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

class Ambience {
  /** 界面看的状态 */
  readonly state = reactive({ playing: false, loading: false, fading: false, error: '' });
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private duckNode: GainNode | null = null;
  private channels = new Map<NoiseKind, Channel>();
  private buffers = new Map<NoiseKind, AudioBuffer>();
  private mix: NoiseMix = { rain: 60, fire: 20, waves: 0, fan: 10 };
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseSession: (() => void) | null = null;

  /** 在点击里调用。重复调用没关系（已经在放时只更新音量） */
  async start(mix: NoiseMix): Promise<void> {
    this.mix = { ...mix };
    clearTimeout(this.stopTimer);
    if (this.state.playing && !this.state.fading) {
      this.setMix(mix);
      return;
    }
    this.state.error = '';
    let ctx: AudioContext;
    try {
      // 必须在任何 await 之前拿到并恢复 AudioContext：Safari 只认点击当下的调用
      ctx = audioContext();
    } catch {
      this.state.error = '这个浏览器不支持网页音频，放不了白噪音';
      return;
    }
    const resumed = ctx.resume().catch(() => undefined);
    this.releaseSession ??= playbackSession();
    this.ctx = ctx;
    this.state.loading = !this.buffers.size;
    try {
      // 让"准备中"先显示出来，再算样本（第一次大约几十到一两百毫秒）
      if (!this.buffers.size) await new Promise((r) => setTimeout(r, 16));
      for (const kind of NOISE_KINDS) {
        if (this.buffers.has(kind)) continue;
        const data = renderLoop(kind);
        const buf = ctx.createBuffer(1, data.length, RATE);
        buf.copyToChannel(data, 0);
        this.buffers.set(kind, buf);
      }
      await resumed;
      if (ctx.state !== 'running') throw new Error('浏览器没有允许出声：再点一下播放试试');
      this.stopChannels();
      const master = ctx.createGain();
      master.gain.value = 0;
      const duck = ctx.createGain();
      duck.gain.value = 1;
      // 几种声音叠满时防止爆音
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.ratio.value = 8;
      duck.connect(master).connect(limiter).connect(ctx.destination);
      for (const kind of NOISE_KINDS) {
        const src = ctx.createBufferSource();
        src.buffer = this.buffers.get(kind)!;
        src.loop = true;
        const gain = ctx.createGain();
        gain.gain.value = sliderGain(kind, this.mix[kind]);
        src.connect(gain).connect(duck);
        // 从随机位置开始：几种声音的循环不会对齐
        src.start(0, Math.random() * src.buffer.duration);
        this.channels.set(kind, { src, gain });
      }
      master.gain.setValueAtTime(0, ctx.currentTime);
      master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 1.5);
      this.master = master;
      this.duckNode = duck;
      this.state.playing = true;
      this.state.fading = false;
    } catch (e) {
      this.state.error = e instanceof Error ? e.message : String(e);
      this.stop(true);
    } finally {
      this.state.loading = false;
    }
  }

  /** 调音量（没在放时只记下来） */
  setMix(mix: NoiseMix): void {
    this.mix = { ...mix };
    const ctx = this.ctx;
    if (!ctx) return;
    for (const kind of NOISE_KINDS) {
      const ch = this.channels.get(kind);
      ch?.gain.gain.setTargetAtTime(sliderGain(kind, mix[kind]), ctx.currentTime, 0.08);
    }
  }

  /** 她说话时压低白噪音 */
  duck(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.duckNode) return;
    this.duckNode.gain.setTargetAtTime(on ? 0.45 : 1, ctx.currentTime, on ? 0.15 : 0.6);
  }

  /** 慢慢变小直到停（定时到点） */
  fadeOut(seconds: number): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.state.playing) return Promise.resolve();
    this.state.fading = true;
    const g = this.master.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(g.value, ctx.currentTime);
    g.linearRampToValueAtTime(0, ctx.currentTime + seconds);
    clearTimeout(this.stopTimer);
    return new Promise((resolve) => {
      this.stopTimer = setTimeout(() => {
        this.stop(true);
        resolve();
      }, seconds * 1000 + 50);
    });
  }

  /** 停下。immediate 为假时先用半秒淡出，免得"啪"一声 */
  stop(immediate = false): void {
    clearTimeout(this.stopTimer);
    const ctx = this.ctx;
    if (!immediate && ctx && this.master && this.state.playing) {
      const g = this.master.gain;
      g.cancelScheduledValues(ctx.currentTime);
      g.setValueAtTime(g.value, ctx.currentTime);
      g.linearRampToValueAtTime(0, ctx.currentTime + 0.5);
      this.state.fading = true;
      this.stopTimer = setTimeout(() => this.stop(true), 550);
      return;
    }
    this.stopChannels();
    this.state.playing = false;
    this.state.fading = false;
    this.releaseSession?.();
    this.releaseSession = null;
  }

  private stopChannels() {
    for (const ch of this.channels.values()) {
      try {
        ch.src.stop();
      } catch {
        // 已经停了
      }
      ch.src.disconnect();
      ch.gain.disconnect();
    }
    this.channels.clear();
    this.master?.disconnect();
    this.duckNode?.disconnect();
    this.master = null;
    this.duckNode = null;
  }
}

export const ambience = new Ambience();
