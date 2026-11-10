import type { SyncMeta } from './common.ts';

/** 连接的协议类型 */
export type ConnectionKind =
  | 'openai' // OpenAI 兼容（各家中转、DeepSeek、硅基流动、Ollama……）
  | 'anthropic'
  | 'gemini'
  | 'novelai'
  | 'workers-ai' // Cloudflare Workers AI（只能经 Worker 用）
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
  lastTest?: { ok: boolean; at: number; latencyMs?: number; message?: string };
}

/** 智能体角色。每个角色单独选"连接 + 模型 + 备用连接" */
export type AgentRole =
  | 'main'
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
  params?: Partial<{ temperature: number; maxTokens: number; topP: number }>;
  /**
   * 在哪里运行：device 本机、hub 自己的 Worker（App 关着也能跑，要求连接的 Key 存在 hub）、
   * auto 本机在线时本机跑，否则 Worker 补上
   */
  runsOn: 'device' | 'hub' | 'auto';
  /** 每日 token 上限，防止后台智能体跑飞 */
  dailyTokenBudget?: number;
  /** 仅 embedding：当前向量维度。换模型后用于判断哪些记忆要重算 */
  dims?: number;
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
