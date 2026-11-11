import {
  assemblePrompt,
  buildChatRequest,
  estimateTokens,
  formatEnvironmentBlock,
  getLocation,
  getScene,
  isRealPlace,
  type AppBlockFill,
  type AssembleResult,
  type Character,
  type Chat,
  type ChatTurn,
  type GenerationType,
  type Message,
  type MessagePart,
  type Persona,
  type Preset,
} from '@app/shared';
import type { LLMChatMessage } from './types';
import { mockToday, todayLine, weather } from '@/mock/activity';
import { personas } from '@/mock/characters';
import { memories } from '@/mock/memories';
import { useAiStore } from '@/stores/ai';
import { useLibraryStore } from '@/stores/library';

/**
 * 每一轮的提示词：把这条聊天、角色卡、绑定的世界书、预设交给共享的拼装器（packages/shared/src/st/assemble.ts，
 * 按 SillyTavern 的规则拼），App 自己的记忆 / 摘要 / 环境 / 场景规则在这里填好内容传进去。
 * 发送和"查看提示词"用的是同一个函数，所以查看到的就是真实请求。
 */

export { estimateTokens };

export function personaOf(chat: Chat | undefined): Persona {
  return personas.find((p) => p.id === chat?.personaId) ?? personas.find((p) => p.isDefault) ?? (personas[0] as Persona);
}

function partToText(p: MessagePart, character: Character, user: string): string {
  switch (p.type) {
    case 'text':
      return p.text;
    case 'voice':
      return `[语音] ${p.transcript}`;
    case 'image':
      return `[图片：${p.caption}]`;
    case 'music':
      return `[分享歌曲：${p.title} - ${p.artist}]`;
    case 'poke':
      return p.actor === 'user' ? `（${user}拍了拍${character.name}的${p.target}）` : `（${character.name}拍了拍${user}）`;
    case 'call-log':
      return `[语音通话 ${Math.round(p.durationSec / 60)} 分钟${p.scene ? ` · ${p.scene}` : ''}]`;
    case 'workout':
      return `[运动记录：${p.sport} ${p.distanceKm ?? ''} 公里，用时 ${Math.round(p.durationSec / 60)} 分钟]`;
    case 'meal':
      return `[饭照：${p.food}]`;
    case 'study':
      return `[陪伴学习：${p.pomodoros} 个番茄，${p.minutes} 分钟]`;
    case 'date':
      return `[约会邀请：${p.when} ${p.place}]`;
    case 'gift':
      return `[礼物：${p.name}]`;
    case 'scene':
      return `（${p.title}${p.summary ? `：${p.summary}` : ''}）`;
  }
}

export function messageToText(m: Message, character: Character, user = personas[0]?.name ?? '你'): string {
  return m.parts.map((p) => partToText(p, character, user)).join(' ').trim();
}

/** 聊天记录 → 拼装器要的格式：旁白 / 场景分隔当系统消息（同 ST 的 narrator） */
export function toTurns(history: Message[], character: Character, user: string): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const m of history) {
    const content = messageToText(m, character, user);
    if (!content) continue;
    if (m.role === 'user') out.push({ role: 'user', name: user, content });
    else if (m.role === 'assistant') out.push({ role: 'assistant', name: character.name, content });
    else out.push({ role: 'system', name: '', content });
  }
  return out;
}

/** 演示用的滚动摘要（每个演示角色一份；正式版由总结智能体写） */
const SUMMARIES: Record<string, string> = {
  suwan: '上周两人一起看了电影；他最近在赶论文、经常熬夜，她很担心；约好周六去水族馆。',
  jiangyu: '他最近每天早上跟江屿在操场晨跑；昨天下雨跑了 3.1 公里，比第一天快了一分钟；约好每天六点见，迟到一分钟加一圈。',
};

/** App 自己的四块：摘要、记忆 + 关系、【当前环境】、场景规则 */
function appFills(chat: Chat, character: Character, history: Message[]): Record<string, AppBlockFill> {
  const scene = getScene(chat.currentScene ?? 'free');
  const loc = getLocation(chat.togetherAt ?? character.locationId);
  const place = !loc
    ? null
    : chat.togetherAt
      ? isRealPlace(loc)
        ? `你带${character.name}出门了，你们一起在${loc.name}`
        : `你在${character.name}的小世界里陪${character.pronoun}，你们一起在${loc.name}`
      : `${character.name}在${character.pronoun}的小世界里的${loc.name}${character.status ? `（${character.status}）` : ''}；你在家`;

  const mems = memories
    .filter((m) => m.characterId === character.id && m.status === 'active')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance)
    .slice(0, 6);
  const rel = character.relationship;
  const relParts = [
    rel.affection !== 50 ? `好感 ${rel.affection}` : '',
    rel.mood ? `心情"${rel.mood}"` : '',
    rel.userNickname ? `${character.pronoun}叫你"${rel.userNickname}"` : '',
  ].filter(Boolean);
  const memoryLines = [...mems.map((m) => `- ${m.content}`), ...(relParts.length ? [`- 关系：${relParts.join('，')}`] : [])];

  // 距上次聊天：最后一条之前那条消息到现在
  const before = history.at(-2)?.createdAt;
  const sinceLastChatMin = before ? Math.max(0, (Date.now() - before) / 60_000) : null;

  return {
    summary: { content: SUMMARIES[character.id] ?? '', source: '滚动摘要（总结智能体）' },
    memory: { content: memoryLines.join('\n'), source: `记忆检索 Top ${mems.length}（置顶必带）+ 关系状态` },
    environment: {
      content: formatEnvironmentBlock({
        now: new Date(),
        weather,
        todayLine: todayLine(mockToday()),
        sinceLastChatMin,
        place,
        sceneName: scene.id === 'free' ? null : scene.name,
      }),
      source: '时间 / 节气 / 天气 / 今日活动 / 她在哪',
    },
    sceneRules: {
      content: `${scene.promptFragment.replaceAll('{{char}}', character.name)}\n可用标签：${scene.allowedTags.map((t) => `[${t}]`).join(' ')}；可用表情：neutral smile laugh blush shy pout surprised sad angry sleepy sleep`,
      source: `场景"${scene.name}"`,
    },
  };
}

export function presetFor(chat: Chat | undefined, character: Character | undefined): Preset {
  const lib = useLibraryStore();
  return lib.presetById(chat?.presetId) ?? lib.presetById(character?.presetId) ?? (lib.presets[0] as Preset);
}

/** 主对话智能体用的模型名（请求体里的 model）；还没分配时显示"演示模型" */
export function mainModel(): string {
  const ai = useAiStore();
  return ai.isLive('main') ? (ai.routeOf('main')?.model ?? '演示模型') : '演示模型';
}

export interface ChatPrompt extends AssembleResult {
  preset: Preset;
  persona: Persona;
  request: Record<string, unknown>;
}

/**
 * 拼这一轮的提示词。history 是要发出去的聊天记录（从旧到新，最后一条通常是你刚发的）。
 * dryRun：只是查看，不推进世界书的粘性 / 冷却、不改聊天变量。
 */
export function assembleForChat(chat: Chat, character: Character, history: Message[], opts: { dryRun?: boolean; type?: GenerationType } = {}): ChatPrompt {
  const lib = useLibraryStore();
  const preset = presetFor(chat, character);
  const persona = personaOf(chat);
  const books = character.lorebookIds.map((id) => lib.lorebookById(id)).filter((b) => !!b);
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const prevUser = [...history].reverse().filter((m) => m.role === 'user')[1];
  const result = assemblePrompt({
    preset,
    character,
    user: { name: persona.name, description: persona.description },
    lorebooks: books,
    history: toTurns(history, character, persona.name),
    app: appFills(chat, character, history),
    type: opts.type,
    now: new Date(),
    idleMs: lastUser && prevUser ? lastUser.createdAt - prevUser.createdAt : null,
    vars: chat.vars,
    loreState: chat.loreState,
    dryRun: opts.dryRun,
    model: mainModel(),
  });
  return { ...result, preset, persona, request: buildChatRequest(result, preset, mainModel()) };
}

/** 发给模型的消息（去掉来源说明） */
export function toLLMMessages(p: ChatPrompt): LLMChatMessage[] {
  return p.messages.map(({ role, content, name }) => (name ? { role, content, name } : { role, content }));
}
