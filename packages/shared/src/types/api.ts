import type { SyncMeta } from './common.ts';

/** 连接的协议类型 */
export type ConnectionKind =
  | 'openai' // OpenAI 兼容（各家中转、DeepSeek、硅基流动、Ollama……）
  | 'anthropic'
  | 'gemini'
  | 'novelai'
  | 'workers-ai' // Cloudflare Workers AI（只能经 Worker 用）
  | 'minimax' // MiniMax 语音合成（t2a_v2）
  | 'volcengine' // 火山引擎豆包语音合成（v3 单向流式），支持声音复刻
  | 'fish-audio' // Fish Audio 语音合成
  | 'gpt-sovits' // 自建 GPT-SoVITS（api_v2 的 /tts）
  | 'google-maps'; // 你的真实世界：地理编码、附近地点、地图

export type Capability = 'chat' | 'vision' | 'embedding' | 'tts' | 'stt' | 'image' | 'maps';

/**
 * Key 存在哪里（按连接设置，不按智能体）：
 * - device：只存本机（默认）。同步记录里永远没有 Key；可选用同步密码加密后在设备间传递
 * - hub：交给自己的 Worker 保管，只能写入、不能读回（用 Worker secret 加密）。
 *        后台智能体（主动消息、夜间总结、生图）只能用这一档；其他设备经 Worker 转发也能用，但看不到明文
 * - none：不需要 Key（本地 Ollama、Workers AI 等）
 */
export type KeyStorage = 'device' | 'hub' | 'none';

/**
 * 发给 OpenAI 兼容接口之前怎么整理消息（同 SillyTavern 的 Prompt Post-Processing）：
 * - none：原样发；
 * - merge：名字写进正文，同一角色连续的消息合并；
 * - semi：再把中途的系统消息改成 user；
 * - strict：再保证系统消息后第一条是 user（不是就补一句占位）；
 * - single：全部合成一条 user 消息。
 * 有的中转或模型（DeepSeek 推理模型、转发到 Claude 的中转）要求严格的角色交替，选 semi / strict
 */
export type PromptProcessing = 'none' | 'merge' | 'semi' | 'strict' | 'single';

/** 推理强度（同 SillyTavern）：auto 交给模型；其余按各家映射成 reasoning_effort / 思考预算 / 思考等级 */
export type ReasoningEffort = 'auto' | 'min' | 'low' | 'medium' | 'high' | 'max';

/** 一个 API 连接。同步数据里只有 keyStorage 和 hasKey，没有 Key 本身 */
export interface ProviderConnection extends SyncMeta {
  name: string;
  kind: ConnectionKind;
  /** 填 Base URL（如 https://api.example.com/v1），程序按协议拼路径 */
  baseUrl: string;
  keyStorage: KeyStorage;
  hasKey: boolean;
  capabilities: Capability[];
  models: string[];
  /** 对方不允许浏览器直连（没有 CORS）时，经自己的 Worker 转发 */
  viaWorker: boolean;
  extraHeaders?: Record<string, string>;
  /**
   * 服务商专有的设置（不是 Key，可以同步）：
   * - minimax：groupId（老账号的接口要带 GroupId）
   * - volcengine：appId、resourceId（默认 seed-tts-2.0；复刻的音色 S_… 自动用 seed-icl-2.0）
   * - workers-ai：accountId（直连 Cloudflare 时用；经自己的 Worker 时不需要）
   * - openai 语音合成：emotion = 'off' 时不给 CosyVoice 加情绪指令
   */
  extra?: Record<string, string>;
  /** 仅 OpenAI 兼容的对话：发出去之前怎么整理消息，默认 none */
  promptProcessing?: PromptProcessing;
  /** 仅 OpenAI 兼容的对话：额外并入请求体的字段（同 SillyTavern 的 Include Body Parameters） */
  includeBody?: Record<string, unknown>;
  /** 仅 OpenAI 兼容的对话：从请求体里去掉的字段（同 SillyTavern 的 Exclude Body Parameters） */
  excludeBody?: string[];
  lastTest?: { ok: boolean; at: number; latencyMs?: number; message?: string };
}

/** 生图风格（生图智能体用）：固定的前后缀和负面词、采样器，同 SleepTogether / SillyTavern 的生图设置 */
export interface ImageStyle {
  /** 拼在提示词前面的画风 / 质量词；含 {prompt} 时把提示词放在那个位置（同 SillyTavern） */
  prefix: string;
  /** 拼在提示词后面的词 */
  suffix: string;
  /** 固定的负面词 */
  negative: string;
  /** 按 NovelAI 网页版追加这个模型的质量词和负面预设（服务端不会自动加） */
  naiQuality: boolean;
  sampler?: string;
  /** NovelAI 的 noise_schedule：native / karras / exponential / polyexponential */
  schedule?: string;
  steps?: number;
  scale?: number;
  /** NovelAI 的 Variety Boost（同 SillyTavern：按画面大小算 skip_cfg_above_sigma） */
  varietyBoost?: boolean;
}

/** 朗读前怎么处理文字（同 SillyTavern 的 TTS 设置） */
export interface TtsTextOptions {
  /** 只读引号里的话（“…” "…" 「…」 『…』 «…»） */
  quotedOnly: boolean;
  /** 星号包住的动作：drop 整段不读（默认），keep 只去掉星号 */
  asterisks: 'drop' | 'keep';
  /** 括号里的动作、神态：drop 不读（默认），keep 照读 */
  parentheses: 'drop' | 'keep';
  /** 不读代码块、<标签>…</标签>（状态栏之类），默认都不读 */
  skipCodeBlocks: boolean;
  skipTags: boolean;
  /** 自定义要去掉的正则，例如 /【.*?】/g */
  regex?: string;
}

/** 智能体角色。每个角色单独选"连接 + 模型 + 备用连接" */
export type AgentRole =
  | 'main'
  | 'sidestory'
  | 'summary'
  | 'embedding'
  | 'imagePrompt'
  | 'image'
  | 'proactive'
  | 'vision'
  | 'tts'
  | 'stt';

export interface AgentRoute {
  role: AgentRole;
  connectionId: string | null;
  model: string;
  fallbackConnectionId: string | null;
  fallbackModel?: string;
  params?: Partial<{
    temperature: number;
    maxTokens: number;
    topP: number;
    /** 推理强度，按各家映射（OpenAI reasoning_effort、Claude 思考预算、Gemini thinkingBudget / thinkingLevel） */
    reasoningEffort: ReasoningEffort;
    /** 要模型返回思考内容（同 SillyTavern 的 Show thoughts / Request model reasoning） */
    includeReasoning: boolean;
  }>;
  /**
   * 在哪里运行：device 本机、hub 自己的 Worker（App 关着也能跑，要求连接的 Key 存在 hub）、
   * auto 本机在线时本机跑，否则 Worker 补上
   */
  runsOn: 'device' | 'hub' | 'auto';
  /** 每日 token 上限，防止后台智能体跑飞 */
  dailyTokenBudget?: number;
  /** 仅 embedding：当前向量维度。换模型后用于判断哪些记忆要重算 */
  dims?: number;
  /**
   * 原样并入请求体的其他字段，例如向量化的 dimensions / input_type、NovelAI 的 sampler。
   * 只放服务商文档里有的字段；不认识的字段多数接口会报 400
   */
  extra?: Record<string, unknown>;
  /** 仅 image：生图风格 */
  imageStyle?: ImageStyle;
  /** 仅 tts：朗读前怎么处理文字 */
  ttsText?: TtsTextOptions;
}

export const AGENT_META: Record<
  AgentRole,
  { label: string; desc: string; capability: Capability; runsOn: 'client' | 'worker' | 'both'; icon: string }
> = {
  main: {
    label: '主对话',
    desc: '角色扮演回复，夹带表情等隐藏标签',
    capability: 'chat',
    runsOn: 'client',
    icon: 'i-lucide-message-circle-heart',
  },
  sidestory: {
    label: '番外 · 她的生活',
    desc: '你不在的时候她那边发生了什么：按她的作息、地点和身边的人写一小段故事，可以引出主动消息或配图',
    capability: 'chat',
    runsOn: 'both',
    icon: 'i-lucide-book-heart',
  },
  summary: {
    label: '总结 / 记忆',
    desc: '滚动摘要、抽取记忆条目、写日记、更新关系状态',
    capability: 'chat',
    runsOn: 'both',
    icon: 'i-lucide-notebook-pen',
  },
  embedding: {
    label: '向量化',
    desc: '把记忆变成向量，供本机检索。任意 OpenAI 兼容 /embeddings 都可以',
    capability: 'embedding',
    runsOn: 'both',
    icon: 'i-lucide-waypoints',
  },
  imagePrompt: {
    label: '生图提示词',
    desc: '把对话场景写成 NovelAI tags',
    capability: 'chat',
    runsOn: 'both',
    icon: 'i-lucide-wand-sparkles',
  },
  image: {
    label: '生图',
    desc: 'NovelAI 出图，结果进相册',
    capability: 'image',
    runsOn: 'worker',
    icon: 'i-lucide-image',
  },
  proactive: {
    label: '主动消息',
    desc: '定时规则命中后，用角色口吻写主动消息',
    capability: 'chat',
    runsOn: 'worker',
    icon: 'i-lucide-bell-ring',
  },
  vision: {
    label: '视觉',
    desc: '看饭照、识别运动截图',
    capability: 'vision',
    runsOn: 'client',
    icon: 'i-lucide-scan-eye',
  },
  tts: {
    label: '语音合成',
    desc: '角色说话的声音（按角色单独设置音色）',
    capability: 'tts',
    runsOn: 'client',
    icon: 'i-lucide-audio-lines',
  },
  stt: {
    label: '语音识别',
    desc: '语音消息和通话里听懂你说的话',
    capability: 'stt',
    runsOn: 'client',
    icon: 'i-lucide-mic',
  },
};
