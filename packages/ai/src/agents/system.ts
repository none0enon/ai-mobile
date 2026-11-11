import { AGENT_META, estimateTokens, type AgentRole } from '@app/shared';
import { AiError, isAbortError } from '../core/errors.ts';
import { parseJsonLoose } from '../core/util.ts';
import { embedTexts, type EmbedPurpose, type EmbedResult } from '../embedding/client.ts';
import { modelFamily, vectorSpace } from '../embedding/vector.ts';
import { generateImage } from '../image/client.ts';
import { applyImageStyle } from '../image/style.ts';
import type { ImageRequest, ImageResult } from '../image/types.ts';
import { chatOnce } from '../llm/client.ts';
import { applyFilters, compileFilters, DEFAULT_OUTPUT_FILTERS } from '../llm/filter.ts';
import { textOf } from '../llm/messages.ts';
import type { ChatOptions, ChatRequest, ChatResult } from '../llm/types.ts';
import { synthesize, ttsCacheKey } from '../tts/client.ts';
import type { TtsAudio, TtsRequest } from '../tts/types.ts';
import { AgentRouter, type AgentConfig, type Attempt, type RouteStatus } from './router.ts';
import { dayKey, MemoryUsageMeter, type UsageMeter } from './usage.ts';

/**
 * 多智能体的入口（设计文档 §4）：每个智能体按自己的分配调用不同的模型。
 * - 文本：主对话、番外、生图提示词、总结、主动消息……（chat / json）
 * - 语音合成（speak）、生图（draw）、向量化（embed）
 * 统一做的事：功能设置里的参数作为默认值、每日 token 上限、失败换备用 API（备用发最简请求，参考 SleepTogether）、
 * 文本回复统一过输出修剪（SleepTogether 的全局正则）、记录用了哪个连接和模型。
 */

export interface CallMeta {
  model: string;
  /** 用的哪个 API（api:main、api:main:backup） */
  connectionId: string;
  /** "Claude"、"DeepSeek（备用）" */
  connectionName: string;
  /** 自己的 API 失败后用了备用 API */
  fellBack: boolean;
  latencyMs: number;
}

export type AgentChatResult = ChatResult & CallMeta;

export interface AudioCache {
  get(key: string): TtsAudio | null | Promise<TtsAudio | null>;
  put(key: string, audio: TtsAudio): void | Promise<void>;
}

/** 内存里的音频缓存（最近 N 句）。App 以后可以换成存在 IndexedDB 的 */
export class MemoryAudioCache implements AudioCache {
  private readonly map = new Map<string, TtsAudio>();
  private readonly limit: number;

  constructor(limit = 48) {
    this.limit = limit;
  }

  get(key: string): TtsAudio | null {
    const hit = this.map.get(key);
    if (!hit) return null;
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  put(key: string, audio: TtsAudio): void {
    this.map.set(key, audio);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as string);
  }
}

export interface AgentSystemOptions {
  config: AgentConfig;
  meter?: UsageMeter;
  audioCache?: AudioCache;
  now?: () => Date;
  /** 换备用 API 时通知（界面弹提示："主对话的 API 失败，改用备用…"） */
  onFailover?(role: AgentRole, from: Attempt, to: Attempt, error: unknown): void;
  /**
   * 每次调用的结果（取消的不算）：设置页据此显示"上次调用失败"和完整报错。
   * 成功但用了备用 API 时 fellBack 为真（自己的 API 那次失败已经通过 onFailover 报过了）
   */
  onCall?(role: AgentRole, outcome: { ok: true; fellBack: boolean } | { ok: false; error: unknown }): void;
  /** 输出修剪的规则（llm/filter.ts 的写法）；不给用默认的三条（去掉漏出来的思考内容） */
  outputFilters?: string[];
}

export interface AgentCallOptions {
  signal?: AbortSignal;
  onFailover?(from: Attempt, to: Attempt, error: unknown): void;
}

/** 分配里没写输出上限时的默认值（主对话由预设决定） */
const DEFAULT_MAX_TOKENS: Partial<Record<AgentRole, number>> = {
  sidestory: 2000,
  imagePrompt: 800,
  summary: 2000,
  proactive: 600,
  vision: 800,
};

export class AgentSystem {
  readonly router: AgentRouter;
  private readonly meter: UsageMeter;
  private readonly audioCache: AudioCache | undefined;
  private readonly now: () => Date;
  private readonly opts: AgentSystemOptions;
  /** 查询向量的缓存：同一句话检索多次不用重复算 */
  private readonly queryCache = new Map<string, Float32Array>();
  private filters: RegExp[];

  constructor(opts: AgentSystemOptions) {
    this.opts = opts;
    this.router = new AgentRouter(opts.config);
    this.meter = opts.meter ?? new MemoryUsageMeter();
    this.audioCache = opts.audioCache;
    this.now = opts.now ?? (() => new Date());
    this.filters = compileFilters(opts.outputFilters ?? DEFAULT_OUTPUT_FILTERS);
  }

  /** 换一套输出修剪规则（设置页改了之后） */
  setOutputFilters(patterns: readonly string[]): void {
    this.filters = compileFilters(patterns);
  }

  status(role: AgentRole): RouteStatus {
    return this.router.status(role);
  }

  isLive(role: AgentRole): boolean {
    return this.router.status(role).live;
  }

  usedToday(role: AgentRole): number {
    return this.meter.used(role, dayKey(this.now()));
  }

  private checkBudget(role: AgentRole, estimate: number): void {
    const budget = this.router.route(role)?.dailyTokenBudget;
    if (!budget) return;
    const used = this.usedToday(role);
    if (used + estimate > budget) {
      throw new AiError('budget', `"${AGENT_META[role].label}"今天的 token 已经用到上限（${used} / ${budget}），明天再继续，或在"API 设置"里调高上限`);
    }
  }

  private record(role: AgentRole, tokens: number): void {
    this.meter.add(role, Math.round(tokens), dayKey(this.now()));
  }

  private failover(role: AgentRole, opts: AgentCallOptions | undefined) {
    return (from: Attempt, to: Attempt, error: unknown) => {
      opts?.onFailover?.(from, to, error);
      this.opts.onFailover?.(role, from, to, error);
    };
  }

  private meta(attempt: Attempt, fellBack: boolean, started: number): CallMeta {
    return { model: attempt.endpoint.model, connectionId: attempt.endpoint.connectionId, connectionName: attempt.endpoint.name, fellBack, latencyMs: Date.now() - started };
  }

  /** 报告这次调用的结果（给 onCall），出错原样抛出 */
  private async track<T extends { fellBack: boolean }>(role: AgentRole, work: () => Promise<T>): Promise<T> {
    try {
      const r = await work();
      this.opts.onCall?.(role, { ok: true, fellBack: r.fellBack });
      return r;
    } catch (e) {
      if (!isAbortError(e)) this.opts.onCall?.(role, { ok: false, error: e });
      throw e;
    }
  }

  /**
   * 文本智能体：分配里的 temperature / maxTokens / topP / 推理强度只在请求没写时补上（主对话以预设为准）。
   * 主连接失败换备用时发最简请求（只有模型、消息、temperature、输出上限），换取兼容性；
   * 流式的每一段和最后的结果都过一遍输出修剪
   */
  async chat(role: AgentRole, req: ChatRequest, opts: ChatOptions & AgentCallOptions = {}): Promise<AgentChatResult> {
    return this.track(role, () => this.chatOnce(role, req, opts));
  }

  private async chatOnce(role: AgentRole, req: ChatRequest, opts: ChatOptions & AgentCallOptions): Promise<AgentChatResult> {
    const route = this.router.route(role);
    const p = route?.params ?? {};
    const merged: ChatRequest = {
      ...req,
      temperature: req.temperature ?? p.temperature,
      topP: req.topP ?? p.topP,
      maxTokens: req.maxTokens ?? p.maxTokens ?? DEFAULT_MAX_TOKENS[role],
      reasoningEffort: req.reasoningEffort ?? p.reasoningEffort,
      includeReasoning: req.includeReasoning ?? p.includeReasoning,
      extraBody: route?.extra ? { ...route.extra, ...(req.extraBody ?? {}) } : req.extraBody,
    };
    const inputTokens = merged.messages.reduce((n, m) => n + estimateTokens(textOf(m.content)), 0);
    this.checkBudget(role, inputTokens);
    const attempts = this.router.attempts(role);
    const started = Date.now();
    const filtered: ChatOptions = {
      ...opts,
      onDelta: opts.onDelta ? (text, thinking) => opts.onDelta?.(applyFilters(text, this.filters), thinking) : undefined,
    };
    const { value, attempt, fellBack } = await this.router.run(
      attempts,
      (ep, a) => chatOnce(ep, a.fallback ? { ...merged, minimal: true } : merged, filtered),
      this.failover(role, opts),
    );
    this.record(role, (value.usage?.inputTokens ?? inputTokens) + (value.usage?.outputTokens ?? estimateTokens(value.text + value.thinking)));
    const text = applyFilters(value.text, this.filters);
    if (!text.trim()) {
      throw new AiError('empty', `${attempt.endpoint.name} 的回复修剪后是空的（只有思考内容）`, {
        retryable: true,
        detail: value.text,
        context: { api: attempt.endpoint.name, model: attempt.endpoint.model },
      });
    }
    return { ...value, text, ...this.meta(attempt, fellBack, started) };
  }

  /**
   * 要 JSON 的文本智能体（番外、生图提示词、总结）：解析失败时把原输出和"只输出 JSON"的提醒发回去，再要一次
   */
  async json<T>(
    role: AgentRole,
    req: ChatRequest,
    parse: (value: unknown) => T | null,
    opts: AgentCallOptions & { retries?: number } = {},
  ): Promise<{ value: T; result: AgentChatResult }> {
    let messages = req.messages;
    for (let tries = 0; ; tries += 1) {
      const result = await this.chat(role, { ...req, messages, json: req.json ?? true }, { signal: opts.signal, onFailover: opts.onFailover });
      const value = parse(parseJsonLoose(result.text));
      if (value !== null) return { value, result };
      if (tries >= (opts.retries ?? 1)) {
        throw new AiError('bad_response', `"${AGENT_META[role].label}"没有按要求输出 JSON：${result.text.replace(/\s+/g, ' ').slice(0, 120)}`, { retryable: true });
      }
      messages = [
        ...req.messages,
        { role: 'assistant', content: result.text },
        { role: 'user', content: '上面的输出不是合法的 JSON，或者缺少要求的字段。请只输出一个符合要求的 JSON 对象，不要任何其他文字。' },
      ];
    }
  }

  /**
   * 语音合成：用"语音合成"功能的 API。角色可以单独填模型（音色在角色上）；音色 id 只在同一家服务商里有效，
   * 所以只会换到同一种协议的备用 API。同一句话按缓存的键复用音频。
   */
  async speak(req: TtsRequest, opts: AgentCallOptions = {}): Promise<TtsAudio & CallMeta & { cached: boolean }> {
    return this.track('tts', async () => {
      const route = this.router.route('tts');
      const all = this.router.attempts('tts', { model: req.voice.model });
      const kind = all[0]?.endpoint.kind;
      const attempts = all.filter((a, i) => i === 0 || a.endpoint.kind === kind);
      const first = attempts[0] as Attempt;
      // 朗读前怎么处理文字：请求没写就用"语音合成"的设置（只读引号里的、动作读不读……）
      const withText: TtsRequest = { ...req, textOptions: req.textOptions ?? route?.ttsText };
      const key = ttsCacheKey(first.endpoint, withText);
      const hit = await this.audioCache?.get(key);
      if (hit) return { ...hit, ...this.meta(first, false, Date.now()), cached: true };
      const started = Date.now();
      const signal = req.signal ?? opts.signal;
      const { value, attempt, fellBack } = await this.router.run(attempts, (ep) => synthesize(ep, { ...withText, signal }), this.failover('tts', opts));
      if (!fellBack) await this.audioCache?.put(key, value);
      this.record('tts', estimateTokens(value.text));
      // TTS 的模型以实际用的为准（角色可以单独填模型）
      return { ...this.meta(attempt, fellBack, started), ...value, cached: false };
    });
  }

  /**
   * 生图。先套生图风格（固定的前后缀、负面词、采样器，同 SleepTogether / SillyTavern 的生图设置），
   * 分配里的 extra 再并进请求参数
   */
  async draw(req: ImageRequest, opts: AgentCallOptions = {}): Promise<ImageResult & CallMeta> {
    return this.track('image', () => this.drawOnce(req, opts));
  }

  private async drawOnce(req: ImageRequest, opts: AgentCallOptions): Promise<ImageResult & CallMeta> {
    const route = this.router.route('image');
    const styled = applyImageStyle(req, route?.imageStyle);
    const merged: ImageRequest = { ...styled, signal: req.signal ?? opts.signal, extra: route?.extra ? { ...route.extra, ...(req.extra ?? {}) } : req.extra };
    const attempts = this.router.attempts('image');
    const started = Date.now();
    const { value, attempt, fellBack } = await this.router.run(attempts, (ep) => generateImage(ep, merged), this.failover('image', opts));
    return { ...value, ...this.meta(attempt, fellBack, started) };
  }

  /**
   * 向量化。不同模型的向量不能互相比较，所以只会换到同一个模型族的备用 API（例如硅基流动的 bge-m3 → 别家的 bge-m3）；
   * 检索时传 family，保证查询向量和已存的记忆向量在同一个空间。分配的 extra.dimensions 作为输出维度。
   */
  async embed(
    texts: string[],
    opts: AgentCallOptions & { purpose?: EmbedPurpose; family?: string } = {},
  ): Promise<EmbedResult & CallMeta & { space: string; cached: boolean }> {
    return this.track('embedding', () => this.embedOnce(texts, opts));
  }

  private async embedOnce(texts: string[], opts: AgentCallOptions & { purpose?: EmbedPurpose; family?: string }): Promise<EmbedResult & CallMeta & { space: string; cached: boolean }> {
    const route = this.router.route('embedding');
    const { dimensions, ...extra } = route?.extra ?? {};
    const all = this.router.attempts('embedding');
    const family = opts.family ?? modelFamily(all[0]?.endpoint.model ?? '');
    const attempts = all.filter((a) => modelFamily(a.endpoint.model) === family);
    if (!attempts.length) throw new AiError('unsupported', `向量化现在用的是 ${all[0]?.endpoint.model}，和已存的记忆向量（${family}）不是同一个模型，要先重算向量`);
    const purpose = opts.purpose ?? 'document';
    const cacheKey = purpose === 'query' && texts.length === 1 ? `${family}|${typeof dimensions === 'number' ? dimensions : ''}|${texts[0]}` : null;
    const hit = cacheKey ? this.queryCache.get(cacheKey) : undefined;
    if (hit) {
      const first = attempts[0] as Attempt;
      return { ...this.meta(first, false, Date.now()), vectors: [hit], dims: hit.length, usage: null, space: vectorSpace(first.endpoint.model, hit.length), cached: true };
    }
    const estimate = texts.reduce((n, t) => n + estimateTokens(t), 0);
    this.checkBudget('embedding', estimate);
    const started = Date.now();
    const { value, attempt, fellBack } = await this.router.run(
      attempts,
      (ep) => embedTexts(ep, { texts, purpose, dimensions: typeof dimensions === 'number' ? dimensions : undefined, extra, signal: opts.signal }),
      this.failover('embedding', opts),
    );
    this.record('embedding', value.usage?.inputTokens ?? estimate);
    if (cacheKey && value.vectors[0]) {
      this.queryCache.set(cacheKey, value.vectors[0]);
      if (this.queryCache.size > 200) this.queryCache.delete(this.queryCache.keys().next().value as string);
    }
    return { ...value, space: vectorSpace(value.model, value.dims), ...this.meta(attempt, fellBack, started), cached: false };
  }
}
