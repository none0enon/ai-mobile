import { readPngText } from '@app/shared';
import { joinUrl, transportOf, trimUrl, type Endpoint } from '../core/endpoint.ts';
import { AiError, httpError } from '../core/errors.ts';
import { readBytes, readText, request, sleep, type Bytes } from '../core/http.ts';
import { randomSeed } from '../core/util.ts';
import { joinTags, NOVELAI_QUALITY_TAGS, NOVELAI_UC_PRESETS, novelaiGeneration, resolveSize } from './presets.ts';
import type { ImageRequest, ImageResult } from './types.ts';
import { isZip, unzipFirst } from './zip.ts';

/**
 * NovelAI 生图（设计文档 §10.2；sleep-together 的"生图端点 = NovelAI + Token"配置沿用）。
 * POST https://image.novelai.net/ai/generate-image，Authorization 用持久 API Token（pst-…），返回 zip，里面是 PNG。
 * - V4 / V4.5：提示词放 v4_prompt（多人时 char_captions + characterPrompts，可以指定每个人在画面里的位置）；
 * - V3：老参数；
 * - 质量标签、UC 预设在这里加（网页版也是客户端加的）；
 * - 种子不给就随机一个，保证"用同样参数重画"能复现；返回后再从 PNG 元数据核对实际用的种子；
 * - 429 多半是"同一时间只能生成一张"，等两三秒重试。
 */
export const NOVELAI_DEFAULT_BASE = 'https://image.novelai.net';

/** 429 后等多久再试（测试里调小） */
export const NOVELAI_RETRY = { delayMs: 2000 };

const CENTER = { x: 0.5, y: 0.5 };

export function buildNovelaiPayload(model: string, req: ImageRequest): { body: Record<string, unknown>; prompt: string; negative: string; seed: number } {
  const gen = novelaiGeneration(model);
  const { width, height } = resolveSize(req.size);
  const seed = req.seed ?? randomSeed();
  const quality = req.quality !== false;
  const prompt = quality ? joinTags(req.prompt, NOVELAI_QUALITY_TAGS[model]) : joinTags(req.prompt);
  const preset = req.ucPreset ?? 'heavy';
  const ucBase = preset === 'none' ? '' : (NOVELAI_UC_PRESETS[model]?.[preset] ?? '');
  const negative = joinTags(ucBase, req.negative);
  const ucPreset = preset === 'heavy' ? 0 : preset === 'light' ? 1 : 3;
  const common = {
    width,
    height,
    scale: req.scale ?? 5,
    sampler: req.sampler ?? 'k_euler_ancestral',
    steps: req.steps ?? 28,
    n_samples: 1,
    ucPreset,
    qualityToggle: quality,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    add_original_image: true,
    cfg_rescale: 0,
    legacy_v3_extend: false,
    seed,
    negative_prompt: negative,
  };
  let parameters: Record<string, unknown>;
  if (gen === 'v4') {
    const chars = req.characters ?? [];
    const useCoords = chars.some((c) => !!c.center);
    parameters = {
      params_version: 3,
      ...common,
      autoSmea: false,
      noise_schedule: 'karras',
      skip_cfg_above_sigma: null,
      use_coords: useCoords,
      legacy_uc: false,
      normalize_reference_strength_multiple: true,
      characterPrompts: chars.map((c) => ({ prompt: c.prompt, uc: c.negative ?? '', center: c.center ?? CENTER, enabled: true })),
      v4_prompt: {
        caption: { base_caption: prompt, char_captions: chars.map((c) => ({ char_caption: c.prompt, centers: [c.center ?? CENTER] })) },
        use_coords: useCoords,
        use_order: true,
      },
      v4_negative_prompt: {
        caption: { base_caption: negative, char_captions: chars.map((c) => ({ char_caption: c.negative ?? '', centers: [c.center ?? CENTER] })) },
        legacy_uc: false,
      },
      deliberate_euler_ancestral_bug: false,
      prefer_brownian: true,
    };
  } else {
    parameters = { params_version: 1, ...common, sm: false, sm_dyn: false, noise_schedule: 'native' };
  }
  Object.assign(parameters, req.extra ?? {});
  return { body: { input: prompt, model, action: 'generate', parameters }, prompt, negative, seed };
}

/** PNG 元数据里的生成参数（NovelAI 写在 Comment 里） */
function seedFromPng(png: Uint8Array): number | null {
  try {
    // readPngText 把关键字转成小写；NovelAI 写的是 Comment
    const comment = readPngText(png).comment;
    if (!comment) return null;
    const seed = (JSON.parse(comment) as { seed?: unknown }).seed;
    return typeof seed === 'number' ? seed : null;
  } catch {
    return null;
  }
}

export async function novelaiGenerate(ep: Endpoint, req: ImageRequest): Promise<ImageResult> {
  const model = ep.model || 'nai-diffusion-4-5-full';
  const { body, prompt, negative, seed } = buildNovelaiPayload(model, req);
  const base = trimUrl(ep.baseUrl || NOVELAI_DEFAULT_BASE).replace(/\/ai\/generate-image$/i, '');
  const url = joinUrl(base, 'ai/generate-image');
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}), ...(ep.headers ?? {}) },
    body: JSON.stringify(body),
    signal: req.signal,
  };
  let res = await request(transportOf(ep), ep.name, url, init);
  for (let attempt = 1; res.status === 429 && attempt <= 2; attempt += 1) {
    await readText(res);
    await sleep(NOVELAI_RETRY.delayMs * attempt, req.signal);
    res = await request(transportOf(ep), ep.name, url, init);
  }
  if (!res.ok) throw httpError(ep.name, res.status, await readText(res));
  const type = res.headers.get('content-type') ?? '';
  if (/json|text\//i.test(type)) throw httpError(ep.name, 502, await readText(res));
  const bytes = await readBytes(res);
  let png: Bytes;
  if (isZip(bytes)) {
    const file = await unzipFirst(bytes);
    if (!file) throw new AiError('bad_response', `${ep.name} 返回的压缩包里没有图片`);
    png = file.data;
  } else {
    // 有的代理已经替你解好了
    png = bytes;
  }
  return {
    images: [{ bytes: png, mime: 'image/png' }],
    seed: seedFromPng(png) ?? seed,
    model,
    provider: ep.kind,
    prompt,
    negative,
    params: body.parameters as Record<string, unknown>,
  };
}

/**
 * 查 NovelAI 订阅（测试连接用）：GET https://api.novelai.net/user/subscription。
 * tier 3 是 Opus（小图免点数）。生图在 image.novelai.net，账号信息在 api.novelai.net。
 */
export async function novelaiSubscription(ep: Endpoint, signal?: AbortSignal): Promise<{ tier: number; anlas: number; active: boolean }> {
  const res = await request(transportOf(ep), ep.name, 'https://api.novelai.net/user/subscription', {
    method: 'GET',
    headers: { ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}) },
    signal,
  });
  if (!res.ok) throw httpError(ep.name, res.status, await readText(res));
  const d = (await res.json()) as { tier?: number; active?: boolean; trainingStepsLeft?: { fixedTrainingStepsLeft?: number; purchasedTrainingSteps?: number } };
  const left = d.trainingStepsLeft ?? {};
  return { tier: d.tier ?? 0, active: !!d.active, anlas: (left.fixedTrainingStepsLeft ?? 0) + (left.purchasedTrainingSteps ?? 0) };
}
