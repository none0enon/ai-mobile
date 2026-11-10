import type { SyncMeta } from './common.ts';

/**
 * 预设里的一块提示词，对应 ST Chat Completion 预设的 prompts[] + prompt_order。
 * marker 块不写内容，由程序填充：角色描述、世界书、聊天历史、记忆、当前环境、场景规则等。
 */
export interface PromptBlock {
  identifier: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  marker: boolean;
  enabled: boolean;
  /** relative：按列表顺序；absolute：插到聊天历史倒数第 depth 条之前 */
  injection: { position: 'relative' | 'absolute'; depth: number };
}

export interface SamplerParams {
  temperature: number;
  topP: number;
  topK?: number;
  maxTokens: number;
  /** 上下文 token 预算（聊天历史按它截断） */
  contextTokens: number;
  frequencyPenalty: number;
  presencePenalty: number;
  stream: boolean;
}

export interface RegexScript {
  id: string;
  name: string;
  find: string;
  replace: string;
  placement: ('user_input' | 'ai_output')[];
  enabled: boolean;
}

export interface Preset extends SyncMeta {
  name: string;
  description: string;
  /** 顺序即拼装顺序 */
  blocks: PromptBlock[];
  sampler: SamplerParams;
  regex: RegexScript[];
}

/** 程序会填充的 marker 块（App 自己扩展了记忆、环境、场景三块） */
export const PROMPT_MARKERS = {
  worldInfoBefore: '世界书（角色前）',
  charDescription: '角色描述',
  charPersonality: '角色性格',
  scenario: '场景',
  worldInfoAfter: '世界书（角色后）',
  personaDescription: '用户人设',
  dialogueExamples: '示例对话',
  memory: '长期记忆 + 关系状态',
  summary: '过往摘要',
  environment: '当前环境',
  sceneRules: '当前场景规则 + 可用标签',
  chatHistory: '聊天历史',
} as const;
