import { anthropicBase, bearerHeaders, geminiBase, joinUrl, openaiBase, transportOf, type Endpoint } from '../core/endpoint.ts';
import { httpError } from '../core/errors.ts';
import { request } from '../core/http.ts';
import { claudeModelInfo } from './claude.ts';
import { postProcessMessages, toClaude, toGemini, toOpenAIMessage } from './messages.ts';
import { claudeThinking, geminiHasThinkingConfig, geminiThinking, openaiReasoningEffort, thinkingAlias } from './reasoning.ts';
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

/**
 * OpenAI 兼容：…/chat/completions（各家中转、DeepSeek、硅基流动、OpenRouter、Ollama…）。
 * 发之前按连接的设置整理消息（merge / semi / strict / single），最后并入连接的额外字段、去掉要排除的字段（同 SillyTavern 的自定义来源）。
 */
export const openaiChat: ChatProvider = async (ep, req, call) => {
  const url = joinUrl(openaiBase(ep.baseUrl), 'chat/completions');
  const messages = postProcessMessages(req.messages, req.processing ?? ep.promptProcessing, req.names);
  const minimal = !!req.minimal;
  const body: Record<string, unknown> = {
    ...(minimal ? {} : (req.extraBody ?? {})),
    model: ep.model,
    messages: messages.map(toOpenAIMessage),
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
  const alias = thinkingAlias(ep.model);
  let maxTokens = req.maxTokens;
  if (alias) {
    body.temperature = 1;
    delete body.top_p;
    delete body.presence_penalty;
    delete body.frequency_penalty;
    if (maxTokens !== undefined) maxTokens = Math.max(maxTokens, alias.budget + 4096);
  }
  Object.assign(body, ep.includeBody ?? {});
  const excluded = new Set(ep.excludeBody ?? []);
  for (const k of excluded) delete body[k];

  // OpenAI 的推理模型不认 max_tokens，要 max_completion_tokens
  let tokenField = 'max_tokens';
  const fixes: RequestFix[] = [
    (err) => {
      if (tokenField !== 'max_tokens' || !/max_completion_tokens/i.test(err)) return false;
      tokenField = 'max_completion_tokens';
      delete body.max_tokens;
      return true;
    },
    dropField(body, 'reasoning_effort', /reasoning_effort|reasoning effort/i),
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
    return request(transportOf(ep), ep.name, url, { method: 'POST', headers: bearerHeaders(ep), body: JSON.stringify(body), signal: call.signal });
  };
  const { response, errText } = await sendFixing(`${url}|${ep.model}`, maxTokens, call.onState, send, fixes);
  if (!response.ok) throw httpError(ep.name, response.status, errText ?? '');
  const textOf = (d: Json) => d.choices?.[0]?.message?.content ?? null;
  const opts = { onDelta: call.onDelta, onState: call.onState, signal: call.signal, textOf };
  if (call.stream) return readAIStream(response, { ...opts, deltaOf: (e: Json) => e.choices?.[0]?.delta?.content });
  return readWhole(response, ep.name, opts);
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

/** 角色扮演按 SillyTavern 的默认关掉 Gemini 的安全过滤（这是你自己的 Key）。接口不认时自动去掉 */
const GEMINI_SAFETY_OFF = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
].map((category) => ({ category, threshold: 'OFF' }));

/** Gemini 原生：…/models/{model}:generateContent，Key 放在 URL 的 key 参数（同 math-reader、SillyTavern） */
export const geminiChat: ChatProvider = async (ep, req, call) => {
  const base = geminiBase(ep.baseUrl);
  const model = ep.model.replace(/^models\//, '');
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
    // 思考：要不要返回思考内容（默认流式时要）；推理强度换成 thinkingBudget / thinkingLevel（同 SillyTavern）
    const include = (req.includeReasoning ?? call.stream) && GEMINI_THINKS.test(model);
    const effort = geminiHasThinkingConfig(model) ? geminiThinking(model, req.maxTokens, req.reasoningEffort) : {};
    if (include || effort.thinkingBudget !== undefined || effort.thinkingLevel) {
      generationConfig.thinkingConfig = { ...(include && effort.thinkingBudget !== 0 ? { includeThoughts: true } : {}), ...effort };
    }
  }
  const body: Record<string, unknown> = { contents, generationConfig, safetySettings: GEMINI_SAFETY_OFF };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const method = call.stream ? ':streamGenerateContent?alt=sse&key=' : ':generateContent?key=';
  const url = `${base}/models/${encodeURIComponent(model)}${method}${encodeURIComponent(ep.key ?? '')}`;
  const fixes = [
    dropField(generationConfig, 'thinkingConfig', /think|thought/i),
    dropField(generationConfig, 'responseMimeType', /mime|json/i),
    dropField(generationConfig, 'topK', /top_?k/i),
    dropField(generationConfig, 'seed', /seed/i),
    dropField(generationConfig, 'presencePenalty', /presence_?penalty/i),
    dropField(generationConfig, 'frequencyPenalty', /frequency_?penalty/i),
    dropField(body, 'safetySettings', /safety|harm/i),
  ];
  const send = (max: number | undefined) => {
    if (max === undefined) delete generationConfig.maxOutputTokens;
    else generationConfig.maxOutputTokens = max;
    return request(transportOf(ep), ep.name, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(ep.headers ?? {}) },
      body: JSON.stringify(body),
      signal: call.signal,
    });
  };
  const { response, errText } = await sendFixing(`${base}|${model}`, req.maxTokens, call.onState, send, fixes);
  if (!response.ok) throw httpError(ep.name, response.status, errText ?? '');
  // 流式时每个事件也是这种结构，只含新增的一段正文。标着 thought 的片段是思考内容，不算正文
  const textOf = (d: Json) => {
    const parts = d.candidates?.[0]?.content?.parts;
    return Array.isArray(parts) && parts.length ? parts.filter((p: Json) => !p?.thought).map((p: Json) => p.text || '').join('') : null;
  };
  const opts = { onDelta: call.onDelta, onState: call.onState, signal: call.signal, textOf };
  if (call.stream) return readAIStream(response, { ...opts, deltaOf: textOf });
  return readWhole(response, ep.name, opts);
};
