import type { ImageStyle } from '@app/shared';
import type { ImageRequest } from './types.ts';

/**
 * 生图风格：固定的前后缀、负面词、采样器（SleepTogether 的 fixedPrompt / fixedPromptEnd / negativePrompt，
 * SillyTavern 的 prompt_prefix / negative_prompt）。
 */
export const DEFAULT_IMAGE_STYLE: ImageStyle = {
  // SleepTogether 的默认前缀
  prefix: 'best quality, amazing quality, very aesthetic, absurdres',
  suffix: '',
  // SillyTavern 的默认负面词
  negative: 'lowres, bad anatomy, bad hands, text, error, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry',
  naiQuality: false,
};

function join(...parts: (string | undefined)[]): string {
  return parts
    .map((p) => (p ?? '').trim().replace(/^,+|,+$/g, '').trim())
    .filter(Boolean)
    .join(', ');
}

/** 前缀里有 {prompt} 时把提示词放在那里（同 SillyTavern 的 combinePrefixes），否则按 前缀、提示词、后缀 拼 */
export function composePrompt(prompt: string, style?: Pick<ImageStyle, 'prefix' | 'suffix'>): string {
  const prefix = style?.prefix ?? '';
  if (prefix.includes('{prompt}')) return join(prefix.replace('{prompt}', prompt), style?.suffix);
  return join(prefix, prompt, style?.suffix);
}

/** 把生图风格套到请求上：请求里写了的参数优先 */
export function applyImageStyle(req: ImageRequest, style?: ImageStyle): ImageRequest {
  if (!style) return req;
  return {
    ...req,
    prompt: composePrompt(req.prompt, style),
    negative: join(style.negative, req.negative),
    quality: req.quality ?? style.naiQuality,
    sampler: req.sampler ?? style.sampler,
    noiseSchedule: req.noiseSchedule ?? style.schedule,
    steps: req.steps ?? style.steps,
    scale: req.scale ?? style.scale,
    varietyBoost: req.varietyBoost ?? style.varietyBoost,
  };
}
