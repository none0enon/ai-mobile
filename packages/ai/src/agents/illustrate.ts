import type { ImageRequest } from '../image/types.ts';
import { buildImagePromptMessages, fallbackImagePrompt, parseImagePrompt, toImageRequest, type ImagePromptInput, type ImagePromptOutput } from './imagePrompt.ts';
import type { AgentCallOptions, AgentSystem, CallMeta } from './system.ts';

/**
 * 配图流水线（设计文档 §4.1：[cg:] → 生图提示词智能体 → 生图智能体 → 相册）。
 * 和 sleep-together 的生图轮次一样分阶段报告进度（写提示词 → 出图 → 完成），界面据此显示"正在构思""正在画"。
 * 生图提示词智能体没分配时，用外观 tags + 画面描述原文。
 */

export type IllustrateStage = 'prompt' | 'image';

export interface IllustrateResult {
  prompt: ImagePromptOutput;
  /** 实际发给生图接口的请求（相册"用同样参数重画"） */
  request: ImageRequest;
  image: Awaited<ReturnType<AgentSystem['draw']>>;
  /** 写提示词用的模型；没用智能体时为 null */
  promptBy: (CallMeta & { model: string }) | null;
}

export async function illustrate(
  system: AgentSystem,
  input: ImagePromptInput,
  opts: AgentCallOptions & { seed?: number; onStage?(stage: IllustrateStage): void } = {},
): Promise<IllustrateResult> {
  opts.onStage?.('prompt');
  let prompt: ImagePromptOutput;
  let promptBy: IllustrateResult['promptBy'] = null;
  if (system.isLive('imagePrompt')) {
    const { value, result } = await system.json('imagePrompt', { messages: buildImagePromptMessages(input), temperature: 0.7 }, parseImagePrompt, opts);
    prompt = value;
    promptBy = result;
  } else {
    prompt = fallbackImagePrompt(input);
  }
  if (!prompt.caption) prompt.caption = input.caption.slice(0, 30);
  const request = toImageRequest(prompt, input, opts.seed);
  opts.onStage?.('image');
  const image = await system.draw(request, opts);
  return { prompt, request, image, promptBy };
}
