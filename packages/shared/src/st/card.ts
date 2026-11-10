import { DEFAULT_PROACTIVE_RULES } from '../types/proactive.ts';
import type { Character, StCardFields } from '../types/character.ts';
import type { Lorebook } from '../types/lorebook.ts';
import { base64Decode, base64Encode, utf8Decode, utf8Encode } from './bytes.ts';
import { isObj, parseLorebook, toCharacterBook, type ParsedLorebook } from './lorebook.ts';
import { isPng, readPngText, writePngText } from './png.ts';

/**
 * SillyTavern 角色卡 V1 / V2 / V3（JSON 或 PNG）。
 * - PNG：tEXt 块里优先 ccv3，其次 chara（同 ST 的 src/character-card-parser.js）
 * - JSON：有 spec + data 时读 data；没有时按 V1 的扁平字段读
 * - 内嵌的 character_book 拆成独立世界书；extensions 和其余字段原样保存，导出时写回
 */

type Obj = Record<string, unknown>;

export interface ParsedCard {
  spec: 'v1' | 'v2' | 'v3';
  /** 数据从哪读出来的 */
  source: 'json' | 'png:ccv3' | 'png:chara';
  name: string;
  card: StCardFields;
  /** 内嵌世界书（没有或没有条目时为空） */
  book: ParsedLorebook | null;
  /** 读卡时值得一提的事（例如缺名字、PNG 里两个块不一致） */
  warnings: string[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s) => s.length > 0) : []);

/** data 里有对应字段的 key（其余放进 card.extra） */
const DATA_USED = new Set([
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt',
  'post_history_instructions', 'alternate_greetings', 'tags', 'creator', 'character_version', 'extensions', 'character_book',
]);

function specOf(json: Obj): ParsedCard['spec'] {
  if (json.spec === 'chara_card_v3') return 'v3';
  if (json.spec === 'chara_card_v2') return 'v2';
  return isObj(json.data) ? 'v2' : 'v1';
}

/** 是不是角色卡 JSON */
export function looksLikeCard(json: unknown): boolean {
  if (!isObj(json)) return false;
  if (json.spec === 'chara_card_v2' || json.spec === 'chara_card_v3') return true;
  return typeof json.name === 'string' && ('first_mes' in json || 'description' in json || 'mes_example' in json);
}

export function parseCardJson(json: unknown, source: ParsedCard['source'] = 'json'): ParsedCard {
  if (!isObj(json)) throw new Error('角色卡不是 JSON 对象');
  const spec = specOf(json);
  // V1 没有 data；V2/V3 读 data（ST 导出的卡外层还有一份 V1 兼容字段，以 data 为准）
  const d: Obj = spec === 'v1' ? json : (json.data as Obj);
  const warnings: string[] = [];
  const name = str(d.name).trim() || str(json.name).trim();
  if (!name) warnings.push('角色卡没有名字，先叫"未命名"');

  const extra: Obj = {};
  if (spec !== 'v1') for (const [k, v] of Object.entries(d)) if (!DATA_USED.has(k)) extra[k] = v;

  const card: StCardFields = {
    description: str(d.description),
    personality: str(d.personality),
    scenario: str(d.scenario),
    firstMes: str(d.first_mes),
    alternateGreetings: strList(d.alternate_greetings),
    mesExample: str(d.mes_example),
    systemPrompt: str(d.system_prompt),
    postHistoryInstructions: str(d.post_history_instructions),
    creatorNotes: str(d.creator_notes) || str(json.creatorcomment),
    tags: strList(d.tags),
    creator: str(d.creator),
    characterVersion: str(d.character_version),
    extensions: isObj(d.extensions) ? { ...d.extensions } : {},
    extra,
  };

  let book: ParsedLorebook | null = null;
  if (isObj(d.character_book)) {
    // 世界书名字：内嵌的 name，其次 extensions.world（ST 导入时用它当世界书名），再次"角色名的世界书"
    const world = str(card.extensions.world);
    book = parseLorebook(d.character_book, world || `${name || '未命名'}的世界书`);
    if (!book.entries.length) {
      warnings.push('内嵌世界书是空的，没有导入');
      book = null;
    }
  }

  return { spec, source, name: name || '未命名', card, book, warnings };
}

/** 从 PNG 里读角色卡 */
export function parseCardPng(bytes: Uint8Array): ParsedCard {
  const text = readPngText(bytes);
  const key = 'ccv3' in text ? 'ccv3' : 'chara' in text ? 'chara' : null;
  if (!key) throw new Error('这张 PNG 里没有角色卡数据（没有 chara / ccv3 块）');
  let json: unknown;
  try {
    json = JSON.parse(utf8Decode(base64Decode(text[key] as string)));
  } catch {
    throw new Error(`PNG 里的 ${key} 块不是有效的角色卡 JSON`);
  }
  const parsed = parseCardJson(json, key === 'ccv3' ? 'png:ccv3' : 'png:chara');
  if (key === 'ccv3' && 'chara' in text) {
    try {
      const v2 = parseCardJson(JSON.parse(utf8Decode(base64Decode(text.chara as string))));
      if (v2.name !== parsed.name || v2.card.description !== parsed.card.description) {
        parsed.warnings.push('PNG 里 ccv3 和 chara 两份数据不一样，按 ccv3（V3）导入');
      }
    } catch {
      // chara 块坏了也没关系，已经用 ccv3
    }
  }
  return parsed;
}

/** 按内容自动判断：PNG 读 tEXt 块，其他按 JSON 读 */
export function parseCardFile(bytes: Uint8Array): ParsedCard {
  if (isPng(bytes)) return parseCardPng(bytes);
  let json: unknown;
  try {
    json = JSON.parse(utf8Decode(bytes).replace(/^﻿/, ''));
  } catch {
    throw new Error('不是 PNG，也不是 JSON');
  }
  return parseCardJson(json);
}

const ACCENTS = ['#f5b8a6', '#f39cc0', '#b7a6f5', '#8ec5e8', '#7fd1b1', '#f2c66d'];

/** 导入的卡变成 App 的角色：卡里没有的（语音、主动消息、关系……）用默认值 */
export function characterFromCard(
  parsed: ParsedCard,
  opts: { id: string; now: number; lorebookIds: string[]; presetId: string | null; accent?: string },
): Character {
  const accent = opts.accent ?? ACCENTS[[...parsed.name].reduce((n, c) => n + (c.codePointAt(0) ?? 0), 0) % ACCENTS.length] ?? '#f5b8a6';
  return {
    id: opts.id,
    createdAt: opts.now,
    updatedAt: opts.now,
    name: parsed.name,
    // 卡里没有性别信息，先用"TA"，在角色页里可以改
    pronoun: 'TA',
    avatar: null,
    accent,
    hairColor: '#3b2a35',
    card: parsed.card,
    lorebookIds: opts.lorebookIds,
    presetId: opts.presetId,
    spriteSetId: null,
    appearanceTags: '',
    negativeTags: '',
    voice: { connectionId: null, voiceId: '', voiceLabel: '未设置', speed: 1, emotionMap: {} },
    proactive: {
      enabled: false,
      personality: 'balanced',
      dailyCap: 3,
      quietHours: { start: '00:30', end: '07:30' },
      triggers: DEFAULT_PROACTIVE_RULES.filter((r) => r.enabled).map((r) => r.id),
      allowCalls: false,
      allowSelfies: false,
    },
    relationship: {
      affection: 50,
      mood: '',
      userNickname: '',
      charNickname: '',
      metAt: opts.now,
      anniversaries: [],
      milestones: [],
    },
    status: '',
    locationId: null,
  };
}

/**
 * 导出成 V3 角色卡 JSON（外层同时带 V1 兼容字段，和 ST 导出的一样）。
 * book 是要嵌回去的世界书（ST 一张卡只嵌一本），通常是角色绑定的第一本。
 */
export function cardToV3(character: Pick<Character, 'name' | 'card'>, book?: Pick<Lorebook, 'name' | 'description' | 'scanDepth' | 'tokenBudget' | 'recursive' | 'entries' | 'extra'> | null): Obj {
  const c = character.card;
  const extensions: Obj = { ...c.extensions };
  if (book && !extensions.world) extensions.world = book.name;
  const data: Obj = {
    ...c.extra,
    name: character.name,
    description: c.description,
    personality: c.personality,
    scenario: c.scenario,
    first_mes: c.firstMes,
    mes_example: c.mesExample,
    creator_notes: c.creatorNotes,
    system_prompt: c.systemPrompt,
    post_history_instructions: c.postHistoryInstructions,
    tags: c.tags,
    creator: c.creator ?? '',
    character_version: c.characterVersion ?? '',
    alternate_greetings: c.alternateGreetings,
    extensions,
  };
  if (book) data.character_book = toCharacterBook(book);
  return {
    name: character.name,
    description: c.description,
    personality: c.personality,
    scenario: c.scenario,
    first_mes: c.firstMes,
    mes_example: c.mesExample,
    creatorcomment: c.creatorNotes,
    tags: c.tags,
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data,
  };
}

/** 把角色卡写进 PNG：chara（V2）和 ccv3（V3）两个块都写，同 ST */
export function cardToPng(image: Uint8Array, v3: Obj): Uint8Array {
  const v2 = { ...v3, spec: 'chara_card_v2', spec_version: '2.0' };
  const enc = (o: unknown) => base64Encode(utf8Encode(JSON.stringify(o)));
  return writePngText(image, { chara: enc(v2), ccv3: enc(v3) });
}
