/**
 * 播放合成好的语音，边播边报"音量"驱动声波和口型。
 *
 * - 所有播放共用一个 <audio>：iPhone 上只有在用户点过屏幕后"解锁"过的元素才能在网络请求之后自动播放，
 *   所以第一次点屏幕时用一段静音解锁它（unlockAudio，在 main.ts 里挂到第一次 pointerdown）。
 * - 音量：AudioContext 已经在运行时用分析器算真实音量；否则（还没被手势激活、或不支持）按播放状态给一个起伏的值。
 *   不在 AudioContext 挂起时把声音接进去，否则会没声音。
 */

let el: HTMLAudioElement | null = null;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let unlocked = false;
let stopCurrent: (() => void) | null = null;

function element(): HTMLAudioElement | null {
  if (el || typeof Audio === 'undefined') return el;
  el = new Audio();
  el.preload = 'auto';
  return el;
}

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
  const a = element();
  if (!a || unlocked) return unlocked;
  unlocked = true;
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
  } catch {
    ctx = null;
  }
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

function connectAnalyser(a: HTMLAudioElement): AnalyserNode | null {
  if (analyser) return analyser;
  if (!ctx || ctx.state !== 'running') return null;
  try {
    const source = ctx.createMediaElementSource(a);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    return analyser;
  } catch {
    return null;
  }
}

export function stopAudio(): void {
  stopCurrent?.();
}

/** 播放一段音频，播完（或被打断、出错）时 resolve */
export function playBytes(bytes: Uint8Array<ArrayBuffer>, mime: string, opts: { onLevel?(level: number): void; signal?: AbortSignal } = {}): Promise<void> {
  stopAudio();
  const a = element();
  if (!a) return Promise.resolve();
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const node = connectAnalyser(a);
    const buf = new Uint8Array(node?.fftSize ?? 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      a.removeEventListener('ended', finish);
      a.removeEventListener('error', finish);
      opts.signal?.removeEventListener('abort', finish);
      a.pause();
      URL.revokeObjectURL(url);
      opts.onLevel?.(0);
      if (stopCurrent === finish) stopCurrent = null;
      resolve();
    };
    stopCurrent = finish;
    const tick = () => {
      if (done) return;
      let level: number;
      if (node && ctx?.state === 'running') {
        node.getByteTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) sum += ((x - 128) / 128) ** 2;
        level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      } else {
        level = a.paused ? 0 : 0.25 + Math.random() * 0.7;
      }
      opts.onLevel?.(level);
      timer = setTimeout(tick, 80);
    };
    a.addEventListener('ended', finish);
    a.addEventListener('error', finish);
    opts.signal?.addEventListener('abort', finish, { once: true });
    a.src = url;
    a.play().then(tick, finish);
  });
}
