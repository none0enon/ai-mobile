import type { ConnectionKind } from '@app/shared';
import type { Endpoint } from '../core/endpoint.ts';
import { AiError } from '../core/errors.ts';
import { novelaiGenerate } from './novelai.ts';
import { openaiImages } from './openai.ts';
import type { ImageRequest, ImageResult } from './types.ts';

const IMAGE_PROVIDERS: Partial<Record<ConnectionKind, (ep: Endpoint, req: ImageRequest) => Promise<ImageResult>>> = {
  novelai: novelaiGenerate,
  openai: openaiImages,
};

export function canDraw(kind: ConnectionKind): boolean {
  return !!IMAGE_PROVIDERS[kind];
}

export async function generateImage(ep: Endpoint, req: ImageRequest): Promise<ImageResult> {
  const provider = IMAGE_PROVIDERS[ep.kind];
  if (!provider) throw new AiError('unsupported', `"${ep.name}" 是 ${ep.kind} 连接，不能生图`);
  if (!req.prompt.trim()) throw new AiError('empty', '生图提示词是空的');
  return provider(ep, req);
}
