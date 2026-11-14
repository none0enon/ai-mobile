import type { Character } from './character.ts';
import type { Preset } from './preset.ts';
import type { NotificationPreview } from './proactive.ts';
import type { RhythmDay } from './rhythm.ts';

/**
 * 朋友圈（社媒）：她们按自己的节律和最近的聊天发朋友圈，你也可以发；互相点赞、评论。
 * - 她发的：云端 Cron 每天在随机的时间发（App 关着也发），也可以在朋友圈页里让她现在发一条；
 * - 你发的：选哪些角色看得到，看得到的角色各自点赞、评论；你回她的评论，她再回你；
 * - 一条朋友圈除了正文，可以有图（你选的照片、AI 画的）和一小页 HTML（缴费单、小票、车票……）；
 * - 朋友圈写进记忆：每条记成一条"事件"记忆，最近的几条每次聊天都带着。
 */

/** 朋友圈里"你"的 id（其余的是角色 id） */
export const MOMENT_USER = 'user';

export interface MomentComment {
  id: string;
  /** MOMENT_USER 或角色 id */
  authorId: string;
  text: string;
  /** 回复谁（MOMENT_USER 或角色 id）；不写 = 直接评论这条朋友圈 */
  replyTo?: string;
  at: number;
}

/** 朋友圈的一张图：你选的照片，或者 AI 画的（caption 是要画的画面） */
export interface MomentImage {
  caption: string;
  /** 本机素材库里的 key；还没画出来时为空 */
  assetKey: string | null;
  url?: string;
  /** 你选的照片（不是 AI 画的） */
  photo?: boolean;
  /** 识图看到的内容（你发的照片）：角色据此评论 */
  seen?: string;
  /** 没画出来的原因 */
  error?: string;
}

export interface Moment {
  id: string;
  /** MOMENT_USER 或角色 id */
  authorId: string;
  text: string;
  images: MomentImage[];
  /** AI 写的一小页 HTML（缴费单、小票、车票……），放在沙盒小窗里显示 */
  html?: string;
  /** 这页 HTML 是什么（"便利店小票"）：提示词和记忆里用这个，不发整页 HTML */
  htmlTitle?: string;
  /** 所在位置（"图书馆三楼"） */
  location?: string;
  /** 你发的：哪些角色看得到；null = 都看得到。角色发的只有你和她自己看得到 */
  visibleTo: string[] | null;
  /** 点赞的人（MOMENT_USER 或角色 id） */
  likes: string[];
  comments: MomentComment[];
  createdAt: number;
  updatedAt: number;
  /** hub 云端定时发的；device 在手机上让她发的；user 你发的 */
  source: 'hub' | 'device' | 'user';
  model?: string;
  /** 你还没看过（朋友圈页签上的红点） */
  unread?: boolean;
  /** 写进记忆的那一条：角色 id → 记忆 id（评论多了改同一条，不重复记） */
  memoryIds?: Record<string, string>;
}

/** 一个角色发不发朋友圈、每天最多几条 */
export interface SocialCharacterSettings {
  enabled: boolean;
  /** 每天最多发几条（1–4）：每天实际发 1 到这么多条，时间随机 */
  perDay: number;
}

export interface SocialSettings {
  /** 朋友圈只显示最近 x 条（"我的"页里改）；0 = 全部显示 */
  visibleCount: number;
  /** 她发的朋友圈要配图时自动画（要接通生图） */
  autoImage: boolean;
  characters: Record<string, SocialCharacterSettings>;
}

export const DEFAULT_SOCIAL_CHARACTER: SocialCharacterSettings = { enabled: true, perDay: 2 };
export const DEFAULT_SOCIAL_SETTINGS: SocialSettings = { visibleCount: 30, autoImage: true, characters: {} };
export const SOCIAL_PER_DAY_MAX = 4;

/** 社媒预设里的任务（块的触发条件写这几个名字） */
export const SOCIAL_TASKS = {
  post: '她发一条朋友圈',
  react: '回应你的朋友圈、回你的评论',
} as const;

export type SocialTask = keyof typeof SOCIAL_TASKS;

/**
 * 云端发朋友圈要的东西（按角色上传，/v1/social/contexts）：角色卡、节律、记忆和最近的聊天都是手机拼好的文字。
 * 每天变化的节律云端自己有（rhythm_days），有今天的就用云端那份；没有就用这里的 day（固定节律、手机上排的）
 */
export interface SocialContext {
  character: Pick<Character, 'id' | 'name' | 'pronoun' | 'card'>;
  userName: string;
  timezone: string;
  settings: SocialCharacterSettings;
  /** 她醒着的时段（HH:mm）：只在这段时间里发 */
  awake: { from: string; to: string };
  /** 手机上今天的节律（云端没有今天的时用它）；地点已经换成名字 */
  day: SocialDay | null;
  /** 她记得的关于你的事（画像卡 + 关系 + 最重要的记忆） */
  memories: string;
  /** 最近的聊天（最后十几句） */
  recent: string;
  /** 最近的朋友圈（她发过的、你发的她看得到的）：避免重复，也能接着说 */
  feed: string;
  preset: Preset | null;
  /** 通知里显示多少（同主动消息的设置） */
  preview: NotificationPreview;
}

/** 节律里的一天，地点换成了名字（云端不用再查她的世界） */
export type SocialDay = Pick<RhythmDay, 'date' | 'meals' | 'task' | 'events'> & {
  schedule: { from: string; to: string; place: string; status: string }[];
  outfit: string;
};

/** 云端发的朋友圈（/v1/social/posts）：图由手机收到后再画 */
export interface HubMoments {
  posts: { doneAt: number; moment: Moment }[];
  errors: { characterId: string; date: string; reason: string }[];
}
