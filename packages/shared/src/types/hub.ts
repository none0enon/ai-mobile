import type { AgentRoute } from './api.ts';
import type { Character, Persona } from './character.ts';
import type { Chat, Message } from './chat.ts';
import type { Lorebook } from './lorebook.ts';
import type { Preset } from './preset.ts';
import type { ProactiveRule, Touchpoint, NotificationPreview } from './proactive.ts';
import type { EnvironmentSettings } from './settings.ts';
import type { World } from '../locations.ts';
import type { RhythmDay, RhythmPerson, RhythmSettings, RhythmTemplate } from './rhythm.ts';

/** Saved independently of proactive messaging, including characters without a chat. */
export interface RhythmContext {
  character: Pick<Character, 'id' | 'name' | 'pronoun' | 'card'>;
  userName: string;
  timezone: string;
  settings: RhythmSettings;
  template: RhythmTemplate;
  world: World;
  people: RhythmPerson[];
  preset: Preset | null;
  promises: string;
}

export interface HubRhythms {
  days: RhythmDay[];
  errors: { characterId: string; date: string; reason: string }[];
}

/** Only the context needed by the proactive agent. API credentials use /v1/secrets separately. */
export interface ProactiveContext {
  character: Character;
  chat: Chat;
  persona: Persona;
  preset: Preset | null;
  lorebooks: Lorebook[];
  history: Message[];
  /** 待跟进（排期用）、置顶的和最重要的几十条；不传全部记忆 */
  memories: { id: string; content: string; dueAt?: number; type: string }[];
  /**
   * 手机拼好的几块：画像卡 + 时间线、每次都带的 + 最重要的 30 条（主动消息不搜）；
   * home：你开了家务、健康系统时今天的情况（手机上传那一刻的，写着"截至几点"）
   */
  memoryBlocks?: { summary: string; memory: string; home?: string };
  /** 你人设里开着的系统（housework、health）：预设里触发条件写了它们的块只在开着时发送 */
  flags?: string[];
  environment: EnvironmentSettings;
  rules: ProactiveRule[];
  /** An active study/sleep session is refreshed by the client and expires if it disappears. */
  busyUntil: number;
  preview: NotificationPreview;
}

/** Stored encrypted; never returned by a read/sync endpoint. */
export interface ProactiveCredentials {
  routes: AgentRoute[];
  keys: Record<string, string>;
  outputFilters: string[];
}

export interface HubTouchpoint extends Touchpoint {
  lastError?: string;
  pushError?: string;
}

export interface HubInbox {
  messages: { seq: number; characterId: string; message: Message }[];
  next: number;
  more: boolean;
  touchpoints: HubTouchpoint[];
}

export interface HubStatus {
  enabled: boolean;
  lastCronAt: number | null;
  lastError: string | null;
  configured: boolean;
  /** Absent on Workers predating daily rhythm support. */
  rhythmConfigured?: boolean;
  lastRhythmError?: string | null;
  /** 云端记忆整理的 API 已上传 */
  memoryConfigured?: boolean;
  lastMemoryError?: string | null;
  vapidPublicKey: string | null;
  channels: { id: string; kind: 'webpush' | 'webhook'; label: string; lastOkAt: number | null }[];
}

export interface HubNotification {
  title: string;
  body: string;
  tag: string;
  route: string;
}

/** 云端记忆整理的结果（/v1/memory/results） */
export interface HubMemoryResults {
  results: { doneAt: number; result: import('./memory.ts').MemoryJobResult }[];
  errors: { characterId: string; date: string; reason: string }[];
}
