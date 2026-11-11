import type { ConnectionKind } from '@app/shared';
import type { Endpoint } from '../src/core/endpoint.ts';
import type { Transport } from '../src/core/http.ts';

/** 测试用的假服务端：按顺序记录请求，handler 决定怎么回 */
export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  rawBody: unknown;
}

export function fakeTransport(handler: (req: Recorded, index: number) => Response | Promise<Response>): Transport & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const t = (async (url: string, init: RequestInit) => {
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let body: any = init.body;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const rec: Recorded = { url, method: init.method ?? 'GET', headers, body, rawBody: init.body };
    calls.push(rec);
    return handler(rec, calls.length - 1);
  }) as Transport & { calls: Recorded[] };
  t.calls = calls;
  return t;
}

export function endpoint(kind: ConnectionKind, transport: Transport, over: Partial<Endpoint> = {}): Endpoint {
  return {
    connectionId: `conn-${kind}`,
    name: `测试 ${kind}`,
    kind,
    baseUrl: 'https://api.example.com/v1',
    key: 'sk-test',
    model: 'test-model',
    transport,
    ...over,
  };
}

/** 把文本按字节切成小块流式返回（会切开多字节的汉字，顺便测解码） */
export function chunked(text: string, chunkSize = 7, init: ResponseInit = {}): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunkSize) c.enqueue(bytes.slice(i, i + chunkSize));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init });
}

export function sse(events: unknown[], opts: { done?: boolean; chunkSize?: number } = {}): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + (opts.done === false ? '' : 'data: [DONE]\n\n');
  return chunked(text, opts.chunkSize ?? 9);
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export function bytesResponse(bytes: Uint8Array, contentType: string, status = 200): Response {
  return new Response(new Uint8Array(bytes), { status, headers: { 'content-type': contentType } });
}
