import { bearerHeaders, joinUrl, openaiBase, transportOf, type Endpoint } from '../core/endpoint.ts';
import { AiError, httpError, responseContext } from '../core/errors.ts';
import { readBytes, readText, request } from '../core/http.ts';
import { randomSeed } from '../core/util.ts';
import { dropField, sendFixing } from '../llm/retry.ts';
import { extractImage, sniffImageMime } from './extract.ts';
import { resolveSize } from './presets.ts';
import type { GeneratedImage, ImageRequest, ImageResult } from './types.ts';

/**
 * OpenAI 兼容生图：POST …/images/generations（写法对照 SleepTogether 的 image-manager）。各家字段不一样：
 * - OpenAI：size 只有几档（按宽高比选）、n、quality（gpt-image：low / medium / high；dall-e-3：hd / standard）；
 *   没有负面词参数，负面词写在提示词后面"Avoid: …"；
 * - 硅基流动（Kolors、FLUX）：image_size、batch_size、num_inference_steps、guidance_scale、negative_prompt、seed，回 images[].url。
 * 按地址认硅基流动；返回的图片按 extractImage 找（b64_json、url、各家中转的写法），接口不认的参数按报错自动去掉。
 */
function openaiSize(model: string, w: number, h: number): string {
  const m = model.toLowerCase();
  const ratio = w / Math.max(1, h);
  if (m === 'dall-e-2') return '1024x1024';
  if (m === 'dall-e-3') return ratio > 1.2 ? '1792x1024' : ratio < 0.8 ? '1024x1792' : '1024x1024';
  if (/gpt-image|dall-e/.test(m)) return ratio > 1.2 ? '1536x1024' : ratio < 0.8 ? '1024x1536' : '1024x1024';
  return `${w}x${h}`;
}

/** 画质：auto 不发；dall-e-3 只有 hd / standard；dall-e-2 不支持 */
function openaiQuality(model: string, quality: unknown): string | undefined {
  const m = model.toLowerCase();
  const q = String(quality ?? 'auto').toLowerCase();
  if (q === 'auto' || m === 'dall-e-2') return undefined;
  if (m === 'dall-e-3') return q === 'high' || q === 'hd' ? 'hd' : 'standard';
  return ['low', 'medium', 'high'].includes(q) ? q : undefined;
}

export async function openaiImages(ep: Endpoint, req: ImageRequest): Promise<ImageResult> {
  const base = openaiBase(ep.baseUrl).replace(/\/images$/i, '');
  const url = joinUrl(base, 'images/generations');
  const model = ep.model;
  const { width, height } = resolveSize(req.size);
  const seed = req.seed ?? randomSeed();
  const siliconflow = /siliconflow/i.test(base);
  const { quality, ...extra } = req.extra ?? {};
  let prompt = req.prompt;
  const body: Record<string, unknown> = { model };
  if (siliconflow) {
    body.image_size = `${width}x${height}`;
    body.batch_size = 1;
    body.seed = seed;
    if (req.steps) body.num_inference_steps = req.steps;
    if (req.scale) body.guidance_scale = req.scale;
    if (req.negative) body.negative_prompt = req.negative;
  } else {
    body.size = openaiSize(model, width, height);
    body.n = 1;
    const q = openaiQuality(model, quality);
    if (q) body.quality = q;
    if (/dall-e/i.test(model)) body.response_format = 'b64_json';
    if (req.negative) prompt = `${prompt}\n\nAvoid: ${req.negative}`;
  }
  body.prompt = prompt;
  Object.assign(body, extra);
  const send = () => request(transportOf(ep), ep.name, url, { method: 'POST', headers: bearerHeaders(ep), body: JSON.stringify(body), signal: req.signal });
  const { response, errText } = await sendFixing(url, undefined, undefined, send, [
    dropField(body, 'negative_prompt', /negative_prompt/i),
    dropField(body, 'seed', /\bseed\b/i),
    dropField(body, 'quality', /quality/i),
    dropField(body, 'response_format', /response_format/i),
    dropField(body, 'num_inference_steps', /num_inference_steps|steps/i),
    dropField(body, 'guidance_scale', /guidance/i),
  ]);
  if (!response.ok) throw httpError(ep.name, response.status, errText ?? '', response);
  const text = await readText(response);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AiError('bad_response', `${ep.name} 的回复看不懂：${text.slice(0, 200)}`, { detail: text, context: responseContext(response) });
  }
  const found = extractImage(data);
  if (!found) throw new AiError('empty', `${ep.name} 没有返回图片`, { retryable: true, detail: text, context: responseContext(response) });
  let image: GeneratedImage;
  if ('bytes' in found) {
    image = { bytes: found.bytes, mime: sniffImageMime(found.bytes, found.mime) };
  } else {
    // 链接通常几小时后失效：能取回来就存字节；取不回来（CORS）先用链接显示
    try {
      const r = await request(transportOf(ep), ep.name, found.url, { method: 'GET', signal: req.signal });
      if (!r.ok) throw new Error(String(r.status));
      const bytes = await readBytes(r);
      image = { bytes, mime: sniffImageMime(bytes, r.headers.get('content-type') || 'image/png'), url: found.url };
    } catch {
      image = { bytes: null, mime: 'image/png', url: found.url };
    }
  }
  return {
    images: [image],
    seed: typeof data?.seed === 'number' ? data.seed : typeof body.seed === 'number' ? (body.seed as number) : null,
    model,
    provider: ep.kind,
    prompt,
    negative: req.negative ?? '',
    params: body,
  };
}
