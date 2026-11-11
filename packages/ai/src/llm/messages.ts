import type { ChatMessage, ChatRequest, ContentPart } from './types.ts';

/**
 * 消息格式转换。App 里拼好的提示词是 OpenAI 的写法（system / user / assistant + 可选 name），
 * Claude、Gemini 需要：开头的系统消息单独放、中途的系统消息改成 user、同一角色连续的消息合并、第一条必须是 user。
 * 名字的处理同 SillyTavern：不支持 name 字段的接口把名字写进正文，示例对话的 example_user / example_assistant 换成真名。
 */

const OPENAI_FIELDS: Record<string, keyof ChatRequest> = {
  temperature: 'temperature',
  top_p: 'topP',
  top_k: 'topK',
  max_tokens: 'maxTokens',
  frequency_penalty: 'frequencyPenalty',
  presence_penalty: 'presencePenalty',
  seed: 'seed',
  stop: 'stop',
};
const IGNORED = new Set(['model', 'messages', 'stream', 'stream_options']);

/** 预设拼出的 OpenAI 请求体（buildChatRequest）→ 统一请求。认不出的字段放进 extraBody，只发给 OpenAI 兼容接口 */
export function fromOpenAIBody(body: Record<string, unknown>): ChatRequest {
  const req: ChatRequest = { messages: [] };
  const extra: Record<string, unknown> = {};
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  req.messages = msgs.map((m) => {
    const x = m as Record<string, unknown>;
    const role = x.role === 'assistant' || x.role === 'system' ? x.role : 'user';
    const out: ChatMessage = { role, content: typeof x.content === 'string' ? x.content : String(x.content ?? '') };
    if (typeof x.name === 'string' && x.name) out.name = x.name;
    return out;
  });
  for (const [k, v] of Object.entries(body)) {
    if (IGNORED.has(k) || v === undefined || v === null) continue;
    const field = OPENAI_FIELDS[k];
    if (field) (req as unknown as Record<string, unknown>)[field] = k === 'stop' && typeof v === 'string' ? [v] : v;
    else extra[k] = v;
  }
  if (Object.keys(extra).length) req.extraBody = extra;
  return req;
}

export function textOf(content: string | ContentPart[]): string {
  return typeof content === 'string' ? content : content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

function realName(name: string, names: ChatRequest['names']): string {
  if (name === 'example_user') return names?.user || name;
  if (name === 'example_assistant') return names?.char || name;
  return name;
}

/** 名字写进正文："名字: 内容" */
function inlineName(m: ChatMessage, names: ChatRequest['names']): ChatMessage {
  if (!m.name) return m;
  const prefix = `${realName(m.name, names)}: `;
  if (typeof m.content === 'string') return { role: m.role, content: prefix + m.content };
  const parts = [...m.content];
  const first = parts.findIndex((p) => p.type === 'text');
  if (first >= 0) {
    const p = parts[first] as { type: 'text'; text: string };
    parts[first] = { type: 'text', text: prefix + p.text };
  } else {
    parts.unshift({ type: 'text', text: prefix.trimEnd() });
  }
  return { role: m.role, content: parts };
}

function isEmpty(m: ChatMessage): boolean {
  return typeof m.content === 'string' ? !m.content.trim() : m.content.every((p) => p.type === 'text' && !p.text.trim());
}

/** 新开聊天时 SillyTavern 的默认占位（第一条必须是 user 时补上） */
export const START_PLACEHOLDER = '[Start a new chat]';

export interface Normalized {
  system: string;
  turns: { role: 'user' | 'assistant'; parts: ContentPart[] }[];
}

/**
 * 开头连续的系统消息合成 system；之后的系统消息当 user；同一角色连续的合并（文字之间空一行）；
 * 第一条是 assistant 时在前面补一条占位的 user；一条对话都没有时也补一条
 */
export function normalizeTurns(messages: ChatMessage[], names?: ChatRequest['names']): Normalized {
  const named = messages.map((m) => inlineName(m, names)).filter((m) => !isEmpty(m));
  let i = 0;
  const system: string[] = [];
  while (i < named.length && named[i]?.role === 'system') {
    system.push(textOf((named[i] as ChatMessage).content));
    i += 1;
  }
  const turns: Normalized['turns'] = [];
  for (const m of named.slice(i)) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const parts: ContentPart[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    const last = turns.at(-1);
    if (last && last.role === role) {
      const tail = last.parts.at(-1);
      const head = parts[0];
      if (tail?.type === 'text' && head?.type === 'text') {
        last.parts[last.parts.length - 1] = { type: 'text', text: `${tail.text}\n\n${head.text}` };
        last.parts.push(...parts.slice(1));
      } else {
        last.parts.push(...parts);
      }
    } else {
      turns.push({ role, parts: [...parts] });
    }
  }
  if (!turns.length || turns[0]?.role !== 'user') turns.unshift({ role: 'user', parts: [{ type: 'text', text: START_PLACEHOLDER }] });
  return { system: system.join('\n\n'), turns };
}

/** Claude Messages：{ system, messages }，图片用 base64 source */
export function toClaude(messages: ChatMessage[], names?: ChatRequest['names']): { system: string; messages: Record<string, unknown>[] } {
  const n = normalizeTurns(messages, names);
  return {
    system: n.system,
    messages: n.turns.map((t) => ({
      role: t.role,
      content:
        t.parts.length === 1 && t.parts[0]?.type === 'text'
          ? t.parts[0].text
          : t.parts.map((p) =>
              p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } },
            ),
    })),
  };
}

/** Gemini：{ systemInstruction, contents }，角色是 user / model，图片用 inline_data */
export function toGemini(
  messages: ChatMessage[],
  names?: ChatRequest['names'],
): { systemInstruction?: { parts: { text: string }[] }; contents: Record<string, unknown>[] } {
  const n = normalizeTurns(messages, names);
  return {
    ...(n.system ? { systemInstruction: { parts: [{ text: n.system }] } } : {}),
    contents: n.turns.map((t) => ({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: t.parts.map((p) => (p.type === 'text' ? { text: p.text } : { inline_data: { mime_type: p.mime, data: p.data } })),
    })),
  };
}

/** OpenAI 兼容：图片用 data URL 的 image_url */
export function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  const content =
    typeof m.content === 'string'
      ? m.content
      : m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } }));
  return m.name ? { role: m.role, content, name: m.name } : { role: m.role, content };
}
