import type { MealSlot } from './activity.ts';
import type { SyncMeta } from './common.ts';
import type { LoreTimedState } from './lorebook.ts';
import type { ImageMode } from './preset.ts';
import type { ChatBackground } from './settings.ts';

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
      /** 要画的画面（[cg:] 里的描述、"生成配图"里写的）；重画时照它再画 */
      caption: string;
      /** 画什么（生图预设里"画什么"那几块按它只发一块）；不写 = 场景 */
      mode?: ImageMode;
      /** 生图提示词智能体起的中文短标题，显示用 */
      title?: string;
      /** AI 生成的图带上提示词和种子，方便在相册里复现 */
      prompt?: string;
      negative?: string;
      seed?: number;
      /** 出图的模型（nai-diffusion-4-5-full …） */
      model?: string;
      generated: boolean;
      /** 生成失败的原因（界面显示，可以重画） */
      error?: string;
      /** 完整报错 */
      errorDetail?: string;
    }
  | { type: 'music'; songId: string; title: string; artist: string; cover?: string | null }
  /** 拍一拍："你拍了拍她的头" / "她拍了拍你" */
  | { type: 'poke'; actor: 'user' | 'char'; target: string }
  | { type: 'call-log'; durationSec: number; scene?: string; missed?: boolean; transcriptId?: string }
  | { type: 'workout'; logId: string; sport: string; distanceKm?: number; durationSec: number; pace?: string }
  | { type: 'meal'; logId: string; meal: MealSlot; food: string; photo?: string | null }
  | {
      type: 'study';
      logId: string;
      pomodoros: number;
      minutes: number;
      /** 这次要完成的任务和完成了没有 */
      tasks?: { text: string; done: boolean }[];
      /** 中途离开 App 的次数 */
      away?: number;
      /** 开场时的约定，以及做到了没有 */
      promise?: { text: string; kept: boolean };
      /** 她这次在忙的事和进度（0–100） */
      her?: { goal: string; progress: number };
      /** 她写的自习日记 */
      diary?: string;
      /** 这次画的图（入座、偷拍、奖励……）：本机素材库的 key，或者服务商给的链接 */
      images?: { assetKey: string | null; url?: string; title: string; moment: string }[];
    }
  | {
      type: 'date';
      logId?: string;
      place: string;
      when: string;
      status: 'invite' | 'accepted' | 'declined' | 'memory';
    }
  | { type: 'gift'; giftId: string; name: string }
  /** 一起看书：这一次读到哪、划了几句 */
  | {
      type: 'read';
      logId: string;
      title: string;
      /** 读到的章 */
      chapter: string;
      /** 全书进度（0–100） */
      progress: number;
      /** 你们这次写了几条批注 */
      notes: number;
      /** 你划的一句 */
      quote?: string;
    }
  /** 一起玩的一局（先只有海龟汤） */
  | {
      type: 'game';
      logId: string;
      game: 'soup';
      title: string;
      /** host 她出题你猜；coop 一起猜；guest 你出题她猜 */
      mode: 'host' | 'coop' | 'guest';
      result: 'solved' | 'partial' | 'gave-up';
      questions: number;
      hints: number;
      /** 揭晓后的汤底 */
      truth?: string;
    }
  /** 一起观影的票根 */
  | {
      type: 'watch';
      logId: string;
      title: string;
      /** 一起看了多久（分钟） */
      minutes: number;
      yourScore?: number;
      herScore?: number;
      /** 她散场后说的话 */
      review?: string;
      /** 她看的时候说过的几句 */
      highlights?: string[];
      /** 贴链接看的：原平台上的地址（B 站 / YouTube / 视频文件） */
      link?: string;
    }
  /**
   * 场景分段：和她一起做某件事的开始 / 结束。聊天里显示成一条居中的分隔提示。
   * mode 是怎么在一起的；youAt 是你在真实世界的哪儿（连线、带她出门时记下，成为"我们的足迹"）
   */
  | {
      type: 'scene';
      event: 'enter' | 'leave';
      sceneId: string;
      locationId: string;
      title: string;
      summary?: string;
      mode?: TogetherMode;
      youAt?: string;
    };

/**
 * 怎么在一起：
 * - remote 连线（默认）：你在真实世界你那儿，她在她的世界里，各做各的、开着"视频"一起做；
 * - visit 去她那：你的注意力进她的世界（人还在你这边），坐在她旁边；
 * - bring 带她来：你在真实世界的某个地方，她"来你这边"陪你。
 */
export type TogetherMode = 'remote' | 'visit' | 'bring';

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
    /** 在一起做哪件事时说的（场景 id） */
    scene?: string;
    /** 在这件事里的位置："第 2 个番茄"、"00:41:08"、"第 12 页"、"第 7 问" */
    cue?: string;
    /** [choice:] 标签给出的选项，显示成快捷回复 */
    choices?: string[];
    /** 回复被打断（切后台、断网）时保留半截内容，界面显示"继续" */
    interrupted?: boolean;
    /** 生成失败的原因（接口报错、Key 不对……）一句话，界面显示，可以重新生成 */
    error?: string;
    /** 完整报错：请求地址、状态码、服务商返回的原文……（界面完整显示，可以复制） */
    errorDetail?: string;
    /** 自己的 API 失败后用了备用 API */
    fellBack?: boolean;
  };
}

/**
 * 一个角色只有一条聊天（消息按人分）。IM 和剧场只是同一条聊天的两种看法；
 * 约会、学习等场景是这条聊天里的一段，用 scene 分隔提示标出进出。
 * 导入的 SillyTavern 聊天记录作为这个角色的"存档"，不在消息列表里单独出现。
 * 用哪个预设看角色（Character.presetId），聊天上不另存。
 */
export interface Chat extends SyncMeta {
  characterId: string;
  personaId: string | null;
  title: string;
  /** 上次用的看法：聊天气泡 / 剧场立绘 */
  mode: 'im' | 'stage';
  currentScene: string | null;
  /** 一起做事时她那边在哪（连线 / 去她那：她世界里的地点；带她来：你真实世界里的地点）；为空表示只是在发消息 */
  togetherAt: string | null;
  /** 怎么在一起；不在一起时为空 */
  togetherMode: TogetherMode | null;
  /** 滚动摘要已经覆盖到哪条消息 */
  summaryUntilMessageId: string | null;
  /** 总结智能体写的摘要（从旧到新，每段对应一段聊天）；提示词里"过往摘要"一块用最近几段 */
  summaries?: { fromMessageId: string; toMessageId: string; text: string; at: number }[];
  pinned: boolean;
  lastMessageAt: number;
  /** 这个聊天单独的背景；为空时用外观设置里的通用背景 */
  background: ChatBackground | null;
  /** 世界书条目的粘性 / 冷却状态（同 ST 的 chat_metadata.timedWorldInfo） */
  loreState?: LoreTimedState;
  /** 聊天变量：{{setvar::x::v}} / {{getvar::x}} */
  vars?: Record<string, string>;
}
