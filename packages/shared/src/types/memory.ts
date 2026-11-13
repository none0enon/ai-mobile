import type { ISODate, SyncMeta } from './common.ts';

export type MemoryType =
  | 'fact' // 事实："在读研一，专业是计算机"
  | 'preference' // 偏好："不吃香菜"
  | 'event' // 事件："11/02 一起看了电影"
  | 'promise' // 约定："周六一起去水族馆"
  | 'followup' // 待跟进：带 dueAt，到期由主动消息去问
  | 'emotion' // 情绪："最近因为论文焦虑"
  | 'relationship'; // 关系里程碑

/**
 * 向量和生成它的模型绑在一起：换了向量模型后，旧向量不能和新向量比较，
 * 所以检索时只用 model 与当前设置一致的向量，其余排队重算。
 */
export interface MemoryVector {
  model: string;
  dims: number;
  /** float16 小端序，base64 编码 */
  data: string;
}

export interface Memory extends SyncMeta {
  characterId: string;
  type: MemoryType;
  content: string;
  /** 1-10，总结智能体给出，用户可改 */
  importance: number;
  pinned: boolean;
  status: 'active' | 'archived' | 'superseded';
  /** 仅 followup：到期时间 */
  dueAt: number | null;
  sourceMessageIds: string[];
  /** 事情发生的时间（来源消息的时间）；不是整理的时间 */
  happenedAt: number | null;
  vector: MemoryVector | null;
  lastRecalledAt: number | null;
  recallCount: number;
  /** 来自哪条聊天 */
  chatId?: string;
  /** 涉及的人、地点、物品（按字面搜索时加分） */
  entities?: string[];
  /** status 为 superseded 时：被哪条记忆取代 */
  supersededBy?: string | null;
  /** 写入时在手机上用向量算出的"可能和这条重复"，留给整理处理 */
  dupOf?: string | null;
  /** 来源消息后来被删除或编辑过：记忆本里提示复核 */
  sourceChanged?: boolean;
}

/** 故事片段的标签 */
export interface SliceTags {
  /** 氛围：日常、温馨、冲突、浪漫…… */
  mood: string[];
  /** 特殊日子或状态：生日、纪念日、节日、生病、出差、考试…… */
  special: string[];
  important: boolean;
}

/**
 * 故事片段：每次总结按话题切出来的一段经过，带时间和标签。
 * 用来找回"那天发生了什么"；事实记忆负责"以后用得上的事"。
 */
export interface MemorySlice extends SyncMeta {
  characterId: string;
  chatId: string;
  /** 一句话标题（30 字以内） */
  title: string;
  /** 经过 */
  text: string;
  fromMessageId: string;
  toMessageId: string;
  /** 起止时间（来源消息的时间） */
  startAt: number;
  endAt: number;
  tags: SliceTags;
  vector: MemoryVector | null;
  lastRecalledAt: number | null;
  recallCount: number;
  /** 来源消息被删除或编辑过，要重新生成 */
  stale?: boolean;
}

/**
 * 时间线的一段：level 0 是每次总结写的梗概；同一层攒满 4 段合并成上一层的一段。
 * 各层还没合并的段放在一起，正好覆盖全部历史（越早越粗）。
 */
export interface ChapterSummary extends SyncMeta {
  chatId: string;
  level: number;
  fromMessageId: string;
  toMessageId: string;
  fromAt: number;
  toAt: number;
  text: string;
  /** 合并进了哪一段；合并后不再单独进提示词 */
  mergedInto: string | null;
}

/** 画像卡的一行 */
export interface ProfileLine {
  id: string;
  /** 分在哪一栏：基本、学习工作、作息身体、喜好、雷区、重要的人、最近、我们这一路…… */
  section: string;
  text: string;
  updatedAt: number;
}

/** "她知道的你"：每次都带进提示词的画像卡，由整理逐行修改，记忆本里可以手动改 */
export interface MemoryProfile extends SyncMeta {
  characterId: string;
  lines: ProfileLine[];
}

/** 角色日记：每晚由总结智能体用角色口吻写 */
export interface DiaryEntry extends SyncMeta {
  characterId: string;
  date: ISODate;
  weather: string;
  mood: string;
  text: string;
  highlights: string[];
}

/** 检索打分 = similarity·w1 + recency·w2 + importance·w3，新近度按半衰期衰减 */
export interface MemoryScoreWeights {
  similarity: number;
  recency: number;
  importance: number;
  halfLifeDays: number;
}

/** 画像卡的一处修改（整理逐行改，不整张重写） */
export type ProfileOp =
  | { op: 'add'; section: string; text: string }
  | { op: 'edit'; id: string; text: string; section?: string }
  | { op: 'remove'; id: string };

/**
 * 记忆整理的输入：手机把这次要整理的东西打包（上传给 Cloudflare 凌晨 4 点整理，或在记忆本里"立即整理"），
 * 每条都带上传时的内容，应用结果时内容变了（你在手机上改过）就跳过那一处。
 */
export interface MemoryConsolidationContext {
  characterId: string;
  chatId: string | null;
  character: { name: string; pronoun: string };
  userName: string;
  timezone: string;
  /** "整理"预设（记忆整理用途选的那个） */
  preset: import('./preset.ts').Preset | null;
  /** 打包的时间 */
  packedAt: number;
  /** 可能重复的几组记忆（手机按向量算出来的） */
  mergeGroups: { group: string; items: { id: string; type: MemoryType; content: string; at: number | null; importance: number }[] }[];
  /** 时间线里该合并的组（同层最早的 4 段） */
  rollups: { ids: string[]; segments: { text: string; fromAt: number; toAt: number }[] }[];
  /** 已经过了时间的待跟进 */
  followups: { id: string; content: string; dueAt: number }[];
  /** 现在的画像卡，和它上次修改的时间 */
  profile: { lines: { id: string; section: string; text: string }[]; updatedAt: number };
  /** 上次整理以后新记下的事（改画像卡用） */
  newMemories: { content: string; type: MemoryType; at: number | null }[];
}

/** 整理的结果：一串修改，手机应用 */
export type MemoryOp =
  | { op: 'merge'; ids: string[]; content: string; type: MemoryType | null; importance: number | null }
  | { op: 'rollup'; ids: string[]; text: string }
  | { op: 'tense'; id: string; content: string; type: 'event' | 'followup'; dueAt: number | null }
  | { op: 'profile'; ops: ProfileOp[] };

/** 云端一次整理的结果（按角色、按日子） */
export interface MemoryJobResult {
  characterId: string;
  date: string;
  ops: MemoryOp[];
  /** 整理用的那份上下文（应用时据此判断你有没有改过） */
  context: MemoryConsolidationContext;
  errors: string[];
  at: number;
}
