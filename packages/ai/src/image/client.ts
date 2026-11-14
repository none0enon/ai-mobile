import type { ConnectionKind } from '@app/shared';
import type { Endpoint } from '../core/endpoint.ts';
import { AiError } from '../core/errors.ts';
import { novelaiAugment, novelaiGenerate } from './novelai.ts';
import { openaiImages } from './openai.ts';
import type { AugmentRequest, GeneratedImage, ImageRequest, ImageResult } from './types.ts';

const IMAGE_PROVIDERS: Partial<Record<ConnectionKind, (ep: Endpoint, req: ImageRequest) => Promise<ImageResult>>> = {
  novelai: novelaiGenerate,
  openai: openaiImages,
};

/** 能照着图改（图生图、局部重绘、精准参考）、能用 Director Tools 的：只有 NovelAI */
const IMAGE_EDITORS: Partial<Record<ConnectionKind, (ep: Endpoint, req: AugmentRequest) => Promise<GeneratedImage>>> = {
  novelai: novelaiAugment,
};

export function canDraw(kind: ConnectionKind): boolean {
  return !!IMAGE_PROVIDERS[kind];
}

export function canEditImage(kind: ConnectionKind): boolean {
  return !!IMAGE_EDITORS[kind];
}

export async function generateImage(ep: Endpoint, req: ImageRequest): Promise<ImageResult> {
  const provider = IMAGE_PROVIDERS[ep.kind];
  if (!provider) throw new AiError('unsupported', `"${ep.name}" 是 ${ep.kind} 连接，不能生图`);
  if (!req.prompt.trim()) throw new AiError('empty', '生图提示词是空的');
  if ((req.source || req.references?.length) && !canEditImage(ep.kind)) throw new AiError('unsupported', `"${ep.name}" 不能照着图改（图生图、局部重绘、精准参考只有 NovelAI 能做）`);
  return provider(ep, req);
}

export async function augmentImage(ep: Endpoint, req: AugmentRequest): Promise<GeneratedImage> {
  const editor = IMAGE_EDITORS[ep.kind];
  if (!editor) throw new AiError('unsupported', `"${ep.name}" 不能用 Director Tools（去背景、换表情只有 NovelAI 能做）`);
  return editor(ep, req);
}
