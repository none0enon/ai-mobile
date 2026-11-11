import { readPngText } from '@app/shared';
import { joinUrl, transportOf, trimUrl, type Endpoint } from '../core/endpoint.ts';
import { AiError, httpError } from '../core/errors.ts';
import { readBytes, readText, request, sleep } from '../core/http.ts';
import { randomSeed } from '../core/util.ts';
import { extractImage, sniffImageMime } from './extract.ts';
import { joinTags, NOVELAI_QUALITY_TAGS, NOVELAI_UC_PRESETS, novelaiGeneration, resolveSize } from './presets.ts';
import type { GeneratedImage, ImageRequest, ImageResult } from './types.ts';
import { isZip, unzipFirst } from './zip.ts';

/**
 * NovelAI 生图（设计文档 §10.2；对照 SleepTogether 的 image-manager 和 SillyTavern 的 novelai 生图接口）。
 * POST {站点}/ai/generate-image，Authorization 用持久 API Token（pst-…）。站点可以是官方 image.novelai.net，
 * 也可以是公益站或自定义站点（连接的 Base URL）。
 * - V4 / V4.5：提示词放 v4_prompt（多人时 char_captions + characterPrompts，可以指定每个人在画面里的位置）；V3：老参数；
 * - 质量标签和 UC 预设默认不加（同 SleepTogether / SillyTavern：qualityToggle false，质量词写在生图风格的前缀里），可以打开；
 * - Variety Boost 按画面大小算 skip_cfg_above_sigma（同 SillyTavern）；
 * - 返回可能是 zip、直接的图片，公益站也可能回 JSON（图片 base64 或链接），都认；
 * - 种子不给就随机一个，返回后再从 PNG 元数据核对；429（同一时间只能生成一张）等两三秒重试。
 */
export const NOVELAI_DEFAULT_BASE = 'https://image.novelai.net';

/** 429 后等多久再试（测试里调小） */
export const NOVELAI_RETRY = { delayMs: 2000 };

const CENTER = { x: 0.5, y: 0.5 };

export function buildNovelaiPayload(model: string, req: ImageRequest): { body: Record<string, unknown>; prompt: string; negative: string; seed: number } {
  const gen = novelaiGeneration(model);
  const { width, height } = resolveSize(req.size);
  const seed = req.seed ?? randomSeed();
  const quality = req.quality === true;
  const prompt = quality ? joinTags(req.prompt, NOVELAI_QUALITY_TAGS[model]) : joinTags(req.prompt);
  const preset = req.ucPreset ?? (quality ? 'heavy' : 'none');
  const ucBase = preset === 'none' ? '' : (NOVELAI_UC_PRESETS[model]?.[preset] ?? '');
  const negative = joinTags(ucBase, req.negative);
  const ucPreset = preset === 'light' ? 1 : 0;
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
      noise_schedule: req.noiseSchedule ?? 'karras',
      skip_cfg_above_sigma: req.varietyBoost ? varietySigma(width, height, model) : null,
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
    parameters = {
      params_version: 1,
      ...common,
      sm: false,
      sm_dyn: false,
      noise_schedule: req.noiseSchedule ?? 'native',
      ...(req.varietyBoost ? { skip_cfg_above_sigma: varietySigma(width, height, model) } : {}),
    };
  }
  Object.assign(parameters, req.extra ?? {});
  return { body: { input: prompt, model, action: 'generate', parameters }, prompt, negative, seed };
}

/** Variety Boost（同 SillyTavern 的 calculateSkipCfgAboveSigma）：以 832×1216 为基准按面积开方缩放，V4.5 的常数是 58，其余 19 */
export function varietySigma(width: number, height: number, model: string): number {
  const magic = model.includes('nai-diffusion-4-5') ? 58 : 19;
  return Math.sqrt((width * height) / 1011712) * magic;
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

/** 读出生成的图：zip、直接的图片、或者 JSON 里的 base64 / 链接（公益站） */
async function readImageResponse(ep: Endpoint, res: Response, signal?: AbortSignal): Promise<GeneratedImage> {
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const bytes = await readBytes(res);
  if (!bytes.length) throw new AiError('empty', `${ep.name} 返回了空的图片`, { retryable: true });
  if (/json|text\//.test(type) || bytes[0] === 0x7b) {
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new AiError('bad_response', `${ep.name} 的回复不是图片：${new TextDecoder().decode(bytes.subarray(0, 200))}`);
    }
    const found = extractImage(data);
    if (!found) throw httpError(ep.name, 502, JSON.stringify(data).slice(0, 2000));
    if ('bytes' in found) return { bytes: found.bytes, mime: sniffImageMime(found.bytes, found.mime) };
    const r = await request(transportOf(ep), ep.name, found.url, { method: 'GET', signal });
    if (!r.ok) return { bytes: null, mime: 'image/png', url: found.url };
    const img = await readBytes(r);
    return { bytes: img, mime: sniffImageMime(img, 'image/png'), url: found.url };
  }
  if (isZip(bytes)) {
    const file = await unzipFirst(bytes);
    if (!file) throw new AiError('bad_response', `${ep.name} 返回的压缩包里没有图片`);
    return { bytes: file.data, mime: sniffImageMime(file.data, 'image/png') };
  }
  const mime = sniffImageMime(bytes, type.startsWith('image/') ? (type.split(';')[0] ?? '') : '');
  if (!mime) throw new AiError('bad_response', `${ep.name} 返回的不是图片`);
  return { bytes, mime };
}

export async function novelaiGenerate(ep: Endpoint, req: ImageRequest): Promise<ImageResult> {
  const model = ep.model || 'nai-diffusion-4-5-full';
  const { body, prompt, negative, seed } = buildNovelaiPayload(model, req);
  const base = trimUrl(ep.baseUrl || NOVELAI_DEFAULT_BASE).replace(/\/ai\/generate-image$/i, '');
  const url = joinUrl(base, 'ai/generate-image');
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-zip-compressed, image/png, application/json',
      ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}),
      ...(ep.headers ?? {}),
    },
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
  const image = await readImageResponse(ep, res, req.signal);
  return {
    images: [image],
    seed: (image.bytes && seedFromPng(image.bytes)) ?? seed,
    model,
    provider: ep.kind,
    prompt,
    negative,
    params: body.parameters as Record<string, unknown>,
  };
}

export interface NovelaiSubscription {
  tier: number;
  active: boolean;
  /** 剩余点数（Anlas） */
  anlas: number;
  /** 小图免点数（订阅特权 unlimitedImageGeneration） */
  unlimited: boolean;
}

/**
 * 查 NovelAI 订阅（测试连接用，不出图、不花点数）：GET {站点}/user/subscription（同 SillyTavern 用生图站点查）。
 * 公益站多半没有这个接口：返回 null，界面说明"接口能连上，查不到订阅"
 */
export async function novelaiSubscription(ep: Endpoint, signal?: AbortSignal): Promise<NovelaiSubscription | null> {
  const base = trimUrl(ep.baseUrl || NOVELAI_DEFAULT_BASE).replace(/\/ai\/generate-image$/i, '');
  const res = await request(transportOf(ep), ep.name, joinUrl(base, 'user/subscription'), {
    method: 'GET',
    headers: { ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}) },
    signal,
  });
  if (res.status === 404 && !/novelai\.net/i.test(base)) return null;
  if (!res.ok) throw httpError(ep.name, res.status, await readText(res));
  const d = (await res.json()) as {
    tier?: number;
    active?: boolean;
    perks?: { unlimitedImageGeneration?: boolean };
    trainingStepsLeft?: { fixedTrainingStepsLeft?: number; purchasedTrainingSteps?: number };
  };
  const left = d.trainingStepsLeft ?? {};
  return {
    tier: d.tier ?? 0,
    active: !!d.active,
    anlas: (left.fixedTrainingStepsLeft ?? 0) + (left.purchasedTrainingSteps ?? 0),
    unlimited: !!d.perks?.unlimitedImageGeneration,
  };
}
