import type { AgentRole, ImageMode, MapLocation, PresetUseId, WeatherSnapshot } from '@app/shared';

/**
 * 服务接口。界面只依赖这些接口。
 * 真实实现在 services/ai.ts（调用 @app/ai 的多智能体）：这个功能在 API 设置里能用（选了渠道、填了 Key）时真的调用，
 * 没有时退回 services/mock 里的演示实现，所以不填 Key 也能逛。
 */

/** 和 math-reader 的 onStreamState 对齐（@app/ai 的 StreamState） */
export type StreamState = 'sent' | 'connected' | 'thinking' | 'streaming' | 'fallback' | 'unstreamed' | 'buffered';

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** 示例对话的 example_user / example_assistant，或预设要求写进 name 字段的名字 */
  name?: string;
}

export interface LLMRequest {
  agent: AgentRole;
  messages: LLMChatMessage[];
  /** 完整的请求体（模型、采样参数），真实客户端直接发它 */
  body?: Record<string, unknown>;
  /** 在和谁聊（假模型用它决定用演示台词还是回显提示词） */
  characterId?: string;
  /** Claude / Gemini 不支持 name 字段：把示例对话的 example_user / example_assistant 换成真名 */
  names?: { user?: string; char?: string };
  signal?: AbortSignal;
}

export interface LLMResult {
  text: string;
  /** 模型的思考内容（没有为空串） */
  thinking: string;
  model: string;
  connectionId: string;
  /** 自己的 API 失败后用了备用 API */
  fellBack: boolean;
  latencyMs?: number;
  tokens?: number;
  /** 用的是演示模型（这个智能体还没有可用的连接） */
  demo: boolean;
}

export interface LLMCallbacks {
  /** 每次给的是累积全文（同 readAIStream 的 onDelta），配合 parseControlTags 使用 */
  onText?(full: string): void;
  onThinking?(full: string): void;
  onState?(state: StreamState, detail?: string): void;
}

export interface LLMClient {
  chat(req: LLMRequest, cb?: LLMCallbacks): Promise<LLMResult>;
}

export interface SpeakOptions {
  /** 谁在说话：用这个角色的音色（CharacterVoice） */
  characterId?: string;
  /** 这句话的表情，映射成情绪；不给用立绘当前的表情 */
  expression?: string | null;
  onLevel?(level: number): void;
  signal?: AbortSignal;
}

export interface TTSClient {
  speak(text: string, opts?: SpeakOptions): Promise<void>;
  stop(): void;
}

export interface STTClient {
  transcribe(audio: Blob, opts?: { signal?: AbortSignal }): Promise<string>;
}

export interface EmbeddingClient {
  /** 有没有真的向量化连接（没有时是演示用的假向量） */
  readonly live: boolean;
  readonly model: string;
  readonly dims: number;
  /** 存进记忆用 document，检索时的查询用 query */
  embed(texts: string[], purpose?: 'document' | 'query'): Promise<Float32Array[]>;
}

export interface IllustrateRequest {
  characterId: string;
  /** 要画的画面（[cg:] 标签里的描述、"生成配图"里写的、场景里这一刻的状态） */
  caption: string;
  /** 画什么：场景（默认）/ 全身像 / 脸部特写 / 只画背景 */
  mode?: ImageMode;
  /** 用哪个用途的生图预设：配图（默认），或者一起做事时这个场景的（image:study；没单独选时跟随配图） */
  use?: PresetUseId;
  /** 一起做事时画的时刻（入座 seat、偷拍 peek、奖励 reward……）：场景生图预设里只发这一块 */
  moment?: string;
  /** 在哪个场景（决定节律里今天该穿哪套：运动穿运动服、哄睡穿睡衣……）；不给按平时 */
  sceneId?: string | null;
  /** 衣服锁成节律里今天这个场景该穿的那套（程序加 tags，同一天的图衣服一致）；不锁时只告诉模型她今天穿什么 */
  lockOutfit?: boolean;
  place?: string;
  expression?: string | null;
  /** 最近几句对话，帮生图提示词智能体理解画面 */
  recent?: string[];
  seed?: number;
  /** 画幅由程序定（陪伴学习分上下两屏时半屏接近方形，画方图或横图）；不给按生图预设让模型写的 */
  size?: 'portrait' | 'landscape' | 'square';
  /**
   * 画的不是她，是"你"（陪伴学习各自专注时下半屏按你的人设画）：长相按这里的，不锁她的衣服；
   * 生图预设仍按 characterId 那个角色选，预设里的 {{user}} 换成她的名字（陪着你、不在画面里）
   */
  subject?: { name: string; appearanceTags: string };
}

/** 出图排到哪了：排队（前面还有图在画）→ 写 tags → 出图 */
export type IllustrateStage = 'queued' | 'prompt' | 'image';

export interface IllustrateOptions {
  signal?: AbortSignal;
  onStage?(stage: IllustrateStage): void;
  /** user：你点的，排在自动画的前面；auto：场景自己画的。默认 user */
  priority?: 'user' | 'auto';
}

export interface IllustrateOutcome {
  /** 存在本机素材库里的 key（内容哈希）；服务商只给了链接时为空 */
  assetKey: string | null;
  url?: string;
  caption: string;
  prompt: string;
  negative: string;
  seed: number | null;
  model: string;
  /** 写提示词的模型；没用生图提示词智能体时为空 */
  promptModel: string | null;
  /** 写 tags 用的生图预设；没有预设时为空 */
  presetName: string | null;
}

export interface ImageClient {
  /** 有没有真的生图连接 */
  readonly live: boolean;
  /** 配图：生图提示词智能体写 tags → 生图智能体出图 → 存进本机素材库。所有出图排队，一次一张 */
  illustrate(req: IllustrateRequest, opts?: IllustrateOptions): Promise<IllustrateOutcome>;
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

export interface LatLng {
  lat: number;
  lng: number;
}

/** 附近地点的种类（对应 Google Places 的类型），决定能一起做什么 */
export type RealPlaceKind = 'cafe' | 'restaurant' | 'park' | 'gym' | 'library';

/**
 * 真实世界的地图（M3 接 Google Maps Platform：Geocoding、Places API (New) 附近搜索、Maps JavaScript API 画图）。
 * Key 放在"连接"里，只存本机，按应用 / 网址做限制。家的地址不发给对话模型。
 */
export interface MapsClient {
  /** 有没有可用的 Google Maps Key（没有时界面显示示意图） */
  readonly ready: boolean;
  /** 地址 → 坐标（只在设置家的时候调用一次，结果缓存） */
  geocode(address: string): Promise<LatLng | null>;
  /** 我此刻在哪（网页定位；安卓壳里可以用后台定位做"出门 / 到家"） */
  whereAmI(): Promise<LatLng | null>;
  /** 附近可以带她一起去的地方 */
  nearby(center: LatLng | null, kinds: RealPlaceKind[]): Promise<MapLocation[]>;
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
