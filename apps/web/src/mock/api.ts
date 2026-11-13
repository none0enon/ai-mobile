import { newFeatureApi } from '@app/ai';
import type { AgentRoute } from '@app/shared';

/**
 * 第一次打开时各功能的设置。API 设置按功能分：每个功能自己选渠道、填地址、Key、模型。
 * - 主对话还没设置：选渠道、填 Key 之后真的调用；
 * - 「陪伴 · 快速」先跟随主对话，想用便宜快的模型就单独设置；
 * - 生图提示词、节律、控制指令跟随「陪伴 · 快速」；番外、创作 · 小说、总结、健康计划、主动消息、识图跟随主对话；
 * - 向量化、语音合成、语音识别先选好硅基流动，生图先选好 NovelAI，只差 Key。
 * 没填 Key 的功能继续用演示模型，所以不填也能逛。
 */
export function defaultRoutes(): AgentRoute[] {
  return [
    { role: 'main', api: null, backup: null, runsOn: 'device', params: { temperature: 0.9 } },
    { role: 'companion', follow: 'main', api: null, backup: null, runsOn: 'device' },
    { role: 'sidestory', follow: 'main', api: null, backup: null, runsOn: 'auto', params: { temperature: 1 }, dailyTokenBudget: 60_000 },
    // 创意工坊写小说：要写长文，默认跟随主对话（想用文笔更好、上下文更长的模型就单独设置）
    { role: 'novel', follow: 'main', api: null, backup: null, runsOn: 'device', params: { temperature: 1 } },
    { role: 'summary', follow: 'main', api: null, backup: null, runsOn: 'auto' },
    { role: 'consolidate', follow: 'main', api: null, backup: null, runsOn: 'hub' },
    { role: 'embedding', api: newFeatureApi('siliconflow', 'embedding'), backup: null, runsOn: 'auto', dims: 1024 },
    { role: 'imagePrompt', follow: 'companion', api: null, backup: null, runsOn: 'auto' },
    { role: 'image', api: newFeatureApi('novelai', 'image'), backup: null, runsOn: 'hub' },
    { role: 'rhythm', follow: 'companion', api: null, backup: null, runsOn: 'auto' },
    // 健康计划要写清楚动作怎么做、菜怎么做：默认跟随主对话（比「陪伴 · 快速」写得细）
    { role: 'health', follow: 'main', api: null, backup: null, runsOn: 'device' },
    // 心跳的控制指令：要快，默认跟随「陪伴 · 快速」
    { role: 'device', follow: 'companion', api: null, backup: null, runsOn: 'device' },
    // 主动消息不设每日 token 上限：设了的话消息一多就被拦住，看起来像她不来找你了（要省钱可以在 API 设置里自己填）
    { role: 'proactive', follow: 'main', api: null, backup: null, runsOn: 'hub' },
    { role: 'vision', follow: 'main', api: null, backup: null, runsOn: 'device' },
    { role: 'tts', api: newFeatureApi('siliconflow', 'tts'), backup: null, runsOn: 'device' },
    { role: 'stt', api: newFeatureApi('siliconflow', 'stt'), backup: null, runsOn: 'device' },
  ];
}
