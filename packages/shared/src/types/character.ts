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
  /**
   * 角色卡 data.extensions 原样保存（depth_prompt、world、talkativeness、regex_scripts……）。
   * depth_prompt 在拼提示词时按深度插入；其余导出时原样写回。
   */
  extensions: Record<string, unknown>;
  /** data 里其他没有对应字段的内容（V3 的 assets、nickname、group_only_greetings、creation_date……），导出时原样写回 */
  extra: Record<string, unknown>;
}

/** 主动消息的性格：决定频率，以及没回复时会不会追发 */
export type ProactivePersonality = 'clingy' | 'balanced' | 'independent';

export interface CharacterVoice {
  /** TTS 连接 id（ProviderConnection）；为空时用"语音合成"智能体分配的连接 */
  connectionId: string | null;
  /**
   * 音色：
   * - OpenAI 兼容 / 硅基流动：voice 字段（如 FunAudioLLM/CosyVoice2-0.5B:claire，或上传音色得到的 speech:…）
   * - MiniMax：voice_id；Fish Audio：reference_id（模型页上的 id）
   * - GPT-SoVITS：参考音频在服务器上的路径（ref_audio_path）
   */
  voiceId: string;
  voiceLabel: string;
  speed: number;
  pitch?: number;
  /** 表情 → TTS 情绪参数，例如 { blush: 'shy', sad: 'sad' }。没写的表情按服务商的默认映射 */
  emotionMap: Record<string, string>;
  /** 这个角色单独用的 TTS 模型；为空时用智能体分配里的模型 */
  model?: string;
  /** 基础说话风格（CosyVoice 的指令、gpt-4o-mini-tts 的 instructions），例如"温柔、语速稍慢" */
  style?: string;
  /** 仅 GPT-SoVITS：参考音频里说的话、语言（zh / ja / en …） */
  refText?: string;
  refLang?: string;
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
  /** 界面里怎么称呼：她 / 他 / TA（"她叫你…""去找他"） */
  pronoun: '她' | '他' | 'TA';
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
  /** 状态行，例如"在图书馆自习" */
  status: string;
  /**
   * 她此刻在哪：通常是她自己小世界里的地点（World.locations 的 id），由模拟作息更新；
   * 你带她去真实世界的地方时，暂时是那个真实地点，离开后回到她的世界
   */
  locationId: string | null;
}

/** 用户人设（ST 的 Persona） */
export interface Persona extends SyncMeta {
  name: string;
  avatar: string | null;
  description: string;
  isDefault: boolean;
}
