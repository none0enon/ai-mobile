import { crc32, utf8Encode, writePngText, type ConnectionKind } from '@app/shared';
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

// —— 测试素材：PNG、zip ——

/** 一个只有文件头和 IHDR / IEND 的 PNG（readPngText 只看块结构） */
export function tinyPng(meta?: Record<string, string>): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(utf8Encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length) >>> 0);
    return out;
  };
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return meta ? writePngText(png, meta) : png;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const s = new Response(new Uint8Array(data)).body!.pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** 手工拼一个 zip（单个文件），method 0 不压缩、8 deflate */
export async function makeZip(name: string, data: Uint8Array, method: 0 | 8, corruptCrc = false): Promise<Uint8Array> {
  const comp = method === 8 ? await deflateRaw(data) : data;
  const nameBytes = utf8Encode(name);
  const crc = (crc32(data) >>> 0) ^ (corruptCrc ? 1 : 0);
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, method, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, comp.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, method, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, comp.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true);
  central.set(nameBytes, 46);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + comp.length, true);
  const out = new Uint8Array(local.length + comp.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(comp, local.length);
  out.set(central, local.length + comp.length);
  out.set(eocd, local.length + comp.length + central.length);
  return out;
}
