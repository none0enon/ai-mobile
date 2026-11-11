import type { Usage } from './types.ts';

/**
 * 从流式事件 / 普通响应里取正文、思考内容、用量、结束原因。
 * 按 OpenAI 兼容接口、Claude、Gemini 的写法依次取——中转服务有时返回别家的格式，所以不只看所选协议
 * （移植自 math-reader docs/index.html 的 aiStreamDeltaText 等函数）。
 */

type Json = Record<string, any>;

/** 文字可能是字符串，也可能是 [{ type: 'text', text }] 数组（Mistral 等） */
function flatText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: Json) => (typeof c?.text === 'string' ? c.text : '')).join('');
  return '';
}

/**
 * 流式事件里新增的一段正文（不含思考内容）。OpenAI 兼容的写法同 SillyTavern 的 getStreamingReply：
 * delta.content，没有时看 message.content（有的中转流里每段都是完整 message）和 text（补全接口的写法）
 */
export function streamDeltaText(event: Json): string {
  const choice = event.choices?.[0];
  if (choice) return flatText(choice.delta?.content ?? choice.message?.content ?? choice.text);
  if (event.type === 'content_block_delta') {
    return event.delta?.type === 'text_delta' ? event.delta.text || '' : '';
  }
  const parts = event.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.filter((p: Json) => p && !p.thought).map((p: Json) => p.text || '').join('') : '';
}

/**
 * 流式事件里新增的一段思考内容：OpenAI 兼容接口的 reasoning_content（DeepSeek 等）或 reasoning（OpenRouter 等）、
 * Claude 的 thinking_delta、Gemini 标着 thought 的片段
 */
export function streamDeltaThinking(event: Json): string {
  const choice = event.choices?.[0];
  if (choice) {
    const delta = choice.delta || choice.message || {};
    // 有的中转服务两个字段发同一段内容，只取一个
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) return delta.reasoning_content;
    return typeof delta.reasoning === 'string' ? delta.reasoning : '';
  }
  if (event.type === 'content_block_delta') {
    return event.delta?.type === 'thinking_delta' ? event.delta.thinking || '' : '';
  }
  const parts = event.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.filter((p: Json) => p?.thought).map((p: Json) => p.text || '').join('') : '';
}

/** 这个事件表明模型正在思考（即使这一段没有思考内容，例如 Claude 的 thinking 块开始） */
export function eventIsThinking(event: Json): boolean {
  const delta = event.choices?.[0]?.delta ?? event.choices?.[0]?.message;
  if (delta) return !!(delta.reasoning_content || delta.reasoning);
  if (event.type === 'content_block_start') return event.content_block?.type === 'thinking';
  if (event.type === 'content_block_delta') return event.delta?.type === 'thinking_delta';
  return !!event.candidates?.[0]?.content?.parts?.some((p: Json) => p?.thought);
}

/** 普通（非流式）响应的正文全文 */
export function responseText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Json;
  const content = d.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: Json) => (typeof c?.text === 'string' ? c.text : '')).join('');
  if (Array.isArray(d.content)) return d.content.filter((x: Json) => x?.type === 'text').map((x: Json) => x.text || '').join('');
  return streamDeltaText(d);
}

/** 普通响应里的思考内容 */
export function responseThinking(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const d = data as Json;
  const message = d.choices?.[0]?.message;
  if (message) {
    if (typeof message.reasoning_content === 'string' && message.reasoning_content) return message.reasoning_content;
    return typeof message.reasoning === 'string' ? message.reasoning : '';
  }
  if (Array.isArray(d.content)) {
    return d.content
      .filter((x: Json) => x?.type === 'thinking')
      .map((x: Json) => x.thinking || '')
      .join('\n\n');
  }
  return streamDeltaThinking(d);
}

/**
 * 用量：OpenAI 的 usage（最后一段流）、Claude 的 message_start / message_delta、Gemini 的 usageMetadata。
 * 返回这个事件里出现的字段，调用方合并（Claude 的输入、输出 token 在两个事件里）
 */
export function usageOf(event: Json): Usage | null {
  const u = event.usage ?? event.message?.usage;
  if (u && typeof u === 'object') {
    const input = u.prompt_tokens ?? u.input_tokens;
    const output = u.completion_tokens ?? u.output_tokens;
    if (typeof input === 'number' || typeof output === 'number') {
      return {
        ...(typeof input === 'number' ? { inputTokens: input } : {}),
        ...(typeof output === 'number' ? { outputTokens: output } : {}),
      };
    }
  }
  const g = event.usageMetadata;
  if (g && typeof g === 'object') {
    const output = (g.candidatesTokenCount ?? 0) + (g.thoughtsTokenCount ?? 0);
    return {
      ...(typeof g.promptTokenCount === 'number' ? { inputTokens: g.promptTokenCount } : {}),
      ...(output ? { outputTokens: output } : {}),
    };
  }
  return null;
}

export function mergeUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (!b) return a;
  return { ...(a ?? {}), ...b };
}

/**
 * 结束原因：OpenAI 的 finish_reason、Claude 的 stop_reason、Gemini 的 finishReason；
 * Gemini 整个请求被拦截时没有 candidates，原因在 promptFeedback.blockReason
 */
export function finishReasonOf(event: Json): string | null {
  const r =
    event.choices?.[0]?.finish_reason ??
    event.delta?.stop_reason ??
    event.stop_reason ??
    event.candidates?.[0]?.finishReason ??
    event.promptFeedback?.blockReason;
  return typeof r === 'string' && r ? r : null;
}
