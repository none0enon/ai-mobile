import { dayLabel, lineTime } from '@app/ai';
import type { AppBlockFill, Character, Chat, Memory } from '@app/shared';
import { useMemoryStore } from '@/stores/memory';
import type { RecallLine } from './recall';
import { recentMomentsBlock } from './social';

/**
 * 记忆进提示词的两块（设计文档 §5.1 的"过往摘要"和"长期记忆 + 关系状态"）：
 * - 过往摘要：画像卡（她知道的你）+ 时间线（各层还没合并的段，越早越概括）；
 * - 长期记忆：关系状态 + 每次都带的（置顶的、到期要问的）+ 这一轮取到的记忆（按发生时间排好，带日期）。
 * 主动消息没有"你刚说的话"可以搜，只带每次都带的和最重要的 30 条。
 * 最近三天的朋友圈（她发的、你发的她看得到的，连同点赞评论）接在长期记忆后面：聊天、主动消息都知道朋友圈里发生了什么。
 */

const DAY = 86_400_000;
const PROACTIVE_TOP = 30;

/** 演示角色还没总结过时的梗概 */
const DEMO_SUMMARIES: Record<string, string> = {
  suwan: '上周两人一起看了电影；他最近在赶论文、经常熬夜，她很担心；约好周六去水族馆。',
  jiangyu: '他最近每天早上跟江屿在操场晨跑；昨天下雨跑了 3.1 公里，比第一天快了一分钟；约好每天六点见，迟到一分钟加一圈。',
};

/** 画像卡按栏目分组："【喜好】不吃香菜；下雨天喜欢听慢歌" */
export function profileText(characterId: string): string {
  const p = useMemoryStore().profileOf(characterId);
  if (!p?.lines.length) return '';
  const groups = new Map<string, string[]>();
  for (const l of p.lines) groups.set(l.section, [...(groups.get(l.section) ?? []), l.text]);
  return [...groups.entries()].map(([section, items]) => `【${section}】${items.join('；')}`).join('\n');
}

/** 时间线："- 2026-01-03 ~ 2026-03-20：……"（从旧到新） */
export function timelineText(chatId: string, timeZone: string): string {
  return useMemoryStore()
    .timelineOf(chatId)
    .map((s) => {
      const a = dayLabel(s.fromAt, timeZone);
      const b = dayLabel(s.toAt, timeZone);
      return `- ${a === b ? a : `${a} ~ ${b}`}：${s.text}`;
    })
    .join('\n');
}

/** 每次都带的：置顶的，和到期要问的待跟进（已经到期的、12 小时内到期的；过期超过一周的交给整理改时态） */
export function alwaysOn(characterId: string, now: number): Memory[] {
  return useMemoryStore()
    .activeOf(characterId)
    .filter((m) => m.pinned || (m.type === 'followup' && m.dueAt !== null && m.dueAt <= now + DAY / 2 && m.dueAt >= now - 7 * DAY))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.dueAt ?? 0) - (b.dueAt ?? 0) || b.importance - a.importance);
}

export function relationshipLine(character: Character): string {
  const rel = character.relationship;
  const parts = [
    rel.affection !== 50 ? `好感 ${rel.affection}` : '',
    rel.mood ? `心情"${rel.mood}"` : '',
    rel.userNickname ? `${character.pronoun}叫你"${rel.userNickname}"` : '',
    rel.charNickname ? `你叫${character.pronoun}"${rel.charNickname}"` : '',
  ].filter(Boolean);
  return parts.length ? `关系：${parts.join('，')}` : '';
}

function memoryLine(m: Memory, timeZone: string): string {
  const due = m.type === 'followup' && m.dueAt ? `（${lineTime(m.dueAt, timeZone)} 到期，到时候问问）` : '';
  return `- ${m.content}${due}`;
}

/** 过往摘要：画像卡 + 时间线 */
export function summaryBlock(chat: Chat, character: Character, timeZone: string): AppBlockFill {
  const profile = profileText(character.id);
  const timeline = timelineText(chat.id, timeZone);
  const segs = useMemoryStore().timelineOf(chat.id).length;
  if (!profile && !timeline) {
    const demo = DEMO_SUMMARIES[character.id];
    return demo ? { content: demo, source: '演示梗概（这条聊天还没总结过）' } : { content: '', source: '这条聊天还没总结过' };
  }
  const parts = [profile ? `${character.name}知道的你：\n${profile}` : '', timeline ? `你们的时间线（越早越概括）：\n${timeline}` : ''].filter(Boolean);
  return { content: parts.join('\n\n'), source: `画像卡 ${useMemoryStore().profileOf(character.id)?.lines.length ?? 0} 行 + 时间线 ${segs} 段` };
}

/** 长期记忆：关系 + 每次都带的 + 这一轮取到的 */
export function memoryBlock(character: Character, recall: RecallLine[], now: number, timeZone: string, opts: { proactive?: boolean; /** 不带"最近的朋友圈"（发朋友圈时那一块单独给） */ moments?: boolean } = {}): AppBlockFill {
  const fixed = alwaysOn(character.id, now);
  const fixedIds = new Set(fixed.map((m) => m.id));
  const lines: string[] = [];
  const rel = relationshipLine(character);
  if (rel) lines.push(rel);
  if (fixed.length) lines.push(`${character.name}一直记着的：\n${fixed.map((m) => memoryLine(m, timeZone)).join('\n')}`);
  let source = `关系状态 + 置顶和到期的 ${fixed.length} 条`;
  if (opts.proactive) {
    const top = useMemoryStore()
      .activeOf(character.id)
      .filter((m) => !fixedIds.has(m.id))
      .sort((a, b) => b.importance - a.importance || (b.happenedAt ?? b.createdAt) - (a.happenedAt ?? a.createdAt))
      .slice(0, PROACTIVE_TOP)
      .sort((a, b) => (a.happenedAt ?? a.createdAt) - (b.happenedAt ?? b.createdAt));
    if (top.length) lines.push(`${character.name}记得的事：\n${top.map((m) => `- ${dayLabel(m.happenedAt ?? m.createdAt, timeZone)}：${m.content}`).join('\n')}`);
    source += ` + 最重要的 ${top.length} 条（主动消息不搜）`;
  } else {
    const picked = recall.filter((l) => !(l.kind === 'memory' && fixedIds.has(l.id))).sort((a, b) => a.at - b.at);
    if (picked.length) lines.push(`${character.name}想起来的事（按时间先后）：\n${picked.map((l) => `- ${dayLabel(l.at, timeZone)}：${l.text}`).join('\n')}`);
    source += ` + 取到的 ${picked.length} 条`;
  }
  const moments = opts.moments === false ? '' : recentMomentsBlock(character);
  if (moments) {
    lines.push(moments);
    source += ' + 最近的朋友圈';
  }
  return { content: lines.join('\n\n'), source };
}
