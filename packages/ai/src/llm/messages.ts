import type { PromptProcessing, ReasoningEffort } from '@app/shared';
import type { ChatMessage, ChatRequest, ContentPart } from './types.ts';

/**
 * 消息格式转换（对照 SillyTavern 的 prompt-converters.js）。App 里拼好的提示词是 OpenAI 的写法（system / user / assistant + 可选 name），
 * Claude、Gemini 需要：开头的系统消息单独放、中途的系统消息改成 user、同一角色连续的消息合并、第一条必须是 user。
 * 名字的处理同 SillyTavern：不支持 name 字段的接口把名字写进正文，示例对话的 example_user / example_assistant 换成真名。
 * OpenAI 兼容接口按连接的设置做 SillyTavern 的 Prompt Post-Processing（postProcessMessages）。
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
const EFFORTS = new Set<ReasoningEffort>(['auto', 'min', 'low', 'medium', 'high', 'max']);
/** SillyTavern 的 custom_prompt_post_processing 取值 → 这里的写法（带 _tools 的当成不带的） */
const ST_PROCESSING: Record<string, PromptProcessing> = {
  '': 'none',
  claude: 'merge',
  merge: 'merge',
  merge_tools: 'merge',
  semi: 'semi',
  semi_tools: 'semi',
  strict: 'strict',
  strict_tools: 'strict',
  single: 'single',
};

/**
 * 预设拼出的 OpenAI 请求体（buildChatRequest）→ 统一请求。认不出的字段放进 extraBody，只发给 OpenAI 兼容接口。
 * SillyTavern 预设里的 reasoning_effort、show_thoughts / include_reasoning、assistant_prefill、custom_prompt_post_processing
 * 转成对应的字段，由各家协议决定怎么发
 */
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
    else if (k === 'reasoning_effort') {
      if (EFFORTS.has(v as ReasoningEffort)) req.reasoningEffort = v as ReasoningEffort;
    } else if (k === 'include_reasoning' || k === 'show_thoughts') req.includeReasoning = v === true;
    else if (k === 'assistant_prefill') {
      if (typeof v === 'string' && v.trim()) req.prefill = v;
    } else if (k === 'custom_prompt_post_processing') {
      const mode = ST_PROCESSING[String(v)];
      if (mode) req.processing = mode;
    } else extra[k] = v;
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

/** 正文前加"名字: "（已经有了就不重复加，同 SillyTavern） */
function withPrefix(m: ChatMessage, name: string): ChatMessage {
  const prefix = `${name}: `;
  if (typeof m.content === 'string') return { role: m.role, content: m.content.startsWith(prefix) ? m.content : prefix + m.content };
  const parts = [...m.content];
  const first = parts.findIndex((p) => p.type === 'text');
  if (first >= 0) {
    const p = parts[first] as { type: 'text'; text: string };
    if (!p.text.startsWith(prefix)) parts[first] = { type: 'text', text: prefix + p.text };
  } else {
    parts.unshift({ type: 'text', text: prefix.trimEnd() });
  }
  return { role: m.role, content: parts };
}

/** 名字写进正文："名字: 内容"，示例对话用真名 */
function inlineName(m: ChatMessage, names: ChatRequest['names']): ChatMessage {
  if (!m.name) return m;
  return withPrefix(m, realName(m.name, names));
}

function isEmpty(m: ChatMessage): boolean {
  return typeof m.content === 'string' ? !m.content.trim() : m.content.every((p) => p.type === 'text' && !p.text.trim());
}

/** 第一条必须是 user、或者一条对话都没有时补的占位（SillyTavern 的 promptPlaceholder 默认值） */
export const START_PLACEHOLDER = "Let's get started.";

/** 同一角色连续的消息合并：文字之间空一行，图片保留 */
function squash(list: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of list) {
    const last = out.at(-1);
    if (!last || last.role !== m.role) {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (typeof last.content === 'string' && typeof m.content === 'string') {
      last.content = `${last.content}\n\n${m.content}`;
      continue;
    }
    const a: ContentPart[] = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [...last.content];
    const b: ContentPart[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    const tail = a.at(-1);
    const head = b[0];
    if (tail?.type === 'text' && head?.type === 'text') a[a.length - 1] = { type: 'text', text: `${tail.text}\n\n${head.text}` };
    else if (head) a.push(head);
    a.push(...b.slice(1));
    last.content = a;
  }
  return out;
}

/**
 * SillyTavern 的 Prompt Post-Processing（mergeMessages），给 OpenAI 兼容接口用：
 * - merge：名字写进正文（示例对话用真名），同一角色连续的合并；
 * - semi：再把中途的系统消息改成 user；
 * - strict：再保证系统消息后面第一条是 user，不是就补一句占位；
 * - single：user / assistant 也写上名字，全部合成一条 user。
 * 有的中转（转发到 Claude 的、DeepSeek 推理模型）要求严格交替，选 semi / strict
 */
export function postProcessMessages(messages: ChatMessage[], mode: PromptProcessing | undefined, names?: ChatRequest['names']): ChatMessage[] {
  if (!mode || mode === 'none') return messages;
  const single = mode === 'single';
  const strict = mode !== 'merge';
  let list: ChatMessage[] = messages
    .filter((m) => !isEmpty(m))
    .map((m) => {
      let x = inlineName(m, names);
      if (single) {
        if (x.role === 'assistant' && names?.char) x = withPrefix(x, names.char);
        if (x.role === 'user' && names?.user) x = withPrefix(x, names.user);
        return { role: 'user' as const, content: x.content };
      }
      return { role: x.role, content: x.content };
    });
  list = squash(list);
  if (!list.length) list = [{ role: 'user', content: START_PLACEHOLDER }];
  if (strict) {
    list = list.map((m, i) => (i > 0 && m.role === 'system' ? { role: 'user' as const, content: m.content } : m));
    if (mode === 'strict') {
      const first = list[0] as ChatMessage;
      if (first.role === 'system' && (list.length === 1 || list[1]?.role !== 'user')) list.splice(1, 0, { role: 'user', content: START_PLACEHOLDER });
      else if (first.role !== 'system' && first.role !== 'user') list.unshift({ role: 'user', content: START_PLACEHOLDER });
    }
    list = squash(list);
  }
  return list;
}

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

/**
 * Claude Messages：{ system, messages }，图片用 base64 source。
 * prefill：助手预填（回复从这段文字接着写，末尾空白去掉，同 SillyTavern）；
 * noPrefill：模型不接受预填、或者开了思考：最后一条是 assistant 时改成 user（同 SillyTavern 的 fixThinkingPrefill）
 */
export function toClaude(
  messages: ChatMessage[],
  names?: ChatRequest['names'],
  opts: { prefill?: string; noPrefill?: boolean } = {},
): { system: string; messages: Record<string, unknown>[] } {
  const n = normalizeTurns(messages, names);
  const pushTurn = (role: 'user' | 'assistant', text: string) => {
    const last = n.turns.at(-1);
    const tail = last?.parts.at(-1);
    if (last?.role === role && tail?.type === 'text') last.parts[last.parts.length - 1] = { type: 'text', text: `${tail.text}\n\n${text}` };
    else if (last?.role === role) last.parts.push({ type: 'text', text });
    else n.turns.push({ role, parts: [{ type: 'text', text }] });
  };
  const prefill = opts.prefill?.trimEnd();
  if (prefill) pushTurn('assistant', prefill);
  const last = n.turns.at(-1);
  if (opts.noPrefill && last?.role === 'assistant' && n.turns.length > 1) {
    n.turns.pop();
    const text = textOf(last.parts);
    pushTurn('user', text);
  }
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
