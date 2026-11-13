import { AiError, errorReport, errorText, isAbortError, prepareTtsText, splitSentences } from '@app/ai';
import { playBytes, stopAudio } from './audio';
import { ttsLiveFor, voiceSpec } from './ai';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { sleep } from '@/utils/id';

/**
 * 她连着说几句话（语音通话、哄睡讲故事、低语）：边生成边按句合成、边合成边播放（设计文档 §11.2）。
 * - SentenceStream 把流式的正文切成一句一句：句末标点后面又来了字才切，"……""！？"不会被切开；
 * - SpeechQueue 按句合成"语音合成"的 API，下一句在这一句播放时就开始合成，首句之后几乎没有停顿；
 * - stop() 立刻停：取消没合成完的、停掉正在播的；
 * - 语音合成没接通（或这个角色还没选音色）时不出声，只按字数停一会儿、报一个起伏的音量，
 *   字幕和声波照常走；界面上写明原因，不拿别的声音冒充。
 */

/** 句末：标点（可以连着几个）+ 可能跟着的右引号、右括号 */
const SENTENCE_END = /[。！？!?；;…~～\n]+[」』”"’）)]*/g;

/** 去掉标点和空白后的字数 */
function wordCount(s: string): number {
  return s.replace(/[\s\p{P}\p{S}]/gu, '').length;
}

export class SentenceStream {
  private used = 0;

  /** 给到目前为止的全文，返回新凑齐的句子 */
  feed(full: string): string[] {
    if (full.length < this.used) this.used = 0;
    const rest = full.slice(this.used);
    let cut = -1;
    for (const m of rest.matchAll(SENTENCE_END)) {
      const end = (m.index ?? 0) + m[0].length;
      // 后面还没来字：可能还有标点（"……"、"！？"、右引号）要跟上，先不切
      if (end < rest.length) cut = end;
    }
    if (cut <= 0) return [];
    const chunk = rest.slice(0, cut);
    // 太短的（"嗯。"）等下一句一起读，少一次合成
    if (wordCount(chunk) < 4) return [];
    this.used += cut;
    return splitSentences(chunk);
  }

  /** 生成结束：剩下的全部 */
  flush(full: string): string[] {
    const rest = full.slice(Math.min(this.used, full.length));
    this.used = full.length;
    return rest.trim() ? splitSentences(rest) : [];
  }
}

export interface SpeechOptions {
  characterId: string;
  /** 这一句的表情（映射成情绪）；不给用立绘当前的表情 */
  expression?: () => string | null | undefined;
  /** 在角色自己的语速上再乘（哄睡时慢一点） */
  speedFactor?: number;
  onLevel?(level: number): void;
  /** Measured playback only; remains zero during silent captions, buffering and errors. */
  onAudioLevel?(level: number): void;
  /** 开始说第 index 句（字幕跟着出） */
  onSentence?(text: string, index: number): void;
  /** 合成或播放失败（每个队列只报一次；之后的句子不出声地"说"完） */
  onError?(message: string, detail: string): void;
}

interface Item {
  text: string;
  audio: Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string } | null> | null;
}

export class SpeechQueue {
  /** 这个角色的声音能真的合成 */
  readonly live: boolean;
  /** 已经开口说了的句子（被打断时，聊天里只留这些） */
  readonly spoken: string[] = [];
  private items: Item[] = [];
  private ctrl = new AbortController();
  private playing = false;
  private ended = false;
  private reported = false;
  private index = 0;
  private waiters: (() => void)[] = [];
  private readonly opts: SpeechOptions;

  constructor(opts: SpeechOptions) {
    this.opts = opts;
    this.live = ttsLiveFor(useCharacterStore().byId(opts.characterId));
  }

  get stopped(): boolean {
    return this.ctrl.signal.aborted;
  }

  /** 还有没说完的 */
  get busy(): boolean {
    return this.playing || this.items.length > 0;
  }

  push(text: string): void {
    const t = text.trim();
    if (!t || this.stopped) return;
    this.items.push({ text: t, audio: null });
    this.prefetch();
    void this.pump();
  }

  pushAll(texts: string[]): void {
    for (const t of texts) this.push(t);
  }

  /** 不会再有新句子了：drained() 在最后一句说完时结束 */
  end(): void {
    this.ended = true;
    this.settle();
  }

  drained(): Promise<void> {
    if (this.stopped || (this.ended && !this.busy)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  stop(): void {
    if (this.stopped) return;
    this.ctrl.abort();
    this.items = [];
    stopAudio();
    this.opts.onLevel?.(0);
    this.opts.onAudioLevel?.(0);
    this.flushWaiters();
  }

  private settle() {
    if (this.ended && !this.busy) this.flushWaiters();
  }

  private flushWaiters() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private report(message: string, detail: string) {
    if (this.reported) return;
    this.reported = true;
    this.opts.onError?.(message, detail);
  }

  /** 前两句先开始合成 */
  private prefetch() {
    for (const it of this.items.slice(0, 2)) it.audio ??= this.synth(it.text);
  }

  private async synth(text: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string } | null> {
    if (!this.live || this.stopped) return null;
    const chars = useCharacterStore();
    const c = chars.byId(this.opts.characterId);
    if (!c) return null;
    const voice = voiceSpec(c);
    if (this.opts.speedFactor && this.opts.speedFactor !== 1) voice.speed = Math.max(0.5, Math.min(2, (voice.speed ?? 1) * this.opts.speedFactor));
    try {
      const r = await useAiStore().system.speak({
        text,
        voice,
        speakerName: c.name,
        expression: this.opts.expression?.() ?? chars.expression[c.id] ?? null,
        signal: this.ctrl.signal,
      });
      return { bytes: r.bytes as Uint8Array<ArrayBuffer>, mime: r.mime };
    } catch (e) {
      if (isAbortError(e) || this.stopped) return null;
      // 去掉动作描写后没字可读（整句都在括号里）：这句不出声
      if (e instanceof AiError && e.code === 'empty') return null;
      this.report(`语音合成失败：${errorText(e)}`, errorReport(e));
      return null;
    }
  }

  private async pump() {
    if (this.playing) return;
    this.playing = true;
    try {
      while (this.items.length && !this.stopped) {
        const head = this.items[0]!;
        head.audio ??= this.synth(head.text);
        const audio = await head.audio;
        if (this.stopped) break;
        this.items.shift();
        this.prefetch();
        this.spoken.push(head.text);
        this.opts.onSentence?.(head.text, this.index);
        this.index += 1;
        if (audio) {
          const r = await playBytes(audio.bytes, audio.mime, { onLevel: this.opts.onLevel, onAudioLevel: this.opts.onAudioLevel, signal: this.ctrl.signal });
          if (!r.ok && !this.stopped) {
            this.report(r.reason, r.reason);
            await this.silent(head.text);
          }
        } else {
          await this.silent(head.text);
        }
      }
    } finally {
      this.playing = false;
      this.opts.onLevel?.(0);
      this.opts.onAudioLevel?.(0);
      this.settle();
    }
  }

  /** 没有声音时按字数停一会儿，让字幕和声波照常走 */
  private async silent(text: string) {
    this.opts.onAudioLevel?.(0);
    const n = wordCount(prepareTtsText(text)) || wordCount(text);
    const total = Math.max(700, n * 190 / (this.opts.speedFactor ?? 1));
    const started = Date.now();
    try {
      while (Date.now() - started < total) {
        this.opts.onLevel?.(0.2 + Math.random() * 0.5);
        await sleep(90, this.ctrl.signal);
      }
    } catch {
      // 停了
    } finally {
      this.opts.onLevel?.(0);
    }
  }
}

/** 说一句（或几句）话，说完时结束 */
export async function speakOnce(text: string, opts: SpeechOptions): Promise<SpeechQueue> {
  const q = new SpeechQueue(opts);
  q.pushAll(splitSentences(text));
  q.end();
  await q.drained();
  return q;
}
