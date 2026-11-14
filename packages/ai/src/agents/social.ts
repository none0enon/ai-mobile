import { assembleTaskPrompt, socialDayText, substituteMacros, type SocialContext, type SocialDay, type SocialTask } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 社媒智能体（朋友圈）：
 * - post：她按今天的节律（此刻在哪、在做什么、吃了什么、穿什么）和最近跟你聊的事发一条朋友圈——
 *   正文，可以配一张图（写画面，交给生图），可以附一小页 HTML（缴费单、小票、车票……）；
 * - react：你发了朋友圈、或者在评论里跟她说话，她点赞、评论、回复。
 * 提示词（任务、规则、输出格式）全在"社媒"预设里，按触发条件只发这次的任务；这里只把这一次的输入填进程序填充块。
 * 输出用 @app/shared 的 parseMomentDraft / parseMomentReaction 读。手机和云端 Worker 用的是同一份。
 */

/** 社媒预设的程序填充块（TASK_MARKERS.social） */
export type SocialFill = 'socialCharacter' | 'socialLife' | 'socialNow' | 'socialMemories' | 'socialRecent' | 'socialFeed' | 'socialPost' | 'socialAsk';

export interface SocialPromptInput {
  task: SocialTask;
  characterName: string;
  userName: string;
  now?: Date;
  timeZone?: string;
  fills: Partial<Record<SocialFill, string>>;
}

export function buildSocialMessages(input: SocialPromptInput, preset: TaskPreset): ChatMessage[] {
  const fills: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fills)) if (v) fills[k] = v;
  return assembleTaskPrompt({ preset, fills, macros: { char: input.characterName, user: input.userName, now: input.now, timeZone: input.timeZone }, type: input.task }).messages;
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function cut(text: string | undefined, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 角色那一块：名字、描述、性格、场景（宏先替换好） */
export function socialCharacterFill(c: SocialContext['character'], userName: string): string {
  const sub = (text: string) => substituteMacros(text, { char: c.name, user: userName }).trim();
  return [
    `名字：${c.name}（界面里称呼"${c.pronoun}"）`,
    c.card.description ? `描述：${cut(sub(c.card.description), 1500)}` : '',
    c.card.personality ? `性格：${cut(sub(c.card.personality), 400)}` : '',
    c.card.scenario ? `场景：${cut(sub(c.card.scenario), 400)}` : '',
  ].filter(Boolean).join('\n');
}

/** "现在"那一块：按她所在时区的日期、星期、时间 */
export function socialNowFill(now: number, timeZone: string): { text: string; minute: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '');
  const hour = Number(parts.hour) % 24;
  return {
    text: `现在：${parts.year}-${parts.month}-${parts.day} ${WEEKDAY[weekday] ?? ''} ${String(hour).padStart(2, '0')}:${parts.minute}`,
    minute: hour * 60 + Number(parts.minute),
  };
}

/** 发一条朋友圈的输入：按上传的上下文（手机拼好的文字）和此刻的时间拼。day 传云端自己排的今天，没有就用上下文里的 */
export function socialPostInput(context: SocialContext, now: number, day: SocialDay | null = context.day): SocialPromptInput {
  const { character: c, userName } = context;
  const at = socialNowFill(now, context.timezone);
  return {
    task: 'post', characterName: c.name, userName, now: new Date(now), timeZone: context.timezone,
    fills: {
      socialCharacter: socialCharacterFill(c, userName),
      socialLife: day ? socialDayText(day, at.minute) : '',
      socialNow: at.text,
      socialMemories: context.memories,
      socialRecent: context.recent ? `最近的聊天：\n${context.recent}` : '',
      socialFeed: context.feed ? `最近的朋友圈（不要重复发过的内容）：\n${context.feed}` : '',
      socialAsk: `这一次：${c.name}现在发一条朋友圈。`,
    },
  };
}
