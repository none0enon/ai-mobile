import type { AgentRoute } from './api.ts';
import type { HHMM } from './common.ts';
import type { MemoryScoreWeights } from './memory.ts';

export interface EnvironmentSettings {
  city: string;
  timezone: string;
  weatherProvider: 'qweather' | 'open-meteo';
  useLocation: boolean;
  wakeTime: HHMM;
  sleepTime: HHMM;
  meals: Record<'breakfast' | 'lunch' | 'dinner', { start: HHMM; end: HHMM }>;
}

export interface SyncSettings {
  /** 自己的 Worker 地址（国内建议绑自定义域名） */
  workerUrl: string;
  loggedIn: boolean;
  autoSync: boolean;
  intervalMin: number;
  lastSyncAt: number | null;
  /** 用同步密码加密 Key 后同步到其他设备 */
  encryptKeys: boolean;
}

/** 聊天背景图：assetKey 为空表示不用图片（只用配色的底色） */
export interface ChatBackground {
  /** 资源 key（R2 内容哈希） */
  assetKey: string | null;
  /** 遮罩浓度 0-80（%），越高气泡越清楚 */
  dim: number;
  /** 模糊 0-20（px） */
  blur: number;
}

export interface AppearanceSettings {
  theme: 'system' | 'dark' | 'light';
  /** 配色（参考 math-reader）：白天、夜里可以选不同的 */
  dayPalette: string;
  nightPalette: string;
  /** 点缀色跟随聊天对象，还是跟随配色 */
  accentFrom: 'character' | 'palette';
  /** 所有聊天的默认背景；单个聊天可以用 Chat.background 另设 */
  chatBackground: ChatBackground | null;
  fontScale: number;
  defaultChatMode: 'im' | 'stage';
  reduceMotion: boolean;
}

export interface MemorySettings {
  /** 多少条未总结消息触发一次滚动摘要 */
  summaryEvery: number;
  topK: number;
  weights: MemoryScoreWeights;
}

export interface AppSettings {
  env: EnvironmentSettings;
  sync: SyncSettings;
  appearance: AppearanceSettings;
  agents: AgentRoute[];
  memory: MemorySettings;
}
