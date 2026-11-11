/**
 * 调用失败的统一错误。message 是给人看的中文（界面直接显示）；code 给程序判断要不要换备用连接、要不要重试。
 */
export type AiErrorCode =
  /** 智能体没分配连接，或分配的连接已删除 */
  | 'no_route'
  /** 连接需要 Key，但这台设备上没有 */
  | 'no_key'
  /** 这个连接（协议）做不了这件事，例如拿 NovelAI 连接去对话 */
  | 'unsupported'
  /** 服务商返回了错误状态码 */
  | 'http'
  /** 请求没发出去：断网、域名解析失败、对方不允许浏览器直连（CORS） */
  | 'network'
  /** 返回的内容看不懂 */
  | 'bad_response'
  /** 返回为空 */
  | 'empty'
  /** 超过这个智能体的每日 token 上限 */
  | 'budget'
  /** 被取消（停止生成、挂断、离开页面） */
  | 'aborted';

export interface AiErrorOptions {
  status?: number;
  retryable?: boolean;
  /** 服务商返回的原文（截断后），排查用 */
  detail?: string;
  cause?: unknown;
}

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status: number | undefined;
  /** 换个连接或稍后重试可能成功（限流、服务端错误、断网） */
  readonly retryable: boolean;
  readonly detail: string | undefined;

  constructor(code: AiErrorCode, message: string, opts: AiErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AiError';
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.detail = opts.detail;
  }
}

export function isAbortError(e: unknown): boolean {
  if (e instanceof AiError) return e.code === 'aborted';
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError';
}

export function abortError(): AiError {
  return new AiError('aborted', '已取消');
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** 换备用连接有没有意义：取消、超预算不换；其余都值得试一下备用 */
export function shouldFailover(e: unknown): boolean {
  if (isAbortError(e)) return false;
  if (e instanceof AiError) return e.code !== 'budget';
  return true;
}

/** 服务商错误正文里最有用的那句话：各家的写法不同，依次找 */
export function extractErrorMessage(body: string): string {
  const text = body.trim();
  if (!text) return '';
  try {
    const data = JSON.parse(text) as Record<string, unknown>;
    const err = data.error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object') {
      const m = (err as Record<string, unknown>).message;
      if (typeof m === 'string' && m) return m;
    }
    // MiniMax：{ base_resp: { status_code, status_msg } }
    const base = data.base_resp as Record<string, unknown> | undefined;
    if (base && typeof base.status_msg === 'string' && base.status_code !== 0) return base.status_msg;
    // NovelAI：{ statusCode, message }；FastAPI（GPT-SoVITS、Fish Audio）：{ detail }
    for (const k of ['message', 'detail', 'msg', 'error_msg']) {
      const v = data[k];
      if (typeof v === 'string' && v) return v;
      if (Array.isArray(v) && v.length) return JSON.stringify(v).slice(0, 300);
    }
  } catch {
    // 不是 JSON：可能是网关的 HTML 错误页
  }
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}

const STATUS_HINT: Record<number, string> = {
  400: '请求参数不被接受',
  401: 'Key 不对或已失效',
  402: '余额或订阅不足',
  403: '没有权限（Key 不对、地区限制或被风控）',
  404: '地址或模型名不对',
  408: '请求超时',
  413: '内容太长',
  422: '请求参数不被接受',
  429: '请求太频繁或额度用完了',
  500: '服务端出错',
  502: '网关出错（中转或上游挂了）',
  503: '服务暂时不可用',
  504: '网关超时',
};

export function httpError(provider: string, status: number, body: string): AiError {
  const said = extractErrorMessage(body);
  const hint = STATUS_HINT[status] ?? (status >= 500 ? '服务端出错' : '请求失败');
  const retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  return new AiError('http', `${provider} 返回 ${status}（${hint}）${said ? `：${said}` : ''}`, {
    status,
    retryable,
    detail: body.slice(0, 2000),
  });
}

export function networkError(provider: string, cause: unknown): AiError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new AiError(
    'network',
    `连不上 ${provider}（${msg || '网络错误'}）。可能是断网、地址写错，或对方不允许浏览器直连——可以换中转，或在连接里打开"经 Worker 转发"`,
    { retryable: true, cause },
  );
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
