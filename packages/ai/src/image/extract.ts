import { base64Decode } from '@app/shared';
import type { Bytes } from '../core/http.ts';

/**
 * 从各种返回里找出图片（移植自 SleepTogether 的 extractImage）：
 * OpenAI 的 data[].b64_json / url、硅基流动的 images[].url、公益站和中转的各种字段、聊天格式里的 Markdown 图片链接。
 * 返回 base64 字节或链接；都没有返回 null。
 */
export type FoundImage = { bytes: Bytes; mime: string } | { url: string };

/** 这几个字段的值本来就是 base64，不管多短都按 base64 认 */
const B64_KEYS = new Set(['b64_json', 'b64', 'base64', 'image_base64']);
const DIRECT = ['b64_json', 'b64', 'base64', 'image_base64', 'dataUrl', 'image_url', 'imageUrl', 'url', 'image', 'imageData'];
const NESTED = ['data', 'images', 'output', 'outputs', 'choices', 'message', 'content', 'result', 'results', 'response'];

function fromString(value: string): FoundImage | null {
  const text = value.trim();
  if (!text) return null;
  const dataUrl = text.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is);
  if (dataUrl) return { bytes: new Uint8Array(base64Decode((dataUrl[2] ?? '').replace(/\s+/g, ''))), mime: (dataUrl[1] ?? 'image/png').toLowerCase() };
  if (/^(?:https?:|blob:)/i.test(text)) return { url: text };
  const compact = text.replace(/\s+/g, '');
  if (compact.length >= 80 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return { bytes: new Uint8Array(base64Decode(compact)), mime: 'image/png' };
  const md = text.match(/!\[[^\]]*]\(([^)\s]+)\)/);
  return md?.[1] ? fromString(md[1]) : null;
}

export function extractImage(payload: unknown, depth = 0): FoundImage | null {
  if (payload == null || depth > 6) return null;
  if (typeof payload === 'string') return fromString(payload);
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const r = extractImage(item, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof payload !== 'object') return null;
  const o = payload as Record<string, unknown>;
  for (const k of [...DIRECT, ...NESTED]) {
    const v = o[k];
    if (B64_KEYS.has(k) && typeof v === 'string' && /^[A-Za-z0-9+/\s]+={0,2}$/.test(v.trim()) && v.trim()) {
      return { bytes: new Uint8Array(base64Decode(v.replace(/\s+/g, ''))), mime: 'image/png' };
    }
    const r = extractImage(v, depth + 1);
    if (r) return r;
  }
  return null;
}

/** 按文件头认图片类型 */
export function sniffImageMime(bytes: Uint8Array, fallback = ''): string {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return fallback;
}
