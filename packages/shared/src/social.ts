import { outfitOfDay, toMinutes } from './rhythm.ts';
import type { RhythmDay } from './types/rhythm.ts';
import { zonedInstant } from './timezone.ts';
import { MOMENT_USER, SOCIAL_PER_DAY_MAX, type Moment, type SocialCharacterSettings, type SocialDay } from './types/social.ts';

/**
 * 朋友圈在手机和云端共用的部分：每天什么时候发（按角色和日期算出来的随机时间，两边算的一样）、
 * 读模型的输出、把一条朋友圈写成一行字（进提示词、进记忆）。
 */

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 每天最多几条：1 到 SOCIAL_PER_DAY_MAX */
export function socialPerDay(settings: Pick<SocialCharacterSettings, 'perDay'>): number {
  return Math.min(SOCIAL_PER_DAY_MAX, Math.max(1, Math.round(settings.perDay) || 1));
}

/**
 * 这个角色这一天发朋友圈的时间（当天的第几分钟，从早到晚）。
 * 随机但可重复：同一个角色同一天算出来的一样，所以重叠的 Cron、手机和云端不会各发各的。
 * 条数是 1 到"每天最多几条"之间；把她醒着的时段平分成几段，每段里随机挑一个时间，不会挤在一起。
 */
export function momentSlots(input: { characterId: string; date: string; perDay: number; awake: { from: string; to: string } }): number[] {
  const max = socialPerDay(input);
  const seed = `${input.characterId}:${input.date}`;
  const count = 1 + (hash32(`${seed}:count`) % max);
  let from = toMinutes(input.awake.from) ?? 8 * 60;
  let to = toMinutes(input.awake.to) ?? 23 * 60;
  // 睡得比起得早（凌晨才睡）：当天算到 23:59
  if (to <= from) to = 24 * 60 - 1;
  // 刚醒、快睡的半小时不发
  from = Math.min(from + 30, to);
  to = Math.max(to - 30, from + 1);
  const span = Math.max(1, Math.floor((to - from) / count));
  return Array.from({ length: count }, (_, i) => from + i * span + (hash32(`${seed}:${i}`) % span));
}

/** 这一天每条朋友圈该发的时刻（毫秒） */
export function momentDueTimes(input: { characterId: string; date: string; perDay: number; awake: { from: string; to: string }; timezone: string }): number[] {
  return momentSlots(input).map((minute) => zonedInstant(input.date, minute, input.timezone));
}

/** 云端发的那条的 id：一个角色、一天、第几条，重试也不会变 */
export function hubMomentId(characterId: string, date: string, slot: number): string {
  return `moment:${characterId}:${date}:${slot}`;
}

// —— 读模型的输出 ——

/** 她发的一条朋友圈（社媒预设 post 任务的输出） */
export interface MomentDraft {
  text: string;
  /** 要配的图的画面（中文一句话）；不配图为 null */
  image: string | null;
  /** 一小页 HTML（缴费单、小票……）；没有为 null */
  html: string | null;
  htmlTitle: string;
  location: string;
}

/** 她对一条朋友圈的回应（社媒预设 react 任务的输出） */
export interface MomentReaction {
  like: boolean;
  /** 评论或回复；不说话为 null */
  comment: string | null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function nullable(v: unknown): string | null {
  const s = str(v);
  return s && !/^(null|none|无|没有)$/i.test(s) ? s : null;
}

/** 模型有时把整页 HTML 包在 ``` 里，或者带着 <!DOCTYPE>：拿出里面的内容 */
function cleanHtml(v: unknown): string | null {
  let s = nullable(v);
  if (!s) return null;
  s = s.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();
  // 不是 HTML（没有任何标签）的不要
  return /<[a-z][\s\S]*>/i.test(s) ? s.slice(0, 20_000) : null;
}

export function parseMomentDraft(value: unknown): MomentDraft | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const text = str(v.text);
  const html = cleanHtml(v.html);
  const image = nullable(v.image);
  // 只发图、只发一张小票也行；什么都没有不算
  if (!text && !html && !image) return null;
  return { text: text.slice(0, 2000), image: image ? image.slice(0, 300) : null, html, htmlTitle: str(v.htmlTitle).slice(0, 30), location: (nullable(v.location) ?? '').slice(0, 40) };
}

export function parseMomentReaction(value: unknown): MomentReaction | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const comment = nullable(v.comment);
  return { like: v.like === true || v.like === 'true', comment: comment ? comment.slice(0, 500) : null };
}

// —— 写成文字 ——

function clock(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
}

/** 一条朋友圈里除了正文还有什么："配图：…"、"附：便利店小票"、"在 图书馆" */
export function momentExtras(m: Pick<Moment, 'images' | 'htmlTitle' | 'html' | 'location'>): string {
  const images = m.images.map((i) => (i.photo ? (i.seen ? `照片：${i.seen}` : '一张照片') : i.caption ? `配图：${i.caption}` : '一张图'));
  return [...images, m.html ? `附：${m.htmlTitle || '一张单据'}` : '', m.location ? `在 ${m.location}` : ''].filter(Boolean).join('；');
}

/**
 * 一条朋友圈写成几行字（进提示词）：谁、什么时候、发了什么、谁点了赞、下面的评论。
 * names：id → 名字（MOMENT_USER 是你的名字）
 */
export function momentText(m: Moment, names: (id: string) => string, opts: { timeZone?: string; comments?: number } = {}): string {
  const extras = momentExtras(m);
  const head = `${clock(m.createdAt, opts.timeZone)} ${names(m.authorId)}发了朋友圈：${m.text ? `「${m.text}」` : ''}${extras ? `（${extras}）` : ''}`;
  const likes = m.likes.length ? `  点赞：${m.likes.map(names).join('、')}` : '';
  const comments = m.comments.slice(-(opts.comments ?? 8)).map((c) => `  ${names(c.authorId)}${c.replyTo ? ` 回复 ${names(c.replyTo)}` : ''}：${c.text}`);
  return [head, likes, ...comments].filter(Boolean).join('\n');
}

/**
 * 一条朋友圈对这个角色来说要记住的一句话（写进记忆）：只带她自己和你的互动
 */
export function momentMemory(m: Moment, characterId: string, names: (id: string) => string, timeZone?: string): string {
  const extras = momentExtras(m);
  const day = new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric' }).format(new Date(m.createdAt));
  const mine = m.authorId === characterId;
  const who = mine ? names(characterId) : names(MOMENT_USER);
  const parts = [`${day} ${who}发了朋友圈：${m.text ? `「${m.text.slice(0, 200)}」` : ''}${extras ? `（${extras}）` : ''}`];
  const other = mine ? MOMENT_USER : characterId;
  if (m.likes.includes(other)) parts.push(`${names(other)}点了赞`);
  const talk = m.comments.filter((c) => c.authorId === characterId || c.authorId === MOMENT_USER).slice(-4);
  if (talk.length) parts.push(`评论里 ${talk.map((c) => `${names(c.authorId)}：${c.text.slice(0, 80)}`).join('；')}`);
  return parts.join('，');
}

/** 节律里的一天换成朋友圈用的样子：地点 id 换成名字，穿着取平时那一套 */
export function socialDayOf(day: RhythmDay, placeName: (locationId: string) => string): SocialDay {
  return {
    date: day.date,
    schedule: day.schedule.map((s) => ({ from: s.from, to: s.to, place: placeName(s.locationId), status: s.status })),
    meals: day.meals,
    outfit: outfitOfDay(day, null)?.name ?? '',
    task: day.task,
    events: day.events ?? [],
  };
}

/** 节律里的一天写成几行字：作息（标出现在在做什么）、三餐、穿着、手头的事、小事 */
export function socialDayText(day: SocialDay, nowMinute: number | null): string {
  const lines = day.schedule.map((s) => {
    const a = toMinutes(s.from) ?? 0;
    let b = toMinutes(s.to) ?? 0;
    if (b <= a) b += 24 * 60;
    const now = nowMinute !== null && ((nowMinute >= a && nowMinute < b) || (nowMinute + 24 * 60 >= a && nowMinute + 24 * 60 < b));
    return `- ${s.from}–${s.to} ${s.place} · ${s.status}${now ? '  ← 现在' : ''}`;
  });
  return [
    `今天的作息：\n${lines.join('\n')}`,
    `三餐：早饭${day.meals.breakfast || '—'}；午饭${day.meals.lunch || '—'}；晚饭${day.meals.dinner || '—'}`,
    day.outfit ? `今天穿：${day.outfit}` : '',
    day.task ? `手头的事：${day.task}` : '',
    day.events.length ? `今天的小事：${day.events.join('；')}` : '',
  ].filter(Boolean).join('\n');
}
