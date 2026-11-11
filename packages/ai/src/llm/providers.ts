import type { PromptProcessing } from '@app/shared';
import { anthropicBase, bearerHeaders, deepseekBase, geminiBase, isDeepSeekOfficial, isOpenAIOfficial, joinUrl, openaiBase, transportOf, type Endpoint } from '../core/endpoint.ts';
import { httpError } from '../core/errors.ts';
import { request } from '../core/http.ts';
import { claudeModelInfo } from './claude.ts';
import { postProcessMessages, toClaude, toGemini, toOpenAIMessage } from './messages.ts';
import { claudeThinking, deepseekThinking, geminiHasThinkingConfig, geminiThinking, openaiReasoningEffort, thinkingAlias } from './reasoning.ts';
import { dropField, sendFixing, type RequestFix } from './retry.ts';
import { readAIStream, readWhole } from './stream.ts';
import type { ChatCallbacks, ChatRequest, ChatResult } from './types.ts';

/**
 * 三家对话协议。底子移植自 math-reader 的 doAIRequest / doClaudeRequest / doGeminiRequest，
 * 参数规则对照 SillyTavern 的 chat-completions 后端（推理强度、Claude 采样限制和预填、Gemini 安全设置、
 * 自定义来源的消息整理和请求体增删），备用连接的"最简请求"和模型名后缀思考参考 SleepTogether 的 api-manager。
 * 每个函数只负责"按这家的写法发一次请求、读出结果"；流式失败改普通请求、换备用连接在 client.ts 和智能体路由里做。
 */

export interface ProviderCall extends ChatCallbacks {
  stream: boolean;
  signal?: AbortSignal;
}

export type ChatProvider = (ep: Endpoint, req: ChatRequest, call: ProviderCall) => Promise<ChatResult>;

type Json = Record<string, any>;

/** OpenAI 格式的一次请求里，各家不同的部分：地址、鉴权头、模型名和请求体的小改动 */
export interface OpenAIDialect {
  url: string;
  headers: Record<string, string>;
  /** 实际发送的模型名（Vertex 的开源模型要带发布方前缀；DeepSeek 停用的旧名换成新名） */
  model?: string;
  /** 请求和连接都没指定消息整理时用的方式（Vertex 的开源模型要求 user 开头、轮流发言） */
  processing?: PromptProcessing;
  /** 不按模型名后缀开思考（DeepSeek 自己有思考开关） */
  noAlias?: boolean;
  /** 输出上限的字段名：默认 max_tokens；OpenAI 官方直接用 max_completion_tokens（推理模型不认 max_tokens，省一次被拒） */
  tokenField?: 'max_tokens' | 'max_completion_tokens';
  /** 在并入连接的额外字段之前改请求体；返回 maxTokens 时改用这个输出上限 */
  tweak?: (body: Record<string, unknown>, messages: Record<string, unknown>[]) => { maxTokens?: number } | void;
}

/**
 * OpenAI 格式的对话（各家中转、DeepSeek、硅基流动、OpenRouter、Ollama、Vertex 上的开源模型…）。
 * 发之前按连接的设置整理消息（merge / semi / strict / single），最后并入连接的额外字段、去掉要排除的字段。
 */
export async function openaiCompatible(ep: Endpoint, req: ChatRequest, call: ProviderCall, d: OpenAIDialect): Promise<ChatResult> {
  const url = d.url;
  const messages = postProcessMessages(req.messages, req.processing ?? ep.promptProcessing ?? d.processing, req.names).map(toOpenAIMessage);
  const minimal = !!req.minimal;
  const body: Record<string, unknown> = {
    ...(minimal ? {} : (req.extraBody ?? {})),
    model: d.model ?? ep.model,
    messages,
    stream: call.stream,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (!minimal) {
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.topK) body.top_k = req.topK;
    if (req.frequencyPenalty) body.frequency_penalty = req.frequencyPenalty;
    if (req.presencePenalty) body.presence_penalty = req.presencePenalty;
    if (req.seed !== undefined && req.seed >= 0) body.seed = req.seed;
    if (req.stop?.length) body.stop = req.stop;
    if (req.json) body.response_format = { type: 'json_object' };
    const effort = openaiReasoningEffort(req.reasoningEffort);
    if (effort) body.reasoning_effort = effort;
  }
  // 中转用模型名后缀开思考（…-thinking-high、reasoner）：temperature 只能是 1，不能带 top_p 和惩罚项，输出上限要大过思考预算
  const alias = d.noAlias ? null : thinkingAlias(ep.model);
  let maxTokens = req.maxTokens;
  if (alias) {
    body.temperature = 1;
    delete body.top_p;
    delete body.presence_penalty;
    delete body.frequency_penalty;
    if (maxTokens !== undefined) maxTokens = Math.max(maxTokens, alias.budget + 4096);
  }
  const tweaked = d.tweak?.(body, messages as Record<string, unknown>[]);
  if (tweaked?.maxTokens !== undefined) maxTokens = tweaked.maxTokens;
  Object.assign(body, ep.includeBody ?? {});
  const excluded = new Set(ep.excludeBody ?? []);
  for (const k of excluded) delete body[k];

  // OpenAI 的推理模型不认 max_tokens，要 max_completion_tokens
  let tokenField: string = d.tokenField ?? 'max_tokens';
  const fixes: RequestFix[] = [
    (err) => {
      if (tokenField !== 'max_tokens' || !/max_completion_tokens/i.test(err)) return false;
      tokenField = 'max_completion_tokens';
      delete body.max_tokens;
      return true;
    },
    dropField(body, 'reasoning_effort', /reasoning_effort|reasoning effort/i),
    dropField(body, 'thinking', /thinking/i),
    dropField(body, 'top_k', /top_k/i),
    dropField(body, 'response_format', /response_format|json_object|json mode/i),
    dropField(body, 'seed', /\bseed\b/i),
    dropField(body, 'frequency_penalty', /frequency_penalty/i),
    dropField(body, 'presence_penalty', /presence_penalty/i),
    dropField(body, 'top_p', /top_p/i),
    dropField(body, 'temperature', /temperature/i),
    dropField(body, 'stop', /\bstop\b/i),
  ];
  const send = (max: number | undefined) => {
    if (max === undefined || excluded.has(tokenField)) delete body[tokenField];
    else body[tokenField] = max;
    return request(transportOf(ep), ep.name, url, { method: 'POST', headers: d.headers, body: JSON.stringify(body), signal: call.signal });
  };
  const { response, errText } = await sendFixing(`${url}|${String(body.model)}`, maxTokens, call.onState, send, fixes);
  if (!response.ok) throw httpError(ep.name, response.status, errText ?? '');
  const textOf = (j: Json) => j.choices?.[0]?.message?.content ?? null;
  const opts = { onDelta: call.onDelta, onState: call.onState, signal: call.signal, textOf };
  if (call.stream) return readAIStream(response, { ...opts, deltaOf: (e: Json) => e.choices?.[0]?.delta?.content });
  return readWhole(response, ep.name, opts);
}

/** OpenAI 兼容：…/chat/completions（OpenAI 官方、各家中转、Termux 等本机服务） */
export const openaiChat: ChatProvider = (ep, req, call) =>
  openaiCompatible(ep, req, call, {
    url: joinUrl(openaiBase(ep.baseUrl), 'chat/completions'),
    headers: bearerHeaders(ep),
    ...(isOpenAIOfficial(ep.baseUrl) ? { tokenField: 'max_completion_tokens' as const } : {}),
  });

/**
 * DeepSeek 官方（按官网文档，2026-11）：
 * - 地址 https://api.deepseek.com/chat/completions，模型 deepseek-flash（V4.1 Flash，能看图）/ deepseek-v4-pro；
 * - 思考模式默认开、强度 high：推理强度换成 thinking 开关和 reasoning_effort（low / high / max），"关闭"发 thinking: disabled；
 * - 思考模式下回复上限也算思考的 token（官网默认 64K），给思考留出空间，免得只有思考、没有正文；
 * - 预设的助手预填走前缀续写（Beta）：地址换成 /beta，最后一条 assistant 带 prefix: true；
 * - 旧模型名 deepseek-chat / deepseek-reasoner 已在 2026-07-24 停用：换成 deepseek-flash 的非思考 / 思考模式。
 */
export const deepseekChat: ChatProvider = (ep, req, call) => {
  const base = deepseekBase(ep.baseUrl);
  const official = isDeepSeekOfficial(base);
  const legacy = official ? (/^deepseek-chat$/i.test(ep.model) ? 'chat' : /^deepseek-reasoner$/i.test(ep.model) ? 'reasoner' : undefined) : undefined;
  const think = req.minimal ? {} : deepseekThinking(req.reasoningEffort, legacy);
  const thinkingOn = think.thinking?.type !== 'disabled';
  const prefill = official && !req.minimal ? req.prefill?.trimEnd() : undefined;
  const url = prefill ? `${new URL(base).origin}/beta/chat/completions` : joinUrl(base, 'chat/completions');
  return openaiCompatible(ep, req, call, {
    url,
    headers: bearerHeaders(ep),
    model: legacy ? 'deepseek-flash' : ep.model,
    noAlias: true,
    tweak: (body, messages) => {
      delete body.reasoning_effort;
      if (think.thinking) body.thinking = think.thinking;
      if (think.effort) body.reasoning_effort = think.effort;
      if (prefill) messages.push({ role: 'assistant', content: prefill, prefix: true });
      if (thinkingOn) return { maxTokens: Math.max(req.maxTokens ?? 0, think.effort === 'max' ? 65536 : 16384) };
    },
  });
};

/**
 * Claude Messages：…/messages（官方，或兼容 Anthropic 原生协议的中转）。
 * 中转站上的 Claude 多数只认 OpenAI 格式（不接受 x-api-key、anthropic-version 这些请求头，浏览器预检就会失败），那种选 OpenAI 兼容。
 */
export const anthropicChat: ChatProvider = async (ep, req, call) => {
  const url = joinUrl(anthropicBase(ep.baseUrl), 'messages');
  const info = claudeModelInfo(ep.model);
  const minimal = !!req.minimal;
  const requested = req.maxTokens ?? 4096;
  const think = minimal ? {} : claudeThinking(info, requested, req.reasoningEffort, call.stream, req.includeReasoning ?? call.stream);
  const { system, messages } = toClaude(req.messages, req.names, {
    prefill: minimal ? undefined : req.prefill,
    noPrefill: !!info?.noPrefill || !!think.thinking,
  });
  const body: Record<string, unknown> = { model: ep.model, messages };
  if (system) body.system = system;
  // 采样参数：较新的模型不接受（400）；传统思考开着时也不能带；有的型号 temperature 和 top_p 只能二选一。
  // Claude 的 temperature 范围是 0–1，预设里常见的 1.1 截到 1
  if (!info?.noSampling && !think.budget) {
    if (req.temperature !== undefined) body.temperature = Math.min(1, Math.max(0, req.temperature));
    if (!minimal) {
      if (req.topP !== undefined && req.topP < 1) body.top_p = req.topP;
      if (req.topK && !think.thinking) body.top_k = req.topK;
    }
    if (info?.limitedSampling) {
      if (body.top_p !== undefined) delete body.temperature;
      else delete body.top_p;
    }
  }
  if (think.thinking) body.thinking = think.thinking;
  if (think.effort) body.output_config = { effort: think.effort };
  if (!minimal && req.stop?.length) body.stop_sequences = req.stop;
  if (call.stream) body.stream = true;
  const fixes = [
    dropField(body, 'thinking', /thinking/i),
    dropField(body, 'output_config', /output_config|effort/i),
    dropField(body, 'top_p', /top_p/i),
    dropField(body, 'top_k', /top_k/i),
    dropField(body, 'temperature', /temperature/i),
  ];
  const send = (max: number | undefined) => {
    // Claude 必须带 max_tokens；传统思考要求至少比 1024 多（同 SillyTavern）
    let m = max ?? 4096;
    if (think.budget && m <= 1024) m += 1024;
    body.max_tokens = m;
    return request(transportOf(ep), ep.name, url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(ep.key ? { 'x-api-key': ep.key } : {}),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        ...(ep.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: call.signal,
    });
  };
  const { response, errText } = await sendFixing(`${url}|${ep.model}`, requested, call.onState, send, fixes);
  if (!response.ok) throw httpError(ep.name, response.status, errText ?? '');
  const textOf = (d: Json) => (Array.isArray(d.content) ? d.content.filter((x: Json) => x.type === 'text').map((x: Json) => x.text).join('') : null);
  const opts = { onDelta: call.onDelta, onState: call.onState, signal: call.signal, textOf };
  if (call.stream) {
    return readAIStream(response, {
      ...opts,
      deltaOf: (e: Json) => (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' ? e.delta.text : ''),
    });
  }
  return readWhole(response, ep.name, opts);
};

/** 会思考的 Gemini 模型（2.5 及以后）：要思考内容时请求摘要 */
const GEMINI_THINKS = /gemini-(?:2\.5|[3-9])|gemini-(?:pro|flash)(?:-lite)?-latest|thinking/i;

/** 角色扮演关掉 Gemini 的安全过滤（这是你自己的 Key）。接口不认时自动去掉 */
const GEMINI_SAFETY_OFF = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
].map((category) => ({ category, threshold: 'OFF' }));

/** Vertex 的官方文档只列了这四类（没有 CIVIC_INTEGRITY） */
export const VERTEX_SAFETY_OFF = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map(
  (category) => ({ category, threshold: 'OFF' }),
);

/** Gemini 原生协议的一次请求里，AI Studio 和 Vertex 不同的部分 */
export interface GeminiTarget {
  /** 按流式与否给出地址和鉴权头（Vertex 用服务账号时要先换访问令牌，所以是异步的） */
  target(stream: boolean): Promise<{ url: string; headers: Record<string, string> }>;
  safety: { category: string; threshold: string }[];
  /** thinkingLevel 写成大写枚举（Vertex 文档的写法） */
  upperLevel?: boolean;
  /** 记住这个地址 + 模型的输出上限用 */
  cacheKey: string;
}

/** Gemini 原生协议：contents / systemInstruction / generationConfig，AI Studio 和 Vertex 共用 */
export async function geminiGenerate(ep: Endpoint, req: ChatRequest, call: ProviderCall, model: string, t: GeminiTarget): Promise<ChatResult> {
  const minimal = !!req.minimal;
  const { systemInstruction, contents } = toGemini(req.messages, req.names);
  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (!minimal) {
    if (req.topP !== undefined) generationConfig.topP = req.topP;
    if (req.topK) generationConfig.topK = req.topK;
    if (req.stop?.length) generationConfig.stopSequences = req.stop;
    if (req.seed !== undefined && req.seed >= 0) generationConfig.seed = req.seed;
    if (req.presencePenalty) generationConfig.presencePenalty = req.presencePenalty;
    if (req.frequencyPenalty) generationConfig.frequencyPenalty = req.frequencyPenalty;
    if (req.json) generationConfig.responseMimeType = 'application/json';
    // 思考：要不要返回思考内容（默认流式时要）；推理强度换成 thinkingBudget / thinkingLevel
    const include = (req.includeReasoning ?? call.stream) && GEMINI_THINKS.test(model);
    const effort = geminiHasThinkingConfig(model) ? geminiThinking(model, req.maxTokens, req.reasoningEffort) : {};
    if (effort.thinkingLevel && t.upperLevel) effort.thinkingLevel = effort.thinkingLevel.toUpperCase();
    if (include || effort.thinkingBudget !== undefined || effort.thinkingLevel) {
      generationConfig.thinkingConfig = { ...(include && effort.thinkingBudget !== 0 ? { includeThoughts: true } : {}), ...effort };
    }
  }
  const body: Record<string, unknown> = { contents, generationConfig, safetySettings: t.safety };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const fixes = [
    dropField(generationConfig, 'thinkingConfig', /think|thought/i),
    dropField(generationConfig, 'responseMimeType', /mime|json/i),
    dropField(generationConfig, 'topK', /top_?k/i),
    dropField(generationConfig, 'seed', /seed/i),
    dropField(generationConfig, 'presencePenalty', /presence_?penalty/i),
    dropField(generationConfig, 'frequencyPenalty', /frequency_?penalty/i),
    dropField(body, 'safetySettings', /safety|harm/i),
  ];
  const send = async (max: number | undefined) => {
    if (max === undefined) delete generationConfig.maxOutputTokens;
    else generationConfig.maxOutputTokens = max;
    const { url, headers } = await t.target(call.stream);
    return request(transportOf(ep), ep.name, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers, ...(ep.headers ?? {}) },
      body: JSON.stringify(body),
      signal: call.signal,
    });
  };
  const { response, errText } = await sendFixing(t.cacheKey, req.maxTokens, call.onState, send, fixes);
  if (!response.ok) throw httpError(ep.name, response.status, errText ?? '');
  // 流式时每个事件也是这种结构，只含新增的一段正文。标着 thought 的片段是思考内容，不算正文
  const textOf = (j: Json) => {
    const parts = j.candidates?.[0]?.content?.parts;
    return Array.isArray(parts) && parts.length ? parts.filter((x: Json) => !x?.thought).map((x: Json) => x.text || '').join('') : null;
  };
  const opts = { onDelta: call.onDelta, onState: call.onState, signal: call.signal, textOf };
  if (call.stream) return readAIStream(response, { ...opts, deltaOf: textOf });
  return readWhole(response, ep.name, opts);
}

/** Gemini（AI Studio）：…/models/{model}:generateContent，Key 放在 URL 的 key 参数（同 math-reader） */
export const geminiChat: ChatProvider = (ep, req, call) => {
  const base = geminiBase(ep.baseUrl);
  const model = ep.model.replace(/^models\//, '');
  const key = encodeURIComponent(ep.key ?? '');
  return geminiGenerate(ep, req, call, model, {
    target: async (stream) => ({
      url: `${base}/models/${encodeURIComponent(model)}${stream ? `:streamGenerateContent?alt=sse&key=${key}` : `:generateContent?key=${key}`}`,
      headers: {},
    }),
    safety: GEMINI_SAFETY_OFF,
    cacheKey: `${base}|${model}`,
  });
};
