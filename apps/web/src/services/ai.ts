import {
  AiError,
  buildSidestoryMessages,
  errorText,
  fromOpenAIBody,
  illustrate,
  isAbortError,
  parseSidestory,
  samplerRequest,
  type ImagePromptInput,
  type Sidestory,
  type VoiceSpec,
} from '@app/ai';
import { getLocation, hasOwnWorld, slotAt, TIME_OF_DAY_LABEL, timeOfDay, worldOf, type Character } from '@app/shared';
import { showToast } from 'vant';
import { putAsset } from './assets';
import { playBytes, stopAudio } from './audio';
import { MissingPresetError } from './prompt';
import type {
  EmbeddingClient,
  IllustrateOutcome,
  IllustrateRequest,
  ImageClient,
  LLMCallbacks,
  LLMClient,
  LLMRequest,
  LLMResult,
  SpeakOptions,
  STTClient,
  TTSClient,
} from './types';
import { weather } from '@/mock/activity';
import { memories as demoMemories } from '@/mock/memories';
import { DEMO_SIDESTORIES, genericSidestory } from '@/mock/sidestories';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useLibraryStore } from '@/stores/library';
import { sleep } from '@/utils/id';

/**
 * 服务接口的真实实现：交给 @app/ai 的多智能体（stores/ai.ts 里的 AgentSystem）。
 * 每次调用时看这个功能能不能真的调用（API 设置里选了渠道、填了地址和 Key）；不能就用演示实现。
 */

/** 同一类失败提示 20 秒内只弹一次（通话时每句都失败也不会刷屏） */
const toasted = new Map<string, number>();
function toastOnce(kind: string, message: string) {
  const last = toasted.get(kind) ?? 0;
  if (Date.now() - last < 20_000) return;
  toasted.set(kind, Date.now());
  showToast({ message: message.slice(0, 140), duration: 3000 });
}

export class RoutedLLM implements LLMClient {
  private readonly demo: LLMClient;

  constructor(demo: LLMClient) {
    this.demo = demo;
  }

  async chat(req: LLMRequest, cb?: LLMCallbacks): Promise<LLMResult> {
    const ai = useAiStore();
    if (!ai.isLive(req.agent)) return this.demo.chat(req, cb);
    const request = req.body ? fromOpenAIBody(req.body) : { messages: req.messages };
    if (req.names) request.names = req.names;
    const r = await ai.system.chat(req.agent, request, {
      signal: req.signal,
      // 预设里关掉了流式（有的中转不支持）：发普通请求，生成完一次显示
      stream: req.body?.stream === false ? false : undefined,
      onDelta: (text, thinking) => {
        cb?.onText?.(text);
        if (thinking) cb?.onThinking?.(thinking);
      },
      onState: (s, d) => cb?.onState?.(s, d),
    });
    const tokens = (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
    return { text: r.text, thinking: r.thinking, model: r.model, connectionId: r.connectionId, fellBack: r.fellBack, latencyMs: r.latencyMs, tokens: tokens || undefined, demo: false };
  }
}

export function voiceSpec(c: Character): VoiceSpec {
  const v = c.voice;
  return { voiceId: v.voiceId, model: v.model, speed: v.speed, pitch: v.pitch, style: v.style, refText: v.refText, refLang: v.refLang, emotionMap: v.emotionMap };
}

/** 这个角色的声音能不能真的合成："语音合成"功能的 API 能用、选了音色（Fish Audio 不选也有默认音色） */
export function ttsLiveFor(c: Character | undefined): boolean {
  if (!c) return false;
  try {
    const attempt = useAiStore().system.router.attempts('tts', { model: c.voice.model })[0];
    return !!attempt && (!!c.voice.voiceId || attempt.endpoint.kind === 'fish-audio');
  } catch {
    return false;
  }
}

export class RoutedTTS implements TTSClient {
  private readonly demo: TTSClient;
  private ctrl: AbortController | null = null;

  constructor(demo: TTSClient) {
    this.demo = demo;
  }

  liveFor(c: Character | undefined): boolean {
    return ttsLiveFor(c);
  }

  async speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    this.stop();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    opts.signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
    const chars = useCharacterStore();
    const c = chars.byId(opts.characterId);
    if (!c || !this.liveFor(c)) return this.demo.speak(text, { ...opts, signal: ctrl.signal });
    try {
      const audio = await useAiStore().system.speak({
        text,
        voice: voiceSpec(c),
        speakerName: c.name,
        expression: opts.expression ?? chars.expression[c.id] ?? null,
        signal: ctrl.signal,
      });
      if (ctrl.signal.aborted) return;
      await playBytes(audio.bytes, audio.mime, { onLevel: opts.onLevel, signal: ctrl.signal });
    } catch (e) {
      if (isAbortError(e) || ctrl.signal.aborted) return;
      if (e instanceof AiError && e.code === 'empty') return;
      // 完整报错记在 API 设置的"语音合成"上（stores/ai.ts 的 lastErrors）；通话中不弹窗打断
      toastOnce('tts', `语音合成失败：${errorText(e)}\n完整报错在"我的 → API 设置 → 语音合成"`);
      // 通话还要继续：退回无声的演示（只动声波）
      await this.demo.speak(text, { ...opts, signal: ctrl.signal }).catch(() => undefined);
    } finally {
      if (this.ctrl === ctrl) this.ctrl = null;
    }
  }

  stop(): void {
    this.ctrl?.abort();
    this.ctrl = null;
    stopAudio();
    this.demo.stop();
  }
}

/** 没配置或调用失败时明确报错，不把演示台词当成用户的录音。 */
export class RoutedSTT implements STTClient {
  async transcribe(audio: Blob, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const r = await useAiStore().system.transcribe({ audio, signal: opts.signal });
    if (!r.text) throw new AiError('empty', '没有识别到说话声，请重新录音');
    return r.text;
  }
}

export class RoutedEmbedding implements EmbeddingClient {
  private readonly demo: EmbeddingClient;

  constructor(demo: EmbeddingClient) {
    this.demo = demo;
  }

  get live(): boolean {
    return useAiStore().isLive('embedding');
  }

  get model(): string {
    return this.live ? (useAiStore().routeOf('embedding').api?.model ?? '') : this.demo.model;
  }

  get dims(): number {
    return this.live ? (useAiStore().routeOf('embedding').dims ?? 0) : this.demo.dims;
  }

  async embed(texts: string[], purpose: 'document' | 'query' = 'document'): Promise<Float32Array[]> {
    if (!this.live) return this.demo.embed(texts, purpose);
    const ai = useAiStore();
    const r = await ai.system.embed(texts, { purpose });
    // 记下当前维度：换模型后据此判断哪些记忆要重算
    const route = ai.routeOf('embedding');
    if (route.dims !== r.dims) ai.saveRoute({ ...route, dims: r.dims });
    return r.vectors;
  }
}

export class RoutedImage implements ImageClient {
  get live(): boolean {
    return useAiStore().isLive('image');
  }

  async illustrate(req: IllustrateRequest, opts: { signal?: AbortSignal; onStage?(stage: 'prompt' | 'image'): void } = {}): Promise<IllustrateOutcome> {
    const c = useCharacterStore().byId(req.characterId);
    if (!c) throw new AiError('no_route', '找不到这个角色');
    const now = new Date();
    const input: ImagePromptInput = {
      character: { name: c.name, appearanceTags: c.appearanceTags, negativeTags: c.negativeTags, pronoun: c.pronoun },
      caption: req.caption,
      scene: {
        place: req.place ?? getLocation(c.locationId)?.name,
        outfit: req.outfit,
        timeOfDay: TIME_OF_DAY_LABEL[timeOfDay(now.getHours())],
        weather: weather.text,
        expression: req.expression ?? undefined,
      },
      recent: req.recent,
    };
    // 写 tags 用"生图"预设（预设页里"配图"选的那个）；一个生图预设都没有时直接用外观 tags + 画面描述
    const preset = useLibraryStore().presetForUse('image', c) ?? null;
    const r = await illustrate(useAiStore().system, input, { signal: opts.signal, onStage: opts.onStage, seed: req.seed, preset });
    const img = r.image.images[0];
    const assetKey = img?.bytes ? await putAsset(img.bytes, img.mime) : null;
    return {
      assetKey,
      url: img?.url,
      caption: r.prompt.caption,
      prompt: r.image.prompt,
      negative: r.image.negative,
      seed: r.image.seed,
      model: r.image.model,
      promptModel: r.promptBy?.model ?? null,
    };
  }
}

// —— 番外 ——

export interface SidestoryOutcome extends Sidestory {
  characterId: string;
  /** 用的是演示故事 */
  demo: boolean;
  model: string | null;
  /** 用的哪个"小剧场"预设 */
  presetName: string | null;
  at: number;
}

/** 每个角色最近写过的番外标题（只放内存，避免重复） */
const previousTitles = new Map<string, string[]>();

/**
 * 写一段她的番外：按角色卡、她的世界（作息、手头的事、三餐）、此刻在哪、记得的事和最近的聊天。
 * 番外智能体没有可用连接时给演示故事。
 */
export async function writeSidestory(characterId: string, opts: { recentChat?: string[]; userName?: string; signal?: AbortSignal } = {}): Promise<SidestoryOutcome> {
  const { recentChat = [], userName = '你', signal } = opts;
  const ai = useAiStore();
  const c = useCharacterStore().byId(characterId);
  if (!c) throw new AiError('no_route', '找不到这个角色');
  if (!ai.isLive('sidestory')) {
    await sleep(500, signal);
    return { ...(DEMO_SIDESTORIES[c.id] ?? genericSidestory(c.name)), characterId, demo: true, model: null, presetName: null, at: Date.now() };
  }
  // 番外用"小剧场"预设（预设页里"番外"选的那个）：提示词和温度、长度都按它
  const preset = useLibraryStore().presetForUse('theater', c);
  if (!preset) throw new MissingPresetError('小剧场');
  const now = new Date();
  const own = hasOwnWorld(c.id);
  const world = own ? worldOf(c.id) : null;
  const slot = world ? slotAt(world, now) : undefined;
  const place = getLocation(slot?.locationId ?? c.locationId)?.name;
  const memories = demoMemories
    .filter((m) => m.characterId === c.id && m.status === 'active')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance)
    .slice(0, 8)
    .map((m) => m.content);
  const { value, result } = await ai.system.json(
    'sidestory',
    {
      messages: buildSidestoryMessages({
        character: { name: c.name, pronoun: c.pronoun, description: c.card.description, personality: c.card.personality, scenario: c.card.scenario },
        user: { name: userName },
        now,
        world: world
          ? {
              name: world.name,
              blurb: world.blurb,
              schedule: world.schedule.map((s) => `${s.from}–${s.to} ${getLocation(s.locationId)?.name ?? s.locationId} · ${s.status}`),
              studyTask: world.life.studyTask,
              meals: `早饭${world.life.meals.breakfast}，午饭${world.life.meals.lunch}，晚饭${world.life.meals.dinner}`,
            }
          : undefined,
        current: { place, status: slot?.status ?? c.status },
        memories,
        recentChat,
        previous: previousTitles.get(c.id),
      }, preset),
      ...samplerRequest(preset.sampler),
    },
    parseSidestory,
    { signal },
  );
  previousTitles.set(c.id, [...(previousTitles.get(c.id) ?? []), value.title].slice(-8));
  return { ...value, characterId, demo: false, model: result.model, presetName: preset.name, at: Date.now() };
}
