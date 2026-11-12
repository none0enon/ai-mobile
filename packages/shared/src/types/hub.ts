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
  memories: { id: string; content: string; dueAt?: number; type: string }[];
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
  rhythmConfigured: boolean;
  lastRhythmError: string | null;
  vapidPublicKey: string | null;
  channels: { id: string; kind: 'webpush' | 'webhook'; label: string; lastOkAt: number | null }[];
}

export interface HubNotification {
  title: string;
  body: string;
  tag: string;
  route: string;
}
