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

export interface AppearanceSettings {
  theme: 'system' | 'dark' | 'light';
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
