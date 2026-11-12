/** 请求协议（各家的写法）。设置页里选的是渠道（ApiChannel），渠道决定用哪种协议 */
export type ConnectionKind =
  | 'openai' // OpenAI 格式（各家中转、硅基流动、Ollama……）
  | 'anthropic'
  | 'gemini'
  | 'deepseek' // DeepSeek 官方（OpenAI 格式；思考开关、推理强度、前缀续写按官网）
  | 'vertex' // Google Gemini Enterprise Agent Platform（原 Vertex AI，math-reader 里叫 Vertex Agent）：Gemini，用服务账号时也能调 DeepSeek 等开源模型
  | 'novelai'
  | 'workers-ai' // Cloudflare Workers AI（只能经 Worker 用）
  | 'minimax' // MiniMax 语音合成（t2a_v2）
  | 'volcengine' // 火山引擎豆包语音合成（v3 单向流式），支持声音复刻
  | 'fish-audio' // Fish Audio 语音合成
  | 'gpt-sovits' // 自建 GPT-SoVITS（api_v2 的 /tts）
  | 'google-maps'; // 你的真实世界：地理编码、附近地点、地图

export type Capability = 'chat' | 'vision' | 'embedding' | 'tts' | 'stt' | 'image' | 'maps';

/**
 * 渠道：API 设置里每个功能选的"哪一家"。渠道决定请求协议（ConnectionKind）、默认地址和常用模型：
 * - 文本功能（主对话、番外、总结、生图提示词、主动消息、识图）：自定义、Claude、OpenAI 兼容、Gemini、Vertex Agent、DeepSeek；
 * - 其他功能：自定义（OpenAI 格式，任意地址），以及能做这件事的几家（硅基流动、NovelAI、MiniMax……）。
 */
export type ApiChannel =
  | 'custom' // 自定义：任意地址。文本功能可选请求格式（默认 Gemini 原生，同 math-reader 的自定义渠道）；其他功能是 OpenAI 格式
  | 'anthropic' // Claude
  | 'openai' // OpenAI 兼容
  | 'gemini' // Gemini（AI Studio）
  | 'vertex' // Vertex Agent
  | 'deepseek'
  | 'siliconflow' // 硅基流动（OpenAI 格式）：向量、语音合成、语音识别、生图
  | 'novelai'
  | 'minimax'
  | 'volcengine'
  | 'fish-audio'
  | 'gpt-sovits';

/** 自定义渠道的请求格式（只有文本功能能选；其他功能固定是 OpenAI 格式） */
export type CustomFormat = 'gemini' | 'openai' | 'anthropic';

/**
 * 发给 OpenAI 格式接口之前怎么整理消息（同 SillyTavern 的 Prompt Post-Processing）：
 * - none：原样发；
 * - merge：名字写进正文，同一角色连续的消息合并；
 * - semi：再把中途的系统消息改成 user；
 * - strict：再保证系统消息后第一条是 user（不是就补一句占位）；
 * - single：全部合成一条 user 消息。
 * 有的中转或模型（DeepSeek 推理模型、转发到 Claude 的中转）要求严格的角色交替，选 semi / strict
 */
export type PromptProcessing = 'none' | 'merge' | 'semi' | 'strict' | 'single';

/** 推理强度：auto 交给模型；none 尽量不思考（DeepSeek 关掉思考模式）；其余按各家映射成 reasoning_effort / 思考预算 / 思考等级 */
export type ReasoningEffort = 'auto' | 'none' | 'min' | 'low' | 'medium' | 'high' | 'max';

/**
 * 一个功能用的 API：渠道 + 地址 + 模型。
 * Key 不在这里：单独存在这台设备的 secrets 表（键见 apiKeyId），永远不进同步数据。
 */
export interface FeatureApi {
  channel: ApiChannel;
  /** 仅自定义渠道的文本功能：请求格式，不写 = Gemini 原生（同 math-reader 的自定义渠道） */
  format?: CustomFormat;
  /** 填 Base URL（如 https://api.example.com/v1），程序按协议拼路径；也可以粘完整的 …/chat/completions */
  baseUrl: string;
  model: string;
  /** 拉取到的、手动添加的模型（选模型用） */
  models: string[];
  /**
   * 渠道专有的设置（不是 Key）：
   * - minimax：groupId（老账号的接口要带 GroupId）
   * - volcengine：appId、resourceId（默认 seed-tts-2.0；复刻的音色 S_… 自动用 seed-icl-2.0）
   * - vertex：location（默认 global）、projectId（服务账号 JSON 里有 project_id 时不用填）；只在用服务账号授权时用到
   * - 语音合成（OpenAI 格式）：emotion = 'off' 时不给 CosyVoice 加情绪指令
   */
  extra?: Record<string, string>;
  /** 额外请求头 */
  headers?: Record<string, string>;
  /** 仅 OpenAI 格式的对话：发出去之前怎么整理消息，默认 none */
  promptProcessing?: PromptProcessing;
  /** 仅 OpenAI 格式的对话：额外并入请求体的字段（同 SillyTavern 的 Include Body Parameters） */
  includeBody?: Record<string, unknown>;
  /** 仅 OpenAI 格式的对话：从请求体里去掉的字段（同 SillyTavern 的 Exclude Body Parameters） */
  excludeBody?: string[];
  /** 上次"测试连接"的结果；失败时 detail 是完整报错 */
  lastTest?: { ok: boolean; at: number; latencyMs?: number; message: string; detail?: string };
}

/** 一个功能的 Key 在 secrets 表里的键：自己的 API 是 api:main，备用 API 是 api:main:backup */
export function apiKeyId(role: AgentRole, backup = false): string {
  return `api:${role}${backup ? ':backup' : ''}`;
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

/** 功能（智能体）。每个功能单独选渠道、填地址、Key 和模型 */
export type AgentRole =
  | 'main'
  | 'companion'
  | 'sidestory'
  | 'summary'
  | 'embedding'
  | 'imagePrompt'
  | 'image'
  | 'rhythm'
  | 'proactive'
  | 'vision'
  | 'tts'
  | 'stt';

/** 文本功能可以跟随的功能：主对话，或者「陪伴 · 快速」 */
export type FollowTarget = 'main' | 'companion';

/** 一个功能的设置：用哪个 API（渠道 + 地址 + 模型）、失败时改用哪个、调用参数 */
export interface AgentRoute {
  role: AgentRole;
  /**
   * 仅主对话以外的文本功能：用哪个功能的 API（连同它的备用 API），不用自己的 api / backup；为空 = 单独设置。
   * 「陪伴 · 快速」只能跟随主对话
   */
  follow?: FollowTarget | null;
  /** 以前的"跟随主对话"开关；读的时候换成 follow（见 followOf） */
  sameAsMain?: boolean;
  /** 这个功能自己的 API；null = 还没设置 */
  api: FeatureApi | null;
  /** 调用失败时改用的 API；null = 不用 */
  backup: FeatureApi | null;
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
   * 在哪里运行：device 本机、hub 自己的 Worker（App 关着也能跑，M2）、
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
  companion: {
    label: '陪伴 · 快速',
    desc: '一起做事时的短句：场景里的即时回应、批量弹幕和批注、前情提要、台词池；生图提示词默认也用它。选便宜、快的模型',
    capability: 'chat',
    runsOn: 'client',
    icon: 'i-lucide-zap',
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
    desc: '把记忆变成向量，供本机检索',
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
    desc: '出图，结果进相册',
    capability: 'image',
    runsOn: 'worker',
    icon: 'i-lucide-image',
  },
  rhythm: {
    label: '节律',
    desc: '导入角色时建她的世界；每天排她的作息、三餐和穿着（穿着用于生图）',
    capability: 'chat',
    runsOn: 'both',
    icon: 'i-lucide-calendar-clock',
  },
  proactive: {
    label: '主动消息',
    desc: '定时规则命中后，用角色口吻写主动消息',
    capability: 'chat',
    runsOn: 'worker',
    icon: 'i-lucide-bell-ring',
  },
  vision: {
    label: '识图',
    desc: '看饭照、识别运动截图（模型要能看图）',
    capability: 'vision',
    runsOn: 'client',
    icon: 'i-lucide-scan-eye',
  },
  tts: {
    label: '语音合成',
    desc: '她说话的声音（音色在"我的 → 语音"里按角色设置）',
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

/** 文本功能（对话、识图）：渠道是自定义、Claude、OpenAI 兼容、Gemini、Vertex Agent、DeepSeek */
export function isTextRole(role: AgentRole): boolean {
  const cap = AGENT_META[role].capability;
  return cap === 'chat' || cap === 'vision';
}

/** 这个功能能跟随谁：主对话不跟随；「陪伴 · 快速」只能跟随主对话；其余文本功能能跟随主对话或「陪伴 · 快速」 */
export function followOptions(role: AgentRole): FollowTarget[] {
  if (role === 'main' || !isTextRole(role)) return [];
  return role === 'companion' ? ['main'] : ['main', 'companion'];
}

/** 这个功能现在跟随谁（以前的 sameAsMain 当作跟随主对话）；单独设置时为空 */
export function followOf(route: Pick<AgentRoute, 'role' | 'follow' | 'sameAsMain'> | undefined): FollowTarget | null {
  if (!route) return null;
  const options = followOptions(route.role);
  const target = route.follow !== undefined ? route.follow : route.sameAsMain ? 'main' : null;
  return target && options.includes(target) ? target : null;
}
