import { AGENT_META, isTextRole, type AgentRole, type ApiChannel, type Capability, type ConnectionKind, type CustomFormat, type FeatureApi } from '@app/shared';
import { DEEPSEEK_DEFAULT_URL, VERTEX_DEFAULT_URL } from './core/endpoint.ts';
import { NOVELAI_MODELS } from './image/presets.ts';

/**
 * 渠道表：API 设置按功能分，每个功能选一个渠道，再填地址、Key、模型。
 * 渠道决定请求协议（ConnectionKind）、默认地址和常用模型。
 */

/** Vertex Agent 的常用模型（Gemini 来自 math-reader 和官方 express 模式的模型表；DeepSeek 来自官方的 DeepSeek 模型页） */
export const VERTEX_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'deepseek-ai/deepseek-v4.1-flash-maas',
];

const GEMINI_MODELS = VERTEX_MODELS.filter((m) => m.startsWith('gemini-'));

export interface ChannelInfo {
  id: ApiChannel;
  label: string;
  /** 换到这个渠道时填上的地址；空 = 要自己填 */
  baseUrl: string;
  /** 地址框的提示 */
  urlPlaceholder: string;
  /** 一句话说明（设置页显示在渠道下面） */
  hint: string;
  /** 各功能的常用模型（拉不到列表时可以直接点） */
  models: Partial<Record<Capability, string[]>>;
  /** 不用填 Key */
  keyless?: boolean;
  /** Key 框的名字和提示 */
  keyLabel?: string;
  keyPlaceholder?: string;
}

export const CHANNELS: Record<ApiChannel, ChannelInfo> = {
  custom: {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    urlPlaceholder: 'https://你的中转地址/v1',
    hint: '任意地址。文本功能选请求格式（默认 Gemini 原生，同 math-reader 的自定义渠道）；其他功能按 OpenAI 格式请求',
    models: {},
  },
  anthropic: {
    id: 'anthropic',
    label: 'Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    urlPlaceholder: 'https://api.anthropic.com/v1',
    hint: 'Anthropic Messages 接口（官方，或兼容 Claude 原生格式的中转）；中转只给 …/chat/completions 时粘完整地址，按 OpenAI 格式发',
    models: { chat: ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
    keyPlaceholder: 'sk-ant-…',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    urlPlaceholder: 'https://api.openai.com/v1 或中转地址',
    hint: 'OpenAI 格式（官方、各家中转、OpenRouter、Ollama……）。填 Base URL，也可以粘完整的 …/chat/completions',
    models: {},
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    urlPlaceholder: 'https://generativelanguage.googleapis.com/v1beta',
    hint: 'Google AI Studio 的 Gemini 原生接口，Key 放在 key 参数',
    models: { chat: GEMINI_MODELS, embedding: ['gemini-embedding-001'] },
    keyPlaceholder: 'AIza…',
  },
  vertex: {
    id: 'vertex',
    label: 'Vertex Agent',
    baseUrl: VERTEX_DEFAULT_URL,
    urlPlaceholder: VERTEX_DEFAULT_URL,
    hint: 'API Key（express 模式，同 math-reader）只能调 Gemini；粘贴服务账号 JSON 还能调 DeepSeek 等开源模型',
    models: { chat: VERTEX_MODELS },
    keyLabel: 'Key（API Key 或服务账号 JSON）',
    keyPlaceholder: 'API Key，或 {"type": "service_account", …}',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: DEEPSEEK_DEFAULT_URL,
    urlPlaceholder: DEEPSEEK_DEFAULT_URL,
    hint: 'DeepSeek 官方（OpenAI 格式）：思考开关、推理强度、前缀续写按官网',
    models: { chat: ['deepseek-chat', 'deepseek-reasoner'] },
  },
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    urlPlaceholder: 'https://api.siliconflow.cn/v1',
    hint: 'OpenAI 格式：/embeddings、/audio/speech（CosyVoice）、/audio/transcriptions、/images/generations',
    models: {
      embedding: ['BAAI/bge-m3', 'Qwen/Qwen3-Embedding-8B', 'Pro/BAAI/bge-m3'],
      tts: ['FunAudioLLM/CosyVoice2-0.5B'],
      stt: ['FunAudioLLM/SenseVoiceSmall'],
      image: ['Kwai-Kolors/Kolors'],
    },
  },
  novelai: {
    id: 'novelai',
    label: 'NovelAI',
    baseUrl: 'https://image.novelai.net',
    urlPlaceholder: 'https://image.novelai.net（公益站、反代填它给的地址）',
    hint: '官方填 https://image.novelai.net；公益站、反代填它给的地址，Key 填它给的 Token',
    models: { image: NOVELAI_MODELS },
    keyLabel: 'Key（持久 API Token，pst- 开头）',
    keyPlaceholder: 'pst-…',
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    urlPlaceholder: 'https://api.minimaxi.com/v1（海外用 https://api.minimax.io/v1）',
    hint: 'MiniMax 语音合成 t2a_v2；海外账号地址换成 https://api.minimax.io/v1',
    models: { tts: ['speech-02-hd', 'speech-02-turbo', 'speech-2.5-hd-preview', 'speech-2.5-turbo-preview'] },
  },
  volcengine: {
    id: 'volcengine',
    label: '火山引擎',
    baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    urlPlaceholder: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    hint: '豆包语音合成（v3 单向流式），可以复刻声音；还要填 APP ID',
    // 火山引擎的"模型"就是 Resource ID
    models: { tts: ['seed-tts-2.0', 'seed-tts-1.0', 'seed-icl-2.0', 'seed-icl-1.0'] },
    keyLabel: 'Key（Access Token）',
    keyPlaceholder: 'Access Token',
  },
  'fish-audio': {
    id: 'fish-audio',
    label: 'Fish Audio',
    baseUrl: 'https://api.fish.audio',
    urlPlaceholder: 'https://api.fish.audio',
    hint: 'Fish Audio 语音合成；音色填模型页上的 reference_id',
    models: { tts: ['s1', 'speech-1.6', 'speech-1.5'] },
  },
  'gpt-sovits': {
    id: 'gpt-sovits',
    label: 'GPT-SoVITS',
    baseUrl: 'http://127.0.0.1:9880',
    urlPlaceholder: 'http://127.0.0.1:9880',
    hint: '自建 GPT-SoVITS（api_v2 的 /tts）；音色填参考音频在服务器上的路径',
    models: { tts: ['gpt-sovits'] },
    keyless: true,
  },
};

/** 文本功能的渠道（按 math-reader 的顺序：自定义、Claude、OpenAI 兼容、Gemini、Vertex Agent、DeepSeek） */
export const TEXT_CHANNELS: readonly ApiChannel[] = ['custom', 'anthropic', 'openai', 'gemini', 'vertex', 'deepseek'];

/** 其他功能能选的渠道：自定义（OpenAI 格式）+ 能做这件事的几家 */
const OTHER_CHANNELS: Partial<Record<Capability, readonly ApiChannel[]>> = {
  embedding: ['custom', 'siliconflow', 'gemini'],
  tts: ['custom', 'siliconflow', 'minimax', 'volcengine', 'fish-audio', 'gpt-sovits'],
  image: ['custom', 'novelai', 'siliconflow'],
  stt: ['custom', 'siliconflow'],
};

export function channelsFor(role: AgentRole): readonly ApiChannel[] {
  if (isTextRole(role)) return TEXT_CHANNELS;
  return OTHER_CHANNELS[AGENT_META[role].capability] ?? ['custom'];
}

export const CUSTOM_FORMAT_LABEL: Record<CustomFormat, string> = { gemini: 'Gemini 格式', openai: 'OpenAI 格式', anthropic: 'Claude 格式' };

/** 这个功能用这个 API 时按哪种协议发请求 */
export function kindOf(api: Pick<FeatureApi, 'channel' | 'format'>, role: AgentRole): ConnectionKind {
  switch (api.channel) {
    case 'custom':
      // 自定义：文本功能按选的格式（默认 Gemini，同 math-reader），其他功能是 OpenAI 格式
      return isTextRole(role) ? (api.format ?? 'gemini') : 'openai';
    case 'siliconflow':
      return 'openai';
    default:
      return api.channel;
  }
}

/** 这个渠道给这个功能的常用模型 */
export function channelModels(channel: ApiChannel, role: AgentRole): string[] {
  const m = CHANNELS[channel].models;
  const cap = AGENT_META[role].capability;
  return [...(m[cap] ?? (cap === 'vision' ? m.chat : undefined) ?? [])];
}

/** 新选一个渠道时的设置：默认地址、常用模型，第一个模型选上 */
export function newFeatureApi(channel: ApiChannel, role: AgentRole): FeatureApi {
  const models = channelModels(channel, role);
  return { channel, baseUrl: CHANNELS[channel].baseUrl, model: models[0] ?? '', models };
}

/** "Claude"、"自定义（OpenAI 格式）"：报错和状态里用 */
export function apiLabel(api: Pick<FeatureApi, 'channel' | 'format'>, role: AgentRole): string {
  const label = CHANNELS[api.channel]?.label ?? api.channel;
  if (api.channel === 'custom' && isTextRole(role)) return `${label}（${CUSTOM_FORMAT_LABEL[api.format ?? 'gemini']}）`;
  return label;
}

/** 本机、局域网的地址（自建服务）：可以不填 Key */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.replace(/^\[|\]$/g, '');
    return (
      host === 'localhost' ||
      host === '::1' ||
      host.endsWith('.local') ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
    );
  } catch {
    return false;
  }
}

/** 这个 API 要不要 Key：自建的 GPT-SoVITS、本机和局域网的服务可以不填 */
export function needsKey(api: Pick<FeatureApi, 'channel' | 'baseUrl'>): boolean {
  return !CHANNELS[api.channel]?.keyless && !isLocalUrl(api.baseUrl);
}
