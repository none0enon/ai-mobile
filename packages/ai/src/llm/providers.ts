import { anthropicBase, bearerHeaders, geminiBase, joinUrl, openaiBase, transportOf, type Endpoint } from '../core/endpoint.ts';
import { httpError } from '../core/errors.ts';
import { request } from '../core/http.ts';
import { claudeModelInfo } from './claude.ts';
import { toClaude, toGemini, toOpenAIMessage } from './messages.ts';
import { dropField, sendFixing, type RequestFix } from './retry.ts';
import { readAIStream, readWhole } from './stream.ts';
import type { ChatCallbacks, ChatRequest, ChatResult } from './types.ts';

/**
 * 三家对话协议（移植自 math-reader 的 doAIRequest / doClaudeRequest / doGeminiRequest）。
 * 每个函数只负责"按这家的写法发一次请求、读出结果"；流式失败改普通请求、换备用连接在 client.ts 和智能体路由里做。
 */

export interface ProviderCall extends ChatCallbacks {
  stream: boolean;
  signal?: AbortSignal;
}

export type ChatProvider = (ep: Endpoint, req: ChatRequest, call: ProviderCall) => Promise<ChatResult>;

type Json = Record<string, any>;

/** OpenAI 兼容：…/chat/completions（各家中转、DeepSeek、硅基流动、OpenRouter、Ollama…） */
export const openaiChat: ChatProvider = async (ep, req, call) => {
  const url = joinUrl(openaiBase(ep.baseUrl), 'chat/completions');
  const body: Record<string, unknown> = {
    ...(req.extraBody ?? {}),
    model: ep.model,
    messages: req.messages.map(toOpenAIMessage),
    stream: call.stream,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.topP !== undefined) body.top_p = req.topP;
  if (req.topK) body.top_k = req.topK;
  if (req.frequencyPenalty) body.frequency_penalty = req.frequencyPenalty;
  if (req.presencePenalty) body.presence_penalty = req.presencePenalty;
  if (req.seed !== undefined && req.seed >= 0) body.seed = req.seed;
  if (req.stop?.length) body.stop = req.stop;
  if (req.json) body.response_format = { type: 'json_object' };

  // OpenAI 的推理模型不认 max_tokens，要 max_completion_tokens
  let tokenField = 'max_tokens';
  const fixes: RequestFix[] = [
    (err) => {
      if (tokenField !== 'max_tokens' || !/max_completion_tokens/i.test(err)) return false;
      tokenField = 'max_completion_tokens';
      delete body.max_tokens;
      return true;
    },
    dropField(body, 'top_k', /top_k/i),
    dropField(body, 'response_format', /response_format|json_object|json mode/i),
    dropField(body, 'seed', /\bseed\b/i),
    dropField(body, 'frequency_penalty', /frequency_penalty/i),
    dropField(body, 'presence_penalty', /presence_penalty/i),
    dropField(body, 'top_p', /top_p/i),
    dropField(body, 'temperature', /temperature/i),
    dropField(body, 'stop', /\bstop\b/i),
  ];
  const send = (maxTokens: number | undefined) => {
    if (maxTokens === undefined) delete body[tokenField];
    else body[tokenField] = maxTokens;
    return request(transportOf(ep), ep.name, url, { method: 'POST', headers: bearerHeaders(ep), body: JSON.stringify(body), signal: call.signal });
  };
  const { response, errText } = await sendFixing(`${url}|${ep.model}`, req.maxTokens, call.onState, send, fixes);
  if (!response.ok) throw httpError(ep.name, response.status, errText ?? '');
  const textOf = (d: Json) => d.choices?.[0]?.message?.content ?? null;
  const opts = { onDelta: call.onDelta, onState: call.onState, signal: call.signal, textOf };
  if (call.stream) return readAIStream(response, { ...opts, deltaOf: (e: Json) => e.choices?.[0]?.delta?.content });
  return readWhole(response, ep.name, opts);
};

/** Claude Messages：…/messages（官方或兼容 Anthropic 协议的中转） */
export const anthropicChat: ChatProvider = async (ep, req, call) => {
  const url = joinUrl(anthropicBase(ep.baseUrl), 'messages');
  const info = claudeModelInfo(ep.model);
  const { system, messages } = toClaude(req.messages, req.names);
  const body: Record<string, unknown> = { model: ep.model, messages };
  if (system) body.system = system;
  // 较新的模型带 temperature 会被拒绝（400）；Claude 的 temperature 范围是 0–1，预设里常见的 1.1 截到 1
  if (!info?.noSampling) {
    if (req.temperature !== undefined) body.temperature = Math.min(1, Math.max(0, req.temperature));
    if (req.topP !== undefined && req.topP < 1) body.top_p = req.topP;
    if (req.topK) body.top_k = req.topK;
  }
  if (req.stop?.length) body.stop_sequences = req.stop;
  if (call.stream) {
    body.stream = true;
    // 默认就会思考的模型流式时要回思考摘要（display 默认是 omitted，思考内容为空）。只决定是否返回思考内容，思考多少、计费都不变
    if (info?.thinksByDefault) body.thinking = { type: 'adaptive', display: 'summarized' };
  }
  const fixes = [
    dropField(body, 'thinking', /thinking/i),
    dropField(body, 'top_p', /top_p/i),
    dropField(body, 'top_k', /top_k/i),
    dropField(body, 'temperature', /temperature/i),
  ];
  const send = (maxTokens: number | undefined) => {
    // Claude 必须带 max_tokens
    body.max_tokens = maxTokens ?? 4096;
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
  const { response, errText } = await sendFixing(`${url}|${ep.model}`, req.maxTokens ?? 4096, call.onState, send, fixes);
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

/** 会思考的 Gemini 模型（2.5 及以后）：流式时要回思考摘要 */
const GEMINI_THINKS = /gemini-(?:2\.5|[3-9])|gemini-(?:pro|flash)(?:-lite)?-latest|thinking/i;

/**
 * 角色扮演按 SillyTavern 的默认关掉 Gemini 的安全过滤（这是你自己的 Key）。接口不认时自动去掉
 */
const GEMINI_SAFETY_OFF = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map(
  (category) => ({ category, threshold: 'BLOCK_NONE' }),
);

/** Gemini 原生：…/models/{model}:generateContent，Key 放在 URL 的 key 参数（同 math-reader） */
export const geminiChat: ChatProvider = async (ep, req, call) => {
  const base = geminiBase(ep.baseUrl);
  const model = ep.model.replace(/^models\//, '');
  const { systemInstruction, contents } = toGemini(req.messages, req.names);
  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.topP !== undefined) generationConfig.topP = req.topP;
  if (req.topK) generationConfig.topK = req.topK;
  if (req.stop?.length) generationConfig.stopSequences = req.stop;
  if (req.seed !== undefined && req.seed >= 0) generationConfig.seed = req.seed;
  if (req.presencePenalty) generationConfig.presencePenalty = req.presencePenalty;
  if (req.frequencyPenalty) generationConfig.frequencyPenalty = req.frequencyPenalty;
  if (req.json) generationConfig.responseMimeType = 'application/json';
  if (call.stream && GEMINI_THINKS.test(model)) generationConfig.thinkingConfig = { includeThoughts: true };
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
  const send = (maxTokens: number | undefined) => {
    if (maxTokens === undefined) delete generationConfig.maxOutputTokens;
    else generationConfig.maxOutputTokens = maxTokens;
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
