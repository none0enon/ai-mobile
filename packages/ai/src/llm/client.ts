import type { ConnectionKind } from '@app/shared';
import { isDeepSeekOfficial, type Endpoint } from '../core/endpoint.ts';
import { AiError, errorText, isAbortError } from '../core/errors.ts';
import { anthropicChat, deepseekChat, geminiChat, openaiChat, type ChatProvider } from './providers.ts';
import { vertexChat } from './vertex.ts';
import type { ChatOptions, ChatRequest, ChatResult } from './types.ts';

const CHAT_PROVIDERS: Partial<Record<ConnectionKind, ChatProvider>> = {
  openai: openaiChat,
  deepseek: deepseekChat,
  anthropic: anthropicChat,
  gemini: geminiChat,
  vertex: vertexChat,
  // Cloudflare Workers AI 也提供 OpenAI 兼容的 /chat/completions
  'workers-ai': openaiChat,
};

export function canChat(kind: ConnectionKind): boolean {
  return !!CHAT_PROVIDERS[kind];
}

/** 选成"OpenAI 兼容"、地址却是 DeepSeek 官方的连接（以前的设置、从 math-reader 粘过来的地址）也按 DeepSeek 的规则发 */
function providerOf(ep: Endpoint): ChatProvider | undefined {
  if (ep.kind === 'openai' && isDeepSeekOfficial(ep.baseUrl)) return deepseekChat;
  return CHAT_PROVIDERS[ep.kind];
}

/** 流式失败后改普通请求也没用的错误：Key 不对、没余额、地址或模型不存在 */
function hopeless(e: unknown): boolean {
  return e instanceof AiError && e.code === 'http' && (e.status === 401 || e.status === 402 || e.status === 403 || e.status === 404);
}

/** 服务端不接受这个请求（参数不认）：按 math-reader 的最简请求再发一次 */
function rejected(e: unknown): boolean {
  return e instanceof AiError && e.code === 'http' && (e.status === 400 || e.status === 422);
}

/**
 * 对一个连接发一次对话（移植自 math-reader 的 doAIRequestPreferStream）：
 * - 有 onDelta 时走流式；流式请求在收到任何正文之前就失败（例如服务端没有流式接口），同一个连接改普通请求再试一次，并报告 fallback；
 * - 只收到思考内容、还没有正文就失败时同样改普通请求；已经有正文了就直接报错（不重复生成）；
 * - 没能流式的（普通请求、服务端忽略流式参数）最后补一次 onDelta，界面拿到的总是全文；
 * - 正文为空算失败（可以换备用 API）。
 * 换备用 API 不在这里，在功能路由（agents/router.ts）。
 */
export async function chatOnce(ep: Endpoint, req: ChatRequest, opts: ChatOptions = {}): Promise<ChatResult> {
  const provider = providerOf(ep);
  if (!provider) throw new AiError('unsupported', `"${ep.name}" 是 ${ep.kind} 连接，不能用来对话`);
  const wantStream = opts.stream ?? !!opts.onDelta;
  let shownText = '';
  let shownThinking = '';
  const onDelta = opts.onDelta
    ? (text: string, thinking: string) => {
        shownText = text;
        shownThinking = thinking;
        opts.onDelta?.(text, thinking);
      }
    : undefined;

  // 带预设参数的请求被拒（400 / 422）时，改成 math-reader 发的最简请求（模型、消息、temperature、stream、输出上限）再发；
  // 之后流式失败改普通请求时也用最简请求
  let current = req;
  const send: ChatProvider = async (e, r, call) => {
    try {
      return await provider(e, r, call);
    } catch (err) {
      if (r.minimal || !rejected(err) || call.signal?.aborted) throw err;
      current = { ...r, minimal: true };
      return provider(e, current, call);
    }
  };

  let result: ChatResult;
  if (!wantStream) {
    result = await send(ep, current, { stream: false, onState: opts.onState, signal: opts.signal });
  } else {
    let received = false;
    try {
      result = await send(ep, current, {
        stream: true,
        onState: opts.onState,
        signal: opts.signal,
        onDelta: (text, thinking) => {
          if (text) received = true;
          onDelta?.(text, thinking);
        },
      });
    } catch (e) {
      if (received || isAbortError(e) || opts.signal?.aborted || hopeless(e)) throw e;
      opts.onState?.('fallback', errorText(e));
      result = await send(ep, current, { stream: false, onState: opts.onState, signal: opts.signal });
    }
  }
  if (onDelta && (result.text !== shownText || result.thinking !== shownThinking)) onDelta(result.text, result.thinking);
  if (!result.text.trim()) {
    throw new AiError('empty', `${ep.name} 返回了空回复${result.finishReason ? `（结束原因：${result.finishReason}）` : ''}`, { retryable: true });
  }
  return result;
}
