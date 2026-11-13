import type { ISODate } from './common.ts';

/**
 * 你（人设）的生活：可以分别打开的两套系统（设计文档 §9.12、§9.13）。
 * - 家务系统：每天、每周要做的家务。"共同的家"里按它列出今天的清单，做完勾上、拖着不做她都有反应，也影响聊天和记忆；
 * - 健康系统：身高体重、目标、能练的方式和时间、家里的食材、做饭时间和厨具。「健康计划」按它排这周和今天的健身、饮食计划。
 * 都挂在人设上（Persona.housework / Persona.health），关着的时候什么都不发给模型。
 */

/** 一件家务在一天里什么时候做 */
export type ChoreWhen = 'morning' | 'noon' | 'evening' | 'bedtime' | 'any';

/** 家务的种类：配图标，决定"没做时她会怎样"的默认值 */
export type ChoreKind = 'hygiene' | 'laundry' | 'cooking' | 'dishes' | 'cleaning' | 'trash' | 'tidy' | 'other';

/**
 * 没做的时候她会怎样（具体怎么说按她的性格；每一种的意思写在对话预设"家务：你怎么反应"那一块里，能改）：
 * - disgust 嫌弃（刷牙、洗澡这类卫生的事）
 * - no-date 不跟你出门约会（衣服没洗）
 * - miss-food 有点失落，想吃你亲手做的（做饭）
 * - nag 唠叨一句
 * - none 不在意
 * - custom 自己写（effectNote）
 */
export type ChoreEffect = 'disgust' | 'no-date' | 'miss-food' | 'nag' | 'none' | 'custom';

export interface ChoreDef {
  id: string;
  name: string;
  kind: ChoreKind;
  /** 每天 / 每周 */
  freq: 'daily' | 'weekly';
  /** 每天的：一天里哪几次（刷牙：早上、睡前）；每周的：那天什么时候做（只看第一个） */
  slots: ChoreWhen[];
  /** 每周的：固定哪几天（0 周日 … 6 周六）；空 = 哪天都行，每周做 perWeek 次 */
  days: number[];
  perWeek: number;
  /** 大概要多久（分钟） */
  minutes: number;
  effect: ChoreEffect;
  /** 补一句：自己写的反应（custom），或者给她的提示（做饭："最想吃你做的番茄牛腩"） */
  effectNote: string;
  /** 什么时候加的（之前的日子不算"没做"） */
  addedAt: number;
}

export interface HouseworkSettings {
  enabled: boolean;
  chores: ChoreDef[];
}

/** 家务的状态：待做 / 正在做 / 做完了 / 拖着（说了晚点做） */
export type ChoreStatus = 'todo' | 'doing' | 'done' | 'later';

/** 一件家务这一天的记录 */
export interface ChoreMark {
  status: ChoreStatus;
  /** 开始做的时间（正在做时） */
  startedAt?: number;
  doneAt?: number;
  /** 开始以后做了多久（秒）；直接勾上的没有 */
  spentSec?: number;
  /** 拖了几次、最后一次说晚点做的时间 */
  later?: number;
  laterAt?: number;
  /** 做饭做了什么之类的备注 */
  note?: string;
}

/** 一个人设一天的家务记录（家务日从凌晨 4 点算起，同节律） */
export interface ChoreDay {
  personaId: string;
  date: ISODate;
  /** `${家务 id}:${什么时候}`（每天的）/ `${家务 id}:w`（每周的）→ 记录 */
  marks: Record<string, ChoreMark>;
}

export type HealthSex = 'male' | 'female';
export type FitTimeOfDay = 'morning' | 'noon' | 'evening' | 'any';
export type MealKey = 'breakfast' | 'lunch' | 'dinner';

export interface HealthSettings {
  enabled: boolean;
  heightCm: number | null;
  weightKg: number | null;
  /** 目标体重（可以不填） */
  targetWeightKg: number | null;
  /** 年龄、性别只用来按心率估算消耗（可以不填） */
  age: number | null;
  sex: HealthSex | null;
  /** 目标：减脂、增肌……可以多写几句 */
  goal: string;
  /** 能接受的健身方式（"随便动动"时从这里挑，排计划时只用这些） */
  methods: string[];
  /** 一周里每天能练多久（分钟，0 = 那天不练），下标 0 是周日 */
  weekMinutes: number[];
  /** 一般什么时候练 */
  timeOfDay: FitTimeOfDay;
  /** 关于时间的补充（"周三要加班""周末上午最好"） */
  timeNote: string;
  /** 家里常有的食材 */
  ingredients: string[];
  /** 忌口、过敏 */
  avoid: string;
  /** 每顿能花多少分钟做饭（0 = 不自己做：食堂、外卖、在外面吃） */
  cookMinutes: Record<MealKey, number>;
  /** 有的厨具 */
  tools: string[];
  /** 身体情况（旧伤、膝盖不好……） */
  note: string;
}
