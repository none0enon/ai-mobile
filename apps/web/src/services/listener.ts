import { audioContext, recordSession } from './audio';

/**
 * 通话时听你说话（设计文档 §11.2）：打开麦克风（回声消除、降噪、自动增益），按音量判断你什么时候开口、什么时候说完，
 * 把这一段（带上开口前约 0.4 秒）录成 16 kHz 单声道 WAV，交给"语音识别"的 API。
 * - 说话检测用能量 + 自适应底噪：安静时慢慢学底噪，比底噪响到一定倍数并持续一小会儿才算开口；
 * - 她在说话时门槛提高、要持续更久才算你开口（扬声器漏进麦克风的声音不容易误判成你在打断她）；
 * - 按住说话：hold(true) 开始、hold(false) 结束，不看音量；
 * - 音频在本机切好再上传，不用 MediaRecorder：每一段都是完整的 WAV，各家识别接口都认。
 */

export interface ListenerOptions {
  /** 灵敏度 0–100：越高越容易判定你在说话 */
  sensitivity: number;
  /** 停顿多久算说完（毫秒） */
  endSilenceMs: number;
  /** 麦克风音量 0–1（界面的声波） */
  onLevel?(level: number): void;
  /** 判定你开口了 */
  onSpeechStart?(): void;
  /** 这一段没算数（太短，像咳嗽、碰到麦克风） */
  onDiscard?(): void;
  /** 你说完了一段 */
  onUtterance?(wav: Blob, durationMs: number): void;
}

const WORKLET_NAME = 'ai-mobile-call-tap';
const WORKLET = `class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', Tap);`;
const loaded = new WeakSet<BaseAudioContext>();

const PREROLL_MS = 420;
const MAX_UTTERANCE_MS = 28_000;
const MIN_VOICED_MS = 260;

/** 把 Float32 片段降到 16 kHz、转成 16 位 PCM WAV */
export function encodeWav16k(chunks: Float32Array[], rate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const target = 16000;
  const ratio = rate / target;
  const outLen = ratio >= 1 ? Math.floor(total / ratio) : total;
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    let v: number;
    if (ratio >= 1) {
      // 简单的盒式低通 + 抽取：对语音识别足够
      const start = Math.floor(i * ratio);
      const end = Math.min(total, Math.floor((i + 1) * ratio));
      let s = 0;
      for (let j = start; j < end; j += 1) s += all[j]!;
      v = s / Math.max(1, end - start);
    } else {
      v = all[i]!;
    }
    pcm[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  const rateOut = ratio >= 1 ? target : rate;
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rateOut, true);
  view.setUint32(28, rateOut * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(bytes.buffer, 44).set(pcm);
  return new Blob([bytes], { type: 'audio/wav' });
}

export class CallListener {
  /** 她正在说话：门槛提高、要更久才算你开口 */
  herSpeaking = false;
  /** 她说话时你开口不算（不允许打断她） */
  ignoreWhileHerSpeaking = false;
  /** 静音：不听也不录 */
  muted = false;
  /** 自动判断你什么时候开口、说完；关掉时只认按住说话 */
  auto = true;
  private opts: ListenerOptions;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private ctx: AudioContext | null = null;
  private releaseSession: (() => void) | null = null;
  private rate = 48000;
  private noise = 0.004;
  private speaking = false;
  private held = false;
  private loudMs = 0;
  private quietMs = 0;
  private voicedMs = 0;
  private uttMs = 0;
  private chunks: Float32Array[] = [];
  private preroll: Float32Array[] = [];
  private prerollMs = 0;
  private lastLevelAt = 0;
  /** 每次 start / stop 加一：麦克风权限晚到时（已经挂断了）立刻关掉，不留着开着的麦克风 */
  private gen = 0;

  constructor(opts: ListenerOptions) {
    this.opts = opts;
  }

  /** 调灵敏度、停顿时长（通话中也能改） */
  configure(patch: Partial<Pick<ListenerOptions, 'sensitivity' | 'endSilenceMs'>>) {
    Object.assign(this.opts, patch);
  }

  /** AudioContext 被挂起了（浏览器要求先点一下屏幕）：点一下后调用 resume() */
  get suspended(): boolean {
    return !!this.ctx && this.ctx.state !== 'running';
  }

  get active(): boolean {
    return !!this.stream;
  }

  resume(): Promise<void> {
    return this.ctx?.resume().catch(() => undefined) ?? Promise.resolve();
  }

  /** 尽量在点击里调用（接听、拨号）：同时申请麦克风和恢复 AudioContext */
  async start(): Promise<void> {
    if (this.stream) return;
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('这个浏览器不能用麦克风：请用支持麦克风的浏览器，并通过 HTTPS 打开');
    const gen = (this.gen += 1);
    const ctx = audioContext();
    this.ctx = ctx;
    const resumed = ctx.resume().catch(() => undefined);
    this.releaseSession ??= recordSession();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      this.releaseSession?.();
      this.releaseSession = null;
      if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw new Error('麦克风权限没开：在浏览器的网站设置里允许麦克风，或者改用打字', { cause: e });
      if (e instanceof Error && e.name === 'NotFoundError') throw new Error('没有找到可用的麦克风', { cause: e });
      throw e;
    }
    if (gen !== this.gen) {
      // 等权限的时候挂断了 / 又重新开始了：这一路麦克风不要了
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    await resumed;
    if (gen !== this.gen) return;
    this.rate = ctx.sampleRate;
    this.source = ctx.createMediaStreamSource(stream);
    let node: AudioWorkletNode | ScriptProcessorNode;
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      if (!loaded.has(ctx)) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
        try {
          await ctx.audioWorklet.addModule(url);
        } finally {
          URL.revokeObjectURL(url);
        }
        loaded.add(ctx);
      }
      const w = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      w.port.onmessage = (e: MessageEvent<Float32Array>) => this.onChunk(e.data);
      node = w;
    } catch {
      // 老浏览器：退回 ScriptProcessor（已废弃但到处都能用）
      const sp = ctx.createScriptProcessor(2048, 1, 1);
      sp.onaudioprocess = (e) => this.onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
      node = sp;
    }
    // 接到一个音量为 0 的出口：有的浏览器节点不接到输出就不处理
    const sink = ctx.createGain();
    sink.gain.value = 0;
    this.source.connect(node);
    node.connect(sink).connect(ctx.destination);
    this.node = node;
    this.sink = sink;
  }

  /** 按住说话 */
  hold(on: boolean) {
    if (on === this.held) return;
    this.held = on;
    if (on) {
      if (!this.speaking) this.begin();
    } else if (this.speaking) {
      this.finish(true);
    }
  }

  /** 丢掉正在录的这一段（挂断、切到打字时） */
  reset() {
    this.speaking = false;
    this.held = false;
    this.chunks = [];
    this.preroll = [];
    this.prerollMs = 0;
    this.loudMs = 0;
    this.quietMs = 0;
    this.voicedMs = 0;
    this.uttMs = 0;
  }

  stop() {
    this.gen += 1;
    this.reset();
    if (this.node && 'port' in this.node) this.node.port.onmessage = null;
    if (this.node && 'onaudioprocess' in this.node) this.node.onaudioprocess = null;
    try {
      this.source?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {
      // 已经断开
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source = null;
    this.node = null;
    this.sink = null;
    this.releaseSession?.();
    this.releaseSession = null;
    this.opts.onLevel?.(0);
  }

  private level(rms: number) {
    const now = Date.now();
    if (now - this.lastLevelAt < 60) return;
    this.lastLevelAt = now;
    this.opts.onLevel?.(Math.min(1, rms * 9));
  }

  private onChunk(x: Float32Array) {
    if (!this.stream) return;
    const ms = (x.length / this.rate) * 1000;
    if (this.muted && !this.held) {
      if (this.speaking) this.reset();
      this.level(0);
      return;
    }
    let sum = 0;
    for (let i = 0; i < x.length; i += 1) sum += x[i]! * x[i]!;
    const rms = Math.sqrt(sum / x.length);
    this.level(rms);

    if (!this.held && !this.auto) {
      if (this.speaking) this.reset();
      return;
    }

    if (this.held) {
      if (!this.speaking) this.begin();
      this.append(x, ms);
      if (rms > this.noise * 2) this.voicedMs += ms;
      if (this.uttMs > MAX_UTTERANCE_MS) this.finish(true);
      return;
    }

    const s = Math.max(0, Math.min(100, this.opts.sensitivity)) / 100;
    let startTh = Math.max(this.noise * (4.2 - 2.6 * s), 0.012 - 0.008 * s);
    if (this.herSpeaking) startTh *= 1.8;
    const endTh = startTh * 0.55;

    if (!this.speaking) {
      this.preroll.push(x);
      this.prerollMs += ms;
      while (this.prerollMs > PREROLL_MS && this.preroll.length > 1) this.prerollMs -= ((this.preroll.shift()?.length ?? 0) / this.rate) * 1000;
      if (this.herSpeaking && this.ignoreWhileHerSpeaking) {
        this.loudMs = 0;
        return;
      }
      if (rms > startTh) {
        this.loudMs += ms;
        if (this.loudMs >= (this.herSpeaking ? 280 : 120)) this.begin();
      } else {
        this.loudMs = 0;
        // 安静时慢慢学底噪（突然变响的不算进去）
        this.noise = Math.max(0.0015, Math.min(0.05, this.noise * 0.97 + Math.min(rms, this.noise * 2.5) * 0.03));
      }
      return;
    }
    this.append(x, ms);
    if (rms > endTh) {
      this.quietMs = 0;
      this.voicedMs += ms;
    } else {
      this.quietMs += ms;
    }
    if (this.quietMs >= this.opts.endSilenceMs || this.uttMs > MAX_UTTERANCE_MS) this.finish(false);
  }

  private begin() {
    this.speaking = true;
    this.chunks = [...this.preroll];
    this.uttMs = this.prerollMs;
    this.voicedMs = this.loudMs;
    this.preroll = [];
    this.prerollMs = 0;
    this.loudMs = 0;
    this.quietMs = 0;
    this.opts.onSpeechStart?.();
  }

  private append(x: Float32Array, ms: number) {
    this.chunks.push(x);
    this.uttMs += ms;
  }

  private finish(manual: boolean) {
    const chunks = this.chunks;
    const voiced = this.voicedMs;
    const dur = this.uttMs;
    this.reset();
    if (voiced < MIN_VOICED_MS && !(manual && dur > 400)) {
      this.opts.onDiscard?.();
      return;
    }
    this.opts.onUtterance?.(encodeWav16k(chunks, this.rate), dur);
  }
}

/** 识别出来的是不是她自己刚说的话（扬声器漏进麦克风）：去掉标点后大半重合就当回声丢掉 */
export function looksLikeEcho(heard: string, herRecent: string[]): boolean {
  const norm = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, '');
  const h = norm(heard);
  if (h.length < 4) return false;
  const her = norm(herRecent.join(''));
  if (!her) return false;
  if (her.includes(h)) return true;
  // 二元组重合比例
  const grams = (s: string) => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const a = grams(h);
  const b = grams(her);
  let hit = 0;
  for (const g of a) if (b.has(g)) hit += 1;
  return a.size > 0 && hit / a.size >= 0.7;
}
