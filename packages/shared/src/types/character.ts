import type { HHMM, SyncMeta } from './common.ts';

/**
 * SillyTavern V2/V3 角色卡里保留的字段，导入导出时一一对应：
 * description / personality / scenario / first_mes / alternate_greetings / mes_example /
 * system_prompt / post_history_instructions / creator_notes / tags / creator / character_version。
 * 角色卡内嵌的 character_book 导入时拆成独立的世界书，再通过 lorebookIds 绑定。
 */
export interface StCardFields {
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  alternateGreetings: string[];
  /** 示例对话，ST 习惯用 <START> 分段 */
  mesExample: string;
  /** 角色卡自带的 system prompt，可在预设里选择是否覆盖主提示 */
  systemPrompt: string;
  postHistoryInstructions: string;
  creatorNotes: string;
  tags: string[];
  creator?: string;
  characterVersion?: string;
}

/** 主动消息的性格：决定频率，以及没回复时会不会追发 */
export type ProactivePersonality = 'clingy' | 'balanced' | 'independent';

export interface CharacterVoice {
  /** TTS 连接 id（ProviderConnection） */
  connectionId: string | null;
  /** 音色 id 或参考音频 id */
  voiceId: string;
  voiceLabel: string;
  speed: number;
  pitch?: number;
  /** 表情 → TTS 情绪参数，例如 { blush: 'shy', sad: 'sad' } */
  emotionMap: Record<string, string>;
}

export interface CharacterProactive {
  enabled: boolean;
  personality: ProactivePersonality;
  dailyCap: number;
  quietHours: { start: HHMM; end: HHMM };
  /** 开启的触发器 id，见 ProactiveTriggerId */
  triggers: string[];
  /** 允许 AI 主动来电（叫醒、想你了） */
  allowCalls: boolean;
  /** 允许 AI 主动发"自拍"（走 NovelAI） */
  allowSelfies: boolean;
}

/** 由总结智能体维护的关系状态 */
export interface Relationship {
  affection: number;
  mood: string;
  /** 她怎么叫你 */
  userNickname: string;
  /** 你怎么叫她 */
  charNickname: string;
  metAt: number;
  anniversaries: { label: string; date: string }[];
  milestones: { label: string; at: number }[];
}

export interface Character extends SyncMeta {
  name: string;
  /** 资源 key（R2 内容哈希）；为空时用占位头像 */
  avatar: string | null;
  /** 角色主题色，界面点缀色跟随它 */
  accent: string;
  /** 占位立绘用的发色（真立绘导入后不再需要） */
  hairColor: string;
  card: StCardFields;
  lorebookIds: string[];
  presetId: string | null;
  spriteSetId: string | null;
  /** NovelAI 外观基础 tags，生图提示词智能体会在此基础上补动作、服装、场景 */
  appearanceTags: string;
  negativeTags: string;
  voice: CharacterVoice;
  proactive: CharacterProactive;
  relationship: Relationship;
  /** 状态行，例如"自习中" */
  status: string;
}

/** 用户人设（ST 的 Persona） */
export interface Persona extends SyncMeta {
  name: string;
  avatar: string | null;
  description: string;
  isDefault: boolean;
}
