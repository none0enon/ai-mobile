import type { Preset, SamplerParams } from '@app/shared';
import type { ChatRequest } from '../llm/types.ts';

/**
 * 任务类智能体（番外、总结、生图提示词）的提示词全在预设里（分类：小剧场、总结、生图），调用方必须给预设：
 * 说明、规则、输出格式是预设里的普通块，这一次的输入由这里的 *Fills 填进程序填充块。
 * App 自带的那几个预设是 apps/web/src/presets/ 里的预设文件。
 */
export type TaskPreset = Pick<Preset, 'blocks' | 'sampler'>;

/** 预设的采样参数 → 请求字段（以预设为准）。top_p 是 1、惩罚是 0 时不发，免得有的模型不收 */
export function samplerRequest(s: SamplerParams): Pick<ChatRequest, 'temperature' | 'topP' | 'maxTokens' | 'frequencyPenalty' | 'presencePenalty'> {
  return {
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    ...(s.topP > 0 && s.topP < 1 ? { topP: s.topP } : {}),
    ...(s.frequencyPenalty ? { frequencyPenalty: s.frequencyPenalty } : {}),
    ...(s.presencePenalty ? { presencePenalty: s.presencePenalty } : {}),
  };
}
