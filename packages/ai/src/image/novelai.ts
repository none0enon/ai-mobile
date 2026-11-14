import { readPngText } from '@app/shared';
import { joinUrl, transportOf, trimUrl, type Endpoint } from '../core/endpoint.ts';
import { AiError, httpError, responseContext } from '../core/errors.ts';
import { readBytes, readText, request, sleep } from '../core/http.ts';
import { randomSeed } from '../core/util.ts';
import { extractImage, sniffImageMime } from './extract.ts';
import { isNovelaiV5, joinTags, NOVELAI_QUALITY_TAGS, NOVELAI_UC_PRESETS, novelaiGeneration, novelaiInpaintModel, resolveSize, supportsCharacterReference } from './presets.ts';
import type { AugmentRequest, GeneratedImage, ImageRequest, ImageResult } from './types.ts';
import { isZip, unzipFirst } from './zip.ts';

/**
 * NovelAI 生图（设计文档 §10.2；对照 SleepTogether 的 image-manager 和 SillyTavern 的 novelai 生图接口）。
 * POST {站点}/ai/generate-image，Authorization 用持久 API Token（pst-…）。站点可以是官方 image.novelai.net，
 * 也可以是公益站或自定义站点（连接的 Base URL）。
 * - V4 / V4.5 / V5：提示词放 v4_prompt（多人时 char_captions + characterPrompts，可以指定每个人在画面里的位置）；V3：老参数；
 *   V5 参数版本 4、straight_alpha（网页版这么发：透明背景存成不预乘的 alpha，PNG 本来就要这样）；
 * - 照着图改（设计文档 §10.7）：图生图 action img2img；局部重绘 action infill（遮罩白色重画，用重绘模型，框外原样贴回）；
 *   精准参考 director_reference_*（只有 V4.5）；字段对照社区客户端（novelai-python、ComfyUI 的几个 NovelAI 节点）；
 * - 质量标签和 UC 预设默认不加（同 SleepTogether / SillyTavern：qualityToggle false，质量词写在生图风格的前缀里），可以打开；
 * - Variety Boost 按画面大小算 skip_cfg_above_sigma（同 SillyTavern）；
 * - 返回可能是 zip、直接的图片，公益站也可能回 JSON（图片 base64 或链接），都认；
 * - 种子不给就随机一个，返回后再从 PNG 元数据核对；429（同一时间只能生成一张）等两三秒重试。
 * Director Tools（去背景、换表情……）是另一个接口 /ai/augment-image，见 novelaiAugment。
 */
export const NOVELAI_DEFAULT_BASE = 'https://image.novelai.net';

/** 429 后等多久再试（测试里调小） */
export const NOVELAI_RETRY = { delayMs: 2000 };

const CENTER = { x: 0.5, y: 0.5 };

export function buildNovelaiPayload(baseModel: string, req: ImageRequest): { body: Record<string, unknown>; prompt: string; negative: string; seed: number } {
  const src = req.source;
  const refs = req.references ?? [];
  const infill = !!src?.mask;
  // 局部重绘用这个模型的重绘版；参数（质量词、提示词结构）还是按原模型
  const model = infill ? (src?.inpaintModel || novelaiInpaintModel(baseModel)) : baseModel;
  if (refs.length && !supportsCharacterReference(baseModel)) {
    throw new AiError('unsupported', `精准参考只有 V4.5 能用，现在的模型是 ${baseModel}`);
  }
  const gen = novelaiGeneration(baseModel);
  const { width, height } = resolveSize(req.size);
  const seed = req.seed ?? randomSeed();
  const quality = req.quality === true;
  const prompt = quality ? joinTags(req.prompt, NOVELAI_QUALITY_TAGS[baseModel]) : joinTags(req.prompt);
  const preset = req.ucPreset ?? (quality ? 'heavy' : 'none');
  const ucBase = preset === 'none' ? '' : (NOVELAI_UC_PRESETS[baseModel]?.[preset] ?? '');
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
    const v5 = isNovelaiV5(baseModel);
    parameters = {
      params_version: v5 ? 4 : 3,
      ...common,
      autoSmea: false,
      noise_schedule: req.noiseSchedule ?? 'karras',
      skip_cfg_above_sigma: req.varietyBoost ? varietySigma(width, height, baseModel) : null,
      ...(v5 ? { straight_alpha: true } : {}),
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
      ...(req.varietyBoost ? { skip_cfg_above_sigma: varietySigma(width, height, baseModel) } : {}),
    };
  }
  let action = 'generate';
  if (src) {
    // 图生图、局部重绘：图（和遮罩）的宽高就是这次出图的宽高；种子也给加噪用（网页版同此）
    parameters.image = src.image;
    parameters.extra_noise_seed = seed;
    if (infill) {
      action = 'infill';
      const strength = clamp01(src.strength ?? 1);
      parameters.mask = src.mask;
      parameters.inpaintImg2ImgStrength = strength;
      // 不是整块重画时，社区客户端还带一份 img2img 的强度和颜色校正（同网页版）
      if (strength < 1) parameters.img2img = { strength, color_correct: true };
    } else {
      action = 'img2img';
      parameters.strength = Math.min(0.99, Math.max(0.01, src.strength ?? 0.7));
      parameters.noise = Math.min(0.99, Math.max(0, src.noise ?? 0));
      parameters.color_correct = true;
    }
  }
  if (refs.length) {
    parameters.director_reference_images = refs.map((r) => r.image);
    parameters.director_reference_descriptions = refs.map((r) => ({
      caption: { base_caption: r.style ? 'character&style' : 'character', char_captions: [] },
      use_coords: false,
      use_order: false,
      legacy_uc: false,
    }));
    parameters.director_reference_information_extracted = refs.map(() => 1);
    parameters.director_reference_strength_values = refs.map((r) => clamp01(r.strength ?? 1));
    // 网页版的"保真度"：接口里写的是 1 − 保真度
    parameters.director_reference_secondary_strength_values = refs.map((r) => 1 - clamp01(r.fidelity ?? 1));
  }
  Object.assign(parameters, req.extra ?? {});
  return { body: { input: prompt, model, action, parameters }, prompt, negative, seed };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
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
      throw new AiError('bad_response', `${ep.name} 的回复不是图片：${new TextDecoder().decode(bytes.subarray(0, 200))}`, { detail: new TextDecoder().decode(bytes), context: responseContext(res) });
    }
    const found = extractImage(data);
    if (!found) throw httpError(ep.name, 502, JSON.stringify(data), res);
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

function novelaiBase(ep: Endpoint): string {
  return trimUrl(ep.baseUrl || NOVELAI_DEFAULT_BASE).replace(/\/ai\/(?:generate|augment)-image$/i, '');
}

/** POST 一个 NovelAI 的图片接口；429（同一时间只能生成一张）等两三秒再试，最多两次 */
async function postNovelai(ep: Endpoint, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<GeneratedImage> {
  const url = joinUrl(novelaiBase(ep), path);
  const init = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-zip-compressed, image/png, application/json',
      ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}),
      ...(ep.headers ?? {}),
    },
    body: JSON.stringify(body),
    signal,
  };
  let res = await request(transportOf(ep), ep.name, url, init);
  for (let attempt = 1; res.status === 429 && attempt <= 2; attempt += 1) {
    await readText(res);
    await sleep(NOVELAI_RETRY.delayMs * attempt, signal);
    res = await request(transportOf(ep), ep.name, url, init);
  }
  if (!res.ok) throw httpError(ep.name, res.status, await readText(res), res);
  return readImageResponse(ep, res, signal);
}

export async function novelaiGenerate(ep: Endpoint, req: ImageRequest): Promise<ImageResult> {
  const { body, prompt, negative, seed } = buildNovelaiPayload(ep.model || 'nai-diffusion-4-5-full', req);
  const image = await postNovelai(ep, 'ai/generate-image', body, req.signal);
  return {
    images: [image],
    seed: (image.bytes && seedFromPng(image.bytes)) ?? seed,
    // 局部重绘时是重绘模型
    model: String(body.model),
    provider: ep.kind,
    prompt,
    negative,
    params: body.parameters as Record<string, unknown>,
  };
}

/**
 * Director Tools：POST {站点}/ai/augment-image（同网页版；字段对照 novelai-python 的 augment_image 和 ComfyUI 的 NovelAI 节点）。
 * - 宽高要和图一样，不然接口报 500；
 * - 换表情：prompt 写成 "情绪;;补充的 tags"，defry 是强度档（0 最强 – 5 最弱）；
 * - 返回 zip（去背景时可能有几张，取第一张）。花点数（Anlas），Opus 也不免。
 */
export function buildAugmentPayload(req: AugmentRequest): Record<string, unknown> {
  const prompt = req.kind === 'emotion' ? `${req.emotion || 'neutral'};;${req.prompt ?? ''}` : req.prompt;
  return {
    req_type: req.kind,
    width: req.width,
    height: req.height,
    image: req.image,
    ...(prompt ? { prompt } : {}),
    ...(req.defry !== undefined ? { defry: Math.min(5, Math.max(0, Math.round(req.defry))) } : {}),
  };
}

export async function novelaiAugment(ep: Endpoint, req: AugmentRequest): Promise<GeneratedImage> {
  return postNovelai(ep, 'ai/augment-image', buildAugmentPayload(req), req.signal);
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
  const base = novelaiBase(ep);
  const res = await request(transportOf(ep), ep.name, joinUrl(base, 'user/subscription'), {
    method: 'GET',
    headers: { ...(ep.key ? { Authorization: `Bearer ${ep.key}` } : {}) },
    signal,
  });
  if (res.status === 404 && !/novelai\.net/i.test(base)) return null;
  if (!res.ok) throw httpError(ep.name, res.status, await readText(res), res);
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
