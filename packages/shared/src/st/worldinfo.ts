import type { LoreEntry, LoreTimedState, Lorebook } from '../types/lorebook.ts';
import { ST_WORLD_INFO_DEFAULTS } from './lorebook.ts';
import { estimateTokens } from './tokens.ts';

/**
 * 世界书扫描，按 SillyTavern 的 checkWorldInfo（public/scripts/world-info.js）一步步来：
 * 1. 条目按 order 从大到小排；逐条检查：关闭 / 生成类型 / 延迟 / 冷却 / 延迟到递归 / 排除递归 → 常驻 → 粘性 → 关键词 + 次关键词逻辑
 * 2. 同组只留一条（优先 groupOverride，否则按权重随机），再抽概率、按 token 预算截断
 * 3. 新触发的条目（没勾"不递归"的）内容加进递归缓冲区，再扫一轮；"延迟到递归"的条目只在递归轮里才有机会
 * 4. 按 order 从小到大拼进各个位置
 * 每条都记下触发或没触发的原因，"查看提示词"里能看到。
 */

export interface WorldInfoInput {
  books: Lorebook[];
  /** 用来扫描的聊天记录，从旧到新，每条已带名字（"小克: 你好"） */
  messages: string[];
  /** 上下文 token 预算（世界书最多占 budgetPercent%） */
  maxContext: number;
  budgetPercent?: number;
  /** 默认扫描深度（条目和世界书都没写时用） */
  scanDepth?: number;
  caseSensitive?: boolean;
  matchWholeWords?: boolean;
  /** 本次生成的类型（normal / continue / impersonate / swipe / regenerate / quiet） */
  trigger?: string;
  /** 聊天里有多少条消息（粘性 / 冷却 / 延迟按它算） */
  chatLength: number;
  state?: LoreTimedState;
  /** 只是预览（查看提示词）：不推进粘性 / 冷却，和 ST 的 dry run 一样 */
  dryRun?: boolean;
  random?: () => number;
  /** 宏替换（关键词和内容都会先替换） */
  macro?: (text: string) => string;
  countTokens?: (text: string) => number;
}

export interface ActivatedLore {
  key: string;
  bookId: string;
  bookName: string;
  entry: LoreEntry;
  /** 宏替换后的内容 */
  content: string;
  reason: string;
}

export interface LoreLogItem {
  key: string;
  bookId: string;
  bookName: string;
  uid: string;
  comment: string;
  position: LoreEntry['position'];
  activated: boolean;
  reason: string;
}

export interface WorldInfoResult {
  before: string;
  after: string;
  anTop: string[];
  anBottom: string[];
  emTop: string[];
  emBottom: string[];
  /** 按深度插入的条目，同深度同角色合成一条（同 ST） */
  depth: { depth: number; role: 'system' | 'user' | 'assistant'; content: string }[];
  activated: ActivatedLore[];
  log: LoreLogItem[];
  state: LoreTimedState;
  budget: number;
  overflowed: boolean;
}

interface Item {
  key: string;
  book: Lorebook;
  e: LoreEntry;
  content: string;
}

const RECURSION = 2;
const INITIAL = 1;
const MAX_LOOPS = 20;

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** /pattern/flags 形式的关键词按正则匹配（同 ST 的 parseRegexFromString） */
function parseRegexKey(input: string): RegExp | null {
  const m = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
  if (!m) return null;
  let pattern = m[1] as string;
  if (/(^|[^\\])\//.test(pattern)) return null;
  pattern = pattern.replace('\\/', '/');
  try {
    return new RegExp(pattern, m[2]);
  } catch {
    return null;
  }
}

const HAS_CJK = /[　-鿿가-힯＀-￯]/;

export function scanWorldInfo(input: WorldInfoInput): WorldInfoResult {
  const rnd = input.random ?? Math.random;
  const macro = input.macro ?? ((s: string) => s);
  const count = input.countTokens ?? estimateTokens;
  const globalCase = input.caseSensitive ?? ST_WORLD_INFO_DEFAULTS.caseSensitive;
  const globalWhole = input.matchWholeWords ?? ST_WORLD_INFO_DEFAULTS.matchWholeWords;
  const recursive = input.books.some((b) => b.recursive);
  const state: LoreTimedState = {
    sticky: { ...(input.state?.sticky ?? {}) },
    cooldown: { ...(input.state?.cooldown ?? {}) },
  };
  const len = input.chatLength;

  // ST 的预算：上下文的 25%；世界书自己写了预算的取最小的当上限
  let budget = Math.round(((input.budgetPercent ?? ST_WORLD_INFO_DEFAULTS.budgetPercent) * input.maxContext) / 100) || 1;
  const caps = input.books.map((b) => b.tokenBudget).filter((n) => n > 0);
  if (caps.length) budget = Math.min(budget, ...caps);

  const items: Item[] = input.books
    .flatMap((book) => book.entries.map((e) => ({ key: `${book.id}.${e.uid}`, book, e, content: e.content })))
    .sort((a, b) => b.e.order - a.e.order);
  const index = new Map(items.map((it, i) => [it, i]));
  const byKey = new Map(items.map((it) => [it.key, it]));

  const reasons = new Map<string, string>();
  const note = (it: Item, r: string) => {
    if (!reasons.has(it.key) || !activated.has(it.key)) reasons.set(it.key, r);
  };

  // 计时效果：粘性 / 冷却（预览时不推进）、延迟
  const stickyNow = new Set<string>();
  const cooldownNow = new Set<string>();
  if (!input.dryRun) {
    for (const type of ['sticky', 'cooldown'] as const) {
      for (const [key, v] of Object.entries(state[type])) {
        const it = byKey.get(key);
        if (len <= v.start && !v.protected) {
          delete state[type][key];
          continue;
        }
        if (!it) {
          if (len >= v.end) delete state[type][key];
          continue;
        }
        if (!it.e[type]) {
          delete state[type][key];
          continue;
        }
        if (len >= v.end) {
          delete state[type][key];
          // 粘性结束后进入冷却
          if (type === 'sticky' && it.e.cooldown) {
            state.cooldown[key] = { start: len, end: len + it.e.cooldown, protected: true };
            cooldownNow.add(key);
          }
          continue;
        }
        (type === 'sticky' ? stickyNow : cooldownNow).add(key);
      }
    }
  }

  const levels = [...new Set(items.filter((it) => it.e.delayUntilRecursion).map((it) => (it.e.delayUntilRecursion === true ? 1 : Number(it.e.delayUntilRecursion))))].sort((a, b) => a - b);
  let level = levels.shift() ?? 0;

  // 扫描缓冲区：最新的在前（同 ST 的 WorldInfoBuffer）
  const recent = [...input.messages].reverse().map((m) => m.trim());
  const recurse: string[] = [];
  const bufferFor = (it: Item, scanState: number) => {
    const depth = Math.max(0, Math.min(1000, it.e.scanDepth ?? it.book.scanDepth ?? input.scanDepth ?? ST_WORLD_INFO_DEFAULTS.scanDepth));
    let text = '\x01' + recent.slice(0, depth).join('\n\x01');
    if (recurse.length && scanState !== 3) text += '\n\x01' + recurse.join('\n\x01');
    return text;
  };
  const matchKey = (haystack: string, rawKey: string, e: LoreEntry): boolean => {
    const key = macro(rawKey).trim();
    if (!key) return false;
    const re = parseRegexKey(key);
    if (re) return re.test(haystack);
    const cs = e.caseSensitive ?? globalCase;
    const h = cs ? haystack : haystack.toLowerCase();
    const k = cs ? key : key.toLowerCase();
    const whole = (e.matchWholeWords ?? globalWhole) && !HAS_CJK.test(k);
    if (!whole || k.split(/\s+/).length > 1) return h.includes(k);
    return new RegExp(`(?:^|\\W)(${escapeRegex(k)})(?:$|\\W)`).test(h);
  };

  const activated = new Map<string, Item & { reason: string }>();
  const failedProbability = new Set<string>();
  let allActivatedText = '';
  let overflowed = false;
  let scanState = INITIAL;
  let loops = 0;

  while (scanState && loops < MAX_LOOPS) {
    loops++;
    let next = 0;
    const now = new Map<Item, string>();

    for (const it of items) {
      const e = it.e;
      if (failedProbability.has(it.key) || activated.has(it.key)) continue;
      if (!e.enabled) {
        note(it, '已关闭');
        continue;
      }
      if (e.triggers.length && !e.triggers.includes(input.trigger ?? 'normal')) {
        note(it, `只在 ${e.triggers.join(' / ')} 时触发`);
        continue;
      }
      const sticky = stickyNow.has(it.key);
      if (e.delay && len < e.delay) {
        note(it, `聊天满 ${e.delay} 条后才触发（现在 ${len} 条）`);
        continue;
      }
      if (cooldownNow.has(it.key) && !sticky) {
        note(it, '冷却中');
        continue;
      }
      if (scanState !== RECURSION && e.delayUntilRecursion && !sticky) {
        note(it, '只在递归扫描时触发，这次没有可以递归的内容');
        continue;
      }
      const lv = e.delayUntilRecursion === true ? 1 : Number(e.delayUntilRecursion);
      if (scanState === RECURSION && e.delayUntilRecursion && lv > level && !sticky) {
        note(it, `只在第 ${lv} 层递归时触发`);
        continue;
      }
      if (scanState === RECURSION && recursive && e.excludeRecursion && !sticky) {
        note(it, '不会被别的条目触发（排除递归）');
        continue;
      }
      if (e.constant) {
        now.set(it, scanState === RECURSION ? '常驻（递归轮）' : '常驻');
        continue;
      }
      if (sticky) {
        now.set(it, '粘性还没结束');
        continue;
      }
      if (!e.keys.length) {
        note(it, '没有关键词，也不是常驻');
        continue;
      }
      const text = bufferFor(it, scanState);
      const hit = e.keys.find((k) => matchKey(text, k, e));
      if (!hit) {
        note(it, '最近的聊天里没有出现关键词');
        continue;
      }
      const sec = e.secondaryKeys.filter((k) => macro(k).trim());
      if (!sec.length) {
        now.set(it, `关键词"${hit}"${scanState === RECURSION ? '（递归）' : ''}`);
        continue;
      }
      const results = sec.map((k) => matchKey(text, k, e));
      const any = results.some(Boolean);
      const all = results.every(Boolean);
      const ok =
        e.logic === 'and_any' ? any : e.logic === 'not_all' ? !all : e.logic === 'not_any' ? !any : all;
      if (!ok) {
        note(it, `关键词"${hit}"命中，但次关键词不满足（${e.logic}）`);
        continue;
      }
      now.set(it, `关键词"${hit}" + 次关键词`);
    }

    // 粘性的排前面，其余按原顺序（order 从大到小）
    let fresh = [...now.keys()].sort(
      (a, b) => Number(stickyNow.has(b.key)) - Number(stickyNow.has(a.key)) || (index.get(a) ?? 0) - (index.get(b) ?? 0),
    );

    // 分组：同组只留一条
    const groups = new Map<string, Item[]>();
    for (const it of fresh) {
      for (const g of it.e.group.split(/,\s*/).filter(Boolean)) groups.set(g, [...(groups.get(g) ?? []), it]);
    }
    const losers = new Set<Item>();
    for (const [g, list] of groups) {
      const stickies = list.filter((it) => stickyNow.has(it.key));
      if (stickies.length) {
        for (const it of list) if (!stickyNow.has(it.key)) losers.add(it);
        continue;
      }
      if ([...activated.values()].some((a) => a.e.group.split(/,\s*/).includes(g))) {
        for (const it of list) losers.add(it);
        continue;
      }
      if (list.length <= 1) continue;
      const prio = list.filter((it) => it.e.groupOverride).sort((a, b) => b.e.order - a.e.order);
      let winner: Item | undefined = prio[0];
      if (!winner) {
        const total = list.reduce((n, it) => n + (it.e.groupWeight ?? 100), 0);
        const r = rnd() * total;
        let acc = 0;
        winner = list.find((it) => (acc += it.e.groupWeight ?? 100) >= r);
      }
      for (const it of list) if (it !== winner) losers.add(it);
    }
    for (const it of losers) note(it, '同组只选一条，这次没选中');
    fresh = fresh.filter((it) => !losers.has(it));

    // 概率 + 预算
    let newContent = '';
    const baseTokens = count(allActivatedText);
    let ignoresLeft = fresh.filter((it) => it.e.ignoreBudget).length;
    for (const it of fresh) {
      if (it.e.ignoreBudget) ignoresLeft--;
      if (overflowed && !it.e.ignoreBudget) {
        note(it, '超出世界书 token 预算');
        if (ignoresLeft > 0) continue;
        break;
      }
      if (it.e.useProbability && it.e.probability < 100 && !stickyNow.has(it.key)) {
        if (rnd() * 100 > it.e.probability) {
          failedProbability.add(it.key);
          note(it, `概率 ${it.e.probability}% 没抽中`);
          continue;
        }
      }
      it.content = macro(it.e.content);
      newContent += `${it.content}\n`;
      if (!it.e.ignoreBudget && baseTokens + count(newContent) >= budget) {
        overflowed = true;
        note(it, '超出世界书 token 预算');
        continue;
      }
      activated.set(it.key, { ...it, reason: now.get(it) ?? '' });
      reasons.set(it.key, now.get(it) ?? '');
    }

    const successful = fresh.filter((it) => !failedProbability.has(it.key));
    const forRecursion = successful.filter((it) => !it.e.preventRecursion);
    if (recursive && !overflowed && forRecursion.length) next = RECURSION;
    if (!next && levels.length) {
      next = RECURSION;
      level = levels.shift() as number;
    }
    scanState = next;
    if (scanState) {
      const text = forRecursion.map((it) => it.content).join('\n');
      if (text) {
        recurse.push(text);
        allActivatedText = `${text}\n${allActivatedText}`;
      }
    }
  }

  // 拼进各个位置：order 从小到大
  const list = [...activated.values()].sort((a, b) => a.e.order - b.e.order);
  const before: string[] = [];
  const after: string[] = [];
  const anTop: string[] = [];
  const anBottom: string[] = [];
  const emTop: string[] = [];
  const emBottom: string[] = [];
  const depth: WorldInfoResult['depth'] = [];
  for (const it of list) {
    if (!it.content) {
      reasons.set(it.key, `${it.reason}，但内容为空，没有插入`);
      continue;
    }
    switch (it.e.position) {
      case 'before_char':
        before.push(it.content);
        break;
      case 'after_char':
        after.push(it.content);
        break;
      case 'an_top':
        anTop.push(it.content);
        break;
      case 'an_bottom':
        anBottom.push(it.content);
        break;
      case 'em_top':
        emTop.push(it.content);
        break;
      case 'em_bottom':
        emBottom.push(it.content);
        break;
      case 'at_depth': {
        const d = depth.find((x) => x.depth === it.e.depth && x.role === it.e.role);
        if (d) d.content = `${d.content}\n${it.content}`;
        else depth.push({ depth: it.e.depth, role: it.e.role, content: it.content });
        break;
      }
    }
  }

  // 记下新的粘性 / 冷却
  if (!input.dryRun) {
    for (const it of activated.values()) {
      if (it.e.sticky && !state.sticky[it.key]) state.sticky[it.key] = { start: len, end: len + it.e.sticky };
      if (it.e.cooldown && !state.cooldown[it.key]) state.cooldown[it.key] = { start: len, end: len + it.e.cooldown };
    }
  }

  return {
    before: before.join('\n'),
    after: after.join('\n'),
    anTop,
    anBottom,
    emTop,
    emBottom,
    depth,
    activated: list.map((it) => ({ key: it.key, bookId: it.book.id, bookName: it.book.name, entry: it.e, content: it.content, reason: it.reason })),
    log: items.map((it) => ({
      key: it.key,
      bookId: it.book.id,
      bookName: it.book.name,
      uid: it.e.uid,
      comment: it.e.comment,
      position: it.e.position,
      activated: activated.has(it.key) && !!activated.get(it.key)?.content,
      reason: reasons.get(it.key) ?? '没有检查到',
    })),
    state,
    budget,
    overflowed,
  };
}
