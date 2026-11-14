import type { MessagePart } from './types/chat.ts';
import type { PokeHow } from './types/sprite.ts';

/**
 * 戳戳乐里怎么碰她（设计文档 §9.7）：用手、用嘴、蹭蹭；点一下是一下，长按是久一点（摸着 / 亲着 / 蹭着不放）。
 * 每种碰法是功能预设里的一个场景任务（触发条件写 poke-hand / poke-mouth / poke-rub 的块），她怎么回应写在那几块里；
 * 尺度也在预设里（poke-level:名字，见 presetUses.ts）。
 */
export interface PokeHowDef {
  id: PokeHow;
  label: string;
  /** 一个字的说法："亲脸 ×3"、"亲了 3 下" */
  verb: string;
  /** 场景任务名：预设里触发条件写了它的块只在这样碰的时候发送 */
  task: string;
  /** 点一下："你戳了戳她的脸" */
  tap: string;
  /** 长按："你摸着她的头不放"（前半、后半） */
  hold: [string, string];
  /** 选碰法的按钮、碰到时冒出来的小图标 */
  icon: string;
}

export const POKE_HOWS: readonly PokeHowDef[] = [
  { id: 'hand', label: '用手', verb: '戳', task: 'poke-hand', tap: '戳了戳', hold: ['摸着', '不放'], icon: 'i-lucide-hand' },
  { id: 'mouth', label: '用嘴', verb: '亲', task: 'poke-mouth', tap: '亲了亲', hold: ['亲着', '不放'], icon: 'i-lucide-heart' },
  { id: 'rub', label: '蹭蹭', verb: '蹭', task: 'poke-rub', tap: '蹭了蹭', hold: ['蹭着', '不放'], icon: 'i-lucide-cat' },
];

export function pokeHow(id: string | null | undefined): PokeHowDef | undefined {
  return POKE_HOWS.find((h) => h.id === id);
}

export type PokePart = Extract<MessagePart, { type: 'poke' }>;

/**
 * 这一下怎么写（聊天卡片、聊天列表、提示词共用）："你亲了亲她的脸，连着 3 下"；
 * 没写怎么碰的是聊天里的拍一拍（"你拍了拍她的头"）
 */
export function pokeLine(p: PokePart, user: string, char: string): string {
  if (p.actor === 'char') return `${char}拍了拍${user}`;
  const how = pokeHow(p.how);
  const act = !how ? `拍了拍${char}的${p.target}` : p.hold ? `${how.hold[0]}${char}的${p.target}${how.hold[1]}` : `${how.tap}${char}的${p.target}`;
  const times = p.times && p.times > 1 ? `，连着 ${p.times} 下` : '';
  const touched = p.sensitive ? '，碰到了不该碰的地方' : '';
  return `${user}${act}${times}${touched}`;
}
