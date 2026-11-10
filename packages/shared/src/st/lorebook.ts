import type { LoreEntry, LoreLogic, LorePosition, Lorebook } from '../types/lorebook.ts';

/**
 * SillyTavern 世界书的两种格式：
 * - 独立的 World Info 文件：{ entries: { "0": { uid, key, keysecondary, order, position: 0-7, disable, … } } }
 * - 角色卡内嵌的 character_book（V2/V3 规范）：{ entries: [{ keys, secondary_keys, insertion_order, enabled,
 *   position: 'before_char' | 'after_char', extensions: { position: 0-7, depth, … } }] }
 * 字段对应关系同 ST 的 convertCharacterBook（public/scripts/world-info.js）。
 */

export type ParsedLorebook = Omit<Lorebook, 'id' | 'createdAt' | 'updatedAt'>;

type Obj = Record<string, unknown>;

const LOGIC: LoreLogic[] = ['and_any', 'not_all', 'not_any', 'and_all'];
const POSITIONS: LorePosition[] = ['before_char', 'after_char', 'an_top', 'an_bottom', 'at_depth', 'em_top', 'em_bottom'];
const ROLES = ['system', 'user', 'assistant'] as const;

/** ST 的世界书默认值（default/content/settings.json） */
export const ST_WORLD_INFO_DEFAULTS = {
  scanDepth: 2,
  budgetPercent: 25,
  recursive: true,
  caseSensitive: false,
  matchWholeWords: true,
  includeNames: true,
};

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : d);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = num(v, Number.NaN);
  return Number.isNaN(n) ? null : n;
};
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter((x) => x.length > 0) : typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

function pick(obj: Obj, used: Set<string>): Obj | undefined {
  const rest: Obj = {};
  for (const [k, v] of Object.entries(obj)) if (!used.has(k)) rest[k] = v;
  return Object.keys(rest).length ? rest : undefined;
}

function positionOf(v: unknown, fallback: LorePosition): LorePosition {
  if (typeof v === 'number') return POSITIONS[v] ?? (v === 7 ? 'after_char' : fallback);
  if (typeof v === 'string') {
    if ((POSITIONS as string[]).includes(v)) return v as LorePosition;
    if (/^\d+$/.test(v)) return positionOf(Number(v), fallback);
  }
  return fallback;
}

function delayUntil(v: unknown): boolean | number {
  if (typeof v === 'number') return v > 0 ? v : false;
  return v === true;
}

/** 已用的字段：世界书独立文件格式（扁平、驼峰） */
const FLAT_USED = new Set([
  'uid', 'key', 'keysecondary', 'comment', 'content', 'constant', 'selective', 'selectiveLogic', 'order', 'position', 'disable',
  'excludeRecursion', 'preventRecursion', 'delayUntilRecursion', 'probability', 'useProbability', 'depth', 'group', 'groupOverride',
  'groupWeight', 'scanDepth', 'caseSensitive', 'matchWholeWords', 'role', 'sticky', 'cooldown', 'delay', 'triggers', 'ignoreBudget',
]);

function fromFlatEntry(e: Obj, fallbackUid: string): LoreEntry {
  return {
    uid: str(e.uid, fallbackUid),
    comment: str(e.comment),
    keys: strList(e.key),
    secondaryKeys: strList(e.keysecondary),
    logic: LOGIC[num(e.selectiveLogic, 0)] ?? 'and_any',
    content: str(e.content),
    constant: e.constant === true,
    enabled: e.disable !== true,
    position: positionOf(e.position, 'before_char'),
    depth: num(e.depth, 4),
    role: ROLES[num(e.role, 0)] ?? 'system',
    order: num(e.order, 100),
    probability: num(e.probability, 100),
    useProbability: e.useProbability !== false,
    scanDepth: numOrNull(e.scanDepth),
    caseSensitive: boolOrNull(e.caseSensitive),
    matchWholeWords: boolOrNull(e.matchWholeWords),
    group: str(e.group),
    groupOverride: e.groupOverride === true,
    groupWeight: num(e.groupWeight, 100),
    preventRecursion: e.preventRecursion === true,
    excludeRecursion: e.excludeRecursion === true,
    delayUntilRecursion: delayUntil(e.delayUntilRecursion),
    ignoreBudget: e.ignoreBudget === true,
    triggers: strList(e.triggers),
    sticky: num(e.sticky, 0),
    cooldown: num(e.cooldown, 0),
    delay: num(e.delay, 0),
    extra: pick(e, FLAT_USED),
  };
}

const BOOK_ENTRY_USED = new Set(['id', 'keys', 'secondary_keys', 'comment', 'content', 'constant', 'selective', 'insertion_order', 'enabled', 'position', 'case_sensitive', 'extensions']);
const BOOK_EXT_USED = new Set([
  'position', 'exclude_recursion', 'prevent_recursion', 'delay_until_recursion', 'probability', 'useProbability', 'depth', 'selectiveLogic',
  'group', 'group_override', 'group_weight', 'scan_depth', 'case_sensitive', 'match_whole_words', 'role', 'sticky', 'cooldown', 'delay',
  'triggers', 'ignore_budget',
]);

function fromBookEntry(e: Obj, index: number): LoreEntry {
  const ext = isObj(e.extensions) ? e.extensions : {};
  const extra = pick(e, BOOK_ENTRY_USED) ?? {};
  const extRest = pick(ext, BOOK_EXT_USED);
  if (extRest) extra.extensions = extRest;
  return {
    uid: str(e.id, String(index)),
    comment: str(e.comment) || str(e.name),
    keys: strList(e.keys),
    secondaryKeys: strList(e.secondary_keys),
    logic: LOGIC[num(ext.selectiveLogic, 0)] ?? 'and_any',
    content: str(e.content),
    constant: e.constant === true,
    enabled: e.enabled !== false,
    position: ext.position !== undefined ? positionOf(ext.position, 'before_char') : e.position === 'before_char' ? 'before_char' : 'after_char',
    depth: num(ext.depth, 4),
    role: ROLES[num(ext.role, 0)] ?? 'system',
    order: num(e.insertion_order, 100),
    probability: num(ext.probability, 100),
    useProbability: ext.useProbability !== false,
    scanDepth: numOrNull(ext.scan_depth),
    caseSensitive: boolOrNull(ext.case_sensitive) ?? boolOrNull(e.case_sensitive),
    matchWholeWords: boolOrNull(ext.match_whole_words),
    group: str(ext.group),
    groupOverride: ext.group_override === true,
    groupWeight: num(ext.group_weight, 100),
    preventRecursion: ext.prevent_recursion === true,
    excludeRecursion: ext.exclude_recursion === true,
    delayUntilRecursion: delayUntil(ext.delay_until_recursion),
    ignoreBudget: ext.ignore_budget === true,
    triggers: strList(ext.triggers),
    sticky: num(ext.sticky, 0),
    cooldown: num(ext.cooldown, 0),
    delay: num(ext.delay, 0),
    extra: Object.keys(extra).length ? extra : undefined,
  };
}

/** 是不是世界书文件（独立的 World Info JSON 或 character_book） */
export function looksLikeLorebook(json: unknown): boolean {
  return isObj(json) && (Array.isArray(json.entries) || isObj(json.entries)) && !('spec' in json) && !('prompts' in json);
}

/**
 * 解析世界书。entries 是数组时按 character_book 读，是对象时按 ST 独立文件读。
 * name 为空时用 fallbackName（通常是文件名）。
 */
export function parseLorebook(json: unknown, fallbackName = '世界书'): ParsedLorebook {
  if (!isObj(json)) throw new Error('世界书不是 JSON 对象');
  const raw = json.entries;
  let entries: LoreEntry[];
  if (Array.isArray(raw)) entries = raw.filter(isObj).map(fromBookEntry);
  else if (isObj(raw)) entries = Object.entries(raw).filter(([, v]) => isObj(v)).map(([k, v]) => fromFlatEntry(v as Obj, k));
  else throw new Error('世界书里没有 entries');

  // 按 ST 编辑器里的显示顺序排
  const display = (e: LoreEntry) => {
    const x = e.extra;
    const d = x?.displayIndex ?? (isObj(x?.extensions) ? x.extensions.display_index : undefined);
    return typeof d === 'number' ? d : Number.MAX_SAFE_INTEGER;
  };
  entries = entries.map((e, i) => ({ e, i })).sort((a, b) => display(a.e) - display(b.e) || a.i - b.i).map((x) => x.e);

  const extra = pick(json, new Set(['entries', 'name', 'description', 'scan_depth', 'token_budget', 'recursive_scanning']));
  return {
    name: str(json.name) || fallbackName,
    description: str(json.description),
    scanDepth: num(json.scan_depth, ST_WORLD_INFO_DEFAULTS.scanDepth),
    // ST 按上下文的百分比算预算；这里存绝对值，0 表示"按预设的上下文 25%"
    tokenBudget: num(json.token_budget, 0),
    recursive: typeof json.recursive_scanning === 'boolean' ? json.recursive_scanning : ST_WORLD_INFO_DEFAULTS.recursive,
    entries,
    extra,
  };
}

/** 导出成角色卡内嵌的 character_book（V2/V3 规范 + ST 的 extensions） */
export function toCharacterBook(book: Pick<Lorebook, 'name' | 'description' | 'scanDepth' | 'tokenBudget' | 'recursive' | 'entries' | 'extra'>): Obj {
  const out: Obj = { ...(book.extra ?? {}) };
  if (book.name) out.name = book.name;
  if (book.description) out.description = book.description;
  if (book.scanDepth !== ST_WORLD_INFO_DEFAULTS.scanDepth) out.scan_depth = book.scanDepth;
  if (book.tokenBudget) out.token_budget = book.tokenBudget;
  out.recursive_scanning = book.recursive;
  out.entries = book.entries.map((e, i) => {
    const { extensions: extExtra, ...topExtra } = (e.extra ?? {}) as Obj;
    return {
      id: Number.isFinite(Number(e.uid)) ? Number(e.uid) : i,
      keys: e.keys,
      secondary_keys: e.secondaryKeys,
      comment: e.comment,
      content: e.content,
      constant: e.constant,
      selective: true,
      insertion_order: e.order,
      enabled: e.enabled,
      position: e.position === 'before_char' ? 'before_char' : 'after_char',
      ...topExtra,
      extensions: {
        ...(isObj(extExtra) ? extExtra : {}),
        position: POSITIONS.indexOf(e.position),
        exclude_recursion: e.excludeRecursion,
        prevent_recursion: e.preventRecursion,
        delay_until_recursion: e.delayUntilRecursion,
        probability: e.probability,
        useProbability: e.useProbability,
        depth: e.depth,
        selectiveLogic: LOGIC.indexOf(e.logic),
        group: e.group,
        group_override: e.groupOverride,
        group_weight: e.groupWeight,
        scan_depth: e.scanDepth,
        case_sensitive: e.caseSensitive,
        match_whole_words: e.matchWholeWords,
        role: ROLES.indexOf(e.role),
        sticky: e.sticky,
        cooldown: e.cooldown,
        delay: e.delay,
        triggers: e.triggers,
        ignore_budget: e.ignoreBudget,
      },
    };
  });
  return out;
}

/** 导出成 ST 的独立世界书文件 */
export function toWorldInfoFile(book: Pick<Lorebook, 'name' | 'entries'>): Obj {
  const entries: Obj = {};
  book.entries.forEach((e, i) => {
    const uid = Number.isFinite(Number(e.uid)) ? Number(e.uid) : i;
    const { extensions, ...flatExtra } = (e.extra ?? {}) as Obj;
    entries[String(uid)] = {
      ...flatExtra,
      ...(isObj(extensions) ? { extensions } : {}),
      uid,
      key: e.keys,
      keysecondary: e.secondaryKeys,
      comment: e.comment,
      content: e.content,
      constant: e.constant,
      selective: true,
      selectiveLogic: LOGIC.indexOf(e.logic),
      order: e.order,
      position: POSITIONS.indexOf(e.position),
      disable: !e.enabled,
      excludeRecursion: e.excludeRecursion,
      preventRecursion: e.preventRecursion,
      delayUntilRecursion: e.delayUntilRecursion,
      probability: e.probability,
      useProbability: e.useProbability,
      depth: e.depth,
      group: e.group,
      groupOverride: e.groupOverride,
      groupWeight: e.groupWeight,
      scanDepth: e.scanDepth,
      caseSensitive: e.caseSensitive,
      matchWholeWords: e.matchWholeWords,
      role: ROLES.indexOf(e.role),
      sticky: e.sticky,
      cooldown: e.cooldown,
      delay: e.delay,
      triggers: e.triggers,
      ignoreBudget: e.ignoreBudget,
      displayIndex: i,
    };
  });
  return { name: book.name, entries };
}
