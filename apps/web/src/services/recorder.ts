export interface VoiceRecording {
  audio: Blob;
  durationMs: number;
}

interface Session {
  cancelled: boolean;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  result?: Promise<VoiceRecording | null>;
  started: number;
  stopped?: number;
}

/** 每次按住单独持有录音；取消或离开页面后，迟到的权限授权也会立刻释放麦克风。 */
export class VoiceRecorder {
  private session: Session | null = null;

  async start(): Promise<boolean> {
    if (this.session) throw new Error('已经在录音');
    if (!globalThis.navigator?.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('当前浏览器无法录音，请使用支持麦克风的浏览器并通过 HTTPS 打开');
    }
    const s: Session = { cancelled: false, started: 0 };
    this.session = s;
    try {
      s.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (s.cancelled || this.session !== s) {
        s.stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']
        .find((mime) => MediaRecorder.isTypeSupported(mime));
      const recorder = new MediaRecorder(s.stream, mimeType ? { mimeType } : undefined);
      s.recorder = recorder;
      const chunks: Blob[] = [];
      s.result = new Promise((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (!s.cancelled && event.data.size) chunks.push(event.data);
        };
        recorder.onerror = (event) => {
          s.stream?.getTracks().forEach((track) => track.stop());
          if (s.cancelled) resolve(null);
          else reject((event as Event & { error?: Error }).error ?? new Error('录音中断，请重新录音'));
        };
        recorder.onstop = () => {
          s.stream?.getTracks().forEach((track) => track.stop());
          const audio = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || mimeType });
          chunks.length = 0;
          resolve(s.cancelled ? null : { audio, durationMs: Math.max(0, (s.stopped ?? Date.now()) - s.started) });
        };
      });
      // 录制中发生错误时先保留错误，松开时由 stop() 交给界面；避免未处理的 Promise rejection。
      void s.result.catch(() => undefined);
      recorder.start();
      s.started = Date.now();
      return true;
    } catch (e) {
      s.stream?.getTracks().forEach((track) => track.stop());
      if (this.session === s) this.session = null;
      if (s.cancelled) return false;
      if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        throw new Error('麦克风权限未开启，请在浏览器的网站设置中允许麦克风后重试', { cause: e });
      }
      if (e instanceof Error && e.name === 'NotFoundError') throw new Error('没有找到可用的麦克风', { cause: e });
      throw e;
    }
  }

  async stop(): Promise<VoiceRecording | null> {
    const s = this.session;
    if (!s) return null;
    if (!s.recorder) {
      this.cancel();
      return null;
    }
    s.stopped = Date.now();
    try {
      if (s.recorder.state !== 'inactive') s.recorder.stop();
      s.stream?.getTracks().forEach((track) => track.stop());
      return await s.result ?? null;
    } finally {
      s.stream?.getTracks().forEach((track) => track.stop());
      if (this.session === s) this.session = null;
    }
  }

  cancel(): void {
    const s = this.session;
    this.session = null;
    if (!s) return;
    s.cancelled = true;
    try {
      if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop();
    } finally {
      s.stream?.getTracks().forEach((track) => track.stop());
    }
  }
}
