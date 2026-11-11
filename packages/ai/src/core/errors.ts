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

/** 出错时的现场：哪个 API、哪个地址、服务端回了什么头。完整报错（errorReport）里列出来 */
export interface ErrorContext {
  /** 哪个 API（"Claude"、"DeepSeek（备用）"） */
  api?: string;
  /** 渠道协议 */
  kind?: string;
  model?: string;
  /** 请求方法和地址（Key 已隐去） */
  method?: string;
  url?: string;
  /** HTTP 状态说明（Unauthorized、Bad Gateway……） */
  statusText?: string;
  /** 服务端返回的响应头（浏览器只让读到一部分） */
  headers?: Record<string, string>;
}

export interface AiErrorOptions {
  status?: number;
  retryable?: boolean;
  /** 服务商返回的原文（完整），排查用 */
  detail?: string;
  cause?: unknown;
  context?: ErrorContext;
  /** 换备用之前，主 API 的报错 */
  previous?: unknown;
}

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status: number | undefined;
  /** 换个连接或稍后重试可能成功（限流、服务端错误、断网） */
  readonly retryable: boolean;
  readonly detail: string | undefined;
  /** 出错时的现场（可以事后补上：哪个 API、哪个模型） */
  readonly context: ErrorContext;
  readonly previous: unknown;

  constructor(code: AiErrorCode, message: string, opts: AiErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AiError';
    this.code = code;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.detail = opts.detail;
    this.context = { ...(opts.context ?? {}) };
    this.previous = opts.previous;
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

/** Google 会把 Key 的 API 限制作为 403 返回；不能笼统归因为地区或风控。 */
function googleKeyRestriction(body: string): { hint: string; advice: string } | undefined {
  const services: Record<string, string> = {
    'aiplatform.googleapis.com': 'Vertex Agent',
    'generativelanguage.googleapis.com': 'Gemini (AI Studio)',
  };
  let reason = '';
  let service = '';
  try {
    const error = JSON.parse(body)?.error;
    if (Array.isArray(error?.details)) {
      const info = error.details.find((d: any) => d?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
        d.domain === 'googleapis.com' && services[d.metadata?.service]);
      reason = info?.reason ?? '';
      service = info?.metadata?.service ?? '';
    }
    // 有的中转只保留 message，没有 ErrorInfo。
    if (!reason && typeof error?.message === 'string') {
      const blocked = error.message.match(/Requests to this API (aiplatform\.googleapis\.com|generativelanguage\.googleapis\.com) method .+ are blocked\./);
      if (blocked) { reason = 'API_KEY_SERVICE_BLOCKED'; service = blocked[1]!; }
    }
  } catch {
    return;
  }
  const name = services[service];
  if (!name) return;
  if (reason === 'API_KEY_SERVICE_BLOCKED') return {
    hint: `Key 的 API 限制未允许 ${name}`,
    advice: `在 Google Cloud 的“API 和服务 → 凭据”核对这把 Key 的 API 限制，确认允许 ${service}，或换用已允许该 API 的 Key。切换模型不会解除此限制。`,
  };
  if (reason === 'API_KEY_HTTP_REFERRER_BLOCKED') return {
    hint: 'Key 的网站来源限制不允许当前页面',
    advice: '在 Google Cloud 的“API 和服务 → 凭据”核对这把 Key 的网站限制，将当前应用的网址加入允许的网站。',
  };
  if (reason === 'SERVICE_DISABLED') return {
    hint: `Key 所属项目未启用 ${name}`,
    advice: `在 Google Cloud 中切换到这把 Key 所属的项目，启用 ${service} 后重试。`,
  };
}

/** 每个响应是哪个请求发出的（http.ts 的 request 记下），报错时列出请求地址 */
const sentRequests = new WeakMap<Response, { method: string; url: string }>();

export function rememberRequest(res: Response, method: string, url: string): void {
  try {
    sentRequests.set(res, { method, url });
  } catch {
    // 测试里的假响应可能不是对象
  }
}

export function requestOf(res: Response): { method: string; url: string } | undefined {
  return sentRequests.get(res);
}

/** 地址里的 Key 换成 ***（Gemini、Vertex 把 Key 放在 ?key=） */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:key|api_key|apikey|access_token|token)=)[^&#]*/gi, '$1***');
}

/** 一个响应的现场：请求地址（http.ts 的 request 记下的）、状态说明、响应头 */
export function responseContext(res: Response | undefined): ErrorContext {
  if (!res) return {};
  const ctx: ErrorContext = {};
  const sent = requestOf(res);
  if (sent) {
    ctx.method = sent.method;
    ctx.url = redactUrl(sent.url);
  } else if (res.url) {
    ctx.url = redactUrl(res.url);
  }
  if (res.statusText) ctx.statusText = res.statusText;
  const headers: Record<string, string> = {};
  try {
    res.headers.forEach((v, k) => (headers[k] = v));
  } catch {
    // 有的环境不让遍历
  }
  if (Object.keys(headers).length) ctx.headers = headers;
  return ctx;
}

/**
 * 服务商返回了错误状态码。消息里是状态码、大意和服务商说的那句话；
 * 完整的响应正文放在 detail，地址、状态说明、响应头放在 context（传了 res 时），完整报错里都列出来
 */
export function httpError(provider: string, status: number, body: string, res?: Response): AiError {
  const said = extractErrorMessage(body);
  const restriction = status === 401 || status === 403 ? googleKeyRestriction(body) : undefined;
  const hint = restriction?.hint ?? STATUS_HINT[status] ?? (status >= 500 ? '服务端出错' : '请求失败');
  const retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  return new AiError('http', `${provider} 返回 ${status}（${hint}）${said ? `：${said}` : ''}${restriction ? `\n${restriction.advice}` : ''}`, {
    status,
    retryable,
    detail: body,
    context: responseContext(res),
  });
}

export function networkError(provider: string, cause: unknown, req?: { method?: string; url?: string }): AiError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new AiError(
    'network',
    `连不上 ${provider}（${msg || '网络错误'}）。可能是断网、地址写错、证书有问题，或对方不允许浏览器直连（CORS）`,
    { retryable: true, cause, context: req?.url ? { method: req.method ?? 'GET', url: redactUrl(req.url) } : {} },
  );
}

/** 一句话的报错（界面上的摘要） */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * 补上出错时的现场（哪个 API、哪个模型）；不是 AiError 的意外错误包成 AiError，原错误放在 cause，
 * 完整报错里还能看到它的名字、消息和调用栈。取消不包。
 */
export function annotateError(e: unknown, ctx: ErrorContext): unknown {
  if (isAbortError(e)) return e;
  if (e instanceof AiError) {
    for (const [k, v] of Object.entries(ctx) as [keyof ErrorContext, never][]) {
      if (v !== undefined && e.context[k] === undefined) e.context[k] = v;
    }
    return e;
  }
  return new AiError('bad_response', `${ctx.api ? `${ctx.api}：` : ''}${errorName(e)}${errorText(e) ? `: ${errorText(e)}` : ''}`, { cause: e, context: ctx });
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name || 'Error' : typeof e;
}

const CODE_LABEL: Record<AiErrorCode, string> = {
  no_route: '没有设置',
  no_key: '缺少 Key',
  unsupported: '这个渠道做不了',
  http: '服务端返回错误',
  network: '网络请求失败',
  bad_response: '返回的内容看不懂',
  empty: '返回为空',
  budget: '超过每日上限',
  aborted: '已取消',
};

/** 服务端回的正文：是 JSON 就排版一下；太长（几百 KB 的错误页）才截 */
function prettyBody(body: string): string {
  const text = body.trim();
  if (!text) return '（空）';
  try {
    return JSON.stringify(JSON.parse(text), null, 2).slice(0, 200_000);
  } catch {
    return text.slice(0, 200_000);
  }
}

/** 原因链：TypeError: Failed to fetch ← … */
function causeChain(e: unknown): string[] {
  const out: string[] = [];
  let c = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  for (let i = 0; c !== undefined && c !== null && i < 5; i += 1) {
    if (c instanceof AiError) break;
    out.push(c instanceof Error ? `${c.name || 'Error'}: ${c.message}` : String(c));
    if (c instanceof Error && c.stack && !(e instanceof AiError && e.code === 'network')) out.push(c.stack.split('\n').slice(1, 6).join('\n'));
    c = c instanceof Error ? (c as Error & { cause?: unknown }).cause : undefined;
  }
  return out;
}

const NETWORK_HINT =
  '浏览器出于安全考虑不会告诉网页具体原因。常见的有：地址写错或少了 https://；断网或需要代理；服务端不允许浏览器直连（没有 CORS 头，换支持网页调用的中转）；https 页面请求 http 地址；证书无效。电脑浏览器按 F12 看 Console / Network 能看到真正的原因。';

/**
 * 完整报错（"API 连接失败必须展示完整报错"）：一句话的原因，加上请求地址、状态码、响应头、服务端返回的完整正文、
 * 底层错误和原因链；备用 API 也失败时，两边的报错都列出来。界面原样显示、可以复制。Key 已从地址里隐去。
 */
export function errorReport(e: unknown): string {
  const lines: string[] = [errorText(e)];
  if (!(e instanceof AiError)) {
    if (e instanceof Error) {
      lines.push('', `错误：${errorName(e)}`);
      if (e.stack) lines.push('', '调用栈：', e.stack);
      lines.push(...causeChain(e).map((x) => `原因：${x}`));
    }
    return lines.join('\n');
  }
  const c = e.context;
  lines.push('');
  lines.push(`类型：${CODE_LABEL[e.code] ?? e.code}（${e.code}）`);
  if (c.api) lines.push(`API：${c.api}${c.kind ? `（${c.kind} 协议）` : ''}`);
  if (c.model) lines.push(`模型：${c.model}`);
  if (c.url) lines.push(`请求：${c.method ?? 'GET'} ${c.url}`);
  if (e.status !== undefined) lines.push(`状态：${e.status}${c.statusText ? ` ${c.statusText}` : ''}`);
  if (c.headers && Object.keys(c.headers).length) {
    lines.push('响应头：');
    for (const [k, v] of Object.entries(c.headers)) lines.push(`  ${k}: ${v}`);
  }
  if (e.detail !== undefined) lines.push('响应内容：', prettyBody(e.detail));
  const chain = causeChain(e);
  if (chain.length) lines.push(...chain.map((x) => `底层错误：${x}`));
  if (e.code === 'network') lines.push('', NETWORK_HINT);
  if (e.previous !== undefined) lines.push('', '—— 先失败的那个 API ——', errorReport(e.previous));
  return lines.join('\n');
}
