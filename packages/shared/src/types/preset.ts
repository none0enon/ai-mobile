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
  /**
   * relative：按列表顺序；absolute：插到聊天历史倒数第 depth 条之前（ST 的 in-chat）。
   * order 是同一深度里的先后（ST 的 injection_order，数字大的更靠后，默认 100）
   */
  injection: { position: 'relative' | 'absolute'; depth: number; order?: number };
  /** 不让角色卡的 system_prompt / post_history_instructions 覆盖这一块（ST 的 forbid_overrides） */
  forbidOverrides?: boolean;
  /** 只在这些生成类型里发送；为空表示都发送（ST 的 injection_trigger） */
  triggers?: string[];
  /** 这一块是 App 自己补的（记忆、环境、场景规则……），不是来自导入的预设 */
  origin?: 'app';
  /** ST 里其余没有对应字段的设置（system_prompt 等），导出时原样写回 */
  extra?: Record<string, unknown>;
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
  /** 随机种子，小于 0 表示不传 */
  seed?: number;
}

/** ST 预设里控制拼装细节的文字和开关 */
export interface PresetFormats {
  /** 聊天记录开头插的一条系统消息（ST 的 new_chat_prompt，例如"[Start a new Chat]"） */
  newChatPrompt: string;
  /** 每段示例对话前的系统消息（new_example_chat_prompt） */
  newExampleChatPrompt: string;
  /** 继续生成时的提示（continue_nudge_prompt） */
  continueNudgePrompt: string;
  /** 代你说话时的提示（impersonation_prompt） */
  impersonationPrompt: string;
  /** 最后一条是她的消息时补一条你的消息（send_if_empty） */
  sendIfEmpty: string;
  /** 世界书包装格式，{0} 是内容（wi_format） */
  wiFormat: string;
  /** 场景的包装格式（scenario_format），可用 {{scenario}} */
  scenarioFormat: string;
  /** 性格的包装格式（personality_format），可用 {{personality}} */
  personalityFormat: string;
  /** 消息里带不带名字：-1 不带 / 0 默认（单人聊天不带）/ 1 写进 name 字段 / 2 写进正文"名字: " */
  namesBehavior: -1 | 0 | 1 | 2;
  /** 把相邻的系统消息合成一条 */
  squashSystemMessages: boolean;
  /** 角色卡的 system_prompt 覆盖主提示 */
  preferCharacterPrompt: boolean;
  /** 角色卡的 post_history_instructions 覆盖后置指令 */
  preferCharacterJailbreak: boolean;
}

export const DEFAULT_PRESET_FORMATS: PresetFormats = {
  newChatPrompt: '',
  newExampleChatPrompt: '',
  continueNudgePrompt: '',
  impersonationPrompt: '',
  sendIfEmpty: '',
  wiFormat: '{0}',
  scenarioFormat: '{{scenario}}',
  personalityFormat: '{{personality}}',
  namesBehavior: 0,
  squashSystemMessages: false,
  preferCharacterPrompt: true,
  preferCharacterJailbreak: true,
};

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
  formats: PresetFormats;
  regex: RegexScript[];
  /** 从 SillyTavern 导入时：用的是哪套 prompt_order（100001 是 ST 实际生效的那套） */
  source?: { kind: 'sillytavern'; orderId: number | null; fileName?: string };
  /** 导入时其余没有对应字段的设置（reasoning_effort、bias、扩展……），导出时原样写回 */
  extra?: Record<string, unknown>;
}

/** 程序会填充的 marker 块（App 自己扩展了记忆、摘要、环境、场景四块） */
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

/** App 自己的程序填充块：ST 预设里没有，导入时补进去 */
export const APP_MARKERS = ['summary', 'memory', 'environment', 'sceneRules'] as const;
