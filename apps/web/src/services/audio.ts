/**
 * 播放合成好的语音，边播边报"音量"驱动声波和口型；另外管一个共用的 AudioContext（白噪音、通话时听你说话用）。
 *
 * - 所有语音共用一个 <audio>：iPhone 上只有在用户点过屏幕后"解锁"过的元素才能在网络请求之后自动播放，
 *   所以第一次点屏幕时用一段静音解锁它（unlockAudio，在 main.ts 里挂到第一次 pointerdown）。
 * - 语音只走 <audio>，不接进 AudioContext：接进去以后，AudioContext 被挂起（切后台、来电、浏览器策略）
 *   或者 iPhone 打开了静音键时，声音会整个没掉（以前通话"没声音"的一个来源）。
 *   音量改成先把这段音频解码、算出每 50 毫秒的响度，播放时按播放进度取值。
 * - play() 被浏览器拒绝时不再悄悄算作"播完了"：返回原因，界面能告诉你点一下屏幕再试。
 */

let el: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
let unlocked = false;
let stopCurrent: (() => void) | null = null;

function element(): HTMLAudioElement | null {
  if (el || typeof Audio === 'undefined') return el;
  el = new Audio();
  el.preload = 'auto';
  // iOS：内联播放，不弹全屏播放器
  el.setAttribute('playsinline', '');
  return el;
}

type AudioContextCtor = typeof AudioContext;

/** 共用的 AudioContext（白噪音、通话时的说话检测）。要在点击里调用一次 resume() 才会真的跑起来 */
export function audioContext(): AudioContext {
  if (ctx && ctx.state !== 'closed') return ctx;
  const Ctor = (globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as AudioContextCtor | undefined;
  if (!Ctor) throw new Error('这个浏览器不支持网页音频');
  ctx = new Ctor({ latencyHint: 'interactive' });
  return ctx;
}

/** 用户点屏幕时顺手恢复被挂起的 AudioContext（切后台回来、iPhone 来电之后） */
export function resumeAudioContext(): void {
  if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => undefined);
}

type SessionType = 'auto' | 'playback' | 'play-and-record' | 'ambient' | 'transient' | 'transient-solo';
interface AudioSessionLike {
  type: SessionType;
}

/**
 * iPhone（Safari 17 起的 navigator.audioSession）：网页音频默认受静音键控制，设成 playback 后静音键打开也听得到；
 * 通话时开着麦克风用 play-and-record。返回一个"用完了"的函数，恢复成原来的类型。其他浏览器什么都不做
 */
function audioSession(type: SessionType): () => void {
  const s = (navigator as Navigator & { audioSession?: AudioSessionLike }).audioSession;
  if (!s) return () => undefined;
  const before = s.type;
  try {
    s.type = type;
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      if (s.type === type) s.type = before === type ? 'auto' : before;
    } catch {
      // 忽略
    }
  };
}

export const playbackSession = () => audioSession('playback');
export const recordSession = () => audioSession('play-and-record');

/** 1 个采样的静音 WAV */
function silentWavUrl(): string {
  const bytes = new Uint8Array(46);
  const v = new DataView(bytes.buffer);
  const text = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 38, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 16000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, 2, true);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
}

/** 在用户手势里调用：解锁共享的 <audio>，顺便激活 AudioContext */
export function unlockAudio(): boolean {
  try {
    void audioContext().resume().catch(() => undefined);
  } catch {
    // 不支持网页音频：语音照样能用 <audio> 播
  }
  const a = element();
  if (!a || unlocked) return unlocked;
  unlocked = true;
  const url = silentWavUrl();
  a.muted = true;
  a.src = url;
  a.play()
    .then(() => {
      a.pause();
      a.muted = false;
      URL.revokeObjectURL(url);
    })
    .catch(() => {
      a.muted = false;
      unlocked = false;
      URL.revokeObjectURL(url);
    });
  return true;
}

/** 每 50 毫秒的响度（0–1），按这段音频里最响的地方归一 */
const ENVELOPE_STEP = 0.05;
async function envelopeOf(bytes: Uint8Array<ArrayBuffer>): Promise<Float32Array | null> {
  try {
    const Ctor = (globalThis.OfflineAudioContext ??
      (globalThis as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext) as typeof OfflineAudioContext | undefined;
    if (!Ctor) return null;
    // 只用来解码，不需要用户手势；解码会接管传进去的 ArrayBuffer，所以复制一份
    const off = new Ctor(1, 1, 22050);
    const buf = await off.decodeAudioData(bytes.slice().buffer);
    const data = buf.getChannelData(0);
    const win = Math.max(1, Math.round(buf.sampleRate * ENVELOPE_STEP));
    const out = new Float32Array(Math.ceil(data.length / win));
    let max = 0;
    for (let w = 0; w < out.length; w += 1) {
      let sum = 0;
      const end = Math.min(data.length, (w + 1) * win);
      for (let i = w * win; i < end; i += 1) sum += data[i]! * data[i]!;
      const rms = Math.sqrt(sum / Math.max(1, end - w * win));
      out[w] = rms;
      if (rms > max) max = rms;
    }
    if (max <= 0) return out;
    for (let w = 0; w < out.length; w += 1) out[w] = Math.min(1, (out[w]! / max) * 1.05);
    return out;
  } catch {
    return null;
  }
}

export function stopAudio(): void {
  stopCurrent?.();
}

export type PlayOutcome = { ok: true } | { ok: false; reason: string; blocked?: boolean };

/** 播放一段音频，播完（或被打断、出错）时 resolve；没能出声时带上原因 */
export function playBytes(
  bytes: Uint8Array<ArrayBuffer>,
  mime: string,
  opts: { onLevel?(level: number): void; onAudioLevel?(level: number): void; signal?: AbortSignal; rate?: number } = {},
): Promise<PlayOutcome> {
  stopAudio();
  const a = element();
  if (!a) return Promise.resolve({ ok: false, reason: '这个浏览器不能播放音频' });
  if (opts.signal?.aborted) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    let envelope: Float32Array | null = null;
    void envelopeOf(bytes).then((e) => (envelope = e));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let playing = false;
    const finish = (outcome: PlayOutcome = { ok: true }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.removeEventListener('ended', onEnded);
      a.removeEventListener('error', onError);
      a.removeEventListener('playing', onPlaying);
      a.removeEventListener('waiting', onSilence);
      a.removeEventListener('pause', onSilence);
      opts.signal?.removeEventListener('abort', onAbort);
      a.pause();
      URL.revokeObjectURL(url);
      opts.onLevel?.(0);
      opts.onAudioLevel?.(0);
      if (stopCurrent === onAbort) stopCurrent = null;
      resolve(outcome);
    };
    const onEnded = () => finish();
    const onAbort = () => finish();
    const onError = () => finish({ ok: false, reason: `浏览器解码不了这段音频（${mime}）` });
    const onPlaying = () => { playing = true; };
    const onSilence = () => { playing = false; opts.onAudioLevel?.(0); };
    stopCurrent = onAbort;
    const tick = () => {
      if (done) return;
      let level: number;
      if (a.paused) level = 0;
      else if (envelope?.length) level = envelope[Math.min(envelope.length - 1, Math.floor(a.currentTime / ENVELOPE_STEP))] ?? 0;
      else level = 0.25 + Math.random() * 0.6;
      opts.onLevel?.(level);
      // Only decoded, actually playing audio drives lips. No synthetic fallback.
      const measured = playing && !a.paused && !a.muted && a.volume > 0
        ? envelope?.[Math.floor(a.currentTime / ENVELOPE_STEP)] ?? 0 : 0;
      opts.onAudioLevel?.(measured > 0.035 ? measured : 0);
      timer = setTimeout(tick, 60);
    };
    a.addEventListener('ended', onEnded);
    a.addEventListener('error', onError);
    a.addEventListener('playing', onPlaying);
    a.addEventListener('waiting', onSilence);
    a.addEventListener('pause', onSilence);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    a.src = url;
    a.playbackRate = opts.rate ?? 1;
    a.play().then(tick, (e: unknown) => {
      const name = e instanceof Error ? e.name : '';
      finish(
        name === 'NotAllowedError'
          ? { ok: false, blocked: true, reason: '浏览器没允许自动出声：点一下屏幕再试' }
          : { ok: false, reason: `播放失败：${e instanceof Error ? e.message : String(e)}` },
      );
    });
  });
}
