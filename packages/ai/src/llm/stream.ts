import { abortError, AiError, isAbortError } from '../core/errors.ts';
import {
  eventIsThinking,
  finishReasonOf,
  mergeUsage,
  responseText,
  responseThinking,
  streamDeltaText,
  streamDeltaThinking,
  usageOf,
} from './events.ts';
import { createThinkTagSplitter, splitThinkTag } from './think.ts';
import type { ChatCallbacks, ChatResult, Usage } from './types.ts';

export interface ReadStreamOptions extends ChatCallbacks {
  /** 这家协议取一段正文的写法；取不到时再按三家的写法依次试 */
  deltaOf?: (event: any) => string | null | undefined;
  /** 整个响应只有一个 JSON（服务端忽略了流式参数）时取全文 */
  textOf?: (data: any) => string | null | undefined;
  signal?: AbortSignal;
}

/**
 * 读取流式响应（移植自 math-reader docs/index.html 的 readAIStream）。
 *
 * 按正文第一个非空字符判断格式，不只看 content-type（有的中转把 SSE 标成 application/json）：
 * - SSE：OpenAI 兼容接口、Claude、Gemini 的 alt=sse；
 * - JSON 数组：Gemini 不带 alt=sse 时逐个元素返回；
 * - 逐个返回的 JSON 对象（每行一个）；
 * - 单个 JSON：服务端忽略了流式参数，按普通响应取全文，并报告 unstreamed。
 *
 * 每收到新的正文或思考内容就调用 onDelta(正文全文, 思考内容全文)；正文开头 <think>…</think> 里的算作思考内容。
 * 第一段正文出现时报告 streaming；思考内容和长正文在一秒内全部到达时报告 buffered（中转或代理把流攒到最后才发）。
 */
export async function readAIStream(response: Response, opts: ReadStreamOptions = {}): Promise<ChatResult> {
  const { onDelta, onState, deltaOf, textOf, signal } = opts;
  onState?.('connected');
  if (!response.body) return fromWholeBody(await response.text(), opts);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = ''; // 收到的正文（可能以 <think> 开头）
  let thinking = ''; // 接口单独返回的思考内容
  let shownText = ''; // 交给 onDelta 的正文和思考内容
  let shownThinking = '';
  let tagThinking = ''; // 正文开头 <think> 标签里的思考内容
  let thinkingReported = false;
  let streamingReported = false;
  const split = createThinkTagSplitter();
  let firstAt = 0; // 第一次收到正文或思考内容的时间
  let lastTextAt = 0;
  let usage: Usage | null = null;
  let finishReason: string | null = null;

  const handleEvent = (event: any) => {
    if (!event || typeof event !== 'object') return;
    // 生成中途出错时服务端在流里发 error 事件（例如 Claude 的 overloaded_error）
    if (event.error) {
      const msg = typeof event.error === 'string' ? event.error : event.error.message || JSON.stringify(event.error);
      throw new AiError('http', `生成途中出错：${msg}`, { retryable: true, detail: JSON.stringify(event.error).slice(0, 2000) });
    }
    usage = mergeUsage(usage, usageOf(event));
    finishReason = finishReasonOf(event) ?? finishReason;
    // Claude 的多个思考块之间空一行
    if (event.type === 'content_block_start' && event.content_block?.type === 'thinking' && thinking) thinking += '\n\n';
    const delta = deltaOf?.(event) || streamDeltaText(event);
    const thinkingDelta = streamDeltaThinking(event);
    if (delta || thinkingDelta) {
      const now = Date.now();
      if (!firstAt) firstAt = now;
      if (delta) {
        text += delta;
        lastTextAt = now;
      }
      thinking += thinkingDelta;
      const s = split(text);
      let changed = s.text !== shownText;
      if (thinkingDelta || s.thinking !== tagThinking) {
        tagThinking = s.thinking;
        shownThinking = [thinking.trim(), tagThinking].filter(Boolean).join('\n\n');
        changed = true;
      }
      if (changed) {
        shownText = s.text;
        if (shownText && !streamingReported) {
          streamingReported = true;
          onState?.('streaming');
        }
        onDelta?.(shownText, shownThinking);
      }
    }
    if (!shownText && !thinkingReported && (shownThinking || eventIsThinking(event))) {
      thinkingReported = true;
      onState?.('thinking');
    }
  };

  // SSE：空行结束一个事件；event:、id: 和以冒号开头的保活注释行都不需要
  let lineBuffer = '';
  let dataLines: string[] = [];
  const dispatch = () => {
    const lines = dataLines;
    dataLines = [];
    const payload = lines.join('\n');
    if (!payload || payload === '[DONE]') return;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      // 有的中转每行一个 data: 却不空行分隔：逐行再解析一次
      if (lines.length > 1) for (const l of lines) parseAndHandle(l);
      return;
    }
    handleEvent(event);
  };
  const parseAndHandle = (payload: string) => {
    if (!payload || payload === '[DONE]') return;
    try {
      handleEvent(JSON.parse(payload));
    } catch (e) {
      if (e instanceof AiError) throw e;
    }
  };
  const handleLine = (raw: string) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line) dispatch();
    else if (line.startsWith('data:')) dataLines.push(line.slice(line.startsWith('data: ') ? 6 : 5));
  };

  // JSON：逐字符扫描，跟踪括号深度和字符串，凑齐一个完整的值就解析。
  // 外层是数组时取数组里的一个个元素，否则取一个个顶层对象
  let raw = '';
  let pos = 0;
  let depth = 0;
  let valueDepth = 0;
  let valueStart = -1;
  let inString = false;
  let escaped = false;
  let values = 0;
  let lastValue: unknown = null;
  const scanJSON = () => {
    for (; pos < raw.length; pos += 1) {
      const c = raw[pos];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
      } else if (c === '{' || c === '[') {
        if (depth === valueDepth && valueStart < 0) valueStart = pos;
        depth += 1;
      } else if (c === '}' || c === ']') {
        depth -= 1;
        if (depth === valueDepth && valueStart >= 0) {
          try {
            lastValue = JSON.parse(raw.slice(valueStart, pos + 1));
          } catch (e) {
            throw new AiError('bad_response', `回复不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`);
          }
          valueStart = -1;
          values += 1;
          handleEvent(lastValue);
        }
      }
    }
    // 丢掉已经解析过的部分，长响应不必反复扫描
    const keep = valueStart >= 0 ? valueStart : pos;
    raw = raw.slice(keep);
    pos -= keep;
    if (valueStart >= 0) valueStart = 0;
  };

  let format: 'sse' | 'json' | null = null; // 由正文第一个非空字符决定
  let head = '';
  const feed = (input: string) => {
    let chunk = input;
    if (!format) {
      head += chunk;
      const start = head.replace(/^\uFEFF/, '').trimStart();
      if (!start) return;
      format = start[0] === '{' || start[0] === '[' ? 'json' : 'sse';
      valueDepth = start[0] === '[' ? 1 : 0;
      chunk = head.replace(/^\uFEFF/, '');
      head = '';
    }
    if (format === 'sse') {
      lineBuffer += chunk;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      lines.forEach(handleLine);
    } else {
      raw += chunk;
      scanJSON();
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
    feed(decoder.decode());
    if (format === 'sse') {
      if (lineBuffer) handleLine(lineBuffer);
      dispatch();
    }
  } catch (e) {
    reader.cancel().catch(() => undefined);
    if (signal?.aborted || isAbortError(e)) throw abortError();
    if (e instanceof AiError) throw e;
    throw new AiError('network', `读取回复时连接断了：${e instanceof Error ? e.message : String(e)}`, { retryable: true, cause: e });
  }

  if (format === 'json' && values <= 1) {
    // 整个响应只有一个 JSON：服务端忽略了流式参数，按普通响应取全文
    onState?.('unstreamed');
    if (shownText) return { text: shownText, thinking: shownThinking, usage, finishReason, streamed: false };
    const whole = lastValue ? textOf?.(lastValue) || responseText(lastValue) : '';
    const s = splitThinkTag(whole);
    return {
      text: s.text,
      thinking: [responseThinking(lastValue), s.thinking].filter(Boolean).join('\n\n'),
      usage,
      finishReason,
      streamed: false,
    };
  }
  if (text.length > 3000 && lastTextAt - firstAt < 1000) onState?.('buffered');
  return { text: shownText, thinking: shownThinking, usage, finishReason, streamed: true };
}

/**
 * 读普通（非流式）响应。有的中转不管 stream: false 照样回 SSE，那就按流读完再取全文
 */
export async function readWhole(response: Response, provider: string, opts: ReadStreamOptions = {}): Promise<ChatResult> {
  let body: string;
  try {
    body = await response.text();
  } catch (e) {
    if (opts.signal?.aborted || isAbortError(e)) throw abortError();
    throw new AiError('network', `读取 ${provider} 的回复时连接断了`, { retryable: true, cause: e });
  }
  if (/^\s*(?:data:|event:|:)/.test(body)) return readAIStream(new Response(body), { ...opts, onDelta: undefined, onState: undefined });
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new AiError('bad_response', `${provider} 的回复不是 JSON：${body.replace(/\s+/g, ' ').slice(0, 200)}`, { retryable: true });
  }
  const whole = opts.textOf?.(data) || responseText(data);
  const s = splitThinkTag(whole);
  const d = data as Record<string, unknown>;
  return {
    text: s.text,
    thinking: [responseThinking(data), s.thinking].filter(Boolean).join('\n\n'),
    usage: usageOf(d),
    finishReason: finishReasonOf(d),
    streamed: false,
  };
}

/** 极少数环境（或测试）里响应没有 body 流：整段读出来当普通响应处理 */
function fromWholeBody(body: string, opts: ReadStreamOptions): ChatResult {
  let data: unknown = null;
  try {
    data = JSON.parse(body);
  } catch {
    data = null;
  }
  opts.onState?.('unstreamed');
  const whole = data ? opts.textOf?.(data) || responseText(data) : '';
  const s = splitThinkTag(whole);
  return {
    text: s.text,
    thinking: [responseThinking(data), s.thinking].filter(Boolean).join('\n\n'),
    usage: data && typeof data === 'object' ? usageOf(data as Record<string, unknown>) : null,
    finishReason: data && typeof data === 'object' ? finishReasonOf(data as Record<string, unknown>) : null,
    streamed: false,
  };
}
