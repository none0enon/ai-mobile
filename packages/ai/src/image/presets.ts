import type { ImageSize } from './types.ts';

/** 设计文档 §10.2：竖版 832×1216、横版 1216×832；都不超过约 1024² 像素 */
export const IMAGE_SIZES = {
  portrait: { width: 832, height: 1216 },
  landscape: { width: 1216, height: 832 },
  square: { width: 1024, height: 1024 },
} as const;

export function resolveSize(size: ImageSize | undefined): { width: number; height: number } {
  if (!size) return { ...IMAGE_SIZES.portrait };
  if (typeof size === 'string') return { ...IMAGE_SIZES[size] };
  // NovelAI 要求宽高是 64 的倍数
  const r = (n: number) => Math.max(64, Math.round(n / 64) * 64);
  return { width: r(size.width), height: r(size.height) };
}

export const NOVELAI_MODELS = [
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-5-full',
  'nai-diffusion-5-curated',
  'nai-diffusion-5-full-medium',
  'nai-diffusion-4-full',
  'nai-diffusion-4-curated-preview',
  'nai-diffusion-3',
  'nai-diffusion-furry-3',
];

/** NovelAI 的采样器、噪声调度（第一个是默认的） */
export const NOVELAI_SAMPLERS = ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m_sde', 'k_dpmpp_2m', 'k_dpmpp_sde'] as const;
export const NOVELAI_SCHEDULES = ['karras', 'native', 'exponential', 'polyexponential'] as const;

/** V4 起（含 4.5、V5）用 v4_prompt；V3 用老的参数 */
export function novelaiGeneration(model: string): 'v4' | 'v3' {
  return /nai-diffusion-[45]/.test(model) ? 'v4' : 'v3';
}

/** V5（2026-08 发布）：提示词结构同 V4，参数版本 4（网页版这么发）；新 VAE 能直接画透明背景 */
export function isNovelaiV5(model: string): boolean {
  return /nai-diffusion-5/.test(model);
}

/**
 * 局部重绘用的模型：重绘版是名字后面加 -inpainting；NovelAI 没有 V5 Curated 的重绘版，网页版用 V4.5 Curated 的（社区客户端同此）。
 * 预设里写了重绘模型时用写的那个
 */
export function novelaiInpaintModel(model: string): string {
  if (/-inpainting$/.test(model)) return model;
  if (/^nai-diffusion-5-curated/.test(model)) return 'nai-diffusion-4-5-curated-inpainting';
  return `${model}-inpainting`;
}

/** 精准参考（Precise Reference）只有 V4.5 能用（官方文档） */
export function supportsCharacterReference(model: string): boolean {
  return /nai-diffusion-4-5/.test(model);
}

/** 精准参考的参考图只收这三种尺寸，别的尺寸接口报 400 / 500：按比例最接近的垫（官方文档、社区客户端） */
export const NOVELAI_REFERENCE_CANVASES = [
  { width: 1024, height: 1536 },
  { width: 1536, height: 1024 },
  { width: 1472, height: 1472 },
] as const;

/**
 * Director Tools 换表情能选的情绪（/ai/augment-image 的 emotion，写成 "情绪;;补充的 tags"）。
 * 是接口认的值，不是表情的规定：立绘预设里每个表情选一个用
 */
export const NOVELAI_EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'scared',
  'surprised',
  'tired',
  'excited',
  'nervous',
  'thinking',
  'confused',
  'shy',
  'disgusted',
  'smug',
  'bored',
  'laughing',
  'irritated',
  'aroused',
  'embarrassed',
  'worried',
  'love',
  'determined',
  'hurt',
  'playful',
] as const;

/** 换表情的强度档（defry 0–5），同网页版 */
export const NOVELAI_EMOTION_LEVELS = ['正常', '稍弱', '弱', '更弱', '很弱', '最弱'] as const;

/**
 * NovelAI 网页版勾选"质量标签"时追加在提示词末尾的词。服务端不会自动加，直接调接口要自己加。
 * 是可以改的默认值：想完全自己控制时请求里传 quality: false。
 */
export const NOVELAI_QUALITY_TAGS: Record<string, string> = {
  'nai-diffusion-4-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'very aesthetic, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated-preview': 'rating:general, amazing quality, very aesthetic, absurdres',
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres',
  'nai-diffusion-furry-3': '{best quality}, {amazing quality}',
};

/** NovelAI 网页版的负面提示词预设（UC preset），同样是客户端加的 */
export const NOVELAI_UC_PRESETS: Record<string, { heavy: string; light: string }> = {
  'nai-diffusion-4-5-full': {
    heavy:
      'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
    light: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
  },
  'nai-diffusion-4-5-curated': {
    heavy:
      'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
    light: 'blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page',
  },
  'nai-diffusion-4-full': {
    heavy:
      'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page',
    light: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, white blank page, blank page',
  },
  'nai-diffusion-4-curated-preview': {
    heavy:
      'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, white blank page, blank page',
    light: 'blurry, lowres, error, worst quality, bad quality, jpeg artifacts, very displeasing, logo, dated, signature, white blank page, blank page',
  },
  'nai-diffusion-3': {
    heavy:
      'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
    light: 'lowres, jpeg artifacts, worst quality, watermark, blurry, very displeasing',
  },
};

/** 逗号分隔的 tags 合并（实现在 @app/shared，前端和 Worker 共用） */
export { joinTags } from '@app/shared';

/**
 * Opus 订阅免点数的条件（设计文档 §10.2）：一次一张、不超过 1024×1024 像素、不超过 28 步、不照着图改
 */
export function freeForOpus(p: { width: number; height: number; steps: number; n_samples?: number; image?: unknown }): boolean {
  return p.width * p.height <= 1024 * 1024 && p.steps <= 28 && (p.n_samples ?? 1) === 1 && !p.image;
}
