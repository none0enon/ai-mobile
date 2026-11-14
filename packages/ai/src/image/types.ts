import type { ConnectionKind } from '@app/shared';
import type { Bytes } from '../core/http.ts';

export type ImageSize = 'portrait' | 'landscape' | 'square' | { width: number; height: number };

/** NovelAI V4 起的多人提示词：每个人单独写，center 是画面里的位置（0–1） */
export interface ImageCharacter {
  prompt: string;
  negative?: string;
  center?: { x: number; y: number };
}

/**
 * 照着一张图改（只有 NovelAI 能做）：
 * - 只给 image：图生图（img2img），strength 越大改得越多；
 * - 再给 mask：局部重绘（infill），只重画遮罩里白色的地方，外面原样保留（用这个模型的重绘版）。
 * 出图的宽高要和这张图一样（调用方按图的尺寸给 size）。
 */
export interface ImageSource {
  /** PNG 的 base64（不带 data: 前缀） */
  image: string;
  /** 图生图 0.01–0.99；局部重绘 0–1（1 = 遮罩里整块重画） */
  strength?: number;
  /** 图生图加的噪声 0–0.99 */
  noise?: number;
  /** 局部重绘的遮罩：和图一样大的 PNG（base64），白色重画、黑色不动 */
  mask?: string;
  /** 局部重绘用的模型；不给按出图的模型推（novelaiInpaintModel） */
  inpaintModel?: string;
}

/**
 * NovelAI 的精准参考（Precise Reference，只有 V4.5 能用）：照着参考图里的角色（和画风）画。
 * 参考图要先垫成 NOVELAI_REFERENCE_CANVASES 里的一种尺寸（调用方用 canvas 垫好）
 */
export interface ImageReference {
  /** PNG 的 base64（不带 data: 前缀） */
  image: string;
  /** 连画风一起参考（character&style）；默认只参考角色 */
  style?: boolean;
  /** 跟参考图有多像 0–1：太高时表情、角度、动作也会照搬 */
  strength?: number;
  /** 参考得多死板 0–1：1 很难用提示词改，0 更灵活 */
  fidelity?: number;
}

/** NovelAI Director Tools（/ai/augment-image）：在一张图上做一件事 */
export interface AugmentRequest {
  /** bg-removal 去背景 / emotion 换表情 / declutter 去杂物 / lineart / sketch / colorize …… */
  kind: string;
  /** PNG 的 base64（不带 data: 前缀） */
  image: string;
  /** 宽高要和图一样，不然接口报 500 */
  width: number;
  height: number;
  /** 换表情：情绪（NOVELAI_EMOTIONS 里的一个）和补充的 tags；上色：tags */
  emotion?: string;
  prompt?: string;
  /** 换表情的强度档 0（最强）– 5（最弱）；上色时是去噪强度 */
  defry?: number;
  signal?: AbortSignal;
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
  /** NovelAI 的 noise_schedule：native / karras / exponential / polyexponential */
  noiseSchedule?: string;
  /** NovelAI 的 Variety Boost（按画面大小算 skip_cfg_above_sigma，同 SillyTavern） */
  varietyBoost?: boolean;
  characters?: ImageCharacter[];
  /**
   * 追加这个模型的质量标签（NovelAI 网页版的"质量标签"开关；服务端不会替你加）。默认不加：
   * 同 SleepTogether / SillyTavern，质量词写在生图风格的前缀里，自己控制
   */
  quality?: boolean;
  /** 负面提示词预设（NovelAI 网页版的 UC 预设）；默认开了质量标签时用 heavy，否则不加 */
  ucPreset?: 'heavy' | 'light' | 'none';
  /** 照着一张图改：图生图、局部重绘（只有 NovelAI） */
  source?: ImageSource;
  /** 精准参考（只有 NovelAI V4.5） */
  references?: ImageReference[];
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
