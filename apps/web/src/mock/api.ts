import type { AgentRoute, Capability, ConnectionKind, KeyStorage, ProviderConnection } from '@app/shared';
import { at } from '@/utils/time';

const t = at(-5, '21:00');

/** Claude 当前的模型（Anthropic 官方模型表，2026-11）：Opus 5.5 是默认，Sonnet / Haiku 更快更便宜，Fable 5.2 最强也最贵 */
export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'];
/** OpenAI 的模型：先放旗舰 gpt-5.5；你的 Key 能用的全部模型点"拉取模型列表"取 */
export const OPENAI_MODELS = ['gpt-5.5'];
/** Termux 等本机服务的默认地址（math-reader 习惯的端口） */
export const LOCAL_URL = 'http://127.0.0.1:8787/v1';

/**
 * 第一次打开时的连接：Claude、OpenAI 官方，Termux 本机服务，再是 DeepSeek、Gemini 和语音、向量、生图用的几家。
 * 地址和模型都填好了，只差 Key（本机服务不用 Key）。Key 只存在这台设备上（我的 → API 与智能体 → 点连接填）。
 * 主对话等文本智能体默认用 Claude，失败时改用 OpenAI；没填 Key 时继续用演示模型，所以不填也能逛。
 * 填好 Key 保存后，没接通的对话智能体会自动改用它（见 ApiPage 的 saveConn）。
 */
export const connections: ProviderConnection[] = [
  {
    id: 'conn-claude',
    createdAt: t,
    updatedAt: t,
    name: 'Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyStorage: 'device',
    hasKey: false,
    capabilities: ['chat', 'vision'],
    models: [...CLAUDE_MODELS],
    viaWorker: false,
  },
  {
    id: 'conn-openai',
    createdAt: t,
    updatedAt: t,
    name: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyStorage: 'device',
    hasKey: false,
    capabilities: ['chat', 'vision'],
    models: [...OPENAI_MODELS],
    viaWorker: false,
  },
  {
    id: 'conn-local',
    createdAt: t,
    updatedAt: t,
    name: '本机（Termux 8787）',
    kind: 'openai',
    baseUrl: LOCAL_URL,
    keyStorage: 'none',
    hasKey: false,
    capabilities: ['chat', 'vision'],
    models: [],
    viaWorker: false,
  },
  {
    id: 'conn-deepseek',
    createdAt: t,
    updatedAt: t,
    name: 'DeepSeek 官方',
    kind: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    keyStorage: 'device',
    hasKey: false,
    capabilities: ['chat', 'vision'],
    models: ['deepseek-flash', 'deepseek-v4-pro'],
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

export const CLAUDE_DEFAULT = 'claude-opus-5-5';
export const OPENAI_DEFAULT = 'gpt-5.5';

export const agentRoutes: AgentRoute[] = [
  { role: 'main', connectionId: 'conn-claude', model: CLAUDE_DEFAULT, fallbackConnectionId: 'conn-openai', fallbackModel: OPENAI_DEFAULT, runsOn: 'device', params: { temperature: 0.9 } },
  { role: 'sidestory', connectionId: 'conn-claude', model: CLAUDE_DEFAULT, fallbackConnectionId: 'conn-openai', fallbackModel: OPENAI_DEFAULT, runsOn: 'auto', params: { temperature: 1 }, dailyTokenBudget: 60_000 },
  { role: 'summary', connectionId: 'conn-claude', model: CLAUDE_DEFAULT, fallbackConnectionId: 'conn-openai', fallbackModel: OPENAI_DEFAULT, runsOn: 'auto', dailyTokenBudget: 200_000 },
  { role: 'embedding', connectionId: 'conn-sf', model: 'BAAI/bge-m3', fallbackConnectionId: null, runsOn: 'auto', dims: 1024 },
  { role: 'imagePrompt', connectionId: 'conn-claude', model: CLAUDE_DEFAULT, fallbackConnectionId: 'conn-openai', fallbackModel: OPENAI_DEFAULT, runsOn: 'auto' },
  { role: 'image', connectionId: 'conn-nai', model: 'nai-diffusion-4-5-full', fallbackConnectionId: null, runsOn: 'hub' },
  { role: 'proactive', connectionId: 'conn-claude', model: CLAUDE_DEFAULT, fallbackConnectionId: 'conn-openai', fallbackModel: OPENAI_DEFAULT, runsOn: 'hub', dailyTokenBudget: 100_000 },
  { role: 'vision', connectionId: 'conn-claude', model: CLAUDE_DEFAULT, fallbackConnectionId: 'conn-openai', fallbackModel: OPENAI_DEFAULT, runsOn: 'device' },
  { role: 'tts', connectionId: 'conn-sf', model: 'FunAudioLLM/CosyVoice2-0.5B', fallbackConnectionId: null, runsOn: 'device' },
  { role: 'stt', connectionId: 'conn-sf', model: 'FunAudioLLM/SenseVoiceSmall', fallbackConnectionId: null, runsOn: 'device' },
];

/**
 * 以前版本自带、现在去掉的连接：示例中转（地址是假的）和 Workers AI（要先有自己的 Worker，还没做）。
 * 打开 App 时，地址没改过的就删掉；用它们的智能体改用 Claude（见 stores/ai.ts 的 migrateSeeds）
 */
export const RETIRED_SEEDS: { id: string; baseUrl: string }[] = [
  { id: 'conn-relay', baseUrl: 'https://api.relay-example.com/v1' },
  { id: 'conn-cf', baseUrl: '经自己的 Worker' },
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
  { label: 'Claude', name: 'Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', capabilities: ['chat', 'vision'], models: [...CLAUDE_MODELS] },
  { label: 'OpenAI', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', capabilities: ['chat', 'vision'], models: [...OPENAI_MODELS] },
  // Termux 等本机服务（math-reader 里填 http://127.0.0.1:8787/v1/chat/completions 的那种）：OpenAI 格式，不要 Key
  { label: '本机 / Termux', name: '本机（Termux 8787）', kind: 'openai', baseUrl: LOCAL_URL, capabilities: ['chat', 'vision'], models: [], keyStorage: 'none' },
  // 任意地址的 OpenAI 格式（中转、各家兼容接口）；math-reader 里 openai / deepseek 渠道改地址就是这种
  { label: '自定义 OpenAI 兼容', name: '我的中转', kind: 'openai', baseUrl: 'https://', capabilities: ['chat', 'vision'], models: [] },
  // 认 Claude 原生协议（/v1/messages、x-api-key）的中转或本机服务
  { label: '自定义 Claude 协议', name: '我的 Claude 中转', kind: 'anthropic', baseUrl: 'https://', capabilities: ['chat', 'vision'], models: [...CLAUDE_MODELS] },
  // math-reader 的"自定义"渠道：任意地址，走 Gemini 原生协议（Key 放在 key 参数）
  { label: '自定义 Gemini 协议', name: '我的 Gemini 中转', kind: 'gemini', baseUrl: 'https://', capabilities: ['chat', 'vision'], models: [] },
  { label: 'DeepSeek', name: 'DeepSeek', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', capabilities: ['chat', 'vision'], models: ['deepseek-flash', 'deepseek-v4-pro'] },
  {
    label: 'Gemini（AI Studio）',
    name: 'Gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    capabilities: ['chat', 'vision', 'embedding'],
    models: ['gemini-2.5-flash', 'gemini-embedding-001'],
  },
  {
    label: 'Vertex Agent',
    name: 'Vertex Agent',
    kind: 'vertex',
    baseUrl: 'https://aiplatform.googleapis.com/v1/publishers/google',
    capabilities: ['chat', 'vision'],
    models: ['gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-2.5-pro', 'deepseek-ai/deepseek-v4.1-flash-maas'],
  },
  { label: 'OpenRouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', capabilities: ['chat', 'vision'], models: [] },
  {
    label: '硅基流动',
    name: '硅基流动',
    kind: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    capabilities: ['chat', 'embedding', 'tts', 'image'],
    models: ['BAAI/bge-m3', 'FunAudioLLM/CosyVoice2-0.5B', 'Kwai-Kolors/Kolors'],
  },
  { label: 'NovelAI', name: 'NovelAI', kind: 'novelai', baseUrl: 'https://image.novelai.net', capabilities: ['image'], models: ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'] },
  {
    label: 'NovelAI 公益站',
    name: 'NovelAI 公益站',
    kind: 'novelai',
    baseUrl: 'https://',
    capabilities: ['image'],
    models: ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-3'],
  },
  { label: 'MiniMax', name: 'MiniMax 语音', kind: 'minimax', baseUrl: 'https://api.minimaxi.com/v1', capabilities: ['tts'], models: ['speech-02-hd', 'speech-02-turbo'] },
  { label: 'MiniMax 海外', name: 'MiniMax 语音（海外）', kind: 'minimax', baseUrl: 'https://api.minimax.io/v1', capabilities: ['tts'], models: ['speech-02-hd', 'speech-02-turbo'] },
  {
    label: '火山引擎',
    name: '豆包语音（火山引擎）',
    kind: 'volcengine',
    baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
    capabilities: ['tts'],
    models: ['seed-tts-2.0', 'seed-tts-1.0', 'seed-icl-2.0'],
  },
  { label: 'Fish Audio', name: 'Fish Audio', kind: 'fish-audio', baseUrl: 'https://api.fish.audio', capabilities: ['tts'], models: ['s1', 'speech-1.6'] },
  { label: 'GPT-SoVITS', name: '我的 GPT-SoVITS', kind: 'gpt-sovits', baseUrl: 'http://127.0.0.1:9880', capabilities: ['tts'], models: ['gpt-sovits'], keyStorage: 'none' },
];
