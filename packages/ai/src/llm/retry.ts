import { readText } from '../core/http.ts';
import type { StreamState } from './types.ts';

/**
 * 按服务端的报错调整请求再发一次（移植自 math-reader 的 sendAIRequestWithTokenRetry / sendAIRequestDroppingRejected）：
 * - 输出 token 数超过模型上限：从报错里读出上限，按上限重试一次，并记住这个模型的上限；
 * - 某个可选参数不被接受（400 / 422 且报错提到它）：去掉这个参数再发，例如中转不认识思考参数、模型不接受 temperature。
 */

/** 已知输出上限更低的模型（地址|模型 → 上限），避免之后每次请求都先被拒绝一次 */
export const outputTokenCaps = new Map<string, number>();

/**
 * 从服务商的 400 错误中读出本次可用的输出 token 数，返回 { tokens, perModel } 或 null。
 * perModel 为真表示这是模型本身的输出上限，可以记住；否则只是本次输入剩余的上下文空间。
 */
export function outputTokenLimitFromError(status: number, errText: string, requested: number): { tokens: number; perModel: boolean } | null {
  if (status !== 400 && status !== 422) return null;
  const text = String(errText || '');
  let tokens = 0;
  let perModel = false;
  // "maximum context length is 32768 tokens ... (8168 in the messages" / "... has 8168 input tokens"
  const openaiContext = text.match(/maximum context length is (\d+)[\s\S]*?(?:\((\d+) in the messages|has (\d+) input tokens)/i);
  // Claude："exceed context limit: 187254 + 32800 > 200000"
  const claudeContext = text.match(/(\d+)\s*\+\s*\d+\s*>\s*(\d+)/);
  if (openaiContext) {
    tokens = Number(openaiContext[1]) - Number(openaiContext[2] || openaiContext[3]);
  } else if (claudeContext) {
    tokens = Number(claudeContext[2]) - Number(claudeContext[1]);
  } else if (/max[_ ]?(?:output[_ ]?|completion[_ ]?)?tokens|maxOutputTokens|output tokens|completion tokens/i.test(text)) {
    // "valid range of max_tokens is [1, 8192]" "supports at most 16384 completion tokens"
    // "32800 > 32000, which is the maximum" "from 1 (inclusive) to 8193 (exclusive)"
    const values = [...text.matchAll(/\b(\d{4,6})\b(\s*\(exclusive\))?/gi)]
      .map((m) => Number(m[1]) - (m[2] ? 1 : 0))
      .filter((n) => n < requested);
    if (values.length) {
      tokens = Math.max(...values);
      perModel = true;
    }
  }
  return tokens >= 1024 && tokens < requested ? { tokens, perModel } : null;
}

export interface SendOutcome {
  response: Response;
  /** 失败时已读出的错误正文 */
  errText?: string;
}

/**
 * 发出请求；输出 token 数超限时按上限重试一次。
 * send(maxTokens) 负责把 maxTokens 写进请求体（undefined 表示不限制、不写这个字段）。
 */
export async function sendWithTokenRetry(
  capKey: string,
  requested: number | undefined,
  onState: ((s: StreamState) => void) | undefined,
  send: (maxTokens: number | undefined) => Promise<Response>,
): Promise<SendOutcome> {
  const cap = outputTokenCaps.get(capKey);
  const maxTokens = requested === undefined ? cap : Math.min(requested, cap ?? Infinity);
  onState?.('sent');
  let response = await send(maxTokens);
  if (response.ok) return { response };
  let errText = await readText(response);
  if (maxTokens === undefined) return { response, errText };
  const limit = outputTokenLimitFromError(response.status, errText, maxTokens);
  if (!limit) return { response, errText };
  if (limit.perModel) outputTokenCaps.set(capKey, limit.tokens);
  response = await send(limit.tokens);
  if (response.ok) return { response };
  errText = await readText(response);
  return { response, errText };
}

/** 看错误正文决定怎么改请求体：改了返回 true（再发一次），否则返回 false 且不能改动任何东西 */
export type RequestFix = (errText: string) => boolean;

/** 报错（400 / 422）提到 field 时去掉它 */
export function dropField(obj: Record<string, unknown>, field: string, pattern: RegExp): RequestFix {
  return (errText) => {
    if (obj[field] === undefined || !pattern.test(errText)) return false;
    delete obj[field];
    return true;
  };
}

/** 同 sendWithTokenRetry；被 400 / 422 拒绝时依次试 fixes，改了请求体就再发，直到成功或没有能改的 */
export async function sendFixing(
  capKey: string,
  requested: number | undefined,
  onState: ((s: StreamState) => void) | undefined,
  send: (maxTokens: number | undefined) => Promise<Response>,
  fixes: RequestFix[],
): Promise<SendOutcome> {
  let result = await sendWithTokenRetry(capKey, requested, onState, send);
  let guard = fixes.length;
  while (!result.response.ok && (result.response.status === 400 || result.response.status === 422) && guard > 0) {
    const errText = result.errText ?? '';
    if (!fixes.some((fix) => fix(errText))) break;
    guard -= 1;
    result = await sendWithTokenRetry(capKey, requested, onState, send);
  }
  return result;
}
