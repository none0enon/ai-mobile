import {
  AiError,
  DEFAULT_EMOTION_MAP,
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
import { getLocation, hasOwnWorld, imageAppearance, slotAt, TIME_OF_DAY_LABEL, timeOfDay, worldOf, type Character } from '@app/shared';
import { showToast } from 'vant';
import { putAsset } from './assets';
import { playBytes, stopAudio } from './audio';
import { MissingPresetError } from './prompt';
import type {
  EmbeddingClient,
  IllustrateOptions,
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
import { DEMO_SIDESTORIES, genericSidestory } from '@/mock/sidestories';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useLibraryStore } from '@/stores/library';
import { useMemoryStore } from '@/stores/memory';
import { useRhythmStore } from '@/stores/rhythm';
import { useWeatherStore } from '@/stores/weather';
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
  return { voiceId: v.voiceId, model: v.model, speed: v.speed, pitch: v.pitch, style: v.style, refText: v.refText, refLang: v.refLang, emotionMap: { ...portraitEmotions(c), ...v.emotionMap } };
}

/** 立绘的自定义表情（坏笑、不屑……）说话时用它挂的基础表情的情绪 */
function portraitEmotions(c: Character): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of c.portraits?.expressions ?? []) {
    const emotion = e.base === 'neutral' ? '' : c.voice.emotionMap[e.base] || DEFAULT_EMOTION_MAP[e.base];
    if (emotion) out[e.id] = emotion;
  }
  return out;
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
      const played = await playBytes(audio.bytes, audio.mime, { onLevel: opts.onLevel, signal: ctrl.signal });
      if (!played.ok) toastOnce('play', played.reason);
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

/**
 * 出图排队（设计文档 §10.6）：一次只出一张（NovelAI 同一个账号同时画两张会被拒，Opus 免费也只算一次一张）。
 * 你点的排在自动画的前面（但在别的你点的后面）
 */
interface ImageJob {
  priority: 'user' | 'auto';
  run(): Promise<void>;
}
const imageQueue: ImageJob[] = [];
let imageBusy = false;

async function pumpImages() {
  if (imageBusy) return;
  imageBusy = true;
  try {
    for (let job = imageQueue.shift(); job; job = imageQueue.shift()) await job.run();
  } finally {
    imageBusy = false;
  }
}

function enqueueImage<T>(priority: 'user' | 'auto', work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const job: ImageJob = {
      priority,
      run: async () => {
        try {
          if (signal?.aborted) throw new AiError('aborted', '取消了');
          resolve(await work());
        } catch (e) {
          reject(e);
        }
      },
    };
    const firstAuto = priority === 'user' ? imageQueue.findIndex((j) => j.priority === 'auto') : -1;
    if (firstAuto >= 0) imageQueue.splice(firstAuto, 0, job);
    else imageQueue.push(job);
    void pumpImages();
  });
}

export class RoutedImage implements ImageClient {
  get live(): boolean {
    return useAiStore().isLive('image');
  }

  /** 前面还有图在画 / 在排队 */
  get busy(): boolean {
    return imageBusy || imageQueue.length > 0;
  }

  illustrate(req: IllustrateRequest, opts: IllustrateOptions = {}): Promise<IllustrateOutcome> {
    if (this.busy) opts.onStage?.('queued');
    return enqueueImage(opts.priority ?? 'user', () => this.illustrateNow(req, opts), opts.signal);
  }

  private async illustrateNow(req: IllustrateRequest, opts: IllustrateOptions): Promise<IllustrateOutcome> {
    const c = useCharacterStore().byId(req.characterId);
    if (!c) throw new AiError('no_route', '找不到这个角色');
    const now = new Date();
    // 节律里今天这个场景该穿的那套：一起做事时锁定（同一天的图衣服一致），配图时只告诉模型；画"你"时不用她的衣服
    const outfit = req.subject || req.free ? undefined : useRhythmStore().outfitFor(c.id, req.sceneId ?? null);
    // 真实天气：画"你"、或者她在你这边真实的地方时用你那边的，否则用她那边的（她住在别的城市时是那里的）
    const weatherStore = useWeatherStore();
    const atReal = getLocation(c.locationId)?.area === 'real';
    const sky = req.subject || atReal ? weatherStore.mine : weatherStore.forCharacter(c);
    const input: ImagePromptInput = {
      mode: req.mode,
      moment: req.moment,
      // 长相：同人是角色 tag + 作品 tag（+ 补充的外观），原创是外观 tags；画"你"时按你给的
      // 自由画：不画她（名字留给预设里的 {{char}}，长相、衣服都不给）
      character: req.free
        ? { name: c.name, appearanceTags: '', outfit: null }
        : req.subject
          ? { name: req.subject.name, appearanceTags: req.subject.appearanceTags, outfit: null }
          : { name: c.name, appearanceTags: imageAppearance(c), negativeTags: c.negativeTags, pronoun: c.pronoun, outfit: outfit ?? null },
      lockOutfit: !!req.lockOutfit && !!outfit?.tags,
      ...(req.subject ? { companionName: c.name } : {}),
      ...(req.size ? { size: req.size } : {}),
      caption: req.caption,
      scene: req.free
        ? { ...(req.place ? { place: req.place } : {}) }
        : {
            place: req.place ?? getLocation(c.locationId)?.name,
            timeOfDay: TIME_OF_DAY_LABEL[timeOfDay(now.getHours())],
            ...(sky ? { weather: sky.text } : {}),
            expression: req.expression ?? undefined,
          },
      recent: req.recent,
    };
    // 写 tags 用这个用途的生图预设：配图（默认），一起做事时用这个场景的（没单独选时跟随配图）；一个生图预设都没有时直接用外观 tags + 画面描述
    const preset = useLibraryStore().presetForUse(req.use ?? 'image', c) ?? null;
    const r = await illustrate(useAiStore().system, input, { signal: opts.signal, onStage: opts.onStage, seed: req.seed, preset });
    const img = r.image.images[0];
    const assetKey = img?.bytes ? await putAsset(img.bytes, img.mime) : null;
    if (!assetKey && !img?.url) throw new AiError('empty', '生图接口返回了，但里面没有图片', { detail: JSON.stringify(r.image).slice(0, 4000) });
    return {
      assetKey,
      url: img?.url,
      caption: r.prompt.caption,
      prompt: r.image.prompt,
      negative: r.image.negative,
      seed: r.image.seed,
      model: r.image.model,
      promptModel: r.promptBy?.model ?? null,
      presetName: preset?.name ?? null,
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
  // 她记得的关于你的事：置顶的在前，再按重要度
  const memories = useMemoryStore()
    .activeOf(c.id)
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
