import type { AgentRoute, Capability, ConnectionKind, KeyStorage, ProviderConnection } from '@app/shared';
import { at } from '@/utils/time';

const t = at(-5, '21:00');

/**
 * 第一次打开时的连接：常见的几家，地址和模型都填好了，只差 Key。
 * Key 只存在这台设备上（我的 → API 与智能体 → 点连接填）。没填 Key 的智能体继续用演示模型，所以不填也能逛。
 * "中转站 A"是示例地址，换成你自己的中转。
 */
export const connections: ProviderConnection[] = [
  {
    id: 'conn-relay',
    createdAt: t,
    updatedAt: t,
    name: '中转站 A',
    kind: 'openai',
    baseUrl: 'https://api.relay-example.com/v1',
    keyStorage: 'device',
    hasKey: false,
    capabilities: ['chat', 'vision'],
    models: ['relay-main-model', 'relay-fast-model', 'deepseek-chat'],
    viaWorker: false,
  },
  {
    id: 'conn-deepseek',
    createdAt: t,
    updatedAt: t,
    name: 'DeepSeek 官方',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    keyStorage: 'device',
    hasKey: false,
    capabilities: ['chat'],
    models: ['deepseek-chat', 'deepseek-reasoner'],
    viaWorker: false,
  },
  {
    id: 'conn-gemini',
    createdAt: t,
    updatedAt: t,
    name: 'Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyStorage: 'device',
    hasKey: false,
    capabilities: ['chat', 'vision', 'embedding'],
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-embedding-001'],
    viaWorker: false,
  },
  {
    id: 'conn-sf',
    createdAt: t,
    updatedAt: t,
    name: '硅基流动',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyStorage: 'device',
    hasKey: false,
    capabilities: ['embedding', 'tts', 'stt', 'chat'],
    models: ['BAAI/bge-m3', 'Qwen/Qwen3-Embedding-8B', 'FunAudioLLM/CosyVoice2-0.5B', 'FunAudioLLM/SenseVoiceSmall'],
    viaWorker: false,
  },
  {
    id: 'conn-nai',
    createdAt: t,
    updatedAt: t,
    name: 'NovelAI',
    kind: 'novelai',
    baseUrl: 'https://image.novelai.net',
    keyStorage: 'device',
    hasKey: false,
    capabilities: ['image'],
    models: ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'],
    viaWorker: false,
  },
  {
    id: 'conn-cf',
    createdAt: t,
    updatedAt: t,
    name: 'Workers AI（免费）',
    kind: 'workers-ai',
    baseUrl: '经自己的 Worker',
    keyStorage: 'none',
    hasKey: false,
    capabilities: ['embedding'],
    models: ['@cf/baai/bge-m3'],
    viaWorker: true,
  },
  {
    id: 'conn-gmaps',
    createdAt: t,
    updatedAt: t,
    name: 'Google 地图（未填 Key）',
    kind: 'google-maps',
    baseUrl: 'https://maps.googleapis.com',
    keyStorage: 'device',
    hasKey: false,
    capabilities: ['maps'],
    models: ['Maps JavaScript API', 'Places API (New)', 'Geocoding API'],
    viaWorker: false,
  },
];

export const agentRoutes: AgentRoute[] = [
  { role: 'main', connectionId: 'conn-relay', model: 'relay-main-model', fallbackConnectionId: 'conn-deepseek', fallbackModel: 'deepseek-chat', runsOn: 'device', params: { temperature: 0.9 } },
  { role: 'sidestory', connectionId: 'conn-deepseek', model: 'deepseek-chat', fallbackConnectionId: 'conn-relay', fallbackModel: 'relay-fast-model', runsOn: 'auto', params: { temperature: 1 }, dailyTokenBudget: 60_000 },
  { role: 'summary', connectionId: 'conn-deepseek', model: 'deepseek-chat', fallbackConnectionId: null, runsOn: 'auto', dailyTokenBudget: 200_000 },
  { role: 'embedding', connectionId: 'conn-sf', model: 'BAAI/bge-m3', fallbackConnectionId: 'conn-cf', fallbackModel: '@cf/baai/bge-m3', runsOn: 'auto', dims: 1024 },
  { role: 'imagePrompt', connectionId: 'conn-deepseek', model: 'deepseek-chat', fallbackConnectionId: null, runsOn: 'auto' },
  { role: 'image', connectionId: 'conn-nai', model: 'nai-diffusion-4-5-full', fallbackConnectionId: null, runsOn: 'hub' },
  { role: 'proactive', connectionId: 'conn-deepseek', model: 'deepseek-chat', fallbackConnectionId: 'conn-relay', fallbackModel: 'relay-fast-model', runsOn: 'hub', dailyTokenBudget: 100_000 },
  { role: 'vision', connectionId: 'conn-relay', model: 'relay-main-model', fallbackConnectionId: null, runsOn: 'device' },
  { role: 'tts', connectionId: 'conn-sf', model: 'FunAudioLLM/CosyVoice2-0.5B', fallbackConnectionId: null, runsOn: 'device' },
  { role: 'stt', connectionId: 'conn-sf', model: 'FunAudioLLM/SenseVoiceSmall', fallbackConnectionId: null, runsOn: 'device' },
];

/** "添加连接"时可以从这些模板开始：协议、地址、能做的事和常用模型都填好 */
export interface ConnectionTemplate {
  label: string;
  name: string;
  kind: ConnectionKind;
  baseUrl: string;
  capabilities: Capability[];
  models: string[];
  keyStorage?: KeyStorage;
  extra?: Record<string, string>;
}

export const CONNECTION_TEMPLATES: ConnectionTemplate[] = [
  { label: '中转', name: '我的中转', kind: 'openai', baseUrl: 'https://', capabilities: ['chat', 'vision'], models: [] },
  { label: 'DeepSeek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', capabilities: ['chat'], models: ['deepseek-chat', 'deepseek-reasoner'] },
  {
    label: '硅基流动',
    name: '硅基流动',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    capabilities: ['chat', 'embedding', 'tts', 'image'],
    models: ['BAAI/bge-m3', 'FunAudioLLM/CosyVoice2-0.5B', 'Kwai-Kolors/Kolors'],
  },
  { label: 'OpenRouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', capabilities: ['chat', 'vision'], models: [] },
  { label: 'Claude', name: 'Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', capabilities: ['chat', 'vision'], models: [] },
  {
    label: 'Gemini',
    name: 'Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    capabilities: ['chat', 'vision', 'embedding'],
    models: ['gemini-2.5-flash', 'gemini-embedding-001'],
  },
  { label: 'NovelAI', name: 'NovelAI', kind: 'novelai', baseUrl: 'https://image.novelai.net', capabilities: ['image'], models: ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'] },
  { label: 'MiniMax', name: 'MiniMax 语音', kind: 'minimax', baseUrl: 'https://api.minimaxi.com/v1', capabilities: ['tts'], models: ['speech-02-hd', 'speech-02-turbo'] },
  { label: 'Fish Audio', name: 'Fish Audio', kind: 'fish-audio', baseUrl: 'https://api.fish.audio', capabilities: ['tts'], models: ['s1', 'speech-1.6'] },
  { label: 'GPT-SoVITS', name: '我的 GPT-SoVITS', kind: 'gpt-sovits', baseUrl: 'http://127.0.0.1:9880', capabilities: ['tts'], models: ['gpt-sovits'], keyStorage: 'none' },
];
