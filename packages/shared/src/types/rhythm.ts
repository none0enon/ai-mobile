/**
 * 节律：她每天的作息、三餐和穿着（设计文档 §9 开头的"节律"）。都挂在角色 id 下，存在本机。
 * - 模板：她的作息模板、三餐习惯、衣柜、手头的事。演示角色的来自她的世界，导入的角色由"建世界"生成，你都能改；
 * - 每天：按模板（固定）或由「节律」排（每天变化）得到的今天，检查过、补过的。
 */

/** 衣服的用途：日常、运动、睡衣、约会 */
export type OutfitKind = 'daily' | 'sport' | 'sleep' | 'date';

export const OUTFIT_KINDS: Record<OutfitKind, string> = { daily: '日常', sport: '运动', sleep: '睡衣', date: '约会' };

/** 衣柜里的一套：中文名 + NovelAI tags */
export interface OutfitItem {
  id: string;
  name: string;
  tags: string;
  kind: OutfitKind;
}

/** 今天穿的一套 */
export interface DayOutfit {
  name: string;
  tags: string;
}

/** 作息里的一段：几点到几点、在哪（她世界里的地点 id）、在做什么；fixed 的事每天都不挪（例如江屿下午的训练） */
export interface RhythmSlot {
  from: string;
  to: string;
  locationId: string;
  status: string;
  fixed?: boolean;
}

export interface RhythmMeals {
  breakfast: string;
  lunch: string;
  dinner: string;
}

export interface RhythmTemplate {
  schedule: RhythmSlot[];
  meals: RhythmMeals;
  wardrobe: OutfitItem[];
  /** 她最近手头在忙的事（陪伴学习里她的小目标） */
  task: string;
}

/** 她身边的人（建世界时从角色卡、世界书里找出来的） */
export interface RhythmPerson {
  name: string;
  relation: string;
  note: string;
}

/** 每个角色怎么排：固定（一直用模板）还是每天变化（三项可以分别勾） */
export interface RhythmSettings {
  mode: 'fixed' | 'daily';
  vary: { schedule: boolean; meals: boolean; outfits: boolean };
  /** 穿着每天变化时：从衣柜里挑着搭（更稳）/ 每天新编（变化多） */
  outfitMode: 'pick' | 'new';
}

export const DEFAULT_RHYTHM_SETTINGS: RhythmSettings = {
  mode: 'fixed',
  vary: { schedule: true, meals: true, outfits: true },
  outfitMode: 'pick',
};

/** 一个角色的节律设置和模板 */
export interface CharacterRhythm {
  characterId: string;
  settings: RhythmSettings;
  /** 还没有时用她的世界里的作息（演示角色）；导入的角色要先"建世界" */
  template: RhythmTemplate | null;
  people: RhythmPerson[];
  updatedAt: number;
}

/** 某一天：节律日从凌晨 4 点算起（4 点前还算前一天） */
export interface RhythmDay {
  characterId: string;
  /** YYYY-MM-DD */
  date: string;
  schedule: RhythmSlot[];
  meals: RhythmMeals;
  outfits: Partial<Record<OutfitKind, DayOutfit>>;
  /** 今天手头的事 */
  task: string;
  /** 一两件小事（番外、主动消息可以用） */
  events: string[];
  /** template：按模板；model：「节律」排的（没变化的几项仍按模板） */
  source: 'template' | 'model';
  model?: string;
  at: number;
  /** 检查时改过的地方（作息没盖满一整天、地点不在她的世界里、挪了固定的事……） */
  fixes?: string[];
  /** 你在节律页里改过 */
  edited?: boolean;
}
