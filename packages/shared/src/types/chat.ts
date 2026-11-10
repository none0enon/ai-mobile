import type { MealSlot } from './activity.ts';
import type { SyncMeta } from './common.ts';

export type MessageRole = 'user' | 'assistant' | 'system' | 'narrator';

/**
 * 一条消息由若干 part 组成。纯文字消息只有一个 text part；
 * 各种"卡片"（语音、图片、歌曲、运动记录……）都是 part，界面按 type 渲染。
 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'voice'; assetKey: string | null; durationMs: number; transcript: string }
  | {
      type: 'image';
      assetKey: string | null;
      caption: string;
      /** AI 生成的图带上提示词和种子，方便在相册里复现 */
      prompt?: string;
      seed?: number;
      generated: boolean;
    }
  | { type: 'music'; songId: string; title: string; artist: string; cover?: string | null }
  /** 拍一拍："你拍了拍她的头" / "她拍了拍你" */
  | { type: 'poke'; actor: 'user' | 'char'; target: string }
  | { type: 'call-log'; durationSec: number; scene?: string; missed?: boolean; transcriptId?: string }
  | { type: 'workout'; logId: string; sport: string; distanceKm?: number; durationSec: number; pace?: string }
  | { type: 'meal'; logId: string; meal: MealSlot; food: string; photo?: string | null }
  | { type: 'study'; logId: string; pomodoros: number; minutes: number }
  | {
      type: 'date';
      logId?: string;
      place: string;
      when: string;
      status: 'invite' | 'accepted' | 'declined' | 'memory';
    }
  | { type: 'gift'; giftId: string; name: string }
  /** 场景分段：和她一起去了某个地点 / 离开。聊天里显示成一条居中的分隔提示 */
  | { type: 'scene'; event: 'enter' | 'leave'; sceneId: string; locationId: string; title: string; summary?: string };

export type MessagePartType = MessagePart['type'];

/** 备选回复（ST 的 swipe） */
export interface Swipe {
  text: string;
  parts?: MessagePart[];
  expression?: string | null;
  createdAt: number;
}

export interface Message extends SyncMeta {
  chatId: string;
  role: MessageRole;
  /** 已剥离控制标签的纯文本，用于总结、检索、通知预览 */
  text: string;
  parts: MessagePart[];
  /** 这条消息结束时的立绘表情 */
  expression: string | null;
  swipes: Swipe[];
  swipeIndex: number;
  /** AI 主动发起的消息 */
  proactive: boolean;
  read: boolean;
  meta: {
    model?: string;
    agent?: string;
    tokens?: number;
    latencyMs?: number;
    scene?: string;
    /** [choice:] 标签给出的选项，显示成快捷回复 */
    choices?: string[];
    /** 回复被打断（切后台、断网）时保留半截内容，界面显示"继续" */
    interrupted?: boolean;
  };
}

/**
 * 一个角色只有一条聊天（消息按人分）。IM 和剧场只是同一条聊天的两种看法；
 * 约会、学习等场景是这条聊天里的一段，用 scene 分隔提示标出进出。
 * 导入的 SillyTavern 聊天记录作为这个角色的"存档"，不在消息列表里单独出现。
 */
export interface Chat extends SyncMeta {
  characterId: string;
  personaId: string | null;
  title: string;
  presetId: string | null;
  /** 上次用的看法：聊天气泡 / 剧场立绘 */
  mode: 'im' | 'stage';
  currentScene: string | null;
  /** 你们此刻一起在哪个地点（从地图进场景时设置，离开时清空）；为空表示各在各处、只是发消息 */
  togetherAt: string | null;
  /** 滚动摘要已经覆盖到哪条消息 */
  summaryUntilMessageId: string | null;
  pinned: boolean;
  lastMessageAt: number;
}
