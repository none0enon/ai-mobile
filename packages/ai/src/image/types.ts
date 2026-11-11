import type { ConnectionKind } from '@app/shared';
import type { Bytes } from '../core/http.ts';

export type ImageSize = 'portrait' | 'landscape' | 'square' | { width: number; height: number };

/** NovelAI V4 起的多人提示词：每个人单独写，center 是画面里的位置（0–1） */
export interface ImageCharacter {
  prompt: string;
  negative?: string;
  center?: { x: number; y: number };
}

export interface ImageRequest {
  /** 正向提示词（NovelAI tags 或自然语言描述） */
  prompt: string;
  negative?: string;
  size?: ImageSize;
  /** 不给时随机生成一个并在结果里返回，保证能复现 */
  seed?: number;
  steps?: number;
  /** CFG / guidance */
  scale?: number;
  sampler?: string;
  characters?: ImageCharacter[];
  /** 追加这个模型的质量标签（NovelAI 网页版的"质量标签"开关；服务端不会替你加），默认加 */
  quality?: boolean;
  /** 负面提示词预设（NovelAI 网页版的 UC 预设），默认 heavy */
  ucPreset?: 'heavy' | 'light' | 'none';
  /** 原样并入请求参数（NovelAI 的 parameters、OpenAI 兼容接口的请求体） */
  extra?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  /** 图片字节；服务商只给了链接且浏览器取不回来（CORS）时为空，用 url 显示 */
  bytes: Bytes | null;
  mime: string;
  url?: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  /** 实际用的种子（NovelAI 从 PNG 元数据里核对） */
  seed: number | null;
  model: string;
  provider: ConnectionKind;
  /** 最终送去生成的正向 / 负向提示词（加了质量标签和 UC 预设之后） */
  prompt: string;
  negative: string;
  /** 实际发出去的参数（相册里"用同样参数重画"） */
  params: Record<string, unknown>;
}
