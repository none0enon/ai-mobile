import {
  formatEnvironmentBlock,
  getScene,
  type Character,
  type Chat,
  type Message,
  type MessagePart,
  type Preset,
} from '@app/shared';
import type { LLMChatMessage } from './types';
import { mockToday, todayLine, weather } from '@/mock/activity';
import { lorebooks, presets } from '@/mock/library';
import { memories } from '@/mock/memories';
import { personas } from '@/mock/characters';

/**
 * 提示词组装的"预览版"：按预设里块的顺序，把角色卡、世界书、记忆、环境、场景规则、聊天记录拼起来。
 * 本轮用它驱动"查看提示词"页和假模型；M1 换成完整实现（宏、世界书递归/概率/分组、token 预算截断）。
 */

const USER = personas[0]?.name ?? '你';

function macros(text: string, character: Character): string {
  return text.replaceAll('{{char}}', character.name).replaceAll('{{user}}', USER);
}

/** 粗略估算 token：中日韩文字约 1 个/字，其他约 3.5 字符 1 个 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[　-鿿＀-￯]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}

function partToText(p: MessagePart, character: Character): string {
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
      return p.actor === 'user' ? `（${USER}拍了拍${character.name}的${p.target}）` : `（${character.name}拍了拍${USER}）`;
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
  }
}

export function messageToText(m: Message, character: Character): string {
  return m.parts.map((p) => partToText(p, character)).join(' ').trim();
}

export interface PromptBlockPreview {
  identifier: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  tokens: number;
  /** relative：按顺序；depth：插在聊天记录倒数第 N 条前 */
  placement: string;
  source: string;
  enabled: boolean;
}

function matchLore(character: Character, recentText: string) {
  const hits: { book: string; comment: string; content: string; constant: boolean; position: string }[] = [];
  for (const book of lorebooks.filter((b) => character.lorebookIds.includes(b.id))) {
    for (const e of book.entries) {
      if (!e.enabled) continue;
      const hit = e.constant || e.keys.some((k) => recentText.includes(k));
      if (hit) hits.push({ book: book.name, comment: e.comment, content: macros(e.content, character), constant: e.constant, position: e.position });
    }
  }
  return hits;
}

export function assemblePreview(chat: Chat, character: Character, history: Message[]): PromptBlockPreview[] {
  const preset: Preset = presets.find((p) => p.id === (chat.presetId ?? character.presetId)) ?? (presets[0] as Preset);
  const recent = history.slice(-12);
  const recentText = recent.map((m) => messageToText(m, character)).join('\n');
  const lore = matchLore(character, recentText);
  const scene = getScene(chat.currentScene ?? 'free');
  const today = mockToday();
  const persona = personas.find((p) => p.id === chat.personaId) ?? personas[0];
  const mems = memories
    .filter((m) => m.characterId === character.id && m.status === 'active')
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance)
    .slice(0, 6);

  const fill: Record<string, { content: string; source: string }> = {
    worldInfoBefore: {
      content: lore.filter((l) => l.position === 'before_char').map((l) => l.content).join('\n'),
      source: `世界书命中 ${lore.filter((l) => l.position === 'before_char').length} 条（常驻 / 关键词）`,
    },
    charDescription: { content: macros(character.card.description, character), source: '角色卡 description' },
    charPersonality: { content: macros(character.card.personality, character), source: '角色卡 personality' },
    scenario: { content: macros(character.card.scenario, character), source: '角色卡 scenario' },
    worldInfoAfter: {
      content: lore.filter((l) => l.position !== 'before_char').map((l) => `【${l.comment}】${l.content}`).join('\n'),
      source: `世界书命中 ${lore.filter((l) => l.position !== 'before_char').length} 条：${lore.filter((l) => l.position !== 'before_char').map((l) => l.comment).join('、') || '无'}`,
    },
    personaDescription: { content: `${persona?.name}：${persona?.description ?? ''}`, source: '我的人设' },
    dialogueExamples: { content: macros(character.card.mesExample, character), source: '角色卡 mes_example' },
    summary: {
      content: '上周两人一起看了电影；他最近在赶论文、经常熬夜，她很担心；约好周六去水族馆。',
      source: '滚动摘要（总结智能体）',
    },
    memory: {
      content: [
        ...mems.map((m) => `- ${m.content}`),
        `- 关系：好感 ${character.relationship.affection}，心情"${character.relationship.mood}"，她叫你"${character.relationship.userNickname}"`,
      ].join('\n'),
      source: `记忆检索 Top ${mems.length}（置顶必带）+ 关系状态`,
    },
    environment: {
      content: formatEnvironmentBlock({ now: new Date(), weather, todayLine: todayLine(today), sinceLastChatMin: 3, sceneName: scene.id === 'free' ? null : scene.name }),
      source: '时间 / 节气 / 天气 / 今日活动',
    },
    sceneRules: {
      content: `${macros(scene.promptFragment, character)}\n可用标签：${scene.allowedTags.map((t) => `[${t}]`).join(' ')}；可用表情：neutral smile laugh blush shy pout surprised sad angry sleepy sleep`,
      source: `场景"${scene.name}"`,
    },
    chatHistory: {
      content: recent.map((m) => `${m.role === 'user' ? USER : character.name}：${messageToText(m, character)}`).join('\n'),
      source: `最近 ${recent.length} 条（按 token 预算截取）`,
    },
  };

  return preset.blocks.map((b) => {
    const filled = b.marker ? fill[b.identifier] : undefined;
    const content = filled ? filled.content : macros(b.content, character);
    return {
      identifier: b.identifier,
      name: b.name,
      role: b.role,
      content,
      tokens: estimateTokens(content),
      placement: b.injection.position === 'absolute' ? `插在聊天记录倒数第 ${b.injection.depth} 条前` : '按顺序',
      source: filled ? filled.source : b.marker ? '程序填充' : '预设',
      enabled: b.enabled && content.trim().length > 0,
    };
  });
}

/** 给假模型用的消息列表（真实版本由 M1 的组装器生成） */
export function buildPromptMessages(chat: Chat, character: Character, history: Message[]): LLMChatMessage[] {
  const blocks = assemblePreview(chat, character, history).filter((b) => b.enabled && b.identifier !== 'chatHistory');
  const out: LLMChatMessage[] = [{ role: 'system', content: blocks.map((b) => b.content).join('\n\n') }];
  for (const m of history.slice(-12)) {
    if (m.role === 'narrator' || m.role === 'system') continue;
    out.push({ role: m.role === 'user' ? 'user' : 'assistant', content: messageToText(m, character) });
  }
  return out;
}
