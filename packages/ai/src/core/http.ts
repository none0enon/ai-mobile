import { abortError, isAbortError, networkError, rememberRequest } from './errors.ts';

/**
 * 发请求的函数。默认是全局 fetch；连接打开"经 Worker 转发"时换成转发到自己 Worker 的版本，
 * 测试里换成假的服务端。签名和 fetch 一样，所以各家协议的代码不用关心请求怎么出去。
 */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

// 不能直接存 fetch 本身：有的浏览器里脱离 window 调用会报 Illegal invocation
export const defaultTransport: Transport = (url, init) => fetch(url, init);

/**
 * 发一个请求：网络层的失败（断网、CORS、DNS）统一成 AiError('network')（带上请求地址），取消统一成 AiError('aborted')。
 * HTTP 错误状态码不在这里处理，交给调用方（有的要读正文判断能不能去掉某个参数重试）。
 */
export async function request(transport: Transport, provider: string, url: string, init: RequestInit): Promise<Response> {
  if (init.signal?.aborted) throw abortError();
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await transport(url, init);
  } catch (e) {
    if (isAbortError(e) || init.signal?.aborted) throw abortError();
    throw networkError(provider, e, { method, url });
  }
  // 记下这个响应是哪个请求的：出错时完整报错里列出请求地址
  rememberRequest(res, method, url);
  return res;
}

export async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** 自己持有缓冲区的字节数组：可以直接交给 Blob / Response（TS 里 Uint8Array<ArrayBufferLike> 不行） */
export type Bytes = Uint8Array<ArrayBuffer>;

export async function readBytes(res: Response): Promise<Bytes> {
  return new Uint8Array(await res.arrayBuffer());
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 合并几个取消信号（任意一个取消就取消）。不用 AbortSignal.any：部分安卓 WebView 和老 iOS 没有。
 * 用完调用 dispose 移除监听，避免长时间存在的信号（例如整个通话的）上挂满监听。
 */
export function linkSignals(...signals: (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const ctrl = new AbortController();
  const live = signals.filter((s): s is AbortSignal => !!s);
  const onAbort = () => ctrl.abort();
  for (const s of live) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    dispose: () => live.forEach((s) => s.removeEventListener('abort', onAbort)),
  };
}

export function jsonHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(extra ?? {}) };
}
