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

/**
 * 预设分类：一个预设给哪类 AI 调用用。
 * - chat 对话：主对话（聊天气泡、剧场模式），每个角色选一个；
 * - feature 功能：和她一起做事时的对话（一起吃饭、一起运动……），每件事选一个；
 * - proactive 主动消息：她先开口的那条；
 * - theater 小剧场：番外，你不在时她那边的一小段故事；
 * - summary 总结：整理聊天，写过往摘要、记忆、关系变化；
 * - image 生图：把画面写成 NovelAI tags。
 * 前三类是角色扮演，程序填充块和 SillyTavern 的对话预设一样（角色卡、世界书、聊天记录……），可以互相复制；
 * 后三类是一次性的任务，程序填充块是这件任务的输入（要整理的聊天、要画的画面……）。
 */
export type PresetCategory = 'chat' | 'feature' | 'proactive' | 'theater' | 'summary' | 'image';

export const PRESET_CATEGORIES: Record<PresetCategory, { label: string; desc: string; icon: string }> = {
  chat: { label: '对话', desc: '主对话：聊天气泡和剧场模式。每个角色选一个（角色设定 → 预设）', icon: 'i-lucide-message-circle-heart' },
  feature: { label: '功能', desc: '一起做事时的对话：一起吃饭、一起运动、陪伴学习……每件事选一个', icon: 'i-lucide-utensils' },
  proactive: { label: '主动消息', desc: '角色先开口发来的那条消息', icon: 'i-lucide-bell-ring' },
  theater: { label: '小剧场', desc: '番外：你不在的时候，角色那边发生的一小段故事', icon: 'i-lucide-book-heart' },
  summary: { label: '总结', desc: '整理聊天：写过往摘要、记下以后用得上的事、更新关系', icon: 'i-lucide-notebook-pen' },
  image: { label: '生图', desc: '生图提示词：把要画的画面写成 NovelAI tags', icon: 'i-lucide-wand-sparkles' },
};

export const PRESET_CATEGORY_ORDER: PresetCategory[] = ['chat', 'feature', 'proactive', 'theater', 'summary', 'image'];

/** 角色扮演类的预设（程序填充块相同，可以互相复制） */
export const ROLEPLAY_CATEGORIES: PresetCategory[] = ['chat', 'feature', 'proactive'];

export function isRoleplayCategory(c: PresetCategory): boolean {
  return ROLEPLAY_CATEGORIES.includes(c);
}

export interface Preset extends SyncMeta {
  name: string;
  description: string;
  /** 分类；以前存的和从 SillyTavern 导入的都是对话预设 */
  category: PresetCategory;
  /** 顺序即拼装顺序 */
  blocks: PromptBlock[];
  sampler: SamplerParams;
  formats: PresetFormats;
  regex: RegexScript[];
  /** 从 SillyTavern 导入时：用的是哪套 prompt_order（100001 是 ST 实际生效的那套） */
  source?: { kind: 'sillytavern'; orderId: number | null; fileName?: string };
  /** 从 App 自带的哪个预设文件放进来的（可以"恢复成文件里的样子"） */
  seedFile?: string;
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
  proactive: '主动消息：这一次要她做的事',
} as const;

/** App 自己的程序填充块：ST 预设里没有，导入时补进去 */
export const APP_MARKERS = ['summary', 'memory', 'environment', 'sceneRules'] as const;

/**
 * 任务类预设（小剧场、总结、生图）的程序填充块：只放这件任务每次的输入（要整理的聊天、要画的画面……）。
 * 说明、规则、输出格式都是预设里的普通块，可以改。
 */
export const TASK_MARKERS: Record<'theater' | 'summary' | 'image', Record<string, string>> = {
  theater: {
    storyCharacter: '角色',
    storyWorld: '她的世界（作息、手头的事、身边的人）',
    storyNow: '现在（时间、她在哪）',
    storyMemories: '她记得的关于你的事',
    storyRecent: '最近的聊天',
    storyPrevious: '最近写过的番外（避免重复）',
  },
  summary: {
    summaryNow: '现在',
    summaryPrevious: '上一段摘要',
    summaryMemories: '已有记忆',
    summaryTranscript: '要整理的聊天',
  },
  image: {
    imageCharacters: '两个人同框时的输出格式（只在画面里有你时填）',
    imageSubject: '角色和外观 tags',
    imageScene: '地点、服装、时间天气、表情',
    imageRecent: '最近的对话',
    imageCaption: '要画的画面',
  },
};

/** 生图预设里按"画什么"发送的块：块的触发条件写这几个值 */
export const IMAGE_MODES = { scene: '画一个场景', portrait: '全身像', face: '脸部特写', background: '只画背景' } as const;

/** 程序填充块的名字（所有分类一起查） */
export function markerName(identifier: string): string | undefined {
  const own = (PROMPT_MARKERS as Record<string, string>)[identifier];
  if (own) return own;
  for (const m of Object.values(TASK_MARKERS)) if (m[identifier]) return m[identifier];
  return undefined;
}
