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

export function networkError(provider: string, cause: unknown, url = ''): AiError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new AiError('network', `连不上 ${provider}（${msg || '网络错误'}）。${networkHint(url)}`, { retryable: true, cause });
}

/**
 * 请求没发出去时最可能的原因。浏览器只给一句 "Failed to fetch"，所以按地址猜：
 * - 本机（127.0.0.1 / localhost，Termux 里跑的服务）：服务没在跑、没开跨域、浏览器没允许访问本地网络；
 * - 局域网的 http 地址：https 的网页（GitHub Pages、装好的 App）不让连 http 的局域网地址；
 * - 公网：断网、地址写错，或对方不允许浏览器直连。
 */
function networkHint(url: string): string {
  let u: URL | null = null;
  try {
    u = new URL(url);
  } catch {
    // 地址写得不对
  }
  if (!u) return '检查一下地址是不是完整的 http(s)://…';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port ? `:${u.port}` : '';
  const loopback = host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host);
  const local = /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local');
  const pageHttps = typeof location !== 'undefined' && location.protocol === 'https:';
  if (loopback) {
    return [
      `这是本机地址 ${host}${port}：`,
      '① Termux 里的服务还在跑吗（切到后台可能被系统杀掉，可以先 termux-wake-lock）；',
      '② 服务要允许跨域：OPTIONS 预检要回 Access-Control-Allow-Origin 和 Access-Control-Allow-Headers（含 Authorization、Content-Type）；',
      '③ Chrome 问"允许访问本地网络上的设备"时选允许（拒绝过的在 网站设置 → 本地网络访问 里改回来）。',
    ].join('');
  }
  if (local && u.protocol === 'http:' && pageHttps) {
    return `这是局域网的 http 地址：https 的网页不让连。服务在这台手机上的话改填 http://127.0.0.1${port}；在别的设备上要给它配 https。`;
  }
  if (local) return '这是局域网地址：确认那台设备上的服务在跑、两边在同一个网络，并且服务允许跨域（CORS）。';
  if (u.protocol === 'http:' && pageHttps) return 'https 的网页不让连 http 的地址，换成 https 的地址。';
  return '可能是断网、地址写错，或对方不允许浏览器直连——可以换中转，或在连接里打开"经 Worker 转发"';
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
