import { base64Decode } from '@app/shared';
import { bearerHeaders, joinUrl, openaiBase, transportOf, type Endpoint } from '../core/endpoint.ts';
import { AiError, httpError } from '../core/errors.ts';
import { readText, request } from '../core/http.ts';
import { randomSeed } from '../core/util.ts';
import { dropField, sendFixing } from '../llm/retry.ts';
import { resolveSize } from './presets.ts';
import type { GeneratedImage, ImageRequest, ImageResult } from './types.ts';

/**
 * OpenAI 兼容生图：POST …/images/generations。各家字段不一样：
 * - OpenAI：size、n；gpt-image 系列只回 b64_json，dall-e 要 response_format: 'b64_json'；
 * - 硅基流动（Kolors、FLUX）：image_size、batch_size、num_inference_steps、guidance_scale、negative_prompt、seed，回 images[].url。
 * 按地址认硅基流动；其余按 OpenAI 写法发，接口不认的参数按报错自动去掉。
 */
function openaiSize(model: string, w: number, h: number): string {
  const portrait = h > w;
  const landscape = w > h;
  if (/gpt-image/i.test(model)) return portrait ? '1024x1536' : landscape ? '1536x1024' : '1024x1024';
  if (/dall-e-3/i.test(model)) return portrait ? '1024x1792' : landscape ? '1792x1024' : '1024x1024';
  return `${w}x${h}`;
}

export async function openaiImages(ep: Endpoint, req: ImageRequest): Promise<ImageResult> {
  const base = openaiBase(ep.baseUrl);
  const url = joinUrl(base, 'images/generations');
  const model = ep.model;
  const { width, height } = resolveSize(req.size);
  const seed = req.seed ?? randomSeed();
  const siliconflow = /siliconflow/i.test(base);
  const body: Record<string, unknown> = { model, prompt: req.prompt };
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
    if (!/gpt-image/i.test(model)) body.response_format = 'b64_json';
    if (req.negative) body.negative_prompt = req.negative;
    body.seed = seed;
  }
  Object.assign(body, req.extra ?? {});
  const send = () => request(transportOf(ep), ep.name, url, { method: 'POST', headers: bearerHeaders(ep), body: JSON.stringify(body), signal: req.signal });
  const { response, errText } = await sendFixing(url, undefined, undefined, send, [
    dropField(body, 'negative_prompt', /negative_prompt/i),
    dropField(body, 'seed', /\bseed\b/i),
    dropField(body, 'response_format', /response_format/i),
    dropField(body, 'num_inference_steps', /num_inference_steps|steps/i),
    dropField(body, 'guidance_scale', /guidance/i),
  ]);
  if (!response.ok) throw httpError(ep.name, response.status, errText ?? '');
  const text = await readText(response);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AiError('bad_response', `${ep.name} 的回复看不懂：${text.slice(0, 200)}`);
  }
  const items: { b64_json?: string; url?: string }[] = data?.data ?? data?.images ?? [];
  const images: GeneratedImage[] = [];
  for (const it of items) {
    if (it.b64_json) {
      images.push({ bytes: new Uint8Array(base64Decode(it.b64_json)), mime: 'image/png' });
    } else if (it.url) {
      // 链接通常几小时后失效：能取回来就存字节；取不回来（CORS）先用链接显示
      try {
        const r = await request(transportOf(ep), ep.name, it.url, { method: 'GET', signal: req.signal });
        if (!r.ok) throw new Error(String(r.status));
        const buf = new Uint8Array(await r.arrayBuffer());
        images.push({ bytes: buf, mime: r.headers.get('content-type') || 'image/png', url: it.url });
      } catch {
        images.push({ bytes: null, mime: 'image/png', url: it.url });
      }
    }
  }
  if (!images.length) throw new AiError('empty', `${ep.name} 没有返回图片`, { retryable: true });
  return {
    images,
    seed: typeof data?.seed === 'number' ? data.seed : typeof body.seed === 'number' ? (body.seed as number) : null,
    model,
    provider: ep.kind,
    prompt: req.prompt,
    negative: req.negative ?? '',
    params: body,
  };
}
