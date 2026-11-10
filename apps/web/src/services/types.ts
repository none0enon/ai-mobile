import type { AgentRole, WeatherSnapshot } from '@app/shared';

/**
 * 服务接口。界面只依赖这些接口；本轮全部是假实现（services/mock），
 * M1 起逐个换成真实实现（例如 LLMClient 换成移植自 math-reader readAIStream 的版本）。
 */

/** 和 math-reader 的 onStreamState 对齐，方便移植 */
export type StreamState = 'sent' | 'connected' | 'thinking' | 'streaming' | 'fallback' | 'unstreamed' | 'buffered';

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  agent: AgentRole;
  messages: LLMChatMessage[];
  signal?: AbortSignal;
}

export interface LLMResult {
  text: string;
  model: string;
  connectionId: string;
  /** 主连接失败后用了备用连接 */
  fellBack: boolean;
}

export interface LLMClient {
  /** onText 每次给的是累积全文（同 readAIStream 的 onDelta），配合 parseControlTags 使用 */
  chat(req: LLMRequest, cb?: { onText?(full: string): void; onState?(state: StreamState): void }): Promise<LLMResult>;
}

export interface TTSClient {
  speak(text: string, opts?: { voiceId?: string; onLevel?(level: number): void; signal?: AbortSignal }): Promise<void>;
  stop(): void;
}

export interface STTClient {
  transcribe(audio: Blob): Promise<string>;
}

export interface EmbeddingClient {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface SongInfo {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  hue: number;
}

export interface MusicClient {
  search(keyword: string): Promise<SongInfo[]>;
  /** 歌曲地址约 20 分钟过期：播放前现取，播放出错时重取 */
  resolve(id: string): Promise<{ url: string; expiresAt: number }>;
  lyric(id: string): Promise<{ lrc: string; tlyric?: string }>;
}

export interface WeatherClient {
  now(city: string): Promise<WeatherSnapshot & { icon: string }>;
}

export interface SyncStatus {
  mode: 'local' | 'hub';
  state: 'idle' | 'syncing' | 'error' | 'offline';
  lastSyncAt: number | null;
  pending: number;
  devices: { name: string; platform: string; lastSeen: number; current: boolean }[];
}

export interface SyncClient {
  status(): SyncStatus;
  syncNow(): Promise<SyncStatus>;
}

export interface PushClient {
  test(channelId: string): Promise<boolean>;
}

/** 安卓壳原生桥（M3）。浏览器 / iPhone PWA 里降级为 Web API 或空操作 */
export interface NativeBridge {
  platform: 'web' | 'pwa' | 'android';
  vibrate(pattern: number | number[]): void;
  keepAwake(on: boolean): Promise<void>;
}
