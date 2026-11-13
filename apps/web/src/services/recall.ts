import { isAbortError, linkSignals, rankRecall, type EchoEntry, type RecallHit, type RecallReason } from '@app/ai';
import { detectStates, estimateTokens, parseTimeQuery, todaySpecials, type Character, type Chat } from '@app/shared';
import { reactive } from 'vue';
import { useAiStore } from '@/stores/ai';
import { useEnvironmentStore } from '@/stores/environment';
import { useMemoryStore } from '@/stores/memory';

/**
 * 取记忆（设计文档 §6.1）：AI 回复完成后在后台搜一次，结果按聊天存起来；你发下一条时直接用存好的结果，不用等。
 * - 搜什么：本轮你的消息 + 她的回复（各取前 300 字）；纯寒暄沿用上一轮的结果；
 * - 你本轮发的内容要到下一轮才进入向量搜索；发送时只在本机用它按字面、按时间说法补一两条（几毫秒、不联网）；
 * - 重新生成时沿用那一轮原来用的结果；
 * - 向量化没接通或失败时只按字面搜。
 */

export interface RecallLine {
  key: string;
  kind: 'memory' | 'slice';
  id: string;
  text: string;
  at: number;
  reason: RecallReason;
  score: number;
  dense: number | null;
  lexical: number | null;
}

export interface RecallSnapshot {
  /** 搜的时候最后一条消息（这份结果给它之后的那一轮用） */
  afterMessageId: string | null;
  at: number;
  query: string;
  lines: RecallLine[];
  echo: EchoEntry[];
  /** 这次用上了向量（按意思搜） */
  dense: boolean;
  /** 没用上向量的原因；用上了为空 */
  denseNote: string;
  time: string | null;
  specials: string[];
  states: string[];
}

/** 每条聊天最近 3 份结果（最新的在最后） */
const snapshots = reactive<Record<string, RecallSnapshot[]>>({});
/** 每条回复生成时用的那份（重新生成时沿用） */
const used = new Map<string, RecallLine[]>();
const running = new Map<string, AbortController>();

const MAX_ITEMS = 8;
const TOKEN_BUDGET = 900;
const PHATIC = /^[\s\p{P}\p{S}]*(嗯+|嗯嗯|哦+|噢+|好+|好的|好呀|好哒|行|ok|okay|收到|晚安|早安|早|哈+|嘿+|呜+|啊+|在吗|在|谢谢|么么哒?|抱抱|亲亲|贴贴)?[\s\p{P}\p{S}]*$/iu;

/** 只有寒暄、表情、标点 */
export function isPhatic(text: string): boolean {
  return PHATIC.test(text.trim());
}

function linesOf(hits: RecallHit[], characterId: string): RecallLine[] {
  const mem = useMemoryStore();
  const byKey = new Map(mem.candidates(characterId, null).map((c) => [c.key, c]));
  return hits
    .map((h) => ({ ...h, text: byKey.get(h.key)?.text ?? '' }))
    .filter((l) => l.text)
    .map(({ key, kind, id, text, at, reason, score, dense, lexical }) => ({ key, kind, id, text, at, reason, score, dense, lexical }));
}

function cues(text: string, character: Character, now: number) {
  const timeZone = useEnvironmentStore().settings.timezone;
  return {
    time: parseTimeQuery(text, now, timeZone),
    specials: todaySpecials({ now, timeZone, anniversaries: character.relationship.anniversaries, metAt: character.relationship.metAt }),
    states: detectStates(text),
  };
}

/** 这条聊天最新的一份结果 */
export function latestRecall(chatId: string): RecallSnapshot | undefined {
  return snapshots[chatId]?.at(-1);
}

/**
 * AI 回复完成后调用：用本轮你的消息 + 她的回复在后台搜一次。query 由调用方从消息里取（各截 300 字）。
 * 同一条聊天上一次还没搜完的会被取消
 */
export async function prefetchRecall(chat: Chat, character: Character, query: string, afterMessageId: string | null): Promise<RecallSnapshot | undefined> {
  const mem = useMemoryStore();
  if (!mem.ready) return undefined;
  const text = query.trim();
  const prev = latestRecall(chat.id);
  if (!text || isPhatic(text)) return prev;
  running.get(chat.id)?.abort();
  const abort = new AbortController();
  running.set(chat.id, abort);
  const ai = useAiStore();
  const now = Date.now();
  let queryVector: Float32Array | null = null;
  let space: { model: string; dims: number } | null = null;
  let denseNote = '';
  if (ai.isLive('embedding')) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 15_000);
    const linked = linkSignals(abort.signal, timeout.signal);
    try {
      const r = await ai.system.embed([text], { purpose: 'query', signal: linked.signal });
      queryVector = r.vectors[0] ?? null;
      space = queryVector ? { model: r.model, dims: queryVector.length } : null;
    } catch (e) {
      if (abort.signal.aborted) return prev;
      denseNote = isAbortError(e) ? '向量化超时，只按字面搜' : '向量化失败，只按字面搜（完整报错在"API 设置 → 向量化"）';
    } finally {
      clearTimeout(timer);
      linked.dispose();
    }
  } else {
    const st = ai.status('embedding');
    denseNote = `向量化没接通${'reason' in st ? `：${st.reason}` : ''}`;
  }
  if (abort.signal.aborted) return prev;
  running.delete(chat.id);

  const c = cues(text, character, now);
  const out = rankRecall({
    candidates: mem.candidates(character.id, space),
    query: text,
    queryVector,
    lexical: mem.lexical,
    now,
    time: c.time,
    specials: c.specials,
    states: c.states,
    echo: prev?.echo,
    maxItems: MAX_ITEMS,
    tokenBudget: TOKEN_BUDGET,
    countTokens: estimateTokens,
  });
  const snap: RecallSnapshot = {
    afterMessageId,
    at: now,
    query: text,
    lines: linesOf(out.hits, character.id),
    echo: out.echo,
    dense: !!queryVector,
    denseNote,
    time: c.time.phrase,
    specials: c.specials,
    states: c.states,
  };
  const list = [...(snapshots[chat.id] ?? []), snap].slice(-3);
  snapshots[chat.id] = list;
  return snap;
}

export interface RecallForTurn {
  lines: RecallLine[];
  snapshot: RecallSnapshot | undefined;
  /** 发送时用本轮消息在本机补的条数 */
  added: number;
  /** 沿用了重新生成前那一轮的结果 */
  reused: boolean;
}

/**
 * 拼提示词时用（同步，不等网络）：
 * - 重新生成（targetId 有值）：沿用那条回复原来用的结果；
 * - 平常：用存好的最新一份，再用本轮你的消息在本机按字面和时间说法补最多 2 条
 */
export function recallForTurn(chat: Chat, character: Character, userText: string, targetId?: string): RecallForTurn {
  if (targetId && used.has(targetId)) return { lines: used.get(targetId) as RecallLine[], snapshot: latestRecall(chat.id), added: 0, reused: true };
  const snap = latestRecall(chat.id);
  const lines = [...(snap?.lines ?? [])];
  let added = 0;
  const text = userText.trim();
  const mem = useMemoryStore();
  if (mem.ready && text && !isPhatic(text)) {
    const now = Date.now();
    const c = cues(text, character, now);
    const out = rankRecall({
      candidates: mem.candidates(character.id, null),
      query: text,
      queryVector: null,
      lexical: mem.lexical,
      now,
      time: c.time,
      states: c.states,
      quotas: { basic: 2, important: 0, special: 0, state: 1, time: 2 },
      maxItems: 2,
      tokenBudget: 300,
      countTokens: estimateTokens,
    });
    const have = new Set(lines.map((l) => l.key));
    for (const l of linesOf(out.hits, character.id)) {
      if (have.has(l.key)) continue;
      lines.push(l);
      added += 1;
    }
  }
  return { lines, snapshot: snap, added, reused: false };
}

/** 这条回复生成时用了哪些记忆（重新生成时沿用）；被带进提示词的记一次"想起过" */
export function noteRecallUsed(messageId: string, lines: RecallLine[], countRecall: boolean) {
  used.set(messageId, lines);
  while (used.size > 40) used.delete(used.keys().next().value as string);
  if (countRecall) useMemoryStore().noteRecalled(lines.map((l) => l.key));
}

/** 清掉一条聊天的结果（聊天删除时） */
export function clearRecall(chatId: string) {
  delete snapshots[chatId];
  running.get(chatId)?.abort();
  running.delete(chatId);
}
