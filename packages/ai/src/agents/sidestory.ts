import type { ChatMessage } from '../llm/types.ts';

/**
 * 番外智能体（sidestory）：你不在的时候，她在自己的小世界里发生了什么。
 * 按她的性格、作息、此刻的地点、世界里的其他人，以及最近和你聊过的事，写一小段第三人称的日常故事。
 * 故事可以引出一条主动消息（hook）或一张配图（cg，交给生图提示词智能体），
 * 也写进她的"生活记录"，之后聊天时她能自然地提起（"今天室友又借我充电器"）。
 */

export interface SidestoryInput {
  character: {
    name: string;
    pronoun: string;
    description: string;
    personality?: string;
    scenario?: string;
  };
  user: { name: string };
  now: Date;
  world?: {
    name: string;
    blurb?: string;
    /** "08:30–11:30 图书馆 · 自习中" 这样的作息行 */
    schedule?: string[];
    studyTask?: string;
    meals?: string;
    people?: { name: string; relation: string }[];
  };
  /** 她此刻在哪、在做什么 */
  current?: { place?: string; status?: string };
  memories?: string[];
  recentChat?: string[];
  /** 最近写过的番外标题，避免重复 */
  previous?: string[];
  length?: 'short' | 'medium';
}

export interface Sidestory {
  title: string;
  story: string;
  /** 故事发生的时段（"午后""21:40"） */
  time: string;
  place: string;
  /** 她现在的心情（一个词） */
  mood: string;
  people: string[];
  /** 写完这件事后她可能发给你的一句话；没有为 null */
  hook: string | null;
  /** 最适合配图的一幕（中文）；没有为 null */
  cg: string | null;
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function cut(text: string | undefined, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function buildSidestoryMessages(input: SidestoryInput): ChatMessage[] {
  const { character: c, user, world, current } = input;
  const words = input.length === 'medium' ? '300–500' : '150–250';
  const system = [
    `你在为一个陪伴 App 写"番外"：${c.name}在${c.pronoun}自己的世界里，${user.name}不在场时发生的一小段日常。`,
    '要求：',
    `- 第三人称，像轻小说的番外，${words} 字；贴合${c.name}的性格、作息和此刻所在的地方。`,
    `- 写一个小而具体的事件（一个小麻烦、一个小惊喜、一段对话），有画面感；不要流水账，不要结尾升华。`,
    `- 可以出现${c.pronoun}世界里的其他人；${user.name}不出场，但${c.name}可以想到${user.name}、想起你们聊过的事。`,
    '- 不要和最近写过的番外重复。',
    '- 只输出一个 JSON 对象，不要任何其他文字：',
    '{"title": "标题（12 字以内）", "story": "故事正文", "time": "发生的时段", "place": "地点", "mood": "她现在的心情（一个词）", "people": ["出场的其他人"], "hook": "写完这件事后她可能发给对方的一句消息（口语，30 字以内），没有就写 null", "cg": "最适合配一张图的画面（中文一句话），没有就写 null"}',
  ].join('\n');
  const now = input.now;
  const lines = [
    `【角色】${c.name}\n${cut(c.description, 1200)}${c.personality ? `\n性格：${cut(c.personality, 300)}` : ''}${c.scenario ? `\n背景：${cut(c.scenario, 300)}` : ''}`,
    world
      ? `【${c.pronoun}的世界】${world.name}${world.blurb ? `：${world.blurb}` : ''}${world.schedule?.length ? `\n作息：\n${world.schedule.join('\n')}` : ''}${world.studyTask ? `\n手头在忙：${world.studyTask}` : ''}${world.meals ? `\n三餐：${world.meals}` : ''}${world.people?.length ? `\n身边的人：${world.people.map((p) => `${p.name}（${p.relation}）`).join('、')}` : ''}`
      : '',
    `【现在】${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${WEEKDAY[now.getDay()]} ${clock(now)}${current?.place ? `；${c.name}在${current.place}${current.status ? `（${current.status}）` : ''}` : ''}`,
    input.memories?.length ? `【${c.name}记得的关于${user.name}的事】\n${input.memories.slice(0, 8).map((m) => `- ${m}`).join('\n')}` : '',
    input.recentChat?.length ? `【最近的聊天】\n${input.recentChat.slice(-8).join('\n')}` : '',
    input.previous?.length ? `【最近写过的番外】${input.previous.slice(-5).join('、')}` : '',
  ].filter(Boolean);
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n\n') },
  ];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function nullable(v: unknown): string | null {
  const s = str(v);
  return s && s.toLowerCase() !== 'null' ? s : null;
}

export function parseSidestory(value: unknown): Sidestory | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const story = str(v.story);
  if (story.length < 20) return null;
  return {
    title: str(v.title).slice(0, 30) || story.slice(0, 12),
    story,
    time: str(v.time),
    place: str(v.place),
    mood: str(v.mood).slice(0, 12),
    people: Array.isArray(v.people) ? v.people.map(str).filter(Boolean).slice(0, 8) : [],
    hook: nullable(v.hook),
    cg: nullable(v.cg),
  };
}
